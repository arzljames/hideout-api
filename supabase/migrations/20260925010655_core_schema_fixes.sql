-- Fixes to 20260924233656_core_schema.sql (applied; never edited) from review:
--   * non-members get room_not_found (HX001), never not_owner (HX002)  (CLAUDE.md rule 4)
--   * consistent lock order (room, then invite) in the invite functions
--   * ownership invariant: remove_member(), change_role(), owner-row delete guard trigger
--   * rooms.updated_at trigger
--   * room-icons bucket settings enforced even if the bucket already existed
--   * stricter SteamID64 checks, lowercase-only topic uuids, invite expiry after creation
--   * messages.created_at from clock_timestamp()
--
-- ---------------------------------------------------------------------------
-- Error codes raised by the room/invite functions (class HX, custom) and their HTTP mapping.
-- This list supersedes the one in 20260924233656_core_schema.sql.
-- ---------------------------------------------------------------------------
--   HX001  room_not_found                    404  room missing or soft-deleted, or the actor
--                                                  has no membership row in it
--   HX002  not_owner / insufficient_role     403  the actor is a member but lacks the role
--   HX003  target_not_member                 404  the target profile is not a member of the room
--   HX004  same_user                         422  the actor targets themself where that's not
--                                                  allowed (transfer to self, change own role)
--   HX005  owner_cannot_leave_or_be_removed  409  the owner row can't be deleted while the room
--                                                  is live; transfer ownership or delete the room
--                                                  (Node picks the HTTP status; 409 suggested)
--   22023  invalid_parameter_value           422  a required argument is null, or an invalid role
-- Constraint failures keep their standard codes: 23514 check_violation, 23502 not_null_violation,
-- 23503 foreign_key_violation (e.g. unknown profile), 23505 unique_violation.
--
-- ---------------------------------------------------------------------------
-- Lock order (every function that locks more than one row follows it, so they can't deadlock):
--   1. public.rooms row          (FOR UPDATE for room mutations; FOR SHARE for invite redemption)
--   2. public.invites row        (FOR UPDATE)
--   3. public.room_members rows  (FOR UPDATE, ordered by user_id)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. rooms.updated_at trigger
-- ---------------------------------------------------------------------------
create function public.rooms_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

comment on function public.rooms_set_updated_at() is 'Trigger: sets rooms.updated_at on every update.';

revoke execute on function public.rooms_set_updated_at() from public, anon, authenticated;

create trigger rooms_set_updated_at
before update on public.rooms
for each row execute function public.rooms_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Owner-row guard on room_members
-- ---------------------------------------------------------------------------
-- A live room always has exactly one owner. Deleting the owner's membership row (directly,
-- or via the profiles on delete cascade) raises HX005 while the room is live. It is allowed
-- when the room is soft-deleted or is itself being deleted (the rooms on delete cascade runs
-- after the room row is gone, so the lookup below finds nothing).
-- Consequence: deleting the profile of a room owner fails until Node transfers ownership or
-- deletes the room.
create function public.room_members_protect_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner' and exists (
    select 1 from public.rooms r where r.id = old.room_id and r.deleted_at is null
  ) then
    raise exception 'the room owner cannot leave or be removed; transfer ownership or delete the room'
      using errcode = 'HX005';
  end if;
  return old;
end;
$$;

comment on function public.room_members_protect_owner() is
  'Trigger: blocks deleting the owner membership row of a live room (HX005).';

revoke execute on function public.room_members_protect_owner() from public, anon, authenticated;

create trigger room_members_protect_owner
before delete on public.room_members
for each row execute function public.room_members_protect_owner();

-- ---------------------------------------------------------------------------
-- 3. transfer_ownership: HX001 for non-members
-- ---------------------------------------------------------------------------
-- Failures (checked in this order):
--   22023 null argument
--   HX004 same_user          p_from = p_to
--   HX001 room_not_found     room missing or soft-deleted, or p_from is not a member
--   HX002 not_owner          p_from is a member but not the owner
--   HX003 target_not_member  p_to is not a member of the room
create or replace function public.transfer_ownership(p_room uuid, p_from uuid, p_to uuid)
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

  perform 1 from public.room_members m
  where m.room_id = p_room and m.user_id in (p_from, p_to)
  order by m.user_id
  for update;

  select m.role into v_from_role
  from public.room_members m
  where m.room_id = p_room and m.user_id = p_from;

  if v_from_role is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if v_from_role <> 'owner' then
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

revoke execute on function public.transfer_ownership(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.transfer_ownership(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. delete_room: HX001 for non-members
-- ---------------------------------------------------------------------------
-- Locks the room row, then soft-deletes the room and its live channels and revokes its
-- pending invites. Already-deleted channels keep their deleted_at; answered invites are
-- untouched. Member rows are kept for Node's broadcasts and LiveKit removal.
-- Not idempotent: deleting an already-deleted room raises HX001.
-- Failures: 22023 null argument; HX001 room missing, already deleted, or actor not a member;
--           HX002 actor is a member but not the owner.
create or replace function public.delete_room(p_room uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  if p_room is null or p_actor is null then
    raise exception 'room and actor are required' using errcode = '22023';
  end if;

  perform 1 from public.rooms r where r.id = p_room and r.deleted_at is null for update;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select m.role into v_role
  from public.room_members m
  where m.room_id = p_room and m.user_id = p_actor;

  if v_role is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if v_role <> 'owner' then
    raise exception 'only the room owner can delete the room' using errcode = 'HX002';
  end if;

  update public.rooms r
  set deleted_at = pg_catalog.now()
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

revoke execute on function public.delete_room(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_room(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. redeem_invite_link: lock room (FOR SHARE) before the invite
-- ---------------------------------------------------------------------------
-- Replaces the earlier version, whose comment called a race with delete_room harmless. It
-- wasn't: invite-then-room locking could deadlock with delete_room (room-then-invite), and
-- without the room lock a redemption could add a member to a room mid-deletion.
-- Now: read the invite's room_id without locking, lock the room FOR SHARE (waits for, and
-- blocks, delete_room/transfer_ownership/remove_member/change_role on that room), then lock
-- the invite FOR UPDATE and re-check it. Concurrent redemptions of the same link serialize
-- on the invite lock, so the last use can't be taken twice.
-- Returns one row (room_id, status), checked in this order:
--   invalid        unknown hash or not a link invite (room_id null, so nothing leaks)
--   room_deleted   the room is soft-deleted
--   already_member caller is already a member; no use consumed
--   revoked        revoked_at is set
--   expired        expires_at <= now()
--   used_up        uses >= max_uses
--   joined         member row inserted with role 'member', uses += 1
-- Failures: 22023 null argument, 23503 unknown profile.
create or replace function public.redeem_invite_link(p_token_hash text, p_user uuid)
returns table (room_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_room    uuid;
  v_invite  public.invites%rowtype;
  v_deleted timestamptz;
  v_rows    integer;
begin
  if p_token_hash is null or p_user is null then
    raise exception 'token_hash and user are required' using errcode = '22023';
  end if;

  select i.room_id into v_room from public.invites i where i.token_hash = p_token_hash;
  if not found then
    return query select null::uuid, 'invalid'::text;
    return;
  end if;

  select r.deleted_at into v_deleted from public.rooms r where r.id = v_room for share;

  select i.* into v_invite
  from public.invites i
  where i.token_hash = p_token_hash
  for update;

  if not found or v_invite.room_id <> v_room or v_invite.kind <> 'link' then
    return query select null::uuid, 'invalid'::text;
    return;
  end if;

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
  'Redeems a link invite by token hash (locks room FOR SHARE, then invite FOR UPDATE). Returns (room_id, status). service_role only.';

revoke execute on function public.redeem_invite_link(text, uuid) from public, anon, authenticated;
grant execute on function public.redeem_invite_link(text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. respond_to_direct_invite: lock room (FOR SHARE) before the invite
-- ---------------------------------------------------------------------------
-- Same locking as redeem_invite_link. Returns one row (room_id, status), checked in order:
--   invalid           unknown id, not a direct invite, unknown profile, or addressed to another
--                     Steam account (room_id null; existence doesn't leak)
--   room_deleted      the room is soft-deleted
--   already_responded accepted_at or declined_at is already set
--   revoked           revoked_at is set
--   expired           expires_at <= now()
--   accepted          (p_accept) member row inserted, accepted_at = now(), uses = 1
--   already_member    (p_accept) caller was already a member; invite still marked accepted, uses = 1
--   declined          (not p_accept) declined_at = now()
-- Failures: 22023 null argument.
create or replace function public.respond_to_direct_invite(p_invite uuid, p_user uuid, p_accept boolean)
returns table (room_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_room     uuid;
  v_invite   public.invites%rowtype;
  v_steam_id text;
  v_deleted  timestamptz;
  v_rows     integer;
begin
  if p_invite is null or p_user is null or p_accept is null then
    raise exception 'invite, user, and accept are required' using errcode = '22023';
  end if;

  select p.steam_id into v_steam_id from public.profiles p where p.id = p_user;

  select i.room_id into v_room from public.invites i where i.id = p_invite;
  if not found or v_steam_id is null then
    return query select null::uuid, 'invalid'::text;
    return;
  end if;

  select r.deleted_at into v_deleted from public.rooms r where r.id = v_room for share;

  select i.* into v_invite
  from public.invites i
  where i.id = p_invite
  for update;

  if not found
     or v_invite.room_id <> v_room
     or v_invite.kind <> 'direct'
     or v_invite.invitee_steam_id is distinct from v_steam_id then
    return query select null::uuid, 'invalid'::text;
    return;
  end if;

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
  'Accepts or declines a direct invite addressed to the caller''s Steam account (locks room FOR SHARE, then invite FOR UPDATE). Returns (room_id, status). service_role only.';

revoke execute on function public.respond_to_direct_invite(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.respond_to_direct_invite(uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 7. remove_member
-- ---------------------------------------------------------------------------
-- Removes p_target from the room (kick, or leave when p_actor = p_target). Locks the room row.
-- Rules: owner may remove anyone except themself; admin may remove members only; a member may
-- remove only themself; nobody removes the owner. Node then broadcasts member:left /
-- member:removed and removes the user from LiveKit (rule 9).
-- Failures (checked in this order):
--   22023 null argument
--   HX001 room missing or soft-deleted, or p_actor is not a member
--   HX003 p_target is not a member
--   HX005 p_target is the owner (including the owner trying to leave)
--   HX002 p_actor's role doesn't allow removing p_target
create function public.remove_member(p_room uuid, p_actor uuid, p_target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role  text;
  v_target_role text;
begin
  if p_room is null or p_actor is null or p_target is null then
    raise exception 'room, actor, and target are required' using errcode = '22023';
  end if;

  perform 1 from public.rooms r where r.id = p_room and r.deleted_at is null for update;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.room_members m
  where m.room_id = p_room and m.user_id in (p_actor, p_target)
  order by m.user_id
  for update;

  select m.role into v_actor_role from public.room_members m
  where m.room_id = p_room and m.user_id = p_actor;
  if v_actor_role is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select m.role into v_target_role from public.room_members m
  where m.room_id = p_room and m.user_id = p_target;
  if v_target_role is null then
    raise exception 'target is not a member of the room' using errcode = 'HX003';
  end if;

  if v_target_role = 'owner' then
    raise exception 'the room owner cannot leave or be removed; transfer ownership or delete the room'
      using errcode = 'HX005';
  end if;

  if p_actor <> p_target
     and not (v_actor_role = 'owner' or (v_actor_role = 'admin' and v_target_role = 'member')) then
    raise exception 'insufficient role to remove this member' using errcode = 'HX002';
  end if;

  delete from public.room_members m where m.room_id = p_room and m.user_id = p_target;
end;
$$;

comment on function public.remove_member(uuid, uuid, uuid) is
  'Removes a member (or lets a non-owner leave) under the room lock, enforcing role rules. service_role only.';

revoke execute on function public.remove_member(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_member(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. change_role
-- ---------------------------------------------------------------------------
-- Owner-only: sets p_target's role to admin or member. Ownership moves only via
-- transfer_ownership. Locks the room row.
-- Failures (checked in this order):
--   22023 null argument, or p_role not in ('admin', 'member')
--   HX001 room missing or soft-deleted, or p_actor is not a member
--   HX002 p_actor is not the owner
--   HX004 p_actor = p_target (the owner can't change their own role)
--   HX003 p_target is not a member
create function public.change_role(p_room uuid, p_actor uuid, p_target uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
begin
  if p_room is null or p_actor is null or p_target is null or p_role is null then
    raise exception 'room, actor, target, and role are required' using errcode = '22023';
  end if;

  if p_role not in ('admin', 'member') then
    raise exception 'role must be admin or member' using errcode = '22023';
  end if;

  perform 1 from public.rooms r where r.id = p_room and r.deleted_at is null for update;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.room_members m
  where m.room_id = p_room and m.user_id in (p_actor, p_target)
  order by m.user_id
  for update;

  select m.role into v_actor_role from public.room_members m
  where m.room_id = p_room and m.user_id = p_actor;
  if v_actor_role is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if v_actor_role <> 'owner' then
    raise exception 'only the room owner can change roles' using errcode = 'HX002';
  end if;

  if p_actor = p_target then
    raise exception 'cannot change your own role' using errcode = 'HX004';
  end if;

  update public.room_members m set role = p_role
  where m.room_id = p_room and m.user_id = p_target;
  if not found then
    raise exception 'target is not a member of the room' using errcode = 'HX003';
  end if;
end;
$$;

comment on function public.change_role(uuid, uuid, uuid, text) is
  'Owner-only role change between admin and member, under the room lock. service_role only.';

revoke execute on function public.change_role(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.change_role(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Stricter SteamID64 checks
-- ---------------------------------------------------------------------------
-- Individual-account SteamID64s start with 7656119. Added NOT VALID (no long lock), then
-- validated (SHARE UPDATE EXCLUSIVE; doesn't block reads or writes).
alter table public.profiles
  add constraint profiles_steam_id_format check (steam_id ~ '^7656119[0-9]{10}$') not valid;
alter table public.profiles validate constraint profiles_steam_id_format;
alter table public.profiles drop constraint profiles_steam_id_check;

alter table public.invites
  add constraint invites_invitee_steam_id_steam64
  check (invitee_steam_id is null or invitee_steam_id ~ '^7656119[0-9]{10}$') not valid;
alter table public.invites validate constraint invites_invitee_steam_id_steam64;
alter table public.invites drop constraint invites_invitee_steam_id_format;

-- ---------------------------------------------------------------------------
-- 10. invites: expiry must be after creation
-- ---------------------------------------------------------------------------
alter table public.invites
  add constraint invites_expires_after_created check (expires_at is null or expires_at > created_at) not valid;
alter table public.invites validate constraint invites_expires_after_created;

-- ---------------------------------------------------------------------------
-- 11. messages.created_at from clock_timestamp()
-- ---------------------------------------------------------------------------
-- now() is the transaction start time; clock_timestamp() orders messages by actual insert
-- time. Metadata-only change.
-- The GET /api/channels/:id/messages?after=<id> backfill is best-effort: rows committed
-- slightly out of created_at order can be missed, so the service should overlap the window
-- by a few seconds and clients dedupe by message id.
alter table public.messages alter column created_at set default clock_timestamp();

comment on table public.messages is
  'Text channel messages (only in channels of type text; the service enforces this). Soft-deleted via deleted_at; author_id is nulled if the profile is deleted. created_at = clock_timestamp(). Server-only (service role).';

-- ---------------------------------------------------------------------------
-- 12. private.can_access_topic: lowercase uuids only
-- ---------------------------------------------------------------------------
-- Topic and sub uuids must be canonical lowercase (what Postgres and Node produce), so a
-- topic has exactly one spelling.
create or replace function private.can_access_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims  jsonb := (select auth.jwt());
  v_uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
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

revoke execute on function private.can_access_topic(text) from public, anon;
grant execute on function private.can_access_topic(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 13. room-icons bucket settings
-- ---------------------------------------------------------------------------
-- The first migration's insert was `on conflict do nothing`, so a pre-existing bucket could
-- have other settings. Enforce them.
update storage.buckets
set public = false,
    file_size_limit = 262144,
    allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
where id = 'room-icons';
