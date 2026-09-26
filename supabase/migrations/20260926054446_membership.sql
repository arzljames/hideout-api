-- Membership: a new public.room_bans table (prepared for a future bans feature), a new
-- version of create_link_invite() that only the owner or an admin may call, and a new
-- version of remove_member() that also revokes pending direct invites addressed to the
-- removed member and returns the direct invites it revoked.
--
-- room_bans: nothing reads or writes it yet. Enforcement (redeem_invite_link,
-- respond_to_direct_invite, and create_direct_invite refusing banned SteamIDs) and the
-- ban/unban API come with the bans feature. Bans are keyed by SteamID64, not profile id, so a
-- ban also covers a Steam account that hasn't signed in yet and survives a profile delete.
-- Creating an empty table takes no lock on existing tables beyond the FK's brief
-- SHARE ROW EXCLUSIVE on public.rooms and public.profiles (no rows to validate).
--
-- Why create_link_invite changes: a link is a bearer credential that works for anyone who
-- holds it until it expires, runs out, or is revoked, so creating one is now an owner/admin
-- action. Plain members can still invite a specific Steam account with create_direct_invite
-- (unchanged). Links that plain members created before this migration keep working; their
-- creators can still revoke them (revoke_invite is unchanged), and remove_member still
-- revokes them when the creator leaves or is removed.
-- Same signature, return type, argument checks, lock order, and other error codes as the
-- version in 20260926045852_invites.sql; the only new rule is the role check after the
-- membership check. The room row is held FOR SHARE, and change_role / transfer_ownership
-- lock it FOR UPDATE, so the role read here can't race a concurrent demotion.
--
-- Why remove_member is replaced (security fix): the version in 20260926045852_invites.sql
-- revokes the invites the target CREATED, but not pending direct invites ADDRESSED to the
-- target. Such an invite can exist (e.g. it was sent before the person joined through a
-- link, or via the accepted create_direct_invite / redeem race), and after a kick the removed
-- member could accept it with respond_to_direct_invite and rejoin. The new version also
-- revokes every pending direct invite in the room whose invitee_steam_id is the target's
-- SteamID (served by invites_pending_direct_uidx, whose predicate matches exactly).
-- It now RETURNS TABLE (invite_id uuid, invitee_profile_id uuid): one row per DIRECT invite
-- this call revoked (created by the target, or addressed to the target), so Node can
-- broadcast invite:revoked to each invitee who has a profile (invitee_profile_id is null for
-- a SteamID that hasn't signed in). Link invites revoked by the sweep are not returned
-- (nobody's inbox shows them). Because the return type changes (void -> table), the function
-- is dropped and re-created in this migration's transaction (no table locks; a concurrent
-- call waits on the catalog lock for the instant of the swap). Callers via PostgREST now get
-- an array (possibly empty) instead of null.
-- Same signature, checks, error codes (22023, HX001, HX003, HX005, HX002, in that order),
-- and lock order as before: room FOR UPDATE, then the actor/target member rows FOR UPDATE
-- (ordered by user_id), then the delete, then the invite updates (created-by sweep first,
-- then addressed-to). Every other invite writer takes the room lock first, so no deadlock.
--
-- ---------------------------------------------------------------------------
-- Error codes raised by create_link_invite and their HTTP mapping
-- (same meanings as the list in 20260925010655_core_schema_fixes.sql):
-- ---------------------------------------------------------------------------
--   HX001  room_not_found           404  room missing or soft-deleted, or the actor has no
--                                        membership row in the room (never leak existence)
--   HX002  insufficient_role        403  NEW: the actor is a plain member (role 'member');
--                                        only the owner or an admin may create link invites
--   22023  invalid_parameter_value  422  a required argument is null, or p_expires_at is not
--                                        in the future
--   23514  check_violation          422  invites_token_hash_format (not 64 lowercase hex),
--                                        invites_max_uses_positive (max_uses < 1)
--   23505  unique_violation         500  token_hash collides with an existing invite
--                                        (practically impossible with 32 random bytes; Node
--                                        may retry once with a new token)
-- room_bans raises only standard constraint codes when written directly by Node:
--   23514 room_bans_steam_id_steam64 / room_bans_reason_length, 23505 duplicate
--   (room_id, steam_id), 23503 unknown room or banned_by profile.
-- remove_member raises exactly what it raised before (22023 422, HX001 404, HX003 404,
-- HX005 409, HX002 403, as mapped in 20260925010655_core_schema_fixes.sql), in the same order.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. room_bans
-- ---------------------------------------------------------------------------
create table public.room_bans (
  room_id    uuid        not null references public.rooms (id) on delete cascade,
  steam_id   text        not null
    constraint room_bans_steam_id_steam64 check (steam_id ~ '^7656119[0-9]{10}$'),
  banned_by  uuid        references public.profiles (id) on delete set null,
  reason     text
    constraint room_bans_reason_length check (reason is null or char_length(reason) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint room_bans_pkey primary key (room_id, steam_id)
);

comment on table public.room_bans is 'Steam accounts banned from a room (keyed by SteamID64, so it covers accounts without a profile). Prepared for the bans feature; not enforced yet. Server-only (service role).';

-- banned_by FK (on delete set null). The PK covers room_id-first lookups and the room_id FK.
create index room_bans_banned_by_idx on public.room_bans (banned_by);

-- RLS on, no policies: anon/authenticated can't read or write even if a grant slipped in.
-- Not added to the supabase_realtime publication (we use Broadcast).
alter table public.room_bans enable row level security;

revoke all on table public.room_bans from anon, authenticated, public;
grant select, insert, update, delete on table public.room_bans to service_role;

-- ---------------------------------------------------------------------------
-- 2. create_link_invite (replaces the version in 20260926045852_invites.sql)
-- ---------------------------------------------------------------------------
-- The owner or an admin may create a shareable link; a plain member gets HX002. Node
-- generates the raw token (32 random bytes, base64url) and passes only its lowercase hex
-- SHA-256.
-- p_max_uses and p_expires_at may be null (unlimited / never expires); the API restricts the
-- allowed values in Zod.
-- Return shape: RETURNS TABLE, always exactly one row: the inserted public.invites columns in
-- table order, EXCEPT token_hash (kind 'link', created_by = p_actor, uses 0). PostgREST
-- returns a one-element array; the service takes that element.
-- Failures (checked in this order): 22023 null room, actor, or token hash; 22023 p_expires_at
-- not in the future; HX001 room missing or soft-deleted, or actor not a member; HX002 actor is
-- a plain member; 23514 bad token hash or max_uses < 1; 23505 token hash collision.
create or replace function public.create_link_invite(
  p_room uuid,
  p_actor uuid,
  p_token_hash text,
  p_max_uses integer,
  p_expires_at timestamptz
)
returns table (
  id               uuid,
  room_id          uuid,
  created_by       uuid,
  kind             text,
  invitee_steam_id text,
  max_uses         integer,
  uses             integer,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  accepted_at      timestamptz,
  declined_at      timestamptz,
  created_at       timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_role   text;
  v_invite public.invites;
begin
  if p_room is null or p_actor is null or p_token_hash is null then
    raise exception 'room, actor, and token_hash are required' using errcode = '22023';
  end if;

  if p_expires_at is not null and p_expires_at <= pg_catalog.now() then
    raise exception 'expires_at must be in the future' using errcode = '22023';
  end if;

  perform 1 from public.rooms r where r.id = p_room and r.deleted_at is null for share;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select m.role into v_role
  from public.room_members m
  where m.room_id = p_room and m.user_id = p_actor;
  if v_role is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'insufficient role to create link invites' using errcode = 'HX002';
  end if;

  insert into public.invites as i (room_id, created_by, kind, token_hash, max_uses, expires_at)
  values (p_room, p_actor, 'link', p_token_hash, p_max_uses, p_expires_at)
  returning i.* into v_invite;

  return query select v_invite.id, v_invite.room_id, v_invite.created_by, v_invite.kind,
                      v_invite.invitee_steam_id, v_invite.max_uses, v_invite.uses,
                      v_invite.expires_at, v_invite.revoked_at, v_invite.accepted_at,
                      v_invite.declined_at, v_invite.created_at;
end;
$$;

comment on function public.create_link_invite(uuid, uuid, text, integer, timestamptz) is
  'Owner or admin creates a link invite (token hash only; optional max_uses and expires_at). Returns exactly one row: the public.invites columns except token_hash. Errors: 22023, HX001, HX002, 23514, 23505. Service role only.';

revoke execute on function public.create_link_invite(uuid, uuid, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_link_invite(uuid, uuid, text, integer, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. remove_member (replaces the version in 20260926045852_invites.sql)
-- ---------------------------------------------------------------------------
-- Removes p_target from the room (kick, or leave when p_actor = p_target). Locks the room row.
-- Rules: owner may remove anyone except themself; admin may remove members only; a member may
-- remove only themself; nobody removes the owner.
-- After the membership row is deleted (room still locked FOR UPDATE):
--   1. every pending invite the target created in this room (link or direct; not revoked,
--      accepted, or declined) is revoked (unchanged);
--   2. NEW: every pending direct invite in this room addressed to the target's SteamID is
--      revoked, so a removed member can't rejoin by accepting an older direct invite.
-- Answered invites, other members' invites, and invites in other rooms are untouched.
-- Return shape: RETURNS TABLE (invite_id, invitee_profile_id), one row per DIRECT invite this
-- call revoked (from step 1 or 2; each invite at most once, since step 2 runs after step 1
-- and only matches invites that are still pending). invitee_profile_id is the profiles.id
-- for invitee_steam_id, or null if that SteamID has no profile. Link invites are not
-- returned. Zero rows when nothing was revoked. Row order is unspecified.
-- Node then broadcasts member:left / member:removed and invite:revoked for each returned row,
-- and removes the user from LiveKit (rule 9).
-- Failures (checked in this order):
--   22023 null argument
--   HX001 room missing or soft-deleted, or p_actor is not a member
--   HX003 p_target is not a member
--   HX005 p_target is the owner (including the owner trying to leave)
--   HX002 p_actor's role doesn't allow removing p_target
drop function public.remove_member(uuid, uuid, uuid);

create function public.remove_member(p_room uuid, p_actor uuid, p_target uuid)
returns table (invite_id uuid, invitee_profile_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
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

  -- 1. The target's pending invites in this room stop working (room still locked FOR UPDATE).
  --    Return the direct ones.
  return query
  with swept as (
    update public.invites i
    set revoked_at = pg_catalog.now()
    where i.room_id = p_room
      and i.created_by = p_target
      and i.revoked_at is null
      and i.accepted_at is null
      and i.declined_at is null
    returning i.id, i.kind, i.invitee_steam_id
  )
  select s.id, p.id
  from swept s
  left join public.profiles p on p.steam_id = s.invitee_steam_id
  where s.kind = 'direct';

  -- 2. Pending direct invites addressed to the target in this room stop working too. A new
  --    statement, so it doesn't see (and can't re-revoke) invites step 1 already revoked.
  --    The invitee is the target, so invitee_profile_id is p_target (steam_id is unique).
  return query
  with addressed as (
    update public.invites i
    set revoked_at = pg_catalog.now()
    where i.room_id = p_room
      and i.kind = 'direct'
      and i.invitee_steam_id = (select p.steam_id from public.profiles p where p.id = p_target)
      and i.revoked_at is null
      and i.accepted_at is null
      and i.declined_at is null
    returning i.id
  )
  select a.id, p_target
  from addressed a;
end;
$$;

comment on function public.remove_member(uuid, uuid, uuid) is
  'Removes a member (or lets a non-owner leave) under the room lock, enforcing role rules; revokes the target''s pending invites in the room and pending direct invites addressed to the target. Returns (invite_id, invitee_profile_id) for each direct invite revoked. Errors: 22023, HX001, HX003, HX005, HX002. service_role only.';

revoke execute on function public.remove_member(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_member(uuid, uuid, uuid) to service_role;
