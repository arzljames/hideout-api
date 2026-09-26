-- 20260926004614_messages: send_message(), edit_message(), delete_message() privileges,
-- argument checks, rule-4 error codes, text-only channels, idempotency replays and reuse,
-- body checks, author/role checks, soft delete, the returned author profile columns and
-- result shapes, and Realtime access sanity checks.
-- Runs inside the runner's transaction, which is always rolled back.
begin;

select plan(79);

-- ---------------------------------------------------------------------------
-- Fixtures (as the owner role)
-- ---------------------------------------------------------------------------
-- Profiles: O owner, A admin, M member, P member, N never a member, R joined room L and was
-- removed. M has an avatar_url; O does not (null avatar in the returned author columns).
-- Room L (f801): live. text c801 general(0), c802 random(1), c804 old (deleted, 2);
--                voice c803 Lounge(0).
-- Room D (f802): soft-deleted (O owner, M member) with a still-live text channel c805.
-- Messages: d801 M in c801, d802 O in c801, d803 M in c801 (deleted, key 'key-del'),
--           d804 M in deleted channel c804, d805 M in c805 (deleted room),
--           d806 A in c801, d807 M in c801, d808 P in c801.
insert into public.profiles (id, steam_id, display_name, avatar_url) values
  ('00000000-0000-0000-0000-00000000e801', '76561190000000801', 'Owner O',    null),
  ('00000000-0000-0000-0000-00000000e802', '76561190000000802', 'Admin A',    null),
  ('00000000-0000-0000-0000-00000000e803', '76561190000000803', 'Member M',   'https://avatars.example.test/m.jpg'),
  ('00000000-0000-0000-0000-00000000e804', '76561190000000804', 'Outsider N', null),
  ('00000000-0000-0000-0000-00000000e805', '76561190000000805', 'Removed R',  null),
  ('00000000-0000-0000-0000-00000000e806', '76561190000000806', 'Member P',   null);

insert into public.rooms (id, name, icon_emoji, deleted_at) values
  ('00000000-0000-0000-0000-00000000f801', 'Room L', 'x', null),
  ('00000000-0000-0000-0000-00000000f802', 'Room D', 'x', '2000-01-02');

insert into public.room_members (room_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000e801', 'owner'),
  ('00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000e802', 'admin'),
  ('00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000e803', 'member'),
  ('00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000e806', 'member'),
  ('00000000-0000-0000-0000-00000000f801', '00000000-0000-0000-0000-00000000e805', 'member'),
  ('00000000-0000-0000-0000-00000000f802', '00000000-0000-0000-0000-00000000e801', 'owner'),
  ('00000000-0000-0000-0000-00000000f802', '00000000-0000-0000-0000-00000000e803', 'member');

-- R is removed from room L (fixture setup, not remove_member).
delete from public.room_members
where room_id = '00000000-0000-0000-0000-00000000f801' and user_id = '00000000-0000-0000-0000-00000000e805';

insert into public.channels (id, room_id, type, name, position, deleted_at) values
  ('00000000-0000-0000-0000-00000000c801', '00000000-0000-0000-0000-00000000f801', 'text',  'general', 0, null),
  ('00000000-0000-0000-0000-00000000c802', '00000000-0000-0000-0000-00000000f801', 'text',  'random',  1, null),
  ('00000000-0000-0000-0000-00000000c803', '00000000-0000-0000-0000-00000000f801', 'voice', 'Lounge',  0, null),
  ('00000000-0000-0000-0000-00000000c804', '00000000-0000-0000-0000-00000000f801', 'text',  'old',     2, '2000-01-02'),
  ('00000000-0000-0000-0000-00000000c805', '00000000-0000-0000-0000-00000000f802', 'text',  'ghost',   0, null);

insert into public.messages (id, channel_id, author_id, body, idempotency_key, deleted_at) values
  ('00000000-0000-0000-0000-00000000d801', '00000000-0000-0000-0000-00000000c801', '00000000-0000-0000-0000-00000000e803', 'hello from M', null, null),
  ('00000000-0000-0000-0000-00000000d802', '00000000-0000-0000-0000-00000000c801', '00000000-0000-0000-0000-00000000e801', 'owner msg',    null, null),
  ('00000000-0000-0000-0000-00000000d803', '00000000-0000-0000-0000-00000000c801', '00000000-0000-0000-0000-00000000e803', 'gone',         'key-del', '2000-01-02'),
  ('00000000-0000-0000-0000-00000000d804', '00000000-0000-0000-0000-00000000c804', '00000000-0000-0000-0000-00000000e803', 'in old',       null, null),
  ('00000000-0000-0000-0000-00000000d805', '00000000-0000-0000-0000-00000000c805', '00000000-0000-0000-0000-00000000e803', 'in ghost',     null, null),
  ('00000000-0000-0000-0000-00000000d806', '00000000-0000-0000-0000-00000000c801', '00000000-0000-0000-0000-00000000e802', 'admin msg',    null, null),
  ('00000000-0000-0000-0000-00000000d807', '00000000-0000-0000-0000-00000000c801', '00000000-0000-0000-0000-00000000e803', 'M again',      null, null),
  ('00000000-0000-0000-0000-00000000d808', '00000000-0000-0000-0000-00000000c801', '00000000-0000-0000-0000-00000000e806', 'from P',       null, null);

-- ---------------------------------------------------------------------------
-- Structure and privileges (1-10)
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('public', 'public.send_message(uuid, uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.send_message(uuid, uuid, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.send_message(uuid, uuid, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.send_message(uuid, uuid, text, text)', 'execute'),
  'send_message is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.edit_message(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.edit_message(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.edit_message(uuid, uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.edit_message(uuid, uuid, text)', 'execute'),
  'edit_message is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.delete_message(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.delete_message(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.delete_message(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.delete_message(uuid, uuid)', 'execute'),
  'delete_message is executable by service_role only'
);

select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.send_message(uuid, uuid, text, text)'::regprocedure),
  'send_message is security definer with an empty search_path'
);
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.edit_message(uuid, uuid, text)'::regprocedure),
  'edit_message is security definer with an empty search_path'
);
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.delete_message(uuid, uuid)'::regprocedure),
  'delete_message is security definer with an empty search_path'
);

set local role anon;
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c801',
       '00000000-0000-0000-0000-00000000e803', 'hacked', null) $$,
  '42501', null, 'anon cannot execute send_message'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000e803","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c801',
       '00000000-0000-0000-0000-00000000e803', 'hacked', null) $$,
  '42501', null, 'authenticated cannot execute send_message, even as a member'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e803', 'hacked') $$,
  '42501', null, 'authenticated cannot execute edit_message, even as the author'
);
select throws_ok(
  $$ select public.delete_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e803') $$,
  '42501', null, 'authenticated cannot execute delete_message, even as the author'
);
reset role;

-- ---------------------------------------------------------------------------
-- send_message: arguments, rule 4, text only, body checks (11-24)
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select * from public.send_message(null, '00000000-0000-0000-0000-00000000e803', 'hi', null) $$,
  '22023', null, 'send_message rejects a null channel'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c801', null, 'hi', null) $$,
  '22023', null, 'send_message rejects a null author'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c801',
       '00000000-0000-0000-0000-00000000e803', null, 'k') $$,
  '22023', null, 'send_message rejects a null body'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-0000000008ff',
       '00000000-0000-0000-0000-00000000e803', 'hi', null) $$,
  'HX001', null, 'send_message to an unknown channel raises HX001'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c805',
       '00000000-0000-0000-0000-00000000e803', 'hi', null) $$,
  'HX001', null, 'send_message to a channel of a soft-deleted room raises HX001, even for a member'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c804',
       '00000000-0000-0000-0000-00000000e803', 'hi', null) $$,
  'HX001', null, 'send_message to a soft-deleted channel raises HX001'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c801',
       '00000000-0000-0000-0000-00000000e804', 'hi', null) $$,
  'HX001', null, 'send_message by a non-member raises HX001'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c801',
       '00000000-0000-0000-0000-00000000e805', 'hi', null) $$,
  'HX001', null, 'send_message by a removed member raises HX001'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c803',
       '00000000-0000-0000-0000-00000000e803', 'hi', null) $$,
  'HX009', null, 'send_message to a voice channel raises HX009'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c803',
       '00000000-0000-0000-0000-00000000e804', 'hi', null) $$,
  'HX001', null, 'send_message to a voice channel by a non-member raises HX001, not HX009'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c801',
       '00000000-0000-0000-0000-00000000e803', '   ', null) $$,
  '23514', null, 'a blank body raises 23514'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c801',
       '00000000-0000-0000-0000-00000000e803', repeat('a', 2001), null) $$,
  '23514', null, 'a 2001-character body raises 23514'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c801',
       '00000000-0000-0000-0000-00000000e803', 'hi', repeat('k', 129)) $$,
  '23514', null, 'a 129-character idempotency key raises 23514'
);
select is(
  (select count(*)::int from public.messages
    where channel_id in ('00000000-0000-0000-0000-00000000c801', '00000000-0000-0000-0000-00000000c802',
                         '00000000-0000-0000-0000-00000000c803', '00000000-0000-0000-0000-00000000c804',
                         '00000000-0000-0000-0000-00000000c805')),
  8, 'no message was stored by the rejected calls'
);

-- ---------------------------------------------------------------------------
-- send_message: success, author columns, and idempotency (25-40)
-- ---------------------------------------------------------------------------
select set_config('test.m1',
  (select row_to_json(s)::text
     from public.send_message('00000000-0000-0000-0000-00000000c801',
            '00000000-0000-0000-0000-00000000e803', 'hi there', 'key-1') s),
  true) is not null as _m1;

select is(
  (select row(j ->> 'channel_id', j ->> 'author_id', j ->> 'body', j ->> 'idempotency_key',
              j ->> 'edited_at', j ->> 'deleted_at', j ->> 'replayed')::text
     from (select current_setting('test.m1')::jsonb as j) x),
  row('00000000-0000-0000-0000-00000000c801', '00000000-0000-0000-0000-00000000e803', 'hi there',
      'key-1', null::text, null::text, 'false')::text,
  'a member sends a message; the row is returned with replayed = false'
);
select is(
  (select row(j ->> 'author_display_name', j ->> 'author_avatar_url')::text
     from (select current_setting('test.m1')::jsonb as j) x),
  row('Member M', 'https://avatars.example.test/m.jpg')::text,
  'a new send returns the author''s display_name and avatar_url'
);
select is(
  (select array_agg(k order by k collate "C")
     from jsonb_object_keys(current_setting('test.m1')::jsonb) k),
  array['author_avatar_url', 'author_display_name', 'author_id', 'body', 'channel_id',
        'created_at', 'deleted_at', 'edited_at', 'id', 'idempotency_key', 'replayed'],
  'send_message returns the message columns, the author columns, and replayed'
);
select ok(
  exists (
    select 1 from public.messages m
    where m.id = (current_setting('test.m1')::jsonb ->> 'id')::uuid
      and m.created_at is not null and m.deleted_at is null and m.edited_at is null
      and m.body = 'hi there' and m.idempotency_key = 'key-1'
  ),
  'the message is stored with created_at set'
);
select is(
  (select row(s.id, s.body, s.replayed)::text
     from public.send_message('00000000-0000-0000-0000-00000000c801',
            '00000000-0000-0000-0000-00000000e803', 'hi there', 'key-1') s),
  row((current_setting('test.m1')::jsonb ->> 'id')::uuid, 'hi there', true)::text,
  'a replay (same key, channel, and body) returns the original message with replayed = true'
);
select is(
  (select row(s.id, s.author_display_name, s.author_avatar_url, s.replayed)::text
     from public.send_message('00000000-0000-0000-0000-00000000c801',
            '00000000-0000-0000-0000-00000000e803', 'hi there', 'key-1') s),
  row((current_setting('test.m1')::jsonb ->> 'id')::uuid, 'Member M',
      'https://avatars.example.test/m.jpg', true)::text,
  'a replay returns the author''s display_name and avatar_url'
);
select is(
  (select count(*)::int from public.messages where channel_id = '00000000-0000-0000-0000-00000000c801'),
  7, 'the replay stored no new row'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c801',
       '00000000-0000-0000-0000-00000000e803', 'something else', 'key-1') $$,
  'HX010', null, 'the same key with a different body raises HX010'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c802',
       '00000000-0000-0000-0000-00000000e803', 'hi there', 'key-1') $$,
  'HX010', null, 'the same key in a different channel raises HX010'
);
select throws_ok(
  $$ select * from public.send_message('00000000-0000-0000-0000-00000000c801',
       '00000000-0000-0000-0000-00000000e803', 'gone', 'key-del') $$,
  'HX010', null, 'the same key after the original was soft-deleted raises HX010'
);
select ok(
  (select s.id <> (current_setting('test.m1')::jsonb ->> 'id')::uuid
          and not s.replayed
          and s.author_id = '00000000-0000-0000-0000-00000000e806'
     from public.send_message('00000000-0000-0000-0000-00000000c801',
            '00000000-0000-0000-0000-00000000e806', 'hi there', 'key-1') s),
  'another author may use the same key; a new message is created'
);
select isnt(
  (select s.id from public.send_message('00000000-0000-0000-0000-00000000c801',
          '00000000-0000-0000-0000-00000000e803', 'same', null) s),
  (select s.id from public.send_message('00000000-0000-0000-0000-00000000c801',
          '00000000-0000-0000-0000-00000000e803', 'same', null) s),
  'a null key never dedupes: two identical sends create two messages'
);
select is(
  (select count(*)::int from public.messages
    where author_id = '00000000-0000-0000-0000-00000000e803' and body = 'same'),
  2, 'both messages without a key are stored'
);
select is(
  (select char_length(s.body)
     from public.send_message('00000000-0000-0000-0000-00000000c802',
            '00000000-0000-0000-0000-00000000e803', repeat('a', 2000), null) s),
  2000, 'a 2000-character body is accepted'
);
select is(
  (select row(s.channel_id, s.author_id, s.replayed)::text
     from public.send_message('00000000-0000-0000-0000-00000000c802',
            '00000000-0000-0000-0000-00000000e801', 'owner says hi', 'key-o') s),
  row('00000000-0000-0000-0000-00000000c802'::uuid, '00000000-0000-0000-0000-00000000e801'::uuid, false)::text,
  'the owner can send to another text channel'
);
select is(
  (select row(s.author_id, s.author_display_name, s.author_avatar_url, s.replayed)::text
     from public.send_message('00000000-0000-0000-0000-00000000c802',
            '00000000-0000-0000-0000-00000000e801', 'owner says hi', 'key-o') s),
  row('00000000-0000-0000-0000-00000000e801'::uuid, 'Owner O', null::text, true)::text,
  'a replay for an author without an avatar returns author_avatar_url null'
);

-- ---------------------------------------------------------------------------
-- edit_message: arguments, rule 4, author only (41-53)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.edit_message(null, '00000000-0000-0000-0000-00000000e803', 'x') $$,
  '22023', null, 'edit_message rejects a null message'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d801', null, 'x') $$,
  '22023', null, 'edit_message rejects a null actor'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e803', null) $$,
  '22023', null, 'edit_message rejects a null body'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-0000000008ff',
       '00000000-0000-0000-0000-00000000e803', 'x') $$,
  'HX001', null, 'edit_message on an unknown message raises HX001'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d805',
       '00000000-0000-0000-0000-00000000e803', 'x') $$,
  'HX001', null, 'edit_message in a soft-deleted room raises HX001, even for the author'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d804',
       '00000000-0000-0000-0000-00000000e803', 'x') $$,
  'HX001', null, 'edit_message in a soft-deleted channel raises HX001, even for the author'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d803',
       '00000000-0000-0000-0000-00000000e803', 'x') $$,
  'HX001', null, 'edit_message on a soft-deleted message raises HX001, even for the author'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e804', 'x') $$,
  'HX001', null, 'edit_message by a non-member raises HX001'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e805', 'x') $$,
  'HX001', null, 'edit_message by a removed member raises HX001'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e806', 'x') $$,
  'HX002', null, 'edit_message by a member who is not the author raises HX002'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e802', 'x') $$,
  'HX002', null, 'edit_message by an admin who is not the author raises HX002'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e801', 'x') $$,
  'HX002', null, 'edit_message by the owner who is not the author raises HX002'
);
select is(
  (select row(m.body, m.edited_at)::text from public.messages m
    where m.id = '00000000-0000-0000-0000-00000000d801'),
  row('hello from M', null::timestamptz)::text,
  'the message is unchanged after the rejected edits'
);

-- ---------------------------------------------------------------------------
-- edit_message: success, author columns, and body checks (54-59)
-- ---------------------------------------------------------------------------
select set_config('test.e1',
  (select row_to_json(e)::text
     from public.edit_message('00000000-0000-0000-0000-00000000d801',
            '00000000-0000-0000-0000-00000000e803', 'edited') e),
  true) is not null as _e1;

select is(
  (select row(j ->> 'id', j ->> 'channel_id', j ->> 'author_id', j ->> 'body',
              j ->> 'edited_at' is not null)::text
     from (select current_setting('test.e1')::jsonb as j) x),
  row('00000000-0000-0000-0000-00000000d801', '00000000-0000-0000-0000-00000000c801',
      '00000000-0000-0000-0000-00000000e803', 'edited', true)::text,
  'the author edits the message; the updated row is returned with edited_at set'
);
select is(
  (select row(j ->> 'author_display_name', j ->> 'author_avatar_url')::text
     from (select current_setting('test.e1')::jsonb as j) x),
  row('Member M', 'https://avatars.example.test/m.jpg')::text,
  'edit_message returns the author''s display_name and avatar_url'
);
select is(
  (select array_agg(k order by k collate "C")
     from jsonb_object_keys(current_setting('test.e1')::jsonb) k),
  array['author_avatar_url', 'author_display_name', 'author_id', 'body', 'channel_id',
        'created_at', 'edited_at', 'id'],
  'edit_message returns the message columns and the author columns, without idempotency_key or deleted_at'
);
select ok(
  (select m.body = 'edited' and m.edited_at is not null and m.edited_at >= m.created_at
     from public.messages m where m.id = '00000000-0000-0000-0000-00000000d801'),
  'the stored message has the new body and edited_at'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e803', '   ') $$,
  '23514', null, 'editing to a blank body raises 23514'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e803', repeat('a', 2001)) $$,
  '23514', null, 'editing to a 2001-character body raises 23514'
);

-- ---------------------------------------------------------------------------
-- delete_message: arguments, rule 4, roles (60-69)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.delete_message(null, '00000000-0000-0000-0000-00000000e803') $$,
  '22023', null, 'delete_message rejects a null message'
);
select throws_ok(
  $$ select public.delete_message('00000000-0000-0000-0000-00000000d801', null) $$,
  '22023', null, 'delete_message rejects a null actor'
);
select throws_ok(
  $$ select public.delete_message('00000000-0000-0000-0000-0000000008ff',
       '00000000-0000-0000-0000-00000000e801') $$,
  'HX001', null, 'delete_message on an unknown message raises HX001'
);
select throws_ok(
  $$ select public.delete_message('00000000-0000-0000-0000-00000000d805',
       '00000000-0000-0000-0000-00000000e801') $$,
  'HX001', null, 'delete_message in a soft-deleted room raises HX001, even for its owner'
);
select throws_ok(
  $$ select public.delete_message('00000000-0000-0000-0000-00000000d804',
       '00000000-0000-0000-0000-00000000e803') $$,
  'HX001', null, 'delete_message in a soft-deleted channel raises HX001, even for the author'
);
select throws_ok(
  $$ select public.delete_message('00000000-0000-0000-0000-00000000d803',
       '00000000-0000-0000-0000-00000000e803') $$,
  'HX001', null, 'delete_message on an already soft-deleted message raises HX001'
);
select throws_ok(
  $$ select public.delete_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e804') $$,
  'HX001', null, 'delete_message by a non-member raises HX001'
);
select throws_ok(
  $$ select public.delete_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e805') $$,
  'HX001', null, 'delete_message by a removed member raises HX001'
);
select throws_ok(
  $$ select public.delete_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e806') $$,
  'HX002', null, 'delete_message by a plain member on another''s message raises HX002'
);
select ok(
  (select m.deleted_at is null from public.messages m where m.id = '00000000-0000-0000-0000-00000000d801'),
  'the message is still live after the rejected deletes'
);

-- ---------------------------------------------------------------------------
-- delete_message: success (70-77)
-- ---------------------------------------------------------------------------
select is(
  (select row(d.id, d.body, d.deleted_at is not null)::text
     from public.delete_message('00000000-0000-0000-0000-00000000d801',
            '00000000-0000-0000-0000-00000000e803') d),
  row('00000000-0000-0000-0000-00000000d801'::uuid, 'edited', true)::text,
  'the author deletes their message; the row is returned with deleted_at set'
);
select ok(
  (select m.deleted_at is not null and m.deleted_at >= m.created_at
     from public.messages m where m.id = '00000000-0000-0000-0000-00000000d801'),
  'the stored message has deleted_at set'
);
select ok(
  (select d.deleted_at is not null
     from public.delete_message('00000000-0000-0000-0000-00000000d807',
            '00000000-0000-0000-0000-00000000e801') d),
  'the owner deletes a member''s message'
);
select ok(
  (select d.deleted_at is not null
     from public.delete_message('00000000-0000-0000-0000-00000000d808',
            '00000000-0000-0000-0000-00000000e802') d),
  'an admin deletes another member''s message'
);
select is(
  (select count(*)::int from public.messages
    where id in ('00000000-0000-0000-0000-00000000d807', '00000000-0000-0000-0000-00000000d808')
      and deleted_at is not null),
  2, 'both moderated messages are stored as deleted'
);
select throws_ok(
  $$ select public.delete_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e803') $$,
  'HX001', null, 'deleting the same message again raises HX001'
);
select throws_ok(
  $$ select public.edit_message('00000000-0000-0000-0000-00000000d801',
       '00000000-0000-0000-0000-00000000e803', 'back again') $$,
  'HX001', null, 'editing a deleted message raises HX001'
);
select is(
  (select m.body from public.messages m where m.id = '00000000-0000-0000-0000-00000000d801'),
  'edited', 'the deleted message''s body was not changed by the rejected edit'
);
reset role;

-- ---------------------------------------------------------------------------
-- Realtime sanity (78-79)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000e803","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select ok(
  private.can_access_topic('channel:00000000-0000-0000-0000-00000000c801'),
  'a member can access channel:<id>'
);
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000e804","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select ok(
  not private.can_access_topic('channel:00000000-0000-0000-0000-00000000c801'),
  'a non-member cannot access channel:<id>'
);
reset role;

select * from finish();
rollback;
