-- Channel management: create_channel(), rename_channel(), reorder_channels(), delete_channel()
-- (owner or admin). No table changes: public.channels already has the name/type/position
-- checks, the live-name unique index channels_live_name_uidx (room_id, type, lower(name))
-- and the ordering index channels_live_room_type_position_idx.
--
-- ---------------------------------------------------------------------------
-- Error codes raised by these functions and their HTTP mapping
-- (same meanings as the list in 20260925010655_core_schema_fixes.sql, plus HX006-HX008):
-- ---------------------------------------------------------------------------
--   HX001  room_not_found           404  room missing or soft-deleted; channel missing,
--                                        soft-deleted, or not in that room; or the actor has
--                                        no membership row in the room (never leak existence)
--   HX002  insufficient_role        403  the actor is a plain member (owner or admin required)
--   HX006  channel_limit_reached    409  create_channel: the room already has 50 live channels
--                                        (text and voice together)
--   HX007  channel_order_mismatch   409  reorder_channels: p_channel_ids is not exactly the set
--                                        of live channel ids of that room and type (wrong
--                                        count, duplicate, null element, unknown/deleted id,
--                                        id from another room or of the other type)
--   HX008  last_text_channel        409  delete_channel: the channel is the room's only live
--                                        text channel (the default channel must exist)
--   22023  invalid_parameter_value  422  a required argument is null, or p_type is not
--                                        'text' or 'voice'
--   23505  unique_violation         409  CHANNEL_NAME_TAKEN: create/rename to a name already
--                                        used by a live channel of the same room and type
--                                        (case-insensitive; channels_live_name_uidx)
--   23514  check_violation          422  channels_name_length (1-32, not blank)
--
-- Lock order: only the public.rooms row is locked (FOR UPDATE), step 1 of the documented
-- order. Channel rows are only written by these functions and delete_room, all under that room
-- lock, so the 50-channel count, the next position, the reorder set check, and the
-- last-text-channel check can't race. Functions taking p_channel read the channel's room_id
-- without locking, lock the room, then re-check the channel under the lock.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. create_channel
-- ---------------------------------------------------------------------------
-- Appends a channel at the end of its type's list: position = max live position of that
-- room + type, plus 1 (0 when there is none). Soft-deleted channels don't count toward the
-- limit or the position, and their names can be reused.
-- Failures (checked in this order): 22023 null argument or bad type; HX001 room missing,
-- soft-deleted, or actor not a member; HX002 plain member; HX006 50 live channels;
-- 23514 bad name; 23505 name taken.
create function public.create_channel(p_room uuid, p_actor uuid, p_type text, p_name text)
returns public.channels
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_channels constant integer := 50;
  v_role     text;
  v_count    integer;
  v_position integer;
  v_channel  public.channels;
begin
  if p_room is null or p_actor is null or p_type is null or p_name is null then
    raise exception 'room, actor, type, and name are required' using errcode = '22023';
  end if;

  if p_type not in ('text', 'voice') then
    raise exception 'type must be text or voice' using errcode = '22023';
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

  if v_role not in ('owner', 'admin') then
    raise exception 'insufficient role to manage channels' using errcode = 'HX002';
  end if;

  select pg_catalog.count(*) into v_count
  from public.channels c
  where c.room_id = p_room and c.deleted_at is null;

  if v_count >= v_max_channels then
    raise exception 'channel limit reached' using errcode = 'HX006';
  end if;

  select coalesce(pg_catalog.max(c.position), -1) + 1 into v_position
  from public.channels c
  where c.room_id = p_room and c.type = p_type and c.deleted_at is null;

  insert into public.channels as c (room_id, type, name, position)
  values (p_room, p_type, p_name, v_position)
  returning c.* into v_channel;

  return v_channel;
end;
$$;

comment on function public.create_channel(uuid, uuid, text, text) is
  'Owner or admin adds a text or voice channel at the end of its type''s list (max 50 live channels per room). Returns the new public.channels row. Errors: 22023, HX001, HX002, HX006, 23514, 23505. Service role only.';

revoke execute on function public.create_channel(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_channel(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. rename_channel
-- ---------------------------------------------------------------------------
-- Failures (checked in this order): 22023 null argument; HX001 channel missing, room missing
-- or soft-deleted, channel soft-deleted, or actor not a member; HX002 plain member;
-- 23514 bad name; 23505 name taken by another live channel of the same type.
create function public.rename_channel(p_channel uuid, p_actor uuid, p_name text)
returns public.channels
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room    uuid;
  v_role    text;
  v_channel public.channels;
begin
  if p_channel is null or p_actor is null or p_name is null then
    raise exception 'channel, actor, and name are required' using errcode = '22023';
  end if;

  -- Unlocked read to find the room; re-checked under the room lock below.
  select c.room_id into v_room from public.channels c where c.id = p_channel;
  if v_room is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.rooms r where r.id = v_room and r.deleted_at is null for update;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.channels c
  where c.id = p_channel and c.room_id = v_room and c.deleted_at is null;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select m.role into v_role
  from public.room_members m
  where m.room_id = v_room and m.user_id = p_actor;

  if v_role is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'insufficient role to manage channels' using errcode = 'HX002';
  end if;

  update public.channels c
  set name = p_name
  where c.id = p_channel
  returning c.* into v_channel;

  return v_channel;
end;
$$;

comment on function public.rename_channel(uuid, uuid, text) is
  'Owner or admin renames a live channel. Returns the updated public.channels row. Errors: 22023, HX001, HX002, 23514, 23505. Service role only.';

revoke execute on function public.rename_channel(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rename_channel(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. reorder_channels
-- ---------------------------------------------------------------------------
-- p_channel_ids is the full new order of the room's live channels of p_type; each gets
-- position = its 0-based index. The array must be exactly that set (HX007 otherwise), so a
-- client working from a stale list gets an error instead of a silently partial reorder.
-- An empty array is valid only when the room has no live channels of that type.
-- Returns all live channels of that room and type, ordered by position.
-- Failures (checked in this order): 22023 null argument or bad type; HX001 room missing,
-- soft-deleted, or actor not a member; HX002 plain member; HX007 mismatch.
create function public.reorder_channels(p_room uuid, p_actor uuid, p_type text, p_channel_ids uuid[])
returns setof public.channels
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role     text;
  v_given    integer;
  v_live     integer;
  v_distinct integer;
  v_matched  integer;
begin
  if p_room is null or p_actor is null or p_type is null or p_channel_ids is null then
    raise exception 'room, actor, type, and channel ids are required' using errcode = '22023';
  end if;

  if p_type not in ('text', 'voice') then
    raise exception 'type must be text or voice' using errcode = '22023';
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

  if v_role not in ('owner', 'admin') then
    raise exception 'insufficient role to manage channels' using errcode = 'HX002';
  end if;

  -- Set equality: no nulls, no duplicates, same size as the live set, and every live
  -- channel of this room + type appears in the array.
  if pg_catalog.array_ndims(p_channel_ids) > 1
     or exists (select 1 from pg_catalog.unnest(p_channel_ids) as u(id) where u.id is null) then
    raise exception 'channel order mismatch' using errcode = 'HX007';
  end if;

  v_given := pg_catalog.cardinality(p_channel_ids);

  select pg_catalog.count(distinct u.id) into v_distinct
  from pg_catalog.unnest(p_channel_ids) as u(id);

  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where c.id = any (p_channel_ids))
    into v_live, v_matched
  from public.channels c
  where c.room_id = p_room and c.type = p_type and c.deleted_at is null;

  if v_distinct <> v_given or v_given <> v_live or v_matched <> v_live then
    raise exception 'channel order mismatch' using errcode = 'HX007';
  end if;

  -- Defense in depth: scoped to room + type + live even though the set check guarantees it; skips unchanged rows.
  update public.channels c
  set position = (u.ord - 1)::integer
  from pg_catalog.unnest(p_channel_ids) with ordinality as u(id, ord)
  where c.id = u.id
    and c.room_id = p_room and c.type = p_type and c.deleted_at is null
    and c.position is distinct from (u.ord - 1)::integer;

  return query
    select c.*
    from public.channels c
    where c.room_id = p_room and c.type = p_type and c.deleted_at is null
    order by c.position, c.id;
end;
$$;

comment on function public.reorder_channels(uuid, uuid, text, uuid[]) is
  'Owner or admin sets the order of a room''s live channels of one type; p_channel_ids must be exactly that set. Returns those channels ordered by position. Errors: 22023, HX001, HX002, HX007. Service role only.';

revoke execute on function public.reorder_channels(uuid, uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.reorder_channels(uuid, uuid, text, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4. delete_channel
-- ---------------------------------------------------------------------------
-- Soft-deletes the channel (deleted_at = now()) and returns the row. The room must keep at
-- least one live text channel (the default channel); voice channels can all be deleted.
-- Messages are left untouched; message reads filter out deleted channels, and
-- private.can_access_topic denies channel:<id> and typing:<id> for deleted channels.
-- Not idempotent: deleting an already-deleted channel raises HX001.
-- Failures (checked in this order): 22023 null argument; HX001 channel missing, room missing
-- or soft-deleted, channel soft-deleted, or actor not a member; HX002 plain member;
-- HX008 last live text channel.
create function public.delete_channel(p_channel uuid, p_actor uuid)
returns public.channels
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room    uuid;
  v_role    text;
  v_channel public.channels;
begin
  if p_channel is null or p_actor is null then
    raise exception 'channel and actor are required' using errcode = '22023';
  end if;

  -- Unlocked read to find the room; re-checked under the room lock below.
  select c.room_id into v_room from public.channels c where c.id = p_channel;
  if v_room is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.rooms r where r.id = v_room and r.deleted_at is null for update;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select c.* into v_channel
  from public.channels c
  where c.id = p_channel and c.room_id = v_room and c.deleted_at is null;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select m.role into v_role
  from public.room_members m
  where m.room_id = v_room and m.user_id = p_actor;

  if v_role is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'insufficient role to manage channels' using errcode = 'HX002';
  end if;

  if v_channel.type = 'text' and not exists (
    select 1 from public.channels c
    where c.room_id = v_room and c.type = 'text' and c.deleted_at is null and c.id <> p_channel
  ) then
    raise exception 'cannot delete the last text channel' using errcode = 'HX008';
  end if;

  update public.channels c
  set deleted_at = pg_catalog.now()
  where c.id = p_channel
  returning c.* into v_channel;

  return v_channel;
end;
$$;

comment on function public.delete_channel(uuid, uuid) is
  'Owner or admin soft-deletes a live channel (never the room''s last live text channel). Messages are untouched. Returns the row with deleted_at set. Errors: 22023, HX001, HX002, HX008. Service role only.';

revoke execute on function public.delete_channel(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_channel(uuid, uuid) to service_role;
