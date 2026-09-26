-- Invites: create_link_invite(), create_direct_invite(), revoke_invite(), and a new version of
-- remove_member() that also revokes the removed member's pending invites.
-- None of these functions returns token_hash: it is a credential-derived value that Node never
-- needs back (Node already holds the raw token it just generated), so it stays in the table.
--
-- Why remove_member changes: without it, a removed member's own link invites stay live, and
-- since links are permanent unless they expire or run out of uses, the removed member could
-- simply redeem their own link to rejoin. Their pending direct invites are revoked too, so
-- people they invited don't join on behalf of someone who is no longer in the room. This also
-- applies to a voluntary leave (p_actor = p_target). Accepted limitation: there are no bans
-- yet, so other members' live links still let a removed member rejoin.
--
-- No table changes: public.invites already has its shape checks (invites_link_shape,
-- invites_direct_shape), invites_token_hash_format (64 lowercase hex), the SteamID64 check
-- invites_invitee_steam_id_steam64, invites_max_uses_positive, invites_expires_after_created,
-- the unique token_hash, and the partial unique index invites_pending_direct_uidx
-- (room_id, invitee_steam_id) where kind = 'direct' and not revoked/accepted/declined (it
-- ignores expires_at, which is why create_direct_invite revokes an expired pending invite
-- before inserting a new one). Every lookup below is covered by an existing index
-- (invites pkey, invites_pending_direct_uidx, invites_created_by_idx for remove_member's
-- sweep, profiles steam_id unique, room_members pkey).
-- redeem_invite_link and respond_to_direct_invite (20260925010655_core_schema_fixes.sql) are
-- unchanged.
--
-- ---------------------------------------------------------------------------
-- Error codes raised by these functions and their HTTP mapping
-- (same meanings as the list in 20260925010655_core_schema_fixes.sql, plus HX011-HX012):
-- ---------------------------------------------------------------------------
--   HX001  room_not_found           404  room missing or soft-deleted, invite missing
--                                        (revoke_invite), or the actor has no membership row
--                                        in the room (never leak existence)
--   HX002  insufficient_role        403  revoke_invite: the actor is a plain member and did
--                                        not create the invite
--   HX011  already_member           409  ALREADY_MEMBER: create_direct_invite for a Steam
--                                        account whose profile is already a member of the
--                                        room (including the actor inviting themself)
--   HX012  invite_already_pending   409  INVITE_ALREADY_PENDING: create_direct_invite while an
--                                        unexpired direct invite for the same room and Steam
--                                        account is pending (also raised when a concurrent
--                                        call inserts one first)
--   22023  invalid_parameter_value  422  a required argument is null, or p_expires_at is not
--                                        in the future
--   23514  check_violation          422  invites_token_hash_format (not 64 lowercase hex),
--                                        invites_max_uses_positive (max_uses < 1),
--                                        invites_invitee_steam_id_steam64 (not a SteamID64)
--   23505  unique_violation         500  create_link_invite: token_hash collides with an
--                                        existing invite (practically impossible with 32
--                                        random bytes; Node may retry once with a new token)
-- remove_member raises exactly what it raised before (22023, HX001, HX002, HX003, HX005 as
-- mapped in 20260925010655_core_schema_fixes.sql).
--
-- Lock order: the order documented in 20260925010655_core_schema_fixes.sql
--   1. public.rooms row          (FOR SHARE here; FOR UPDATE in remove_member)
--   2. public.invites row        (FOR UPDATE)
--   3. public.room_members rows  (not locked here; read only)
-- Every function takes step 1 first. remove_member keeps its existing order (room FOR UPDATE,
-- then the two member rows, then the delete) and updates the target's pending invites last;
-- every other invite writer takes the room lock first, so the room lock serializes them and
-- no deadlock is possible. It also means remove_member waits for an in-flight invite insert
-- by the target, so its sweep includes it, and a create_*_invite that runs after the removal
-- commits fails its membership check (HX001).
-- revoke_invite reads the invite's room_id without a lock,
-- locks the room, then locks the invite FOR UPDATE and re-checks it. create_direct_invite
-- locks the pending direct invite for (room, Steam account), if any, after the room.
-- FOR SHARE on the room lets invite writes in one room run concurrently with each other and
-- with sends/redemptions, but serializes them against delete_room, remove_member,
-- change_role, and transfer_ownership (which lock the room FOR UPDATE): a member removed, or
-- a room deleted, by a transaction that commits first is seen by the membership re-checks
-- below, and delete_room waits for an in-flight invite insert, so its "revoke pending
-- invites" sweep includes it.
-- Accepted race: create_direct_invite's already-member check is not serialized against a
-- concurrent redeem_invite_link by the same person (both hold the room FOR SHARE). The worst
-- case is a pending direct invite for someone who just joined; accepting it later returns
-- already_member from respond_to_direct_invite.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. create_link_invite
-- ---------------------------------------------------------------------------
-- Any member (owner, admin, or member) may create a shareable link. Node generates the raw
-- token (32 random bytes, base64url) and passes only its lowercase hex SHA-256.
-- p_max_uses and p_expires_at may be null (unlimited / never expires); the API restricts the
-- allowed values in Zod.
-- Return shape: RETURNS TABLE, always exactly one row: the inserted public.invites columns in
-- table order, EXCEPT token_hash (kind 'link', created_by = p_actor, uses 0). PostgREST
-- returns a one-element array; the service takes that element.
-- Failures (checked in this order): 22023 null room, actor, or token hash; 22023 p_expires_at
-- not in the future; HX001 room missing or soft-deleted, or actor not a member;
-- 23514 bad token hash or max_uses < 1; 23505 token hash collision.
create function public.create_link_invite(
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

  perform 1 from public.room_members m where m.room_id = p_room and m.user_id = p_actor;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
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
  'Member creates a link invite (token hash only; optional max_uses and expires_at). Returns exactly one row: the public.invites columns except token_hash. Errors: 22023, HX001, 23514, 23505. Service role only.';

revoke execute on function public.create_link_invite(uuid, uuid, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_link_invite(uuid, uuid, text, integer, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. create_direct_invite
-- ---------------------------------------------------------------------------
-- Any member may invite a Steam account directly. The invitee may not have a profile yet
-- (they haven't signed in); the invite appears in their inbox when they do.
-- If a pending direct invite for (room, Steam account) exists:
--   * expired (expires_at <= now())  -> it is revoked (revoked_at = now()) and a new one is
--                                        created, so an expired invite never blocks a re-invite
--   * otherwise                      -> HX012
-- A concurrent call that inserts the pending invite first also yields HX012 (ON CONFLICT on
-- invites_pending_direct_uidx waits for it to commit, then does nothing).
--
-- Return shape: RETURNS TABLE, always exactly one row: the public.invites columns in table
-- order except token_hash (always null for a direct invite, and never returned by any invite
-- function), then replaced_invite_id (the id of the expired pending direct invite this call
-- revoked before inserting, else null, so Node can broadcast invite:revoked for it), then
-- invitee_profile_id (the id of the profile with that steam_id, or null if the person hasn't
-- signed in yet) so Node can broadcast invite:received to user:<id> without a second read.
-- PostgREST returns a one-element array; the service takes that element.
--
-- Failures (checked in this order): 22023 null room, actor, or Steam ID; 22023 p_expires_at
-- not in the future; HX001 room missing or soft-deleted, or actor not a member; HX011 the
-- Steam account's profile is already a member; HX012 an unexpired invite is pending;
-- 23514 malformed Steam ID.
create function public.create_direct_invite(
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
  'Member invites a Steam account directly (one use; an expired pending invite is revoked first). Returns exactly one row: the public.invites columns except token_hash, replaced_invite_id (the revoked expired invite, else null), and invitee_profile_id (null if the invitee has no profile yet). Errors: 22023, HX001, HX011, HX012, 23514. Service role only.';

revoke execute on function public.create_direct_invite(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_direct_invite(uuid, uuid, text, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. revoke_invite
-- ---------------------------------------------------------------------------
-- The invite's creator, or the room's owner or an admin, may revoke it. Sets
-- revoked_at = now() when it is null. Idempotent: revoking an already-revoked invite returns
-- the row unchanged (revoked_at keeps its original value). Node broadcasts invite:revoked on
-- every successful call, including repeats, so clients must treat invite:revoked as
-- idempotent (removing an invite that is already gone is a no-op).
-- Answered invites (accepted/declined, or a used-up link) can also be revoked; that only
-- stops further use and never removes a member.
--
-- Return shape: RETURNS TABLE, exactly one row: the public.invites columns except
-- token_hash, then invitee_profile_id (the invitee's profile id for a direct invite whose
-- Steam account has signed in, else null) so Node can tell the invitee.
--
-- Failures (checked in this order): 22023 null argument; HX001 invite missing, room missing
-- or soft-deleted, or actor not a member; HX002 actor is a plain member who didn't create
-- the invite.
create function public.revoke_invite(p_invite uuid, p_actor uuid)
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
  invitee_profile_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_room    uuid;
  v_role    text;
  v_invite  public.invites;
  v_profile uuid;
begin
  if p_invite is null or p_actor is null then
    raise exception 'invite and actor are required' using errcode = '22023';
  end if;

  -- Unlocked read to find the room; re-checked under the room lock below.
  select i.room_id into v_room from public.invites i where i.id = p_invite;
  if v_room is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.rooms r where r.id = v_room and r.deleted_at is null for share;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select m.role into v_role
  from public.room_members m
  where m.room_id = v_room and m.user_id = p_actor;
  if v_role is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select i.* into v_invite
  from public.invites i
  where i.id = p_invite and i.room_id = v_room
  for update;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if v_invite.created_by is distinct from p_actor and v_role not in ('owner', 'admin') then
    raise exception 'insufficient role to revoke this invite' using errcode = 'HX002';
  end if;

  if v_invite.revoked_at is null then
    update public.invites i
    set revoked_at = pg_catalog.now()
    where i.id = p_invite
    returning i.* into v_invite;
  end if;

  if v_invite.invitee_steam_id is not null then
    select p.id into v_profile from public.profiles p where p.steam_id = v_invite.invitee_steam_id;
  end if;

  return query select v_invite.id, v_invite.room_id, v_invite.created_by, v_invite.kind,
                      v_invite.invitee_steam_id, v_invite.max_uses, v_invite.uses,
                      v_invite.expires_at, v_invite.revoked_at, v_invite.accepted_at,
                      v_invite.declined_at, v_invite.created_at, v_profile;
end;
$$;

comment on function public.revoke_invite(uuid, uuid) is
  'Invite creator, owner, or admin revokes an invite (idempotent; an already-revoked invite is returned unchanged). Returns exactly one row: the public.invites columns except token_hash, and invitee_profile_id. Errors: 22023, HX001, HX002. Service role only.';

revoke execute on function public.revoke_invite(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_invite(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. remove_member (replaces the version in 20260925010655_core_schema_fixes.sql)
-- ---------------------------------------------------------------------------
-- Same signature, return type, checks, error codes, and lock order as before. New: after the
-- membership row is deleted, every pending invite the target created in this room (link or
-- direct; not revoked, accepted, or declined) is revoked, so a removed or departing member
-- can't rejoin through their own link (see the header for the accepted limitation). Answered
-- invites and other members' invites are untouched. Node then broadcasts member:left /
-- member:removed and removes the user from LiveKit (rule 9).
-- Removes p_target from the room (kick, or leave when p_actor = p_target). Locks the room row.
-- Rules: owner may remove anyone except themself; admin may remove members only; a member may
-- remove only themself; nobody removes the owner.
-- Failures (checked in this order):
--   22023 null argument
--   HX001 room missing or soft-deleted, or p_actor is not a member
--   HX003 p_target is not a member
--   HX005 p_target is the owner (including the owner trying to leave)
--   HX002 p_actor's role doesn't allow removing p_target
create or replace function public.remove_member(p_room uuid, p_actor uuid, p_target uuid)
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

  -- The target's pending invites in this room stop working (room still locked FOR UPDATE).
  update public.invites i
  set revoked_at = pg_catalog.now()
  where i.room_id = p_room
    and i.created_by = p_target
    and i.revoked_at is null
    and i.accepted_at is null
    and i.declined_at is null;
end;
$$;

comment on function public.remove_member(uuid, uuid, uuid) is
  'Removes a member (or lets a non-owner leave) under the room lock, enforcing role rules, and revokes the target''s pending invites in the room. service_role only.';

revoke execute on function public.remove_member(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_member(uuid, uuid, uuid) to service_role;
