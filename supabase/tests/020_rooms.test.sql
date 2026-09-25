-- rooms, room_members, channels, messages, invites lockdown; table constraints;
-- create_room(), transfer_ownership(), delete_room(); profiles.current_game.
-- Runs inside the runner's transaction, which is always rolled back.
begin;

select plan(110);

-- Fixture profiles (as the owner role, which bypasses RLS).
insert into public.profiles (id, steam_id, display_name) values
  ('00000000-0000-0000-0000-00000000a101', '76561190000000101', 'Owner'),
  ('00000000-0000-0000-0000-00000000a102', '76561190000000102', 'Member'),
  ('00000000-0000-0000-0000-00000000a103', '76561190000000103', 'Outsider'),
  ('00000000-0000-0000-0000-00000000a104', '76561190000000104', 'Leaver');

-- ---------------------------------------------------------------------------
-- Structure (1-13)
-- ---------------------------------------------------------------------------
select has_table('public', 'rooms', 'rooms table exists');
select has_table('public', 'room_members', 'room_members table exists');
select has_table('public', 'channels', 'channels table exists');
select has_table('public', 'messages', 'messages table exists');
select has_table('public', 'invites', 'invites table exists');

select is(
  (select count(*)::int from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relrowsecurity
     and c.relname in ('rooms', 'room_members', 'channels', 'messages', 'invites')),
  5,
  'RLS is enabled on rooms, room_members, channels, messages, invites'
);
select is(
  (select count(*)::int from pg_catalog.pg_policies
    where schemaname = 'public' and tablename in ('rooms', 'room_members', 'channels', 'messages', 'invites')),
  0,
  'the new application tables have no RLS policies'
);
select is(
  (select count(*)::int from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename in ('rooms', 'room_members', 'channels', 'messages', 'invites')),
  0,
  'the new application tables are not in the supabase_realtime publication'
);

select has_index('public', 'room_members', 'room_members_one_owner_uidx', 'room_members has the one-owner index');
select has_index('public', 'room_members', 'room_members_user_id_room_id_idx', 'room_members has a (user_id, room_id) index');
select has_index('public', 'channels', 'channels_live_name_uidx', 'channels has the live-name unique index');
select has_index('public', 'channels', 'channels_live_room_type_position_idx', 'channels has the ordering index');
select has_index('public', 'messages', 'messages_channel_created_id_idx', 'messages has the history index');

-- ---------------------------------------------------------------------------
-- Table privileges (14-54)
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($$ select * from public.rooms $$, '42501', null, 'anon cannot select rooms');
select throws_ok($$ insert into public.rooms (name, icon_emoji) values ('x', 'x') $$, '42501', null, 'anon cannot insert rooms');
select throws_ok($$ update public.rooms set name = 'x' $$, '42501', null, 'anon cannot update rooms');
select throws_ok($$ delete from public.rooms $$, '42501', null, 'anon cannot delete rooms');
select throws_ok($$ select * from public.room_members $$, '42501', null, 'anon cannot select room_members');
select throws_ok(
  $$ insert into public.room_members (room_id, user_id) values (gen_random_uuid(), gen_random_uuid()) $$,
  '42501', null, 'anon cannot insert room_members'
);
select throws_ok($$ update public.room_members set role = 'owner' $$, '42501', null, 'anon cannot update room_members');
select throws_ok($$ delete from public.room_members $$, '42501', null, 'anon cannot delete room_members');
select throws_ok($$ select * from public.channels $$, '42501', null, 'anon cannot select channels');
select throws_ok(
  $$ insert into public.channels (room_id, type, name, position) values (gen_random_uuid(), 'text', 'x', 0) $$,
  '42501', null, 'anon cannot insert channels'
);
select throws_ok($$ update public.channels set name = 'x' $$, '42501', null, 'anon cannot update channels');
select throws_ok($$ delete from public.channels $$, '42501', null, 'anon cannot delete channels');
select throws_ok($$ select * from public.messages $$, '42501', null, 'anon cannot select messages');
select throws_ok(
  $$ insert into public.messages (channel_id, body) values (gen_random_uuid(), 'x') $$,
  '42501', null, 'anon cannot insert messages'
);
select throws_ok($$ update public.messages set body = 'x' $$, '42501', null, 'anon cannot update messages');
select throws_ok($$ delete from public.messages $$, '42501', null, 'anon cannot delete messages');
select throws_ok($$ select * from public.invites $$, '42501', null, 'anon cannot select invites');
select throws_ok(
  $$ insert into public.invites (room_id, kind, token_hash) values (gen_random_uuid(), 'link', repeat('0', 64)) $$,
  '42501', null, 'anon cannot insert invites'
);
select throws_ok($$ update public.invites set revoked_at = now() $$, '42501', null, 'anon cannot update invites');
select throws_ok($$ delete from public.invites $$, '42501', null, 'anon cannot delete invites');
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000a101","role":"authenticated","iss":"hideout-api"}', true) is not null as _claims;
select throws_ok($$ select * from public.rooms $$, '42501', null, 'authenticated cannot select rooms');
select throws_ok($$ insert into public.rooms (name, icon_emoji) values ('x', 'x') $$, '42501', null, 'authenticated cannot insert rooms');
select throws_ok($$ update public.rooms set name = 'x' $$, '42501', null, 'authenticated cannot update rooms');
select throws_ok($$ delete from public.rooms $$, '42501', null, 'authenticated cannot delete rooms');
select throws_ok($$ select * from public.room_members $$, '42501', null, 'authenticated cannot select room_members');
select throws_ok(
  $$ insert into public.room_members (room_id, user_id) values (gen_random_uuid(), gen_random_uuid()) $$,
  '42501', null, 'authenticated cannot insert room_members'
);
select throws_ok($$ update public.room_members set role = 'owner' $$, '42501', null, 'authenticated cannot update room_members');
select throws_ok($$ delete from public.room_members $$, '42501', null, 'authenticated cannot delete room_members');
select throws_ok($$ select * from public.channels $$, '42501', null, 'authenticated cannot select channels');
select throws_ok(
  $$ insert into public.channels (room_id, type, name, position) values (gen_random_uuid(), 'text', 'x', 0) $$,
  '42501', null, 'authenticated cannot insert channels'
);
select throws_ok($$ update public.channels set name = 'x' $$, '42501', null, 'authenticated cannot update channels');
select throws_ok($$ delete from public.channels $$, '42501', null, 'authenticated cannot delete channels');
select throws_ok($$ select * from public.messages $$, '42501', null, 'authenticated cannot select messages');
select throws_ok(
  $$ insert into public.messages (channel_id, body) values (gen_random_uuid(), 'x') $$,
  '42501', null, 'authenticated cannot insert messages'
);
select throws_ok($$ update public.messages set body = 'x' $$, '42501', null, 'authenticated cannot update messages');
select throws_ok($$ delete from public.messages $$, '42501', null, 'authenticated cannot delete messages');
select throws_ok($$ select * from public.invites $$, '42501', null, 'authenticated cannot select invites');
select throws_ok(
  $$ insert into public.invites (room_id, kind, token_hash) values (gen_random_uuid(), 'link', repeat('0', 64)) $$,
  '42501', null, 'authenticated cannot insert invites'
);
select throws_ok($$ update public.invites set revoked_at = now() $$, '42501', null, 'authenticated cannot update invites');
select throws_ok($$ delete from public.invites $$, '42501', null, 'authenticated cannot delete invites');
reset role;

select ok(
  (select bool_and(
      has_table_privilege('service_role', t, 'select')
      and has_table_privilege('service_role', t, 'insert')
      and has_table_privilege('service_role', t, 'update')
      and has_table_privilege('service_role', t, 'delete'))
     from unnest(array['public.rooms', 'public.room_members', 'public.channels', 'public.messages', 'public.invites']) as t),
  'service_role can select/insert/update/delete on all new tables'
);

-- ---------------------------------------------------------------------------
-- Function privileges (55-60)
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('public', 'public.create_room(uuid, text, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.create_room(uuid, text, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.create_room(uuid, text, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.create_room(uuid, text, text, text)', 'execute'),
  'create_room is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.redeem_invite_link(text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.redeem_invite_link(text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.redeem_invite_link(text, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.redeem_invite_link(text, uuid)', 'execute'),
  'redeem_invite_link is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.respond_to_direct_invite(uuid, uuid, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.respond_to_direct_invite(uuid, uuid, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.respond_to_direct_invite(uuid, uuid, boolean)', 'execute')
  and has_function_privilege('service_role', 'public.respond_to_direct_invite(uuid, uuid, boolean)', 'execute'),
  'respond_to_direct_invite is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.transfer_ownership(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.transfer_ownership(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.transfer_ownership(uuid, uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.transfer_ownership(uuid, uuid, uuid)', 'execute'),
  'transfer_ownership is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.delete_room(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.delete_room(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.delete_room(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.delete_room(uuid, uuid)', 'execute'),
  'delete_room is executable by service_role only'
);
select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
     from pg_catalog.pg_proc p
    where p.oid in (
      'public.create_room(uuid, text, text, text)'::regprocedure,
      'public.redeem_invite_link(text, uuid)'::regprocedure,
      'public.respond_to_direct_invite(uuid, uuid, boolean)'::regprocedure,
      'public.transfer_ownership(uuid, uuid, uuid)'::regprocedure,
      'public.delete_room(uuid, uuid)'::regprocedure)),
  'all new public functions are security definer with an empty search_path'
);

-- ---------------------------------------------------------------------------
-- create_room (61-67)
-- ---------------------------------------------------------------------------
set local role service_role;
select ok(
  set_config(
    'test.room',
    public.create_room('00000000-0000-0000-0000-00000000a101', 'Squad', 'x', null)::text,
    true
  ) is not null,
  'service_role can execute create_room'
);
reset role;

select is(
  (select role from public.room_members
    where room_id = current_setting('test.room')::uuid and user_id = '00000000-0000-0000-0000-00000000a101'),
  'owner',
  'create_room makes the creator the owner'
);
select is(
  (select array_agg(type || ':' || name || ':' || position order by type)
     from public.channels where room_id = current_setting('test.room')::uuid),
  array['text:general:0', 'voice:voice:0'],
  'create_room creates the general text channel and the voice channel'
);
select throws_ok(
  $$ select public.create_room('00000000-0000-0000-0000-00000000a101', 'Both', 'x', 'rooms/a.png') $$,
  '23514', null, 'create_room rejects both icon_emoji and icon_path'
);
select throws_ok(
  $$ select public.create_room('00000000-0000-0000-0000-00000000a101', 'Neither', null, null) $$,
  '23514', null, 'create_room rejects a room with no icon'
);
select throws_ok(
  $$ select public.create_room('00000000-0000-0000-0000-0000000000ff', 'Ghost', 'x', null) $$,
  '23503', null, 'create_room rejects an unknown owner'
);
select throws_ok(
  $$ select public.create_room(null, 'Nobody', 'x', null) $$,
  '22023', null, 'create_room rejects a null owner'
);

-- ---------------------------------------------------------------------------
-- rooms and room_members constraints (68-75)
-- ---------------------------------------------------------------------------
select throws_ok($$ insert into public.rooms (name, icon_emoji) values ('', 'x') $$, '23514', null, 'room name cannot be empty');
select throws_ok($$ insert into public.rooms (name, icon_emoji) values ('   ', 'x') $$, '23514', null, 'room name cannot be blank');
select throws_ok(
  $$ insert into public.rooms (name, icon_emoji) values (repeat('n', 49), 'x') $$,
  '23514', null, 'room name cannot exceed 48 characters'
);
select lives_ok(
  $$ insert into public.rooms (name, icon_emoji) values (repeat('n', 48), 'x') $$,
  'room name of 48 characters is accepted'
);
select throws_ok(
  $$ insert into public.rooms (name, icon_emoji) values ('Emoji', repeat('e', 17)) $$,
  '23514', null, 'icon_emoji cannot exceed 16 characters'
);
select throws_ok(
  $$ insert into public.rooms (name, icon_path) values ('Path', repeat('p', 257)) $$,
  '23514', null, 'icon_path cannot exceed 256 characters'
);
select throws_ok(
  $$ insert into public.room_members (room_id, user_id, role)
     values (current_setting('test.room')::uuid, '00000000-0000-0000-0000-00000000a102', 'owner') $$,
  '23505', null, 'a room cannot have two owners'
);
select throws_ok(
  $$ insert into public.room_members (room_id, user_id, role)
     values (current_setting('test.room')::uuid, '00000000-0000-0000-0000-00000000a102', 'superuser') $$,
  '23514', null, 'room_members.role must be owner, admin, or member'
);

insert into public.room_members (room_id, user_id, role)
values (current_setting('test.room')::uuid, '00000000-0000-0000-0000-00000000a102', 'member');

-- ---------------------------------------------------------------------------
-- channels constraints (76-81)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.channels (room_id, type, name, position)
     values (current_setting('test.room')::uuid, 'text', 'General', 1) $$,
  '23505', null, 'live channel names are unique per room and type, case-insensitively'
);
select lives_ok(
  $$ insert into public.channels (room_id, type, name, position)
     values (current_setting('test.room')::uuid, 'voice', 'general', 1) $$,
  'the same name is allowed for a different channel type'
);

insert into public.channels (room_id, type, name, position, deleted_at)
values (current_setting('test.room')::uuid, 'text', 'lounge', 1, now());

select lives_ok(
  $$ insert into public.channels (room_id, type, name, position)
     values (current_setting('test.room')::uuid, 'text', 'Lounge', 1) $$,
  'a soft-deleted channel name can be reused'
);
select throws_ok(
  $$ insert into public.channels (room_id, type, name, position)
     values (current_setting('test.room')::uuid, 'text', repeat('c', 33), 2) $$,
  '23514', null, 'channel name cannot exceed 32 characters'
);
select throws_ok(
  $$ insert into public.channels (room_id, type, name, position)
     values (current_setting('test.room')::uuid, 'text', '  ', 2) $$,
  '23514', null, 'channel name cannot be blank'
);
select throws_ok(
  $$ insert into public.channels (room_id, type, name, position)
     values (current_setting('test.room')::uuid, 'video', 'cams', 2) $$,
  '23514', null, 'channel type must be text or voice'
);

-- ---------------------------------------------------------------------------
-- messages constraints (82-90)
-- ---------------------------------------------------------------------------
select set_config(
  'test.chan',
  (select id::text from public.channels
    where room_id = current_setting('test.room')::uuid and type = 'text' and name = 'general'),
  true
) is not null as _chan;

select throws_ok(
  $$ insert into public.messages (channel_id, author_id, body)
     values (current_setting('test.chan')::uuid, '00000000-0000-0000-0000-00000000a101', '') $$,
  '23514', null, 'message body cannot be empty'
);
select throws_ok(
  $$ insert into public.messages (channel_id, author_id, body)
     values (current_setting('test.chan')::uuid, '00000000-0000-0000-0000-00000000a101', E' \n\t ') $$,
  '23514', null, 'message body cannot be blank'
);
select throws_ok(
  $$ insert into public.messages (channel_id, author_id, body)
     values (current_setting('test.chan')::uuid, '00000000-0000-0000-0000-00000000a101', repeat('m', 2001)) $$,
  '23514', null, 'message body cannot exceed 2000 characters'
);
select lives_ok(
  $$ insert into public.messages (channel_id, author_id, body)
     values (current_setting('test.chan')::uuid, '00000000-0000-0000-0000-00000000a101', repeat('m', 2000)) $$,
  'message body of 2000 characters is accepted'
);
select lives_ok(
  $$ insert into public.messages (channel_id, author_id, body, idempotency_key)
     values (current_setting('test.chan')::uuid, '00000000-0000-0000-0000-00000000a101', 'hi', 'key-1') $$,
  'a message with an idempotency key is accepted'
);
select throws_ok(
  $$ insert into public.messages (channel_id, author_id, body, idempotency_key)
     values (current_setting('test.chan')::uuid, '00000000-0000-0000-0000-00000000a101', 'hi again', 'key-1') $$,
  '23505', null, 'the same author cannot reuse an idempotency key'
);
select lives_ok(
  $$ insert into public.messages (channel_id, author_id, body, idempotency_key)
     values (current_setting('test.chan')::uuid, '00000000-0000-0000-0000-00000000a102', 'hi', 'key-1') $$,
  'a different author can use the same idempotency key'
);
select throws_ok(
  $$ insert into public.messages (channel_id, author_id, body, idempotency_key)
     values (current_setting('test.chan')::uuid, '00000000-0000-0000-0000-00000000a101', 'hi', repeat('k', 129)) $$,
  '23514', null, 'idempotency_key cannot exceed 128 characters'
);

insert into public.messages (channel_id, author_id, body)
values (current_setting('test.chan')::uuid, '00000000-0000-0000-0000-00000000a104', 'bye');
delete from public.profiles where id = '00000000-0000-0000-0000-00000000a104';

select is(
  (select count(*)::int from public.messages
    where channel_id = current_setting('test.chan')::uuid and body = 'bye' and author_id is null),
  1,
  'deleting a profile keeps its messages with author_id set to null'
);

-- ---------------------------------------------------------------------------
-- transfer_ownership (91-98)
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select public.transfer_ownership(current_setting('test.room')::uuid,
       '00000000-0000-0000-0000-00000000a101', '00000000-0000-0000-0000-00000000a101') $$,
  'HX004', null, 'transfer_ownership rejects transferring to yourself (HX004)'
);
select throws_ok(
  $$ select public.transfer_ownership(current_setting('test.room')::uuid,
       '00000000-0000-0000-0000-00000000a102', '00000000-0000-0000-0000-00000000a101') $$,
  'HX002', null, 'transfer_ownership rejects a member who is not the owner (HX002)'
);
select throws_ok(
  $$ select public.transfer_ownership(current_setting('test.room')::uuid,
       '00000000-0000-0000-0000-00000000a101', '00000000-0000-0000-0000-00000000a103') $$,
  'HX003', null, 'transfer_ownership rejects a non-member target (HX003)'
);
select throws_ok(
  $$ select public.transfer_ownership('00000000-0000-0000-0000-0000000000ff',
       '00000000-0000-0000-0000-00000000a101', '00000000-0000-0000-0000-00000000a102') $$,
  'HX001', null, 'transfer_ownership rejects an unknown room (HX001)'
);
select lives_ok(
  $$ select public.transfer_ownership(current_setting('test.room')::uuid,
       '00000000-0000-0000-0000-00000000a101', '00000000-0000-0000-0000-00000000a102') $$,
  'the owner can transfer ownership to a member'
);
select is(
  (select role from public.room_members
    where room_id = current_setting('test.room')::uuid and user_id = '00000000-0000-0000-0000-00000000a101'),
  'admin',
  'the previous owner becomes an admin'
);
select is(
  (select role from public.room_members
    where room_id = current_setting('test.room')::uuid and user_id = '00000000-0000-0000-0000-00000000a102'),
  'owner',
  'the target becomes the owner'
);
select throws_ok(
  $$ select public.transfer_ownership(current_setting('test.room')::uuid,
       '00000000-0000-0000-0000-00000000a101', '00000000-0000-0000-0000-00000000a102') $$,
  'HX002', null, 'the previous owner can no longer transfer ownership (HX002)'
);
reset role;

-- ---------------------------------------------------------------------------
-- delete_room (99-107)
-- ---------------------------------------------------------------------------
insert into public.invites (room_id, created_by, kind, token_hash)
values (current_setting('test.room')::uuid, '00000000-0000-0000-0000-00000000a102', 'link', repeat('7', 64));

set local role service_role;
select throws_ok(
  $$ select public.delete_room(current_setting('test.room')::uuid, '00000000-0000-0000-0000-00000000a101') $$,
  'HX002', null, 'an admin cannot delete the room (HX002)'
);
select throws_ok(
  $$ select public.delete_room(current_setting('test.room')::uuid, '00000000-0000-0000-0000-00000000a103') $$,
  'HX001', null, 'a non-member cannot delete the room and gets room_not_found (HX001)'
);
select lives_ok(
  $$ select public.delete_room(current_setting('test.room')::uuid, '00000000-0000-0000-0000-00000000a102') $$,
  'the owner can delete the room'
);
reset role;

select ok(
  (select deleted_at is not null from public.rooms where id = current_setting('test.room')::uuid),
  'delete_room sets rooms.deleted_at'
);
select is(
  (select count(*)::int from public.channels
    where room_id = current_setting('test.room')::uuid and deleted_at is null),
  0,
  'delete_room soft-deletes every live channel'
);
select is(
  (select count(*)::int from public.invites
    where room_id = current_setting('test.room')::uuid and revoked_at is null),
  0,
  'delete_room revokes pending invites'
);
select is(
  (select count(*)::int from public.room_members where room_id = current_setting('test.room')::uuid),
  2,
  'delete_room keeps member rows for Node''s broadcasts and LiveKit removal'
);

set local role service_role;
select throws_ok(
  $$ select public.delete_room(current_setting('test.room')::uuid, '00000000-0000-0000-0000-00000000a102') $$,
  'HX001', null, 'deleting an already-deleted room raises HX001'
);
select throws_ok(
  $$ select public.transfer_ownership(current_setting('test.room')::uuid,
       '00000000-0000-0000-0000-00000000a102', '00000000-0000-0000-0000-00000000a101') $$,
  'HX001', null, 'transfer_ownership on a deleted room raises HX001'
);
reset role;

-- ---------------------------------------------------------------------------
-- profiles.current_game (108-110)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ update public.profiles set current_game = '' where id = '00000000-0000-0000-0000-00000000a101' $$,
  '23514', null, 'current_game cannot be empty'
);
select throws_ok(
  $$ update public.profiles set current_game = repeat('g', 129) where id = '00000000-0000-0000-0000-00000000a101' $$,
  '23514', null, 'current_game cannot exceed 128 characters'
);
select lives_ok(
  $$ update public.profiles set current_game = 'Deep Rock Galactic', current_game_updated_at = now()
     where id = '00000000-0000-0000-0000-00000000a101' $$,
  'a valid current_game is accepted'
);

select * from finish();
rollback;
