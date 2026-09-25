-- 20260925035847_rooms_update_room: update_room() privileges, argument checks, rule-4
-- error codes, role checks, partial updates, icon exclusivity, returned row, constraints,
-- updated_at.
-- Runs inside the runner's transaction, which is always rolled back.
begin;

select plan(26);

-- ---------------------------------------------------------------------------
-- Fixtures (as the owner role)
-- ---------------------------------------------------------------------------
-- Room R (f601): uploaded icon (icon_path), old updated_at. O owner, A admin, M member.
-- Room D (f602): soft-deleted, O owner. N is never a member of anything.
insert into public.profiles (id, steam_id, display_name) values
  ('00000000-0000-0000-0000-00000000e601', '76561190000000601', 'Owner O'),
  ('00000000-0000-0000-0000-00000000e602', '76561190000000602', 'Admin A'),
  ('00000000-0000-0000-0000-00000000e603', '76561190000000603', 'Member M'),
  ('00000000-0000-0000-0000-00000000e604', '76561190000000604', 'Outsider N');

insert into public.rooms (id, name, icon_emoji, icon_path, created_at, updated_at, deleted_at) values
  ('00000000-0000-0000-0000-00000000f601', 'Update Room', null, 'rooms/f601.png', '2000-01-01', '2000-01-01', null),
  ('00000000-0000-0000-0000-00000000f602', 'Gone Room', 'x', null, '2000-01-01', '2000-01-01', '2000-01-02');

insert into public.room_members (room_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000f601', '00000000-0000-0000-0000-00000000e601', 'owner'),
  ('00000000-0000-0000-0000-00000000f601', '00000000-0000-0000-0000-00000000e602', 'admin'),
  ('00000000-0000-0000-0000-00000000f601', '00000000-0000-0000-0000-00000000e603', 'member'),
  ('00000000-0000-0000-0000-00000000f602', '00000000-0000-0000-0000-00000000e601', 'owner');

-- ---------------------------------------------------------------------------
-- Structure and privileges (1-4)
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('public', 'public.update_room(uuid, uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.update_room(uuid, uuid, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.update_room(uuid, uuid, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.update_room(uuid, uuid, text, text)', 'execute'),
  'update_room is executable by service_role only'
);
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.update_room(uuid, uuid, text, text)'::regprocedure),
  'update_room is security definer with an empty search_path'
);

set local role anon;
select throws_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e601', 'Hacked', null) $$,
  '42501', null, 'anon cannot execute update_room'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000e601","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select throws_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e601', 'Hacked', null) $$,
  '42501', null, 'authenticated cannot execute update_room, even as the owner'
);
reset role;

-- ---------------------------------------------------------------------------
-- Argument checks (5-7)
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select public.update_room(null, '00000000-0000-0000-0000-00000000e601', 'New Name', null) $$,
  '22023', null, 'update_room rejects a null room'
);
select throws_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601', null, 'New Name', null) $$,
  '22023', null, 'update_room rejects a null actor'
);
select throws_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e601', null, null) $$,
  '22023', null, 'update_room with nothing to update raises 22023'
);

-- ---------------------------------------------------------------------------
-- Rule 4 and roles (8-12)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.update_room('00000000-0000-0000-0000-0000000000ff',
       '00000000-0000-0000-0000-00000000e601', 'New Name', null) $$,
  'HX001', null, 'update_room on an unknown room raises HX001'
);
select throws_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f602',
       '00000000-0000-0000-0000-00000000e601', 'New Name', null) $$,
  'HX001', null, 'update_room on a soft-deleted room raises HX001, even for its owner'
);
select throws_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e604', 'New Name', null) $$,
  'HX001', null, 'update_room by a non-member raises HX001'
);
select throws_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e603', 'New Name', 'y') $$,
  'HX002', null, 'update_room by a plain member raises HX002'
);
select ok(
  (select r.name = 'Update Room' and r.icon_emoji is null and r.icon_path = 'rooms/f601.png'
          and r.updated_at = '2000-01-01'::timestamptz
     from public.rooms r where r.id = '00000000-0000-0000-0000-00000000f601'),
  'the room is unchanged after the rejected calls'
);

-- ---------------------------------------------------------------------------
-- Successful updates (13-19)
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e602', 'Admin Renamed', null) $$,
  'an admin can rename the room'
);
select ok(
  (select r.name = 'Admin Renamed' and r.icon_emoji is null and r.icon_path = 'rooms/f601.png'
     from public.rooms r where r.id = '00000000-0000-0000-0000-00000000f601'),
  'a name-only update renames the room and leaves the icon unchanged'
);
select ok(
  (select r.updated_at > '2001-01-01'::timestamptz
     from public.rooms r where r.id = '00000000-0000-0000-0000-00000000f601'),
  'update_room bumps updated_at'
);
select lives_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e601', null, chr(127918)) $$,
  'the owner can change the emoji icon'
);
select ok(
  (select r.name = 'Admin Renamed' and r.icon_emoji = chr(127918) and r.icon_path is null
     from public.rooms r where r.id = '00000000-0000-0000-0000-00000000f601'),
  'setting an emoji clears icon_path and leaves the name unchanged'
);
select lives_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e601', 'Both Changed', 'z') $$,
  'the owner can change the name and emoji together'
);
select ok(
  (select r.name = 'Both Changed' and r.icon_emoji = 'z' and r.icon_path is null
     from public.rooms r where r.id = '00000000-0000-0000-0000-00000000f601'),
  'name and emoji are both updated'
);

-- ---------------------------------------------------------------------------
-- Returned row (20-22)
-- ---------------------------------------------------------------------------
-- Put an uploaded icon back (as the owner role) so the returned row can show icon_path cleared.
reset role;
update public.rooms set icon_emoji = null, icon_path = 'rooms/f601-b.png'
 where id = '00000000-0000-0000-0000-00000000f601';
set local role service_role;

-- The before-update trigger sets updated_at to now(), so the returned row must carry it.
select is(
  (select row(r.id, r.name, r.icon_emoji, r.icon_path, r.deleted_at, r.updated_at = now())::text
     from public.update_room('00000000-0000-0000-0000-00000000f601',
            '00000000-0000-0000-0000-00000000e602', 'Returned Name', 'w') r),
  row('00000000-0000-0000-0000-00000000f601'::uuid, 'Returned Name', 'w', null::text,
      null::timestamptz, true)::text,
  'update_room returns the updated row: new name and emoji, icon_path cleared, bumped updated_at'
);
select is(
  (select row(r.name, r.icon_emoji, r.icon_path)::text
     from public.update_room('00000000-0000-0000-0000-00000000f601',
            '00000000-0000-0000-0000-00000000e601', 'Only Name', null) r),
  row('Only Name', 'w', null::text)::text,
  'a name-only update returns the new name with the emoji unchanged and icon_path still null'
);
select is(
  (select row(r.name, r.icon_emoji, r.icon_path)::text
     from public.rooms r where r.id = '00000000-0000-0000-0000-00000000f601'),
  row('Only Name', 'w', null::text)::text,
  'the stored row matches the row update_room returned'
);

-- ---------------------------------------------------------------------------
-- Check constraints (23-26)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e601', '   ', null) $$,
  '23514', null, 'a blank name raises 23514'
);
select throws_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e601', repeat('a', 49), null) $$,
  '23514', null, 'a 49-character name raises 23514'
);
select lives_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e601', repeat('a', 48), null) $$,
  'a 48-character name is accepted'
);
select throws_ok(
  $$ select public.update_room('00000000-0000-0000-0000-00000000f601',
       '00000000-0000-0000-0000-00000000e601', null, repeat('x', 17)) $$,
  '23514', null, 'a 17-character emoji raises 23514'
);
reset role;

select * from finish();
rollback;
