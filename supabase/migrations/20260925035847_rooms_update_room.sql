-- update_room(): rename a room and/or change its emoji icon (owner or admin).
--
-- ---------------------------------------------------------------------------
-- Error codes raised by update_room and their HTTP mapping
-- (same meanings as the list in 20260925010655_core_schema_fixes.sql):
-- ---------------------------------------------------------------------------
--   HX001  room_not_found           404  room missing or soft-deleted, or the actor has no
--                                        membership row in it (never leak existence)
--   HX002  insufficient_role        403  the actor is a plain member (owner or admin required)
--   22023  invalid_parameter_value  422  p_room or p_actor is null, or both p_name and
--                                        p_icon_emoji are null (nothing to update)
--   23514  check_violation          422  rooms_name_length (1-48, not blank) or
--                                        rooms_icon_emoji_length (1-16)
--
-- Lock order: only the public.rooms row is locked (FOR UPDATE), step 1 of the documented order.
-- ---------------------------------------------------------------------------

-- Updates only the non-null fields and returns the updated row. Setting an emoji clears
-- icon_path so that rooms_icon_exactly_one holds. Replacing an uploaded icon leaves the old
-- object in the room-icons bucket; cleanup lands with the image-icon upload feature.
-- Length rules stay in the table's check constraints (23514). The rooms_set_updated_at
-- trigger (before update) bumps updated_at, so the returned row carries the new value.
create function public.update_room(p_room uuid, p_actor uuid, p_name text, p_icon_emoji text)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_room public.rooms;
begin
  if p_room is null or p_actor is null then
    raise exception 'room and actor are required' using errcode = '22023';
  end if;

  if p_name is null and p_icon_emoji is null then
    raise exception 'nothing to update' using errcode = '22023';
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
    raise exception 'insufficient role to update the room' using errcode = 'HX002';
  end if;

  update public.rooms r
  set name       = coalesce(p_name, r.name),
      icon_emoji = case when p_icon_emoji is not null then p_icon_emoji else r.icon_emoji end,
      icon_path  = case when p_icon_emoji is not null then null else r.icon_path end
  where r.id = p_room
  returning r.* into v_room;

  return v_room;
end;
$$;

comment on function public.update_room(uuid, uuid, text, text) is
  'Owner or admin renames a live room and/or sets its emoji icon (clearing icon_path). Null fields are left unchanged. Returns the updated public.rooms row. Errors: 22023, HX001, HX002, 23514. Service role only.';

revoke execute on function public.update_room(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.update_room(uuid, uuid, text, text) to service_role;
