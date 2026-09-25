-- 20260925010655_core_schema_fixes: rule-4 error codes, remove_member(), change_role(),
-- the owner-row guard and rooms.updated_at triggers, room-icons bucket, SteamID64 checks,
-- invite expiry check, messages.created_at default, lowercase-only topic uuids, and
-- delete_room side effects.
-- Runs inside the runner's transaction, which is always rolled back.
begin;

select plan(56);

-- ---------------------------------------------------------------------------
-- Fixtures (as the owner role)
-- ---------------------------------------------------------------------------
-- Room R: O owner, A and A2 admins, M1..M3 members. N is never a member.
insert into public.profiles (id, steam_id, display_name) values
  ('00000000-0000-0000-0000-00000000e501', '76561190000000501', 'Owner O'),
  ('00000000-0000-0000-0000-00000000e502', '76561190000000502', 'Admin A'),
  ('00000000-0000-0000-0000-00000000e503', '76561190000000503', 'Admin A2'),
  ('00000000-0000-0000-0000-00000000e504', '76561190000000504', 'Member M1'),
  ('00000000-0000-0000-0000-00000000e505', '76561190000000505', 'Member M2'),
  ('00000000-0000-0000-0000-00000000e506', '76561190000000506', 'Member M3'),
  ('00000000-0000-0000-0000-00000000e507', '76561190000000507', 'Outsider N');

select set_config('test.r',
  public.create_room('00000000-0000-0000-0000-00000000e501', 'Fixes Room', 'x', null)::text, true) is not null as _r;

insert into public.room_members (room_id, user_id, role) values
  (current_setting('test.r')::uuid, '00000000-0000-0000-0000-00000000e502', 'admin'),
  (current_setting('test.r')::uuid, '00000000-0000-0000-0000-00000000e503', 'admin'),
  (current_setting('test.r')::uuid, '00000000-0000-0000-0000-00000000e504', 'member'),
  (current_setting('test.r')::uuid, '00000000-0000-0000-0000-00000000e505', 'member'),
  (current_setting('test.r')::uuid, '00000000-0000-0000-0000-00000000e506', 'member');

-- ---------------------------------------------------------------------------
-- Structure and privileges (1-6)
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('public', 'public.remove_member(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.remove_member(uuid, uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.remove_member(uuid, uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.remove_member(uuid, uuid, uuid)', 'execute'),
  'remove_member is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.change_role(uuid, uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.change_role(uuid, uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.change_role(uuid, uuid, uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.change_role(uuid, uuid, uuid, text)', 'execute'),
  'change_role is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.rooms_set_updated_at()', 'execute')
  and not has_function_privilege('anon', 'public.rooms_set_updated_at()', 'execute')
  and not has_function_privilege('authenticated', 'public.rooms_set_updated_at()', 'execute')
  and not has_function_privilege('public', 'public.room_members_protect_owner()', 'execute')
  and not has_function_privilege('anon', 'public.room_members_protect_owner()', 'execute')
  and not has_function_privilege('authenticated', 'public.room_members_protect_owner()', 'execute'),
  'trigger functions are not executable by PUBLIC, anon, or authenticated'
);
select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
     from pg_catalog.pg_proc p
    where p.oid in (
      'public.remove_member(uuid, uuid, uuid)'::regprocedure,
      'public.change_role(uuid, uuid, uuid, text)'::regprocedure,
      'public.room_members_protect_owner()'::regprocedure,
      'public.transfer_ownership(uuid, uuid, uuid)'::regprocedure,
      'public.delete_room(uuid, uuid)'::regprocedure,
      'public.redeem_invite_link(text, uuid)'::regprocedure,
      'public.respond_to_direct_invite(uuid, uuid, boolean)'::regprocedure)),
  'new and replaced functions are security definer with an empty search_path'
);
select has_trigger('public', 'room_members', 'room_members_protect_owner', 'room_members has the owner-row guard trigger');
select has_trigger('public', 'rooms', 'rooms_set_updated_at', 'rooms has the updated_at trigger');

-- ---------------------------------------------------------------------------
-- room-icons bucket (7-9)
-- ---------------------------------------------------------------------------
select ok(
  (select not b.public from storage.buckets b where b.id = 'room-icons'),
  'the room-icons bucket exists and is private'
);
select ok(
  (select b.file_size_limit = 262144
      and b.allowed_mime_types @> array['image/png', 'image/jpeg', 'image/webp']
      and b.allowed_mime_types <@ array['image/png', 'image/jpeg', 'image/webp']
     from storage.buckets b where b.id = 'room-icons'),
  'room-icons allows 256 KiB png/jpeg/webp only'
);
select is(
  (select count(*)::int from pg_catalog.pg_policies
    where schemaname = 'storage' and tablename in ('objects', 'buckets')
      and roles && array['anon', 'authenticated', 'public']::name[]),
  0,
  'no storage.objects or storage.buckets policies for anon, authenticated, or PUBLIC'
);

-- ---------------------------------------------------------------------------
-- Rule 4: non-members get HX001, members lacking the role get HX002 (10-13)
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select public.transfer_ownership(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e507', '00000000-0000-0000-0000-00000000e501') $$,
  'HX001', null, 'transfer_ownership from a non-member raises HX001'
);
select throws_ok(
  $$ select public.delete_room(current_setting('test.r')::uuid, '00000000-0000-0000-0000-00000000e507') $$,
  'HX001', null, 'delete_room by a non-member raises HX001'
);
select throws_ok(
  $$ select public.delete_room(current_setting('test.r')::uuid, '00000000-0000-0000-0000-00000000e504') $$,
  'HX002', null, 'delete_room by a member who is not the owner raises HX002'
);
select throws_ok(
  $$ select public.transfer_ownership(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e504', '00000000-0000-0000-0000-00000000e501') $$,
  'HX002', null, 'transfer_ownership from a member who is not the owner raises HX002'
);

-- ---------------------------------------------------------------------------
-- remove_member (14-26)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.remove_member(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e507', '00000000-0000-0000-0000-00000000e504') $$,
  'HX001', null, 'remove_member by a non-member raises HX001'
);
select throws_ok(
  $$ select public.remove_member(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e507') $$,
  'HX003', null, 'remove_member of a non-member target raises HX003'
);
select throws_ok(
  $$ select public.remove_member(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e504', '00000000-0000-0000-0000-00000000e505') $$,
  'HX002', null, 'a member cannot remove another member (HX002)'
);
select throws_ok(
  $$ select public.remove_member(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e502', '00000000-0000-0000-0000-00000000e501') $$,
  'HX005', null, 'an admin cannot remove the owner (HX005)'
);
select throws_ok(
  $$ select public.remove_member(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e501') $$,
  'HX005', null, 'the owner cannot leave (HX005)'
);
select throws_ok(
  $$ select public.remove_member(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e502', '00000000-0000-0000-0000-00000000e503') $$,
  'HX002', null, 'an admin cannot remove another admin (HX002)'
);
select throws_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-0000000000ff',
       '00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e504') $$,
  'HX001', null, 'remove_member on an unknown room raises HX001'
);
select throws_ok(
  $$ select public.remove_member(current_setting('test.r')::uuid, null, '00000000-0000-0000-0000-00000000e504') $$,
  '22023', null, 'remove_member rejects a null actor'
);
select lives_ok(
  $$ select public.remove_member(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e502', '00000000-0000-0000-0000-00000000e504') $$,
  'an admin can remove a member'
);
select is(
  (select count(*)::int from public.room_members
    where room_id = current_setting('test.r')::uuid and user_id = '00000000-0000-0000-0000-00000000e504'),
  0, 'the removed member no longer has a membership row'
);
select lives_ok(
  $$ select public.remove_member(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e505', '00000000-0000-0000-0000-00000000e505') $$,
  'a member can leave'
);
select lives_ok(
  $$ select public.remove_member(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e503') $$,
  'the owner can remove an admin'
);
select is(
  (select array_agg(user_id::text order by user_id) from public.room_members
    where room_id = current_setting('test.r')::uuid),
  array['00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e502',
        '00000000-0000-0000-0000-00000000e506'],
  'only the owner, admin A, and member M3 remain'
);

-- ---------------------------------------------------------------------------
-- change_role (27-35)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.change_role(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e502', '00000000-0000-0000-0000-00000000e506', 'admin') $$,
  'HX002', null, 'an admin cannot change roles (HX002)'
);
select throws_ok(
  $$ select public.change_role(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e501', 'member') $$,
  'HX004', null, 'the owner cannot change their own role (HX004)'
);
select throws_ok(
  $$ select public.change_role(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e507', 'admin') $$,
  'HX003', null, 'change_role on a non-member target raises HX003'
);
select throws_ok(
  $$ select public.change_role(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e506', 'owner') $$,
  '22023', null, 'change_role cannot grant owner (use transfer_ownership)'
);
select throws_ok(
  $$ select public.change_role(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e507', '00000000-0000-0000-0000-00000000e506', 'admin') $$,
  'HX001', null, 'change_role by a non-member raises HX001'
);
select lives_ok(
  $$ select public.change_role(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e506', 'admin') $$,
  'the owner can promote a member to admin'
);
select is(
  (select role from public.room_members
    where room_id = current_setting('test.r')::uuid and user_id = '00000000-0000-0000-0000-00000000e506'),
  'admin', 'the promoted member is now an admin'
);
select lives_ok(
  $$ select public.change_role(current_setting('test.r')::uuid,
       '00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e502', 'member') $$,
  'the owner can demote an admin to member'
);
select is(
  (select role from public.room_members
    where room_id = current_setting('test.r')::uuid and user_id = '00000000-0000-0000-0000-00000000e502'),
  'member', 'the demoted admin is now a member'
);
reset role;

-- ---------------------------------------------------------------------------
-- Owner-row guard trigger (36-38)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ delete from public.room_members
     where room_id = current_setting('test.r')::uuid and user_id = '00000000-0000-0000-0000-00000000e501' $$,
  'HX005', null, 'deleting the owner row of a live room raises HX005'
);
select throws_ok(
  $$ delete from public.profiles where id = '00000000-0000-0000-0000-00000000e501' $$,
  'HX005', null, 'deleting an owner''s profile raises HX005 instead of orphaning the room'
);
select is(
  (select role from public.room_members
    where room_id = current_setting('test.r')::uuid and user_id = '00000000-0000-0000-0000-00000000e501'),
  'owner', 'the owner row is still there'
);

-- ---------------------------------------------------------------------------
-- rooms.updated_at (39-40)
-- ---------------------------------------------------------------------------
insert into public.rooms (id, name, icon_emoji, created_at, updated_at) values
  ('00000000-0000-0000-0000-00000000f501', 'Stale Room', 'x', '2000-01-01', '2000-01-01'),
  ('00000000-0000-0000-0000-00000000f502', 'Transfer Room', 'x', '2000-01-01', '2000-01-01');
insert into public.room_members (room_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000f502', '00000000-0000-0000-0000-00000000e501', 'owner'),
  ('00000000-0000-0000-0000-00000000f502', '00000000-0000-0000-0000-00000000e506', 'member');

update public.rooms set name = 'Renamed Room' where id = '00000000-0000-0000-0000-00000000f501';
select ok(
  (select updated_at > '2001-01-01' from public.rooms where id = '00000000-0000-0000-0000-00000000f501'),
  'updating a room sets updated_at'
);

set local role service_role;
select public.transfer_ownership('00000000-0000-0000-0000-00000000f502',
  '00000000-0000-0000-0000-00000000e501', '00000000-0000-0000-0000-00000000e506');
reset role;
select ok(
  (select updated_at > '2001-01-01' from public.rooms where id = '00000000-0000-0000-0000-00000000f502'),
  'transfer_ownership bumps rooms.updated_at'
);

-- ---------------------------------------------------------------------------
-- SteamID64, invite expiry, messages.created_at (41-46)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.profiles (steam_id, display_name) values ('12345678901234567', 'Not Steam64') $$,
  '23514', null, 'profiles.steam_id must be a SteamID64 (7656119 prefix)'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, invitee_steam_id, max_uses)
     values (current_setting('test.r')::uuid, 'direct', '12345678901234567', 1) $$,
  '23514', null, 'invites.invitee_steam_id must be a SteamID64 (7656119 prefix)'
);
select is(
  (select count(*)::int from pg_catalog.pg_constraint
    where convalidated and conname in (
      'profiles_steam_id_format', 'invites_invitee_steam_id_steam64', 'invites_expires_after_created')),
  3,
  'the new check constraints are validated'
);
select is(
  (select count(*)::int from pg_catalog.pg_constraint
    where conname in ('profiles_steam_id_check', 'invites_invitee_steam_id_format')
      and conrelid in ('public.profiles'::regclass, 'public.invites'::regclass)),
  0,
  'the old SteamID checks are dropped'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, token_hash, created_at, expires_at)
     values (current_setting('test.r')::uuid, 'link', repeat('5', 64), now(), now()) $$,
  '23514', null, 'an invite cannot expire at or before its creation'
);
select ok(
  (select pg_catalog.pg_get_expr(d.adbin, d.adrelid) like '%clock_timestamp()%'
     from pg_catalog.pg_attrdef d
     join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = 'public.messages'::regclass and a.attname = 'created_at'),
  'messages.created_at defaults to clock_timestamp()'
);

-- ---------------------------------------------------------------------------
-- can_access_topic: lowercase uuids only (47-50)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000e501","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select ok(private.can_access_topic('room:' || current_setting('test.r')), 'a lowercase room topic is allowed for the owner');
select ok(not private.can_access_topic('room:' || upper(current_setting('test.r'))), 'an uppercase room uuid is denied');
select ok(not private.can_access_topic('room:' || current_setting('test.r') || ':x'), 'a topic with a trailing segment is denied');
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000E501","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select ok(not private.can_access_topic('room:' || current_setting('test.r')), 'an uppercase sub is denied');
reset role;

-- ---------------------------------------------------------------------------
-- delete_room side effects and cascades (51-56)
-- ---------------------------------------------------------------------------
insert into public.invites (id, room_id, kind, invitee_steam_id, max_uses, uses, accepted_at, declined_at) values
  ('d0000000-0000-0000-0000-000000000501', current_setting('test.r')::uuid, 'direct', '76561190000000591', 1, 1, now(), null),
  ('d0000000-0000-0000-0000-000000000502', current_setting('test.r')::uuid, 'direct', '76561190000000592', 1, 0, null, now());
insert into public.channels (room_id, type, name, position, deleted_at)
values (current_setting('test.r')::uuid, 'text', 'old-news', 1, '2001-01-01');

set local role service_role;
select lives_ok(
  $$ select public.delete_room(current_setting('test.r')::uuid, '00000000-0000-0000-0000-00000000e501') $$,
  'the owner can delete the room'
);
reset role;
select is(
  (select count(*)::int from public.invites
    where id in ('d0000000-0000-0000-0000-000000000501', 'd0000000-0000-0000-0000-000000000502')
      and revoked_at is null),
  2,
  'delete_room leaves answered direct invites untouched'
);
select is(
  (select deleted_at from public.channels
    where room_id = current_setting('test.r')::uuid and name = 'old-news'),
  '2001-01-01'::timestamptz,
  'delete_room keeps an already-deleted channel''s original deleted_at'
);
select lives_ok(
  $$ delete from public.room_members
     where room_id = current_setting('test.r')::uuid and user_id = '00000000-0000-0000-0000-00000000e501' $$,
  'the owner row of a soft-deleted room can be deleted'
);

select set_config('test.h',
  public.create_room('00000000-0000-0000-0000-00000000e507', 'Hard Delete', 'x', null)::text, true) is not null as _h;
select lives_ok(
  $$ delete from public.rooms where id = current_setting('test.h')::uuid $$,
  'hard-deleting a live room cascades through its owner row'
);
select is(
  (select count(*)::int from public.room_members where room_id = current_setting('test.h')::uuid),
  0,
  'the hard-deleted room has no member rows left'
);

select * from finish();
rollback;
