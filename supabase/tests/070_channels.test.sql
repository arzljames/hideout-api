-- 20260925231826_channels_management: create_channel(), rename_channel(), reorder_channels(),
-- delete_channel() privileges, argument checks, rule-4 error codes, role checks, positions,
-- limits, name uniqueness, reorder set checks, last-text-channel guard, and Realtime access
-- to a deleted channel's topics.
-- Runs inside the runner's transaction, which is always rolled back.
begin;

select plan(98);

-- ---------------------------------------------------------------------------
-- Fixtures (as the owner role)
-- ---------------------------------------------------------------------------
-- Profiles: O owner, A admin, M member (of R, S, X), N never a member of anything.
-- Room R (f701): rename + reorder. text c701 general(0), c702 random(1), c704 old (deleted, 2);
--                voice c703 Lounge(0), c707 Stage(1).
-- Room D (f702): soft-deleted (O owner, A admin) with a still-live text channel c705.
-- Room S (f703): create. text c706 general(0), c709 Archive (deleted, 5); voice c708 voice(0).
-- Room L (f704): the 50-channel limit. O owner; 49 live channels + 1 deleted.
-- Room X (f705): delete. text c711 a(0) with 2 messages, c712 b(1); voice c713 v(0).
insert into public.profiles (id, steam_id, display_name) values
  ('00000000-0000-0000-0000-00000000e701', '76561190000000701', 'Owner O'),
  ('00000000-0000-0000-0000-00000000e702', '76561190000000702', 'Admin A'),
  ('00000000-0000-0000-0000-00000000e703', '76561190000000703', 'Member M'),
  ('00000000-0000-0000-0000-00000000e704', '76561190000000704', 'Outsider N');

insert into public.rooms (id, name, icon_emoji, deleted_at) values
  ('00000000-0000-0000-0000-00000000f701', 'Room R', 'x', null),
  ('00000000-0000-0000-0000-00000000f702', 'Room D', 'x', '2000-01-02'),
  ('00000000-0000-0000-0000-00000000f703', 'Room S', 'x', null),
  ('00000000-0000-0000-0000-00000000f704', 'Room L', 'x', null),
  ('00000000-0000-0000-0000-00000000f705', 'Room X', 'x', null);

insert into public.room_members (room_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000e701', 'owner'),
  ('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000e702', 'admin'),
  ('00000000-0000-0000-0000-00000000f701', '00000000-0000-0000-0000-00000000e703', 'member'),
  ('00000000-0000-0000-0000-00000000f702', '00000000-0000-0000-0000-00000000e701', 'owner'),
  ('00000000-0000-0000-0000-00000000f702', '00000000-0000-0000-0000-00000000e702', 'admin'),
  ('00000000-0000-0000-0000-00000000f703', '00000000-0000-0000-0000-00000000e701', 'owner'),
  ('00000000-0000-0000-0000-00000000f703', '00000000-0000-0000-0000-00000000e702', 'admin'),
  ('00000000-0000-0000-0000-00000000f703', '00000000-0000-0000-0000-00000000e703', 'member'),
  ('00000000-0000-0000-0000-00000000f704', '00000000-0000-0000-0000-00000000e701', 'owner'),
  ('00000000-0000-0000-0000-00000000f705', '00000000-0000-0000-0000-00000000e701', 'owner'),
  ('00000000-0000-0000-0000-00000000f705', '00000000-0000-0000-0000-00000000e702', 'admin'),
  ('00000000-0000-0000-0000-00000000f705', '00000000-0000-0000-0000-00000000e703', 'member');

insert into public.channels (id, room_id, type, name, position, deleted_at) values
  ('00000000-0000-0000-0000-00000000c701', '00000000-0000-0000-0000-00000000f701', 'text',  'general', 0, null),
  ('00000000-0000-0000-0000-00000000c702', '00000000-0000-0000-0000-00000000f701', 'text',  'random',  1, null),
  ('00000000-0000-0000-0000-00000000c703', '00000000-0000-0000-0000-00000000f701', 'voice', 'Lounge',  0, null),
  ('00000000-0000-0000-0000-00000000c704', '00000000-0000-0000-0000-00000000f701', 'text',  'old',     2, '2000-01-02'),
  ('00000000-0000-0000-0000-00000000c707', '00000000-0000-0000-0000-00000000f701', 'voice', 'Stage',   1, null),
  ('00000000-0000-0000-0000-00000000c705', '00000000-0000-0000-0000-00000000f702', 'text',  'ghost',   0, null),
  ('00000000-0000-0000-0000-00000000c706', '00000000-0000-0000-0000-00000000f703', 'text',  'general', 0, null),
  ('00000000-0000-0000-0000-00000000c709', '00000000-0000-0000-0000-00000000f703', 'text',  'Archive', 5, '2000-01-02'),
  ('00000000-0000-0000-0000-00000000c708', '00000000-0000-0000-0000-00000000f703', 'voice', 'voice',   0, null),
  ('00000000-0000-0000-0000-00000000c711', '00000000-0000-0000-0000-00000000f705', 'text',  'a',       0, null),
  ('00000000-0000-0000-0000-00000000c712', '00000000-0000-0000-0000-00000000f705', 'text',  'b',       1, null),
  ('00000000-0000-0000-0000-00000000c713', '00000000-0000-0000-0000-00000000f705', 'voice', 'v',       0, null);

-- Room L: text ch1..ch30 (positions 1..30), voice ch31..ch49 (positions 31..49), plus a
-- deleted text channel at position 100.
insert into public.channels (room_id, type, name, position)
select '00000000-0000-0000-0000-00000000f704', case when g <= 30 then 'text' else 'voice' end, 'ch' || g, g
from generate_series(1, 49) as g;
insert into public.channels (room_id, type, name, position, deleted_at)
values ('00000000-0000-0000-0000-00000000f704', 'text', 'gone', 100, '2000-01-02');

insert into public.messages (channel_id, author_id, body) values
  ('00000000-0000-0000-0000-00000000c711', '00000000-0000-0000-0000-00000000e703', 'first'),
  ('00000000-0000-0000-0000-00000000c711', '00000000-0000-0000-0000-00000000e701', 'second');

-- ---------------------------------------------------------------------------
-- Structure and privileges (1-10)
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('public', 'public.create_channel(uuid, uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.create_channel(uuid, uuid, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.create_channel(uuid, uuid, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.create_channel(uuid, uuid, text, text)', 'execute'),
  'create_channel is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.rename_channel(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.rename_channel(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.rename_channel(uuid, uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.rename_channel(uuid, uuid, text)', 'execute'),
  'rename_channel is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.reorder_channels(uuid, uuid, text, uuid[])', 'execute')
  and not has_function_privilege('anon', 'public.reorder_channels(uuid, uuid, text, uuid[])', 'execute')
  and not has_function_privilege('authenticated', 'public.reorder_channels(uuid, uuid, text, uuid[])', 'execute')
  and has_function_privilege('service_role', 'public.reorder_channels(uuid, uuid, text, uuid[])', 'execute'),
  'reorder_channels is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.delete_channel(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.delete_channel(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.delete_channel(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.delete_channel(uuid, uuid)', 'execute'),
  'delete_channel is executable by service_role only'
);

select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.create_channel(uuid, uuid, text, text)'::regprocedure),
  'create_channel is security definer with an empty search_path'
);
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.rename_channel(uuid, uuid, text)'::regprocedure),
  'rename_channel is security definer with an empty search_path'
);
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.reorder_channels(uuid, uuid, text, uuid[])'::regprocedure),
  'reorder_channels is security definer with an empty search_path'
);
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.delete_channel(uuid, uuid)'::regprocedure),
  'delete_channel is security definer with an empty search_path'
);

set local role anon;
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f703',
       '00000000-0000-0000-0000-00000000e701', 'text', 'hacked') $$,
  '42501', null, 'anon cannot execute create_channel'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000e701","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select throws_ok(
  $$ select public.delete_channel('00000000-0000-0000-0000-00000000c712',
       '00000000-0000-0000-0000-00000000e701') $$,
  '42501', null, 'authenticated cannot execute delete_channel, even as the owner'
);
reset role;

-- ---------------------------------------------------------------------------
-- create_channel: arguments, rule 4, roles (11-20)
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select public.create_channel(null, '00000000-0000-0000-0000-00000000e701', 'text', 'new') $$,
  '22023', null, 'create_channel rejects a null room'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f703', null, 'text', 'new') $$,
  '22023', null, 'create_channel rejects a null actor'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f703',
       '00000000-0000-0000-0000-00000000e701', null, 'new') $$,
  '22023', null, 'create_channel rejects a null type'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f703',
       '00000000-0000-0000-0000-00000000e701', 'text', null) $$,
  '22023', null, 'create_channel rejects a null name'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f703',
       '00000000-0000-0000-0000-00000000e701', 'stage', 'new') $$,
  '22023', null, 'create_channel rejects a type other than text or voice'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-0000000000ff',
       '00000000-0000-0000-0000-00000000e701', 'text', 'new') $$,
  'HX001', null, 'create_channel in an unknown room raises HX001'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f702',
       '00000000-0000-0000-0000-00000000e701', 'text', 'new') $$,
  'HX001', null, 'create_channel in a soft-deleted room raises HX001, even for its owner'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f703',
       '00000000-0000-0000-0000-00000000e704', 'text', 'new') $$,
  'HX001', null, 'create_channel by a non-member raises HX001'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f703',
       '00000000-0000-0000-0000-00000000e703', 'text', 'new') $$,
  'HX002', null, 'create_channel by a plain member raises HX002'
);
select is(
  (select count(*)::int from public.channels where room_id = '00000000-0000-0000-0000-00000000f703'),
  3, 'no channel was created by the rejected calls'
);

-- ---------------------------------------------------------------------------
-- create_channel: success, positions, names (21-29)
-- ---------------------------------------------------------------------------
select is(
  (select row(c.room_id, c.type, c.name, c.position, c.deleted_at)::text
     from public.create_channel('00000000-0000-0000-0000-00000000f703',
            '00000000-0000-0000-0000-00000000e702', 'text', 'Chat') c),
  row('00000000-0000-0000-0000-00000000f703'::uuid, 'text', 'Chat', 1, null::timestamptz)::text,
  'an admin creates a text channel at position 1 (deleted channels ignored for position)'
);
select is(
  (select row(c.type, c.name, c.position)::text
     from public.create_channel('00000000-0000-0000-0000-00000000f703',
            '00000000-0000-0000-0000-00000000e701', 'voice', 'Voice Two') c),
  row('voice', 'Voice Two', 1)::text,
  'the owner creates a voice channel; voice positions are independent of text'
);
select is(
  (select c.position
     from public.create_channel('00000000-0000-0000-0000-00000000f703',
            '00000000-0000-0000-0000-00000000e701', 'text', 'Third') c),
  2, 'the next text channel is appended at position 2'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f703',
       '00000000-0000-0000-0000-00000000e701', 'text', 'CHAT') $$,
  '23505', null, 'a live name of the same type, differing only in case, raises 23505'
);
select is(
  (select row(c.type, c.name, c.position)::text
     from public.create_channel('00000000-0000-0000-0000-00000000f703',
            '00000000-0000-0000-0000-00000000e701', 'voice', 'chat') c),
  row('voice', 'chat', 2)::text,
  'the same name is allowed for the other channel type'
);
select is(
  (select row(c.type, c.name, c.position)::text
     from public.create_channel('00000000-0000-0000-0000-00000000f703',
            '00000000-0000-0000-0000-00000000e701', 'text', 'archive') c),
  row('text', 'archive', 3)::text,
  'a soft-deleted channel''s name can be reused'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f703',
       '00000000-0000-0000-0000-00000000e701', 'text', repeat('a', 33)) $$,
  '23514', null, 'a 33-character name raises 23514'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f703',
       '00000000-0000-0000-0000-00000000e701', 'text', '   ') $$,
  '23514', null, 'a blank name raises 23514'
);
select is(
  (select array_agg(c.name order by c.position)
     from public.channels c
    where c.room_id = '00000000-0000-0000-0000-00000000f703' and c.type = 'text' and c.deleted_at is null),
  array['general', 'Chat', 'Third', 'archive'],
  'stored live text channels are general, Chat, Third, archive in position order'
);

-- ---------------------------------------------------------------------------
-- create_channel: 50-channel limit (30-32)
-- ---------------------------------------------------------------------------
select is(
  (select c.position
     from public.create_channel('00000000-0000-0000-0000-00000000f704',
            '00000000-0000-0000-0000-00000000e701', 'text', 'fiftieth') c),
  31, 'the 50th live channel is created (deleted channels count toward neither limit nor position)'
);
select throws_ok(
  $$ select public.create_channel('00000000-0000-0000-0000-00000000f704',
       '00000000-0000-0000-0000-00000000e701', 'voice', 'fifty-first') $$,
  'HX006', null, 'the 51st live channel raises HX006'
);
select is(
  (select count(*)::int from public.channels
    where room_id = '00000000-0000-0000-0000-00000000f704' and deleted_at is null),
  50, 'the room has exactly 50 live channels'
);

-- ---------------------------------------------------------------------------
-- rename_channel: arguments, rule 4, roles (33-41)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.rename_channel(null, '00000000-0000-0000-0000-00000000e701', 'new') $$,
  '22023', null, 'rename_channel rejects a null channel'
);
select throws_ok(
  $$ select public.rename_channel('00000000-0000-0000-0000-00000000c701', null, 'new') $$,
  '22023', null, 'rename_channel rejects a null actor'
);
select throws_ok(
  $$ select public.rename_channel('00000000-0000-0000-0000-00000000c701',
       '00000000-0000-0000-0000-00000000e701', null) $$,
  '22023', null, 'rename_channel rejects a null name'
);
select throws_ok(
  $$ select public.rename_channel('00000000-0000-0000-0000-0000000000ff',
       '00000000-0000-0000-0000-00000000e701', 'new') $$,
  'HX001', null, 'rename_channel on an unknown channel raises HX001'
);
select throws_ok(
  $$ select public.rename_channel('00000000-0000-0000-0000-00000000c705',
       '00000000-0000-0000-0000-00000000e701', 'new') $$,
  'HX001', null, 'rename_channel on a channel of a soft-deleted room raises HX001, even for its owner'
);
select throws_ok(
  $$ select public.rename_channel('00000000-0000-0000-0000-00000000c704',
       '00000000-0000-0000-0000-00000000e701', 'new') $$,
  'HX001', null, 'rename_channel on a soft-deleted channel raises HX001'
);
select throws_ok(
  $$ select public.rename_channel('00000000-0000-0000-0000-00000000c701',
       '00000000-0000-0000-0000-00000000e704', 'new') $$,
  'HX001', null, 'rename_channel by a non-member raises HX001'
);
select throws_ok(
  $$ select public.rename_channel('00000000-0000-0000-0000-00000000c701',
       '00000000-0000-0000-0000-00000000e703', 'new') $$,
  'HX002', null, 'rename_channel by a plain member raises HX002'
);
select is(
  (select name from public.channels where id = '00000000-0000-0000-0000-00000000c701'),
  'general', 'the channel is unchanged after the rejected calls'
);

-- ---------------------------------------------------------------------------
-- rename_channel: success and names (42-48)
-- ---------------------------------------------------------------------------
select is(
  (select row(c.id, c.room_id, c.type, c.name, c.position, c.deleted_at)::text
     from public.rename_channel('00000000-0000-0000-0000-00000000c701',
            '00000000-0000-0000-0000-00000000e702', 'lobby') c),
  row('00000000-0000-0000-0000-00000000c701'::uuid, '00000000-0000-0000-0000-00000000f701'::uuid,
      'text', 'lobby', 0, null::timestamptz)::text,
  'an admin renames a channel; the updated row is returned'
);
select is(
  (select c.name
     from public.rename_channel('00000000-0000-0000-0000-00000000c702',
            '00000000-0000-0000-0000-00000000e701', 'Memes') c),
  'Memes', 'the owner renames a channel'
);
select is(
  (select array_agg(c.name order by c.position)
     from public.channels c
    where c.room_id = '00000000-0000-0000-0000-00000000f701' and c.type = 'text' and c.deleted_at is null),
  array['lobby', 'Memes'],
  'the stored names match the renames'
);
select throws_ok(
  $$ select public.rename_channel('00000000-0000-0000-0000-00000000c702',
       '00000000-0000-0000-0000-00000000e701', 'LOBBY') $$,
  '23505', null, 'renaming to another live channel''s name of the same type (any case) raises 23505'
);
select is(
  (select c.name
     from public.rename_channel('00000000-0000-0000-0000-00000000c703',
            '00000000-0000-0000-0000-00000000e701', 'lobby') c),
  'lobby', 'a voice channel may share a text channel''s name'
);
select is(
  (select c.name
     from public.rename_channel('00000000-0000-0000-0000-00000000c701',
            '00000000-0000-0000-0000-00000000e701', 'Lobby') c),
  'Lobby', 'a channel can be renamed to a different case of its own name'
);
select throws_ok(
  $$ select public.rename_channel('00000000-0000-0000-0000-00000000c701',
       '00000000-0000-0000-0000-00000000e701', repeat('a', 33)) $$,
  '23514', null, 'renaming to a 33-character name raises 23514'
);

-- ---------------------------------------------------------------------------
-- reorder_channels: arguments, rule 4, roles (49-58)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select * from public.reorder_channels(null, '00000000-0000-0000-0000-00000000e701', 'text',
       array['00000000-0000-0000-0000-00000000c702', '00000000-0000-0000-0000-00000000c701']::uuid[]) $$,
  '22023', null, 'reorder_channels rejects a null room'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701', null, 'text',
       array['00000000-0000-0000-0000-00000000c702', '00000000-0000-0000-0000-00000000c701']::uuid[]) $$,
  '22023', null, 'reorder_channels rejects a null actor'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e701', null,
       array['00000000-0000-0000-0000-00000000c702', '00000000-0000-0000-0000-00000000c701']::uuid[]) $$,
  '22023', null, 'reorder_channels rejects a null type'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e701', 'text', null) $$,
  '22023', null, 'reorder_channels rejects a null id array'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e701', 'stage',
       array['00000000-0000-0000-0000-00000000c702', '00000000-0000-0000-0000-00000000c701']::uuid[]) $$,
  '22023', null, 'reorder_channels rejects a type other than text or voice'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-0000000000ff',
       '00000000-0000-0000-0000-00000000e701', 'text',
       array['00000000-0000-0000-0000-00000000c702', '00000000-0000-0000-0000-00000000c701']::uuid[]) $$,
  'HX001', null, 'reorder_channels in an unknown room raises HX001'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f702',
       '00000000-0000-0000-0000-00000000e701', 'text',
       array['00000000-0000-0000-0000-00000000c705']::uuid[]) $$,
  'HX001', null, 'reorder_channels in a soft-deleted room raises HX001, even for its owner'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e704', 'text',
       array['00000000-0000-0000-0000-00000000c702', '00000000-0000-0000-0000-00000000c701']::uuid[]) $$,
  'HX001', null, 'reorder_channels by a non-member raises HX001'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e703', 'text',
       array['00000000-0000-0000-0000-00000000c702', '00000000-0000-0000-0000-00000000c701']::uuid[]) $$,
  'HX002', null, 'reorder_channels by a plain member raises HX002'
);
select is(
  (select array_agg(c.id::text || ':' || c.position order by c.id)
     from public.channels c where c.room_id = '00000000-0000-0000-0000-00000000f701'),
  array['00000000-0000-0000-0000-00000000c701:0', '00000000-0000-0000-0000-00000000c702:1',
        '00000000-0000-0000-0000-00000000c703:0', '00000000-0000-0000-0000-00000000c704:2',
        '00000000-0000-0000-0000-00000000c707:1'],
  'positions are unchanged after the rejected calls'
);

-- ---------------------------------------------------------------------------
-- reorder_channels: set mismatches (59-67)
-- ---------------------------------------------------------------------------
-- Room R live text channels: c701, c702. Live voice: c703, c707. Deleted text: c704.
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e701', 'text',
       array['00000000-0000-0000-0000-00000000c701']::uuid[]) $$,
  'HX007', null, 'a missing live channel id raises HX007'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e701', 'text',
       array['00000000-0000-0000-0000-00000000c701', '00000000-0000-0000-0000-00000000c702',
             '00000000-0000-0000-0000-00000000c706']::uuid[]) $$,
  'HX007', null, 'an extra id from another room raises HX007'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e701', 'text',
       array['00000000-0000-0000-0000-00000000c701', '00000000-0000-0000-0000-00000000c706']::uuid[]) $$,
  'HX007', null, 'swapping a live id for another room''s id (same count) raises HX007'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e701', 'text',
       array['00000000-0000-0000-0000-00000000c701', '00000000-0000-0000-0000-00000000c701']::uuid[]) $$,
  'HX007', null, 'a duplicate id raises HX007'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e701', 'text',
       array['00000000-0000-0000-0000-00000000c701', '00000000-0000-0000-0000-00000000c703']::uuid[]) $$,
  'HX007', null, 'an id of the other channel type raises HX007'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e701', 'text',
       array['00000000-0000-0000-0000-00000000c701', '00000000-0000-0000-0000-00000000c704']::uuid[]) $$,
  'HX007', null, 'a soft-deleted channel id raises HX007'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e701', 'text',
       array['00000000-0000-0000-0000-00000000c701', null]::uuid[]) $$,
  'HX007', null, 'a null element raises HX007'
);
select throws_ok(
  $$ select * from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
       '00000000-0000-0000-0000-00000000e701', 'text', array[]::uuid[]) $$,
  'HX007', null, 'an empty array for a type with live channels raises HX007'
);
select is(
  (select array_agg(c.id::text || ':' || c.position order by c.id)
     from public.channels c where c.room_id = '00000000-0000-0000-0000-00000000f701'),
  array['00000000-0000-0000-0000-00000000c701:0', '00000000-0000-0000-0000-00000000c702:1',
        '00000000-0000-0000-0000-00000000c703:0', '00000000-0000-0000-0000-00000000c704:2',
        '00000000-0000-0000-0000-00000000c707:1'],
  'positions are unchanged after the mismatched calls'
);

-- ---------------------------------------------------------------------------
-- reorder_channels: success (68-71)
-- ---------------------------------------------------------------------------
select is(
  (select array_agg(x.id::text || ':' || x.position order by x.ordinality)
     from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
            '00000000-0000-0000-0000-00000000e702', 'text',
            array['00000000-0000-0000-0000-00000000c702', '00000000-0000-0000-0000-00000000c701']::uuid[])
          with ordinality as x),
  array['00000000-0000-0000-0000-00000000c702:0', '00000000-0000-0000-0000-00000000c701:1'],
  'an admin reorders text channels; the live text channels are returned in the new order'
);
select is(
  (select array_agg(x.id::text || ':' || x.position order by x.ordinality)
     from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
            '00000000-0000-0000-0000-00000000e701', 'voice',
            array['00000000-0000-0000-0000-00000000c707', '00000000-0000-0000-0000-00000000c703']::uuid[])
          with ordinality as x),
  array['00000000-0000-0000-0000-00000000c707:0', '00000000-0000-0000-0000-00000000c703:1'],
  'the owner reorders voice channels; the live voice channels are returned in the new order'
);
select is(
  (select array_agg(c.id::text || ':' || c.position order by c.id)
     from public.channels c where c.room_id = '00000000-0000-0000-0000-00000000f701'),
  array['00000000-0000-0000-0000-00000000c701:1', '00000000-0000-0000-0000-00000000c702:0',
        '00000000-0000-0000-0000-00000000c703:1', '00000000-0000-0000-0000-00000000c704:2',
        '00000000-0000-0000-0000-00000000c707:0'],
  'the new positions are stored; the soft-deleted channel keeps its position'
);
select is(
  (select array_agg(c.id::text || ':' || c.position order by c.id)
     from public.channels c where c.room_id = '00000000-0000-0000-0000-00000000f703'
      and c.id in ('00000000-0000-0000-0000-00000000c706', '00000000-0000-0000-0000-00000000c708')),
  array['00000000-0000-0000-0000-00000000c706:0', '00000000-0000-0000-0000-00000000c708:0'],
  'channels of other rooms are untouched'
);

-- ---------------------------------------------------------------------------
-- reorder_channels: partial and no-op reorders (72-76)
-- ---------------------------------------------------------------------------
-- Room S live text channels at this point: general(0), Chat(1), Third(2), archive(3);
-- deleted Archive c709 at 5. Swap only the middle two; general and archive stay put.
select is(
  (select array_agg(x.name || ':' || x.position order by x.ordinality)
     from public.reorder_channels('00000000-0000-0000-0000-00000000f703',
            '00000000-0000-0000-0000-00000000e702', 'text',
            array[
              '00000000-0000-0000-0000-00000000c706',
              (select id from public.channels where room_id = '00000000-0000-0000-0000-00000000f703'
                 and type = 'text' and name = 'Third' and deleted_at is null),
              (select id from public.channels where room_id = '00000000-0000-0000-0000-00000000f703'
                 and type = 'text' and name = 'Chat' and deleted_at is null),
              (select id from public.channels where room_id = '00000000-0000-0000-0000-00000000f703'
                 and type = 'text' and name = 'archive' and deleted_at is null)
            ]::uuid[])
          with ordinality as x),
  array['general:0', 'Third:1', 'Chat:2', 'archive:3'],
  'a partial reorder returns the new order; channels left in place keep their positions'
);
select is(
  (select array_agg(c.name || ':' || c.position order by c.position, c.name)
     from public.channels c
    where c.room_id = '00000000-0000-0000-0000-00000000f703' and c.type = 'text'),
  array['general:0', 'Third:1', 'Chat:2', 'archive:3', 'Archive:5'],
  'after a partial reorder, unmoved channels are unchanged, moved ones are correct, and the deleted one keeps its position'
);

-- Room R live text order at this point: c702(0), c701(1). Record row versions, then
-- submit the same order: nothing moves, so no row is rewritten.
select set_config('hideout.test_ctids',
  (select string_agg(c.id::text || '@' || c.ctid::text, ',' order by c.id)
     from public.channels c where c.room_id = '00000000-0000-0000-0000-00000000f701'),
  true) is not null as _c;
select is(
  (select array_agg(x.id::text || ':' || x.position order by x.ordinality)
     from public.reorder_channels('00000000-0000-0000-0000-00000000f701',
            '00000000-0000-0000-0000-00000000e701', 'text',
            array['00000000-0000-0000-0000-00000000c702', '00000000-0000-0000-0000-00000000c701']::uuid[])
          with ordinality as x),
  array['00000000-0000-0000-0000-00000000c702:0', '00000000-0000-0000-0000-00000000c701:1'],
  'a no-op reorder (same order) succeeds and returns the same order'
);
select is(
  (select array_agg(c.id::text || ':' || c.position order by c.id)
     from public.channels c where c.room_id = '00000000-0000-0000-0000-00000000f701'),
  array['00000000-0000-0000-0000-00000000c701:1', '00000000-0000-0000-0000-00000000c702:0',
        '00000000-0000-0000-0000-00000000c703:1', '00000000-0000-0000-0000-00000000c704:2',
        '00000000-0000-0000-0000-00000000c707:0'],
  'a no-op reorder leaves every stored position unchanged'
);
select is(
  (select string_agg(c.id::text || '@' || c.ctid::text, ',' order by c.id)
     from public.channels c where c.room_id = '00000000-0000-0000-0000-00000000f701'),
  current_setting('hideout.test_ctids'),
  'a no-op reorder rewrites no rows (row versions unchanged)'
);

-- ---------------------------------------------------------------------------
-- delete_channel: arguments, rule 4, roles (77-84)
-- ---------------------------------------------------------------------------
-- Room X: text c711 (2 messages), c712; voice c713.
select throws_ok(
  $$ select public.delete_channel(null, '00000000-0000-0000-0000-00000000e701') $$,
  '22023', null, 'delete_channel rejects a null channel'
);
select throws_ok(
  $$ select public.delete_channel('00000000-0000-0000-0000-00000000c711', null) $$,
  '22023', null, 'delete_channel rejects a null actor'
);
select throws_ok(
  $$ select public.delete_channel('00000000-0000-0000-0000-0000000000ff',
       '00000000-0000-0000-0000-00000000e701') $$,
  'HX001', null, 'delete_channel on an unknown channel raises HX001'
);
select throws_ok(
  $$ select public.delete_channel('00000000-0000-0000-0000-00000000c705',
       '00000000-0000-0000-0000-00000000e701') $$,
  'HX001', null, 'delete_channel on a channel of a soft-deleted room raises HX001, even for its owner'
);
select throws_ok(
  $$ select public.delete_channel('00000000-0000-0000-0000-00000000c704',
       '00000000-0000-0000-0000-00000000e701') $$,
  'HX001', null, 'delete_channel on an already soft-deleted channel raises HX001'
);
select throws_ok(
  $$ select public.delete_channel('00000000-0000-0000-0000-00000000c711',
       '00000000-0000-0000-0000-00000000e704') $$,
  'HX001', null, 'delete_channel by a non-member raises HX001'
);
select throws_ok(
  $$ select public.delete_channel('00000000-0000-0000-0000-00000000c711',
       '00000000-0000-0000-0000-00000000e703') $$,
  'HX002', null, 'delete_channel by a plain member raises HX002'
);
select is(
  (select count(*)::int from public.channels
    where room_id = '00000000-0000-0000-0000-00000000f705' and deleted_at is null),
  3, 'no channel was deleted by the rejected calls'
);
reset role;

-- ---------------------------------------------------------------------------
-- Realtime baseline before the delete (85)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000e703","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select ok(
  private.can_access_topic('channel:00000000-0000-0000-0000-00000000c711'),
  'before the delete, a member can access channel:<id>'
);
reset role;

-- ---------------------------------------------------------------------------
-- delete_channel: success, last-text guard, messages (86-93)
-- ---------------------------------------------------------------------------
set local role service_role;
select is(
  (select row(c.id, c.type, c.name, c.deleted_at is not null)::text
     from public.delete_channel('00000000-0000-0000-0000-00000000c711',
            '00000000-0000-0000-0000-00000000e702') c),
  row('00000000-0000-0000-0000-00000000c711'::uuid, 'text', 'a', true)::text,
  'an admin deletes one of two text channels; the row is returned with deleted_at set'
);
select ok(
  (select deleted_at is not null and deleted_at <= now()
     from public.channels where id = '00000000-0000-0000-0000-00000000c711'),
  'the stored channel has deleted_at set'
);
select is(
  (select count(*)::int from public.messages
    where channel_id = '00000000-0000-0000-0000-00000000c711' and deleted_at is null),
  2, 'the deleted channel''s messages are untouched'
);
select throws_ok(
  $$ select public.delete_channel('00000000-0000-0000-0000-00000000c712',
       '00000000-0000-0000-0000-00000000e701') $$,
  'HX008', null, 'deleting the last live text channel raises HX008, even for the owner'
);
select ok(
  (select deleted_at is null from public.channels where id = '00000000-0000-0000-0000-00000000c712'),
  'the last text channel is still live'
);
select is(
  (select row(c.id, c.type, c.deleted_at is not null)::text
     from public.delete_channel('00000000-0000-0000-0000-00000000c713',
            '00000000-0000-0000-0000-00000000e701') c),
  row('00000000-0000-0000-0000-00000000c713'::uuid, 'voice', true)::text,
  'the owner can delete the last voice channel'
);
select ok(
  (select deleted_at is not null from public.channels where id = '00000000-0000-0000-0000-00000000c713'),
  'the voice channel is stored as deleted'
);
select throws_ok(
  $$ select public.delete_channel('00000000-0000-0000-0000-00000000c711',
       '00000000-0000-0000-0000-00000000e701') $$,
  'HX001', null, 'deleting the same channel again raises HX001'
);
reset role;

-- ---------------------------------------------------------------------------
-- Realtime after the delete (94-98)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000e703","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select ok(
  not private.can_access_topic('channel:00000000-0000-0000-0000-00000000c711'),
  'after the delete, a member cannot access channel:<id> of the deleted channel'
);
select ok(
  not private.can_access_topic('typing:00000000-0000-0000-0000-00000000c711'),
  'after the delete, a member cannot access typing:<id> of the deleted channel'
);
select ok(
  not private.can_access_topic('channel:00000000-0000-0000-0000-00000000c713'),
  'after the delete, a member cannot access channel:<id> of the deleted voice channel'
);
select ok(
  private.can_access_topic('channel:00000000-0000-0000-0000-00000000c712'),
  'a member can still access channel:<id> of the remaining live channel'
);
select ok(
  private.can_access_topic('room:00000000-0000-0000-0000-00000000f705'),
  'a member can still access room:<id> after a channel delete'
);
reset role;

select * from finish();
rollback;
