-- Core Hideout schema: rooms, room_members, channels, messages, invites; the transactional
-- functions Node calls for them; the Realtime topic helper and realtime.messages policies;
-- the private room-icons storage bucket.
--
-- Access model (CLAUDE.md): only Node touches application tables and public functions, via
-- the service role. Browsers only join private Realtime channels, authorized by the
-- realtime.messages policies at the end of this file.
--
-- Roles and channel types are text + check constraints rather than enums: a check can be
-- widened or narrowed with a new constraint (added NOT VALID, then validated), while an
-- enum value can never be removed, and text maps directly onto the Zod string unions in
-- src/contracts.
--
-- ---------------------------------------------------------------------------
-- Error codes raised by the functions below (class HX, custom). Node maps them to HTTP.
-- ---------------------------------------------------------------------------
--   HX001  room_not_found     room does not exist or is soft-deleted
--   HX002  not_owner          the actor is not the room's owner
--   HX003  target_not_member  transfer_ownership target is not a member of the room
--   HX004  same_user          transfer_ownership from and to are the same profile
--   22023  invalid_parameter_value  a required argument is null
-- Constraint failures surface with their standard codes: 23514 check_violation,
-- 23502 not_null_violation, 23503 foreign_key_violation (e.g. unknown profile), 23505 unique_violation.
-- redeem_invite_link and respond_to_direct_invite report outcomes as a status value, not errors.

-- ---------------------------------------------------------------------------
-- 1. profiles: cached Steam "currently playing"
-- ---------------------------------------------------------------------------
-- Nullable, no default: metadata-only change, safe on a live table.
alter table public.profiles
  add column current_game text
    constraint profiles_current_game_length
    check (current_game is null or char_length(current_game) between 1 and 128),
  add column current_game_updated_at timestamptz;

comment on column public.profiles.current_game is 'Steam "currently playing" game name, refreshed by Node. Null = not in game / unknown.';

-- ---------------------------------------------------------------------------
-- 2. rooms
-- ---------------------------------------------------------------------------
-- No owner_id: ownership lives in room_members.role (exactly one owner per room).
create table public.rooms (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null
    constraint rooms_name_length check (char_length(name) between 1 and 48 and name ~ '[^[:space:]]'),
  icon_emoji text
    constraint rooms_icon_emoji_length check (icon_emoji is null or char_length(icon_emoji) between 1 and 16),
  icon_path  text
    constraint rooms_icon_path_length check (icon_path is null or char_length(icon_path) between 1 and 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint rooms_icon_exactly_one check (num_nonnulls(icon_emoji, icon_path) = 1)
);

comment on table public.rooms is 'Invite-only rooms. Soft-deleted via deleted_at. icon_path is an object path in the private room-icons bucket. Server-only (service role).';

-- ---------------------------------------------------------------------------
-- 3. room_members
-- ---------------------------------------------------------------------------
create table public.room_members (
  room_id   uuid        not null references public.rooms (id) on delete cascade,
  user_id   uuid        not null references public.profiles (id) on delete cascade,
  role      text        not null default 'member'
    constraint room_members_role_valid check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  constraint room_members_pkey primary key (room_id, user_id)
);

comment on table public.room_members is 'Room membership and role (owner | admin | member). Exactly one owner per room. Server-only (service role).';

-- One owner per room. Transfers must demote the old owner before promoting the new one.
create unique index room_members_one_owner_uidx on public.room_members (room_id) where role = 'owner';
-- "My rooms" lookups, the user_id FK, and can_access_topic (the PK covers room_id-first lookups).
create index room_members_user_id_room_id_idx on public.room_members (user_id, room_id);

-- ---------------------------------------------------------------------------
-- 4. channels
-- ---------------------------------------------------------------------------
create table public.channels (
  id         uuid        primary key default gen_random_uuid(),
  room_id    uuid        not null references public.rooms (id) on delete cascade,
  type       text        not null
    constraint channels_type_valid check (type in ('text', 'voice')),
  name       text        not null
    constraint channels_name_length check (char_length(name) between 1 and 32 and name ~ '[^[:space:]]'),
  position   integer     not null
    constraint channels_position_nonnegative check (position >= 0),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.channels is 'Text and voice channels in a room. Soft-deleted via deleted_at. Server-only (service role).';

-- Live channel names are unique per room and type, case-insensitively; a soft-deleted name can be reused.
create unique index channels_live_name_uidx on public.channels (room_id, type, lower(name)) where deleted_at is null;
-- Channel list ordering.
create index channels_live_room_type_position_idx on public.channels (room_id, type, position) where deleted_at is null;
-- FK (cascade from rooms covers soft-deleted rows too).
create index channels_room_id_idx on public.channels (room_id);

-- ---------------------------------------------------------------------------
-- 5. messages
-- ---------------------------------------------------------------------------
create table public.messages (
  id              uuid        primary key default gen_random_uuid(),
  channel_id      uuid        not null references public.channels (id) on delete cascade,
  author_id       uuid        references public.profiles (id) on delete set null,
  body            text        not null
    constraint messages_body_length check (char_length(body) between 1 and 2000 and body ~ '[^[:space:]]'),
  idempotency_key text
    constraint messages_idempotency_key_length check (idempotency_key is null or char_length(idempotency_key) between 1 and 128),
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  deleted_at      timestamptz
);

comment on table public.messages is 'Text channel messages. Soft-deleted via deleted_at; author_id is nulled if the profile is deleted. Server-only (service role).';

-- Idempotency-Key replay detection, per author.
create unique index messages_author_idempotency_uidx on public.messages (author_id, idempotency_key)
  where idempotency_key is not null;
-- History pagination (newest first, id as tie-breaker) and the channel_id FK.
create index messages_channel_created_id_idx on public.messages (channel_id, created_at desc, id desc);
-- author_id FK (on delete set null).
create index messages_author_id_idx on public.messages (author_id);

-- ---------------------------------------------------------------------------
-- 6. invites
-- ---------------------------------------------------------------------------
-- kind = 'link':   shareable link; token_hash = lowercase hex SHA-256 of the raw token (never stored).
-- kind = 'direct': addressed to one Steam account; single use; accepted or declined by the invitee.
-- Note: the pending-direct unique index ignores expires_at (now() can't appear in an index
-- predicate), so Node must revoke an expired pending direct invite before re-inviting that person.
create table public.invites (
  id               uuid        primary key default gen_random_uuid(),
  room_id          uuid        not null references public.rooms (id) on delete cascade,
  created_by       uuid        references public.profiles (id) on delete set null,
  kind             text        not null
    constraint invites_kind_valid check (kind in ('link', 'direct')),
  token_hash       text        unique
    constraint invites_token_hash_format check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  invitee_steam_id text
    constraint invites_invitee_steam_id_format check (invitee_steam_id is null or invitee_steam_id ~ '^[0-9]{17}$'),
  max_uses         integer
    constraint invites_max_uses_positive check (max_uses is null or max_uses > 0),
  uses             integer     not null default 0,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  accepted_at      timestamptz,
  declined_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint invites_uses_within_max check (uses >= 0 and (max_uses is null or uses <= max_uses)),
  constraint invites_link_shape check (
    kind <> 'link'
    or (token_hash is not null and invitee_steam_id is null and accepted_at is null and declined_at is null)
  ),
  constraint invites_direct_shape check (
    kind <> 'direct'
    or (invitee_steam_id is not null and token_hash is null and max_uses is not null and max_uses = 1)
  ),
  constraint invites_not_accepted_and_declined check (accepted_at is null or declined_at is null)
);

comment on table public.invites is 'Link and direct room invites. token_hash = hex SHA-256 of the link token. Server-only (service role).';

-- One pending direct invite per room and invitee.
create unique index invites_pending_direct_uidx on public.invites (room_id, invitee_steam_id)
  where kind = 'direct' and revoked_at is null and accepted_at is null and declined_at is null;
-- Invitee inbox.
create index invites_pending_direct_invitee_idx on public.invites (invitee_steam_id)
  where kind = 'direct' and revoked_at is null and accepted_at is null and declined_at is null;
-- Room invite list (newest first) and the room_id FK.
create index invites_room_created_idx on public.invites (room_id, created_at desc);
-- created_by FK (on delete set null).
create index invites_created_by_idx on public.invites (created_by);

-- ---------------------------------------------------------------------------
-- 7. Lockdown for the new tables
-- ---------------------------------------------------------------------------
-- RLS on, no policies: anon/authenticated can't read or write even if a grant slipped in.
-- The default privileges from the first migration already apply; this is explicit.
-- None of these tables is added to the supabase_realtime publication (we use Broadcast).
alter table public.rooms        enable row level security;
alter table public.room_members enable row level security;
alter table public.channels     enable row level security;
alter table public.messages     enable row level security;
alter table public.invites      enable row level security;

revoke all on table public.rooms, public.room_members, public.channels, public.messages, public.invites
  from anon, authenticated, public;
grant select, insert, update, delete
  on table public.rooms, public.room_members, public.channels, public.messages, public.invites
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. create_room
-- ---------------------------------------------------------------------------
-- Inserts the room, the owner's membership, and the default channels
-- "general" (text, position 0) and "voice" (voice, position 0). Returns the room id.
-- Failures: 23514 bad name/icon (including not exactly one icon), 23503 unknown owner,
--           23502 null name, 22023 null owner.
create function public.create_room(
  p_owner      uuid,
  p_name       text,
  p_icon_emoji text,
  p_icon_path  text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room_id uuid;
begin
  if p_owner is null then
    raise exception 'owner is required' using errcode = '22023';
  end if;

  insert into public.rooms (name, icon_emoji, icon_path)
  values (p_name, p_icon_emoji, p_icon_path)
  returning id into v_room_id;

  insert into public.room_members (room_id, user_id, role)
  values (v_room_id, p_owner, 'owner');

  insert into public.channels (room_id, type, name, position)
  values (v_room_id, 'text', 'general', 0),
         (v_room_id, 'voice', 'voice', 0);

  return v_room_id;
end;
$$;

comment on function public.create_room(uuid, text, text, text) is
  'Creates a room with its owner membership and default general/voice channels. service_role only.';

revoke execute on function public.create_room(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.create_room(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. redeem_invite_link
-- ---------------------------------------------------------------------------
-- Locks the invite row (select ... for update), so concurrent redemptions of the same link
-- serialize and the last use can't be taken twice.
-- Returns one row (room_id, status), checked in this order:
--   invalid        unknown hash or not a link invite (room_id null, so nothing leaks)
--   room_deleted   the room is soft-deleted
--   already_member caller is already a member; no use consumed (checked before revoked/expired
--                  so an existing member is simply sent to the room)
--   revoked        revoked_at is set
--   expired        expires_at <= now()
--   used_up        uses >= max_uses
--   joined         member row inserted with role 'member', uses += 1
-- Failures: 22023 null argument, 23503 unknown profile.
-- A redemption racing delete_room can add a member to a room that is being deleted; that
-- membership is harmless because every read path filters deleted rooms.
create function public.redeem_invite_link(p_token_hash text, p_user uuid)
returns table (room_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_invite  public.invites%rowtype;
  v_deleted timestamptz;
  v_rows    integer;
begin
  if p_token_hash is null or p_user is null then
    raise exception 'token_hash and user are required' using errcode = '22023';
  end if;

  select i.* into v_invite
  from public.invites i
  where i.token_hash = p_token_hash
  for update;

  if not found or v_invite.kind <> 'link' then
    return query select null::uuid, 'invalid'::text;
    return;
  end if;

  select r.deleted_at into v_deleted from public.rooms r where r.id = v_invite.room_id;
  if v_deleted is not null then
    return query select v_invite.room_id, 'room_deleted'::text;
    return;
  end if;

  if exists (
    select 1 from public.room_members m
    where m.room_id = v_invite.room_id and m.user_id = p_user
  ) then
    return query select v_invite.room_id, 'already_member'::text;
    return;
  end if;

  if v_invite.revoked_at is not null then
    return query select v_invite.room_id, 'revoked'::text;
    return;
  end if;

  if v_invite.expires_at is not null and v_invite.expires_at <= pg_catalog.now() then
    return query select v_invite.room_id, 'expired'::text;
    return;
  end if;

  if v_invite.max_uses is not null and v_invite.uses >= v_invite.max_uses then
    return query select v_invite.room_id, 'used_up'::text;
    return;
  end if;

  -- on conflict covers a concurrent join through a different invite.
  insert into public.room_members as m (room_id, user_id, role)
  values (v_invite.room_id, p_user, 'member')
  on conflict on constraint room_members_pkey do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return query select v_invite.room_id, 'already_member'::text;
    return;
  end if;

  update public.invites i set uses = i.uses + 1 where i.id = v_invite.id;

  return query select v_invite.room_id, 'joined'::text;
end;
$$;

comment on function public.redeem_invite_link(text, uuid) is
  'Redeems a link invite by token hash under a row lock. Returns (room_id, status). service_role only.';

revoke execute on function public.redeem_invite_link(text, uuid) from public, anon, authenticated;
grant execute on function public.redeem_invite_link(text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 10. respond_to_direct_invite
-- ---------------------------------------------------------------------------
-- Locks the invite row. Returns one row (room_id, status), checked in this order:
--   invalid           unknown id, not a direct invite, unknown profile, or the invite is
--                     addressed to another Steam account (room_id null; existence doesn't leak)
--   room_deleted      the room is soft-deleted
--   already_responded accepted_at or declined_at is already set
--   revoked           revoked_at is set
--   expired           expires_at <= now()
--   accepted          (p_accept) member row inserted, accepted_at = now(), uses = 1
--   already_member    (p_accept) caller was already a member; invite still marked accepted
--   declined          (not p_accept) declined_at = now()
-- Failures: 22023 null argument.
create function public.respond_to_direct_invite(p_invite uuid, p_user uuid, p_accept boolean)
returns table (room_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_invite   public.invites%rowtype;
  v_steam_id text;
  v_deleted  timestamptz;
  v_rows     integer;
begin
  if p_invite is null or p_user is null or p_accept is null then
    raise exception 'invite, user, and accept are required' using errcode = '22023';
  end if;

  select p.steam_id into v_steam_id from public.profiles p where p.id = p_user;

  select i.* into v_invite
  from public.invites i
  where i.id = p_invite
  for update;

  if not found
     or v_invite.kind <> 'direct'
     or v_steam_id is null
     or v_invite.invitee_steam_id is distinct from v_steam_id then
    return query select null::uuid, 'invalid'::text;
    return;
  end if;

  select r.deleted_at into v_deleted from public.rooms r where r.id = v_invite.room_id;
  if v_deleted is not null then
    return query select v_invite.room_id, 'room_deleted'::text;
    return;
  end if;

  if v_invite.accepted_at is not null or v_invite.declined_at is not null then
    return query select v_invite.room_id, 'already_responded'::text;
    return;
  end if;

  if v_invite.revoked_at is not null then
    return query select v_invite.room_id, 'revoked'::text;
    return;
  end if;

  if v_invite.expires_at is not null and v_invite.expires_at <= pg_catalog.now() then
    return query select v_invite.room_id, 'expired'::text;
    return;
  end if;

  if not p_accept then
    update public.invites i set declined_at = pg_catalog.now() where i.id = v_invite.id;
    return query select v_invite.room_id, 'declined'::text;
    return;
  end if;

  insert into public.room_members as m (room_id, user_id, role)
  values (v_invite.room_id, p_user, 'member')
  on conflict on constraint room_members_pkey do nothing;
  get diagnostics v_rows = row_count;

  update public.invites i set accepted_at = pg_catalog.now(), uses = 1 where i.id = v_invite.id;

  if v_rows = 0 then
    return query select v_invite.room_id, 'already_member'::text;
  else
    return query select v_invite.room_id, 'accepted'::text;
  end if;
end;
$$;

comment on function public.respond_to_direct_invite(uuid, uuid, boolean) is
  'Accepts or declines a direct invite addressed to the caller''s Steam account, under a row lock. Returns (room_id, status). service_role only.';

revoke execute on function public.respond_to_direct_invite(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.respond_to_direct_invite(uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 11. transfer_ownership
-- ---------------------------------------------------------------------------
-- Locks the room row (serializing with other transfers and delete_room), then both member
-- rows. Demotes p_from to admin before promoting p_to, so the one-owner index holds.
-- Failures (checked in this order):
--   22023 null argument
--   HX004 same_user          p_from = p_to
--   HX001 room_not_found     room missing or soft-deleted
--   HX002 not_owner          p_from is not the room's owner
--   HX003 target_not_member  p_to is not a member of the room
create function public.transfer_ownership(p_room uuid, p_from uuid, p_to uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from_role text;
begin
  if p_room is null or p_from is null or p_to is null then
    raise exception 'room, from, and to are required' using errcode = '22023';
  end if;

  if p_from = p_to then
    raise exception 'cannot transfer ownership to yourself' using errcode = 'HX004';
  end if;

  perform 1 from public.rooms r where r.id = p_room and r.deleted_at is null for update;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  -- Lock both member rows in a fixed order.
  perform 1 from public.room_members m
  where m.room_id = p_room and m.user_id in (p_from, p_to)
  order by m.user_id
  for update;

  select m.role into v_from_role
  from public.room_members m
  where m.room_id = p_room and m.user_id = p_from;

  if v_from_role is distinct from 'owner' then
    raise exception 'only the room owner can transfer ownership' using errcode = 'HX002';
  end if;

  if not exists (
    select 1 from public.room_members m where m.room_id = p_room and m.user_id = p_to
  ) then
    raise exception 'new owner must be a member of the room' using errcode = 'HX003';
  end if;

  update public.room_members m set role = 'admin' where m.room_id = p_room and m.user_id = p_from;
  update public.room_members m set role = 'owner' where m.room_id = p_room and m.user_id = p_to;
  update public.rooms r set updated_at = pg_catalog.now() where r.id = p_room;
end;
$$;

comment on function public.transfer_ownership(uuid, uuid, uuid) is
  'Moves room ownership from the current owner (demoted to admin) to another member. service_role only.';

revoke execute on function public.transfer_ownership(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.transfer_ownership(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 12. delete_room
-- ---------------------------------------------------------------------------
-- Locks the room row, then soft-deletes the room and its live channels and revokes its
-- pending invites. Member rows are kept so Node can broadcast room:deleted and remove the
-- members from LiveKit after the call.
-- Not idempotent: deleting an already-deleted room raises HX001 (it no longer exists as far
-- as the API is concerned, which maps to 404).
-- Failures: 22023 null argument, HX001 room_not_found (missing or already deleted),
--           HX002 not_owner.
create function public.delete_room(p_room uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_room is null or p_actor is null then
    raise exception 'room and actor are required' using errcode = '22023';
  end if;

  perform 1 from public.rooms r where r.id = p_room and r.deleted_at is null for update;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if not exists (
    select 1 from public.room_members m
    where m.room_id = p_room and m.user_id = p_actor and m.role = 'owner'
  ) then
    raise exception 'only the room owner can delete the room' using errcode = 'HX002';
  end if;

  update public.rooms r
  set deleted_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where r.id = p_room;

  update public.channels c
  set deleted_at = pg_catalog.now()
  where c.room_id = p_room and c.deleted_at is null;

  update public.invites i
  set revoked_at = pg_catalog.now()
  where i.room_id = p_room
    and i.revoked_at is null and i.accepted_at is null and i.declined_at is null;
end;
$$;

comment on function public.delete_room(uuid, uuid) is
  'Owner-only soft delete of a room, its live channels, and its pending invites. service_role only.';

revoke execute on function public.delete_room(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_room(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 13. Realtime authorization
-- ---------------------------------------------------------------------------
-- https://supabase.com/docs/guides/realtime/authorization
-- Private channels are authorized by RLS on realtime.messages; realtime.topic() returns the
-- topic being joined, and realtime.messages.extension is 'broadcast' or 'presence'.
-- Policies are evaluated when a client joins (and when it sends a new JWT) and are cached
-- for the connection, which is why membership removal is bounded by the token TTL.
--
-- How the Realtime server runs the checks (supabase/realtime,
-- lib/realtime/tenants/authorization.ex): for reads it inserts a probe row with the
-- server's own role, switches to the JWT's role, and selects it; for writes it inserts a
-- probe row as the JWT's role. The probe row has only id, topic, and extension set, and the
-- check runs once per join, not per message (broadcast_handler.ex caches
-- policies.broadcast.write). So `event` and `payload` are null when the insert policy runs.

create schema private;
comment on schema private is 'Helpers callable by browser roles (via Realtime policies). Nothing here touches data beyond returning booleans.';

revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Returns true if the JWT caller may use the topic:
--   room:<uuid>     caller is a member of that room and the room is not deleted
--   channel:<uuid>  channel is not deleted, its room is not deleted, and caller is a member
--   typing:<uuid>   same rule as channel:<uuid> (the uuid is a channel id)
--   user:<uuid>     uuid is the caller's profile id
-- The JWT must be one Node minted (iss = 'hideout-api', role = 'authenticated') with a uuid sub.
-- Anything else (other prefixes, malformed uuids, null) returns false.
create function private.can_access_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims  jsonb := (select auth.jwt());
  v_uuid_re constant text := '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';
  v_sub     text;
  v_user    uuid;
  v_prefix  text;
  v_rest    text;
  v_id      uuid;
begin
  if p_topic is null or v_claims is null then
    return false;
  end if;

  if (v_claims ->> 'iss') is distinct from 'hideout-api'
     or (v_claims ->> 'role') is distinct from 'authenticated' then
    return false;
  end if;

  v_sub := v_claims ->> 'sub';
  if v_sub is null or v_sub !~ v_uuid_re then
    return false;
  end if;
  v_user := v_sub::uuid;

  v_prefix := pg_catalog.split_part(p_topic, ':', 1);
  v_rest   := pg_catalog.substr(p_topic, pg_catalog.length(v_prefix) + 2);
  if pg_catalog.strpos(p_topic, ':') = 0 or v_rest !~ v_uuid_re then
    return false;
  end if;
  v_id := v_rest::uuid;

  if v_prefix = 'room' then
    return exists (
      select 1
      from public.room_members m
      join public.rooms r on r.id = m.room_id
      where m.room_id = v_id and m.user_id = v_user and r.deleted_at is null
    );
  elsif v_prefix in ('channel', 'typing') then
    return exists (
      select 1
      from public.channels c
      join public.rooms r on r.id = c.room_id
      join public.room_members m on m.room_id = c.room_id
      where c.id = v_id and c.deleted_at is null and r.deleted_at is null and m.user_id = v_user
    );
  elsif v_prefix = 'user' then
    return v_id = v_user;
  end if;

  return false;
end;
$$;

comment on function private.can_access_topic(text) is
  'Realtime topic authorization for realtime.messages policies. Returns only a boolean. Executable by authenticated only.';

-- Functions get EXECUTE for PUBLIC by default (the first migration's default-privilege
-- changes cover schema public only), so revoke explicitly.
revoke execute on function private.can_access_topic(text) from public, anon;
grant execute on function private.can_access_topic(text) to authenticated;

-- Receive: members may receive Broadcast and Presence on topics they can access
-- (room:<id> of their rooms, channel:<id> and typing:<id> of channels in their rooms,
-- their own user:<id>).
create policy "hideout: members receive on accessible topics"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension in ('broadcast', 'presence')
  and (select private.can_access_topic((select realtime.topic())))
);

-- Send Presence: members may track Presence on room:<id> topics of their rooms only.
create policy "hideout: members track presence on room topics"
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension = 'presence'
  and (select realtime.topic()) like 'room:%'
  and (select private.can_access_topic((select realtime.topic())))
);

-- Send Broadcast: members may broadcast only on typing:<channelId> topics of channels they
-- can access. channel:<id>, room:<id>, and user:<id> are receive-only for browsers (only
-- Node broadcasts there, with the service role).
-- Per-event checks are not possible here: Realtime runs this check once per join with
-- event and payload null (see the note at the top of this section), so any member can send
-- any event with any payload on a typing: topic. Clients must treat typing payloads as
-- untrusted: resolve names and avatars from the room member list, and ignore userIds that
-- are not in it.
create policy "hideout: members broadcast on typing topics"
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) like 'typing:%'
  and (select private.can_access_topic((select realtime.topic())))
);

-- No policies for anon: anonymous clients can't join private channels.

-- ---------------------------------------------------------------------------
-- 14. Storage: private bucket for room icons
-- ---------------------------------------------------------------------------
-- Node uploads and signs URLs with the service role; no storage.objects policies for
-- anon/authenticated, so browsers can't read or write objects directly.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('room-icons', 'room-icons', false, 262144, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;
