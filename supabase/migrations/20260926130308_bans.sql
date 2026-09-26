-- Bans: ban_member() and unban() write public.room_bans (created, unenforced, in
-- 20260926054446_membership.sql), and the three ways into a room now refuse a banned
-- SteamID: redeem_invite_link() and respond_to_direct_invite() return the new status
-- 'banned', and create_direct_invite() raises HX013. delete_room() now returns the direct
-- invites it revoked so Node can broadcast invite:revoked to each invitee.
--
-- Bans are keyed by SteamID64 (room_bans PK (room_id, steam_id)), so a ban survives the
-- banned person's profile being deleted and re-created. Every ban lookup below is a PK
-- lookup on room_bans. No table changes; only the room_bans table comment is updated.
--
-- Replaced functions (same signatures; the first three keep their return types, so
-- CREATE OR REPLACE; delete_room's return type changes void -> table, so it is dropped and
-- re-created in this migration's transaction: no table locks, a concurrent call waits on the
-- catalog lock for the instant of the swap). Callers of delete_room via PostgREST now get an
-- array (possibly empty) instead of null.
--   redeem_invite_link        20260925010655_core_schema_fixes.sql  + 'banned'
--   respond_to_direct_invite  20260925010655_core_schema_fixes.sql  + 'banned' (accept only)
--   create_direct_invite      20260926045852_invites.sql            + HX013
--   delete_room               20260925010655_core_schema_fixes.sql  returns revoked direct invites
--
-- ---------------------------------------------------------------------------
-- Error codes raised by the new and replaced functions and their HTTP mapping
-- (same meanings as the lists in 20260925010655_core_schema_fixes.sql and
-- 20260926045852_invites.sql, plus HX013):
-- ---------------------------------------------------------------------------
--   HX001  room_not_found           404  room missing or soft-deleted, or the actor has no
--                                        membership row in the room (never leak existence)
--   HX002  insufficient_role        403  ban_member: the actor's role doesn't allow banning
--                                        the target (admin -> admin, member -> anyone);
--                                        unban: the actor is a plain member;
--                                        delete_room: the actor is not the owner
--   HX003  target_not_member        404  ban_member: the target is not a member of the room;
--          not_banned                    unban: the SteamID is not banned from the room
--   HX004  same_user                422  ban_member: the actor tries to ban themself
--   HX005  owner_cannot_be_removed  409  ban_member: the target is the owner
--   HX011  already_member           409  create_direct_invite (unchanged)
--   HX012  invite_already_pending   409  create_direct_invite (unchanged)
--   HX013  user_banned              409  NEW: USER_BANNED. create_direct_invite for a Steam
--                                        account that is banned from the room
--   22023  invalid_parameter_value  422  a required argument is null (p_reason may be null),
--                                        or p_expires_at is not in the future
--   23514  check_violation          422  ban_member: room_bans_reason_length (reason empty or
--                                        over 200 characters); create_direct_invite:
--                                        invites_invitee_steam_id_steam64 (unchanged)
-- New status (not an error) from redeem_invite_link and respond_to_direct_invite:
--   'banned'  -> Node maps it to 403 BANNED. Nothing is written (no use consumed, no member
--                row, the direct invite stays pending).
--
-- ---------------------------------------------------------------------------
-- Lock order (the order documented in 20260925010655_core_schema_fixes.sql, unchanged):
--   1. public.rooms row          (FOR UPDATE in ban_member, unban, delete_room;
--                                 FOR SHARE in redeem, respond, create_direct_invite)
--   2. public.invites row        (FOR UPDATE)
--   3. public.room_members rows  (FOR UPDATE, ordered by user_id)
-- ban_member follows remove_member exactly: room FOR UPDATE, then the actor/target member
-- rows FOR UPDATE (ordered by user_id), then the room_bans upsert, the membership delete,
-- and the invite updates (created-by sweep first, then addressed-to). unban locks the room
-- FOR UPDATE, then deletes the ban row. Every room_bans writer (ban_member, unban) and every
-- ban reader that admits someone (redeem, respond, create_direct_invite) holds the room row
-- lock first, so a ban and a join/invite in the same room serialize on it: a ban committed
-- first is seen by the ban check (a new statement under READ COMMITTED, run after the room
-- lock is granted), and a join or invite committed first is swept by ban_member (it
-- deletes the membership row and revokes the pending direct invite).
-- ---------------------------------------------------------------------------

comment on table public.room_bans is
  'Steam accounts banned from a room (keyed by SteamID64, so it covers accounts without a profile). Written by ban_member/unban; enforced by redeem_invite_link, respond_to_direct_invite, and create_direct_invite. Server-only (service role).';

-- ---------------------------------------------------------------------------
-- 1. ban_member
-- ---------------------------------------------------------------------------
-- Bans p_target (a current member) from the room: records the ban by the target's SteamID,
-- removes the membership, and revokes invites exactly like remove_member. Locks the room row.
-- Rules (same as remove_member, minus leaving): the owner may ban anyone except themself; an
-- admin may ban members only; a plain member may ban nobody; nobody bans the owner.
-- p_reason is optional (null = no reason); room_bans_reason_length enforces 1-200 chars.
-- Existing ban for the same (room, SteamID) (only possible if a ban row was written outside
-- this function while the target was a member): ON CONFLICT DO UPDATE overwrites banned_by
-- and reason with this call's values and keeps the original created_at, so the call still
-- succeeds and the latest actor and reason are recorded.
-- After the membership row is deleted (room still locked FOR UPDATE):
--   1. every pending invite the target created in this room (link or direct) is revoked;
--   2. every pending direct invite in this room addressed to the target's SteamID is revoked.
-- Return shape: identical to remove_member: RETURNS TABLE (invite_id, invitee_profile_id),
-- one row per DIRECT invite this call revoked (from step 1 or 2; each at most once, since
-- step 2 is a separate statement that only matches invites still pending).
-- invitee_profile_id is the profile id for invitee_steam_id, or null if that SteamID has no
-- profile. Link invites are not returned. Zero rows when nothing was revoked; row order is
-- unspecified.
-- Node then broadcasts member:removed (user:<target>) / member:left (room:<id>) and
-- invite:revoked for each returned row, and removes the user from LiveKit (rule 9).
-- Failures (checked in this order):
--   22023 null room, actor, or target (p_reason may be null)
--   HX004 p_actor = p_target (can't ban yourself)
--   HX001 room missing or soft-deleted, or p_actor is not a member
--   HX003 p_target is not a member
--   HX005 p_target is the owner
--   HX002 p_actor's role doesn't allow banning p_target
--   23514 reason empty or longer than 200 characters
create function public.ban_member(p_room uuid, p_actor uuid, p_target uuid, p_reason text)
returns table (invite_id uuid, invitee_profile_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor_role    text;
  v_target_role   text;
  v_target_steam  text;
begin
  if p_room is null or p_actor is null or p_target is null then
    raise exception 'room, actor, and target are required' using errcode = '22023';
  end if;

  if p_actor = p_target then
    raise exception 'cannot ban yourself' using errcode = 'HX004';
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
    raise exception 'the room owner cannot be banned' using errcode = 'HX005';
  end if;

  if not (v_actor_role = 'owner' or (v_actor_role = 'admin' and v_target_role = 'member')) then
    raise exception 'insufficient role to ban this member' using errcode = 'HX002';
  end if;

  -- The target is a member, so their profile exists (room_members.user_id FK).
  select p.steam_id into v_target_steam from public.profiles p where p.id = p_target;

  insert into public.room_bans as b (room_id, steam_id, banned_by, reason)
  values (p_room, v_target_steam, p_actor, p_reason)
  on conflict on constraint room_bans_pkey
  do update set banned_by = excluded.banned_by, reason = excluded.reason;

  delete from public.room_members m where m.room_id = p_room and m.user_id = p_target;

  -- 1. The target's pending invites in this room stop working. Return the direct ones.
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
  --    The invitee is the target, so invitee_profile_id is p_target.
  return query
  with addressed as (
    update public.invites i
    set revoked_at = pg_catalog.now()
    where i.room_id = p_room
      and i.kind = 'direct'
      and i.invitee_steam_id = v_target_steam
      and i.revoked_at is null
      and i.accepted_at is null
      and i.declined_at is null
    returning i.id
  )
  select a.id, p_target
  from addressed a;
end;
$$;

comment on function public.ban_member(uuid, uuid, uuid, text) is
  'Bans a member by SteamID under the room lock (role rules as remove_member; no self-ban), removes the membership, revokes the target''s pending invites and pending direct invites addressed to the target. Returns (invite_id, invitee_profile_id) for each direct invite revoked. Errors: 22023, HX004, HX001, HX003, HX005, HX002, 23514. service_role only.';

revoke execute on function public.ban_member(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ban_member(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. unban
-- ---------------------------------------------------------------------------
-- The owner or an admin lifts the ban on a SteamID. It does not re-add the member or
-- restore any invite; the person needs a new invite to rejoin. Locks the room row.
-- Failures (checked in this order):
--   22023 null argument
--   HX001 room missing or soft-deleted, or p_actor is not a member
--   HX002 p_actor is a plain member
--   HX003 the SteamID is not banned from this room (Node: 404)
create function public.unban(p_room uuid, p_actor uuid, p_steam_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  if p_room is null or p_actor is null or p_steam_id is null then
    raise exception 'room, actor, and steam_id are required' using errcode = '22023';
  end if;

  perform 1 from public.rooms r where r.id = p_room and r.deleted_at is null for update;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select m.role into v_role from public.room_members m
  where m.room_id = p_room and m.user_id = p_actor;
  if v_role is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'insufficient role to unban' using errcode = 'HX002';
  end if;

  delete from public.room_bans b where b.room_id = p_room and b.steam_id = p_steam_id;
  if not found then
    raise exception 'this player is not banned from the room' using errcode = 'HX003';
  end if;
end;
$$;

comment on function public.unban(uuid, uuid, text) is
  'Owner or admin lifts a room ban on a SteamID under the room lock. Errors: 22023, HX001, HX002, HX003 (not banned). service_role only.';

revoke execute on function public.unban(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.unban(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. redeem_invite_link (replaces the version in 20260925010655_core_schema_fixes.sql)
-- ---------------------------------------------------------------------------
-- Same signature, return type, locking (invite's room_id read unlocked, room FOR SHARE, then
-- invite FOR UPDATE and re-check) and statuses as before, plus 'banned'.
-- Returns one row (room_id, status), checked in this order:
--   invalid        unknown hash or not a link invite (room_id null, so nothing leaks)
--   room_deleted   the room is soft-deleted
--   banned         NEW: the caller's SteamID is banned from the room; no use consumed, no
--                  member row
--   already_member caller is already a member; no use consumed
--   revoked        revoked_at is set
--   expired        expires_at <= now()
--   used_up        uses >= max_uses
--   joined         member row inserted with role 'member', uses += 1
-- Failures: 22023 null argument, 23503 unknown profile (an unknown profile has no SteamID,
-- so it skips the ban check and fails at the insert as before).
create or replace function public.redeem_invite_link(p_token_hash text, p_user uuid)
returns table (room_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_room     uuid;
  v_invite   public.invites%rowtype;
  v_deleted  timestamptz;
  v_steam_id text;
  v_rows     integer;
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

  select p.steam_id into v_steam_id from public.profiles p where p.id = p_user;

  if v_steam_id is not null and exists (
    select 1 from public.room_bans b
    where b.room_id = v_invite.room_id and b.steam_id = v_steam_id
  ) then
    return query select v_invite.room_id, 'banned'::text;
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
  'Redeems a link invite by token hash (locks room FOR SHARE, then invite FOR UPDATE). Returns (room_id, status); status is invalid, room_deleted, banned, already_member, revoked, expired, used_up, or joined. service_role only.';

revoke execute on function public.redeem_invite_link(text, uuid) from public, anon, authenticated;
grant execute on function public.redeem_invite_link(text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. respond_to_direct_invite (replaces the version in 20260925010655_core_schema_fixes.sql)
-- ---------------------------------------------------------------------------
-- Same signature, return type, locking, and statuses as before, plus 'banned'.
-- Returns one row (room_id, status), checked in this order:
--   invalid           unknown id, not a direct invite, unknown profile, or addressed to another
--                     Steam account (room_id null; existence doesn't leak)
--   room_deleted      the room is soft-deleted
--   already_responded accepted_at or declined_at is already set
--   banned            NEW: (p_accept only) the caller's SteamID is banned from the room;
--                     nothing is written (the invite stays as it was)
--   revoked           revoked_at is set
--   expired           expires_at <= now()
--   accepted          (p_accept) member row inserted, accepted_at = now(), uses = 1
--   already_member    (p_accept) caller was already a member; invite still marked accepted, uses = 1
--   declined          (not p_accept) declined_at = now()
-- Why 'banned' sits after already_responded and before revoked/expired: an answered invite is
-- terminal, so that status wins; otherwise the ban is the real reason the caller can't join,
-- and ban_member revokes the target's pending direct invites, so checking revoked first would
-- hide the ban behind 'revoked' in the usual case. Same position relative to the invite's own
-- validity as in redeem_invite_link. Declining is unaffected by a ban: a banned user can still
-- decline a pending invite (it records declined_at and admits nobody).
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

  if p_accept and exists (
    select 1 from public.room_bans b
    where b.room_id = v_invite.room_id and b.steam_id = v_steam_id
  ) then
    return query select v_invite.room_id, 'banned'::text;
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
  'Accepts or declines a direct invite addressed to the caller''s Steam account (locks room FOR SHARE, then invite FOR UPDATE). Returns (room_id, status); status is invalid, room_deleted, already_responded, banned (accept only), revoked, expired, accepted, already_member, or declined. service_role only.';

revoke execute on function public.respond_to_direct_invite(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.respond_to_direct_invite(uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. create_direct_invite (replaces the version in 20260926045852_invites.sql)
-- ---------------------------------------------------------------------------
-- Same signature, return shape, locking, and behaviour as before, plus: a Steam account
-- banned from the room can't be invited (HX013). Plain members may still create direct
-- invites (unchanged).
-- Failures (checked in this order): 22023 null room, actor, or Steam ID; 22023 p_expires_at
-- not in the future; HX001 room missing or soft-deleted, or actor not a member; HX013 the
-- Steam account is banned from the room; HX011 the Steam account's profile is already a
-- member; HX012 an unexpired invite is pending; 23514 malformed Steam ID.
create or replace function public.create_direct_invite(
  p_room uuid,
  p_actor uuid,
  p_steam_id text,
  p_expires_at timestamptz
)
returns table (
  id                 uuid,
  room_id            uuid,
  created_by         uuid,
  kind               text,
  invitee_steam_id   text,
  max_uses           integer,
  uses               integer,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  accepted_at        timestamptz,
  declined_at        timestamptz,
  created_at         timestamptz,
  replaced_invite_id uuid,
  invitee_profile_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_profile  uuid;
  v_pending  public.invites;
  v_invite   public.invites;
  v_replaced uuid;
begin
  if p_room is null or p_actor is null or p_steam_id is null then
    raise exception 'room, actor, and steam_id are required' using errcode = '22023';
  end if;

  if p_expires_at is not null and p_expires_at <= pg_catalog.now() then
    raise exception 'expires_at must be in the future' using errcode = '22023';
  end if;

  perform 1 from public.rooms r where r.id = p_room and r.deleted_at is null for share;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.room_members m where m.room_id = p_room and m.user_id = p_actor;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.room_bans b where b.room_id = p_room and b.steam_id = p_steam_id;
  if found then
    raise exception 'this player is banned from the room' using errcode = 'HX013';
  end if;

  -- Null if this Steam account hasn't signed in yet.
  select p.id into v_profile from public.profiles p where p.steam_id = p_steam_id;

  if v_profile is not null and exists (
    select 1 from public.room_members m where m.room_id = p_room and m.user_id = v_profile
  ) then
    raise exception 'this player is already a member of the room' using errcode = 'HX011';
  end if;

  select i.* into v_pending
  from public.invites i
  where i.room_id = p_room
    and i.kind = 'direct'
    and i.invitee_steam_id = p_steam_id
    and i.revoked_at is null and i.accepted_at is null and i.declined_at is null
  for update;

  if found then
    if v_pending.expires_at is not null and v_pending.expires_at <= pg_catalog.now() then
      update public.invites i set revoked_at = pg_catalog.now() where i.id = v_pending.id;
      v_replaced := v_pending.id;
    else
      raise exception 'a direct invite for this player is already pending'
        using errcode = 'HX012';
    end if;
  end if;

  insert into public.invites as i (room_id, created_by, kind, invitee_steam_id, max_uses, expires_at)
  values (p_room, p_actor, 'direct', p_steam_id, 1, p_expires_at)
  on conflict (room_id, invitee_steam_id)
    where kind = 'direct' and revoked_at is null and accepted_at is null and declined_at is null
    do nothing
  returning i.* into v_invite;

  if not found then
    -- A concurrent call inserted a pending invite for the same room and Steam account.
    raise exception 'a direct invite for this player is already pending' using errcode = 'HX012';
  end if;

  return query select v_invite.id, v_invite.room_id, v_invite.created_by, v_invite.kind,
                      v_invite.invitee_steam_id, v_invite.max_uses, v_invite.uses,
                      v_invite.expires_at, v_invite.revoked_at, v_invite.accepted_at,
                      v_invite.declined_at, v_invite.created_at, v_replaced, v_profile;
end;
$$;

comment on function public.create_direct_invite(uuid, uuid, text, timestamptz) is
  'Member invites a Steam account directly (one use; an expired pending invite is revoked first; banned accounts refused). Returns exactly one row: the public.invites columns except token_hash, replaced_invite_id (the revoked expired invite, else null), and invitee_profile_id (null if the invitee has no profile yet). Errors: 22023, HX001, HX013, HX011, HX012, 23514. Service role only.';

revoke execute on function public.create_direct_invite(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_direct_invite(uuid, uuid, text, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. delete_room (replaces the version in 20260925010655_core_schema_fixes.sql)
-- ---------------------------------------------------------------------------
-- Same arguments, checks, error codes, locking, and side effects as before: locks the room
-- row FOR UPDATE, then soft-deletes the room and its live channels and revokes its pending
-- invites (link and direct). Already-deleted channels keep their deleted_at; answered
-- invites are untouched. Member rows are kept for Node's broadcasts and LiveKit removal.
-- Not idempotent: deleting an already-deleted room raises HX001.
-- NEW return shape: RETURNS TABLE (invite_id, invitee_profile_id), one row per pending
-- DIRECT invite this call revoked, with the profile id for invitee_steam_id (null if that
-- SteamID has no profile), so Node can broadcast invite:revoked to each invitee's user:
-- topic. Link invites are revoked but not returned. Zero rows when no direct invite was
-- pending; row order is unspecified. Node still broadcasts room:deleted to the room topic
-- and member:removed / LiveKit removal per member (rule 9).
-- Failures: 22023 null argument; HX001 room missing, already deleted, or actor not a member;
--           HX002 actor is a member but not the owner.
drop function public.delete_room(uuid, uuid);

create function public.delete_room(p_room uuid, p_actor uuid)
returns table (invite_id uuid, invitee_profile_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
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

  return query
  with revoked as (
    update public.invites i
    set revoked_at = pg_catalog.now()
    where i.room_id = p_room
      and i.revoked_at is null and i.accepted_at is null and i.declined_at is null
    returning i.id, i.kind, i.invitee_steam_id
  )
  select rv.id, p.id
  from revoked rv
  left join public.profiles p on p.steam_id = rv.invitee_steam_id
  where rv.kind = 'direct';
end;
$$;

comment on function public.delete_room(uuid, uuid) is
  'Owner-only soft delete of a room, its live channels, and its pending invites, under the room lock. Returns (invite_id, invitee_profile_id) for each pending direct invite revoked. Errors: 22023, HX001, HX002. service_role only.';

revoke execute on function public.delete_room(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_room(uuid, uuid) to service_role;
