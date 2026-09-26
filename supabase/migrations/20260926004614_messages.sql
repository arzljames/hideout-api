-- Messages: send_message(), edit_message(), delete_message().
-- No table changes: public.messages already has the body check messages_body_length
-- (1-2000 characters, at least one non-space), messages_idempotency_key_length (1-128), the
-- partial unique index messages_author_idempotency_uidx (author_id, idempotency_key) where
-- idempotency_key is not null, the history index messages_channel_created_id_idx
-- (channel_id, created_at desc, id desc), and created_at default clock_timestamp().
--
-- ---------------------------------------------------------------------------
-- Error codes raised by these functions and their HTTP mapping
-- (same meanings as the list in 20260925010655_core_schema_fixes.sql, plus HX009-HX010):
-- ---------------------------------------------------------------------------
--   HX001  room_not_found           404  channel missing or soft-deleted; message missing or
--                                        soft-deleted; room missing or soft-deleted; or the
--                                        actor/author has no membership row in the room
--                                        (never leak existence)
--   HX002  insufficient_role        403  edit_message: the actor is a member but not the
--                                        author. delete_message: the actor is a plain member
--                                        and not the author
--   HX009  channel_not_text         409  CHANNEL_NOT_TEXT: send_message to a voice channel
--   HX010  idempotency_key_reused   409  IDEMPOTENCY_KEY_REUSED: send_message with an
--                                        idempotency key the author already used for a
--                                        different channel or body, or for a message that
--                                        has since been soft-deleted
--   22023  invalid_parameter_value  422  a required argument is null (p_idempotency_key may
--                                        be null)
--   23514  check_violation          422  messages_body_length (1-2000, not blank) or
--                                        messages_idempotency_key_length (1-128)
--
-- Lock order: this migration extends the order documented in
-- 20260925010655_core_schema_fixes.sql (1. public.rooms row, 2. public.invites row,
-- 3. public.room_members rows) with
--   4. public.messages row       (FOR UPDATE; edit_message and delete_message)
-- Every function here takes step 1 and then (edit/delete only) step 4, skipping steps 2-3;
-- no function locks a message and then a room, so these can't deadlock with the room/invite
-- functions.
-- Step 1, the public.rooms row, is locked FOR SHARE, so sends, edits, and deletes in the same
-- room don't block each other but do serialize against delete_room and remove_member (which
-- lock the room FOR UPDATE): a member removed, or a room deleted, in a transaction that
-- commits first is seen by the re-checks below, and a send that locks first commits before
-- the removal proceeds. Each function reads the channel's room_id (via the message for
-- edit/delete) without locking, locks the room, then re-checks the channel, message, and
-- membership under the lock. Step 4 (the message row FOR UPDATE, always after the room) makes
-- two concurrent edits/deletes of one message serialize and re-check its state.
-- The author profile lookup (public.profiles, for the returned author_display_name and
-- author_avatar_url) is a plain read and takes no lock.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. send_message
-- ---------------------------------------------------------------------------
-- Inserts a message into a live text channel and returns it with replayed = false.
--
-- Idempotency (per author): when p_idempotency_key is not null and the author already has a
-- message with that key, nothing is inserted:
--   * same channel and same body, not soft-deleted  -> that message, replayed = true
--   * different channel or body, or soft-deleted    -> HX010 (a replay must never resurrect
--                                                      a deleted body, nor silently return a
--                                                      message other than the one requested)
-- A null key never dedupes. Concurrent sends with the same key are safe: ON CONFLICT waits
-- for the other insert to commit, then this call returns its row as a replay.
--
-- Return shape: RETURNS TABLE, always exactly one row: the public.messages columns in table
-- order, then author_display_name and author_avatar_url (the author's public.profiles
-- display_name and avatar_url, read inside the function for both the insert and the replay
-- paths, so the service needs no second read after commit; both null only if author_id is
-- null, which can't happen on send but keeps the shape uniform), then replayed boolean.
-- A composite column (message public.messages) would serialize as a nested object; flat
-- columns serialize as {id, channel_id, ..., author_display_name, author_avatar_url,
-- replayed}. PostgREST returns a JSON array for table-valued functions
-- (https://docs.postgrest.org/en/stable/references/api/functions.html); the service does not
-- call .single(), it takes the single element of the returned array (or the object itself,
-- if one is returned).
--
-- Failures (checked in this order): 22023 null channel, author, or body; HX001 channel
-- missing, room missing or soft-deleted, channel soft-deleted, or author not a member;
-- HX009 voice channel; 23514 bad body or key; HX010 key reused.
create function public.send_message(
  p_channel uuid,
  p_author uuid,
  p_body text,
  p_idempotency_key text
)
returns table (
  id                  uuid,
  channel_id          uuid,
  author_id           uuid,
  body                text,
  idempotency_key     text,
  created_at          timestamptz,
  edited_at           timestamptz,
  deleted_at          timestamptz,
  author_display_name text,
  author_avatar_url   text,
  replayed            boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_room          uuid;
  v_type          text;
  v_message       public.messages;
  v_author_name   text;
  v_author_avatar text;
begin
  if p_channel is null or p_author is null or p_body is null then
    raise exception 'channel, author, and body are required' using errcode = '22023';
  end if;

  -- Unlocked read to find the room; re-checked under the room lock below.
  select c.room_id into v_room from public.channels c where c.id = p_channel;
  if v_room is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.rooms r where r.id = v_room and r.deleted_at is null for share;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select c.type into v_type
  from public.channels c
  where c.id = p_channel and c.room_id = v_room and c.deleted_at is null;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.room_members m where m.room_id = v_room and m.user_id = p_author;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if v_type <> 'text' then
    raise exception 'messages can only be sent to text channels' using errcode = 'HX009';
  end if;

  insert into public.messages as m (channel_id, author_id, body, idempotency_key)
  values (p_channel, p_author, p_body, p_idempotency_key)
  on conflict (author_id, idempotency_key) where idempotency_key is not null do nothing
  returning m.* into v_message;

  if found then
    -- No row (author_id null) leaves both variables null.
    select p.display_name, p.avatar_url into v_author_name, v_author_avatar
    from public.profiles p
    where p.id = v_message.author_id;

    return query select v_message.id, v_message.channel_id, v_message.author_id, v_message.body,
                        v_message.idempotency_key, v_message.created_at, v_message.edited_at,
                        v_message.deleted_at, v_author_name, v_author_avatar, false;
    return;
  end if;

  -- Conflict: the author already used this key. The conflicting row is committed (ON CONFLICT
  -- waited for it), so this statement's new snapshot sees it.
  select m.* into v_message
  from public.messages m
  where m.author_id = p_author and m.idempotency_key = p_idempotency_key;
  if not found then
    -- Only if the row vanished in between (messages are never hard-deleted except by a
    -- channel hard delete). Safe to retry.
    raise exception 'idempotent replay raced with a delete; retry' using errcode = '40001';
  end if;

  if v_message.deleted_at is not null
     or v_message.channel_id is distinct from p_channel
     or v_message.body is distinct from p_body then
    raise exception 'idempotency key already used for a different message'
      using errcode = 'HX010';
  end if;

  select p.display_name, p.avatar_url into v_author_name, v_author_avatar
  from public.profiles p
  where p.id = v_message.author_id;

  return query select v_message.id, v_message.channel_id, v_message.author_id, v_message.body,
                      v_message.idempotency_key, v_message.created_at, v_message.edited_at,
                      v_message.deleted_at, v_author_name, v_author_avatar, true;
end;
$$;

comment on function public.send_message(uuid, uuid, text, text) is
  'Member sends a message to a live text channel; an idempotency key replay with the same channel and body returns the original (replayed = true). Returns exactly one row: the public.messages columns, author_display_name and author_avatar_url (from the author''s profile), and replayed. Errors: 22023, HX001, HX009, 23514, HX010. Service role only.';

revoke execute on function public.send_message(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.send_message(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. edit_message
-- ---------------------------------------------------------------------------
-- Only the author may edit (owners and admins can delete but not rewrite others' words).
-- Sets body and edited_at = clock_timestamp(). Editing to the same body still bumps
-- edited_at.
-- Return shape: RETURNS TABLE, always exactly one row: id, channel_id, author_id, body,
-- created_at, edited_at of the updated message, plus author_display_name and
-- author_avatar_url from the author's public.profiles row (null only if author_id is null).
-- idempotency_key and deleted_at are not returned (the message is live after an edit). As
-- with send_message, PostgREST returns a one-element array and the service takes that
-- element; it does not call .single().
-- Failures (checked in this order): 22023 null argument; HX001 message missing, room missing
-- or soft-deleted, actor not a member, message's channel soft-deleted, or message
-- soft-deleted; HX002 actor is not the author; 23514 bad body.
create function public.edit_message(p_message uuid, p_actor uuid, p_body text)
returns table (
  id                  uuid,
  channel_id          uuid,
  author_id           uuid,
  body                text,
  created_at          timestamptz,
  edited_at           timestamptz,
  author_display_name text,
  author_avatar_url   text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_room          uuid;
  v_message       public.messages;
  v_author_name   text;
  v_author_avatar text;
begin
  if p_message is null or p_actor is null or p_body is null then
    raise exception 'message, actor, and body are required' using errcode = '22023';
  end if;

  -- Unlocked read to find the room; re-checked under the room lock below.
  select c.room_id into v_room
  from public.messages m
  join public.channels c on c.id = m.channel_id
  where m.id = p_message;
  if v_room is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.rooms r where r.id = v_room and r.deleted_at is null for share;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.room_members rm where rm.room_id = v_room and rm.user_id = p_actor;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select m.* into v_message
  from public.messages m
  join public.channels c on c.id = m.channel_id
  where m.id = p_message and c.room_id = v_room
    and c.deleted_at is null and m.deleted_at is null
  for update of m;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if v_message.author_id is distinct from p_actor then
    raise exception 'only the author can edit a message' using errcode = 'HX002';
  end if;

  update public.messages m
  set body = p_body, edited_at = pg_catalog.clock_timestamp()
  where m.id = p_message
  returning m.* into v_message;

  -- No row (author_id null) leaves both variables null.
  select p.display_name, p.avatar_url into v_author_name, v_author_avatar
  from public.profiles p
  where p.id = v_message.author_id;

  return query select v_message.id, v_message.channel_id, v_message.author_id, v_message.body,
                      v_message.created_at, v_message.edited_at, v_author_name, v_author_avatar;
end;
$$;

comment on function public.edit_message(uuid, uuid, text) is
  'Author edits a live message (sets body and edited_at). Returns exactly one row: id, channel_id, author_id, body, created_at, edited_at, author_display_name, author_avatar_url. Errors: 22023, HX001, HX002, 23514. Service role only.';

revoke execute on function public.edit_message(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.edit_message(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. delete_message
-- ---------------------------------------------------------------------------
-- Soft-deletes (deleted_at = clock_timestamp()) and returns the row. Allowed for the author
-- and for the room's owner or admins (moderation). The body is kept in the table; the API
-- must never return or broadcast a deleted message's body.
-- Not idempotent: deleting an already-deleted message raises HX001.
-- Failures (checked in this order): 22023 null argument; HX001 message missing, room missing
-- or soft-deleted, actor not a member, message's channel soft-deleted, or message
-- soft-deleted; HX002 actor is a plain member and not the author.
create function public.delete_message(p_message uuid, p_actor uuid)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room    uuid;
  v_role    text;
  v_message public.messages;
begin
  if p_message is null or p_actor is null then
    raise exception 'message and actor are required' using errcode = '22023';
  end if;

  -- Unlocked read to find the room; re-checked under the room lock below.
  select c.room_id into v_room
  from public.messages m
  join public.channels c on c.id = m.channel_id
  where m.id = p_message;
  if v_room is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  perform 1 from public.rooms r where r.id = v_room and r.deleted_at is null for share;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select rm.role into v_role
  from public.room_members rm
  where rm.room_id = v_room and rm.user_id = p_actor;
  if v_role is null then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  select m.* into v_message
  from public.messages m
  join public.channels c on c.id = m.channel_id
  where m.id = p_message and c.room_id = v_room
    and c.deleted_at is null and m.deleted_at is null
  for update of m;
  if not found then
    raise exception 'room not found' using errcode = 'HX001';
  end if;

  if v_message.author_id is distinct from p_actor and v_role not in ('owner', 'admin') then
    raise exception 'insufficient role to delete this message' using errcode = 'HX002';
  end if;

  update public.messages m
  set deleted_at = pg_catalog.clock_timestamp()
  where m.id = p_message
  returning m.* into v_message;

  return v_message;
end;
$$;

comment on function public.delete_message(uuid, uuid) is
  'Author, owner, or admin soft-deletes a live message. Returns the row with deleted_at set. Errors: 22023, HX001, HX002. Service role only.';

revoke execute on function public.delete_message(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_message(uuid, uuid) to service_role;
