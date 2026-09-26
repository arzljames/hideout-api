-- 20260926054446_membership: the room_bans table (structure, lockdown, checks, FK behaviour),
-- create_link_invite() now owner/admin only (HX002 for a plain member), remove_member() now
-- also revoking pending direct invites addressed to the target and returning the direct
-- invites it revoked, and behaviour spot-checks of the membership functions the membership
-- API relies on: remove_member(), change_role(), transfer_ownership().
-- Runs inside the runner's transaction, which is always rolled back.
begin;

select plan(46);

-- ---------------------------------------------------------------------------
-- Fixtures (as the owner role)
-- ---------------------------------------------------------------------------
-- Profiles: O owner, A and B admins, F admin (leaves), M and P members, C member (leaves),
-- E member (removed), N never a member, Z bans someone and is then deleted.
-- Room R (1101): live; O owner, A/B/F admins, M/P/C/E members.
-- Room X (1102): live, no members; only holds bans, then is hard-deleted.
insert into public.profiles (id, steam_id, display_name) values
  ('00000000-0000-0000-0000-000000001001', '76561190000001001', 'Owner O'),
  ('00000000-0000-0000-0000-000000001002', '76561190000001002', 'Admin A'),
  ('00000000-0000-0000-0000-000000001003', '76561190000001003', 'Admin B'),
  ('00000000-0000-0000-0000-000000001004', '76561190000001004', 'Member M'),
  ('00000000-0000-0000-0000-000000001005', '76561190000001005', 'Member P'),
  ('00000000-0000-0000-0000-000000001006', '76561190000001006', 'Outsider N'),
  ('00000000-0000-0000-0000-000000001007', '76561190000001007', 'Member C'),
  ('00000000-0000-0000-0000-000000001008', '76561190000001008', 'Member E'),
  ('00000000-0000-0000-0000-000000001009', '76561190000001009', 'Admin F'),
  ('00000000-0000-0000-0000-00000000100a', '76561190000001010', 'Banner Z');

insert into public.rooms (id, name, icon_emoji) values
  ('00000000-0000-0000-0000-000000001101', 'Room R', 'x'),
  ('00000000-0000-0000-0000-000000001102', 'Room X', 'x');

insert into public.room_members (room_id, user_id, role) values
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001001', 'owner'),
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001002', 'admin'),
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001003', 'admin'),
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001009', 'admin'),
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001004', 'member'),
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001005', 'member'),
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001007', 'member'),
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001008', 'member');

-- ---------------------------------------------------------------------------
-- room_bans: structure and lockdown (1-6)
-- ---------------------------------------------------------------------------
select has_table('public', 'room_bans', 'room_bans table exists');
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.room_bans'::regclass),
  'RLS is enabled on room_bans'
);
select col_is_pk('public', 'room_bans', array['room_id', 'steam_id']::name[],
  'room_bans primary key is (room_id, steam_id)');
select has_index('public', 'room_bans', 'room_bans_banned_by_idx', 'room_bans has the banned_by FK index');
select ok(
  not has_table_privilege('anon', 'public.room_bans', 'select, insert, update, delete, truncate, references, trigger')
  and not has_table_privilege('authenticated', 'public.room_bans', 'select, insert, update, delete, truncate, references, trigger')
  and has_table_privilege('service_role', 'public.room_bans', 'select')
  and has_table_privilege('service_role', 'public.room_bans', 'insert')
  and has_table_privilege('service_role', 'public.room_bans', 'update')
  and has_table_privilege('service_role', 'public.room_bans', 'delete'),
  'anon and authenticated have no privileges on room_bans; service_role has select/insert/update/delete'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000001001","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select throws_ok(
  $$ select * from public.room_bans $$,
  '42501', null, 'authenticated cannot read room_bans, even as a room owner'
);
reset role;

-- ---------------------------------------------------------------------------
-- room_bans: checks and FK behaviour (7-14)
-- ---------------------------------------------------------------------------
set local role service_role;
select lives_ok(
  $$ insert into public.room_bans (room_id, steam_id, banned_by, reason) values
       ('00000000-0000-0000-0000-000000001102', '76561190000001050',
        '00000000-0000-0000-0000-00000000100a', repeat('r', 200)) $$,
  'service_role bans a SteamID with a 200-character reason'
);
select throws_ok(
  $$ insert into public.room_bans (room_id, steam_id) values
       ('00000000-0000-0000-0000-000000001102', '76561200000001050') $$,
  '23514', null, 'a steam_id that is not an individual SteamID64 raises 23514'
);
select throws_ok(
  $$ insert into public.room_bans (room_id, steam_id, reason) values
       ('00000000-0000-0000-0000-000000001102', '76561190000001051', '') $$,
  '23514', null, 'an empty reason raises 23514'
);
select throws_ok(
  $$ insert into public.room_bans (room_id, steam_id, reason) values
       ('00000000-0000-0000-0000-000000001102', '76561190000001051', repeat('r', 201)) $$,
  '23514', null, 'a 201-character reason raises 23514'
);
select throws_ok(
  $$ insert into public.room_bans (room_id, steam_id) values
       ('00000000-0000-0000-0000-000000001102', '76561190000001050') $$,
  '23505', null, 'banning the same SteamID twice in a room raises 23505'
);

-- A second ban with no reason and no banned_by is valid.
insert into public.room_bans (room_id, steam_id) values
  ('00000000-0000-0000-0000-000000001102', '76561190000001051');

-- Deleting the profile that banned someone keeps the ban and nulls banned_by.
delete from public.profiles where id = '00000000-0000-0000-0000-00000000100a';
select is(
  (select row(b.banned_by, b.created_at is not null)::text from public.room_bans b
    where b.room_id = '00000000-0000-0000-0000-000000001102' and b.steam_id = '76561190000001050'),
  row(null::uuid, true)::text,
  'deleting the banning profile keeps the ban and sets banned_by to null'
);

select is(
  (select count(*)::int from public.room_bans where room_id = '00000000-0000-0000-0000-000000001102'),
  2, 'room X has two bans before it is deleted'
);
-- Hard delete (soft delete is the app's path; this checks the FK's on delete cascade).
delete from public.rooms where id = '00000000-0000-0000-0000-000000001102';
select is(
  (select count(*)::int from public.room_bans where room_id = '00000000-0000-0000-0000-000000001102'),
  0, 'hard-deleting a room deletes its bans'
);

-- ---------------------------------------------------------------------------
-- create_link_invite: owner/admin only (15-19)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001004', repeat('c0', 32), null, null) $$,
  'HX002', null, 'a plain member cannot create a link invite (HX002)'
);
select is(
  (select count(*)::int from public.invites where room_id = '00000000-0000-0000-0000-000000001101'),
  0, 'the rejected call stored no invite'
);
select is(
  (select row(s.room_id, s.created_by, s.kind, s.uses)::text
     from public.create_link_invite('00000000-0000-0000-0000-000000001101',
            '00000000-0000-0000-0000-000000001002', repeat('c1', 32), 5, null) s),
  row('00000000-0000-0000-0000-000000001101'::uuid, '00000000-0000-0000-0000-000000001002'::uuid,
      'link', 0)::text,
  'an admin creates a link invite'
);
select is(
  (select row(s.room_id, s.created_by, s.kind, s.uses)::text
     from public.create_link_invite('00000000-0000-0000-0000-000000001101',
            '00000000-0000-0000-0000-000000001001', repeat('c2', 32), null,
            now() + interval '1 day') s),
  row('00000000-0000-0000-0000-000000001101'::uuid, '00000000-0000-0000-0000-000000001001'::uuid,
      'link', 0)::text,
  'the owner creates a link invite'
);
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001006', repeat('c0', 32), null, null) $$,
  'HX001', null, 'a non-member still gets HX001 (not HX002)'
);

-- ---------------------------------------------------------------------------
-- remove_member (20-34)
-- ---------------------------------------------------------------------------
-- Fixtures: G (100b) is a member with no invites. Invites in R (inserted directly):
--   1201 pending direct from O addressed to E (e.g. sent before E joined through a link)
--   1202 pending direct from E to N (has a profile)
--   1203 pending direct from E to a SteamID with no profile
--   1204 pending link from E (created before links became owner/admin only)
--   1205 declined direct from E; 1206 declined direct from A addressed to E
insert into public.profiles (id, steam_id, display_name) values
  ('00000000-0000-0000-0000-00000000100b', '76561190000001011', 'Member G');
insert into public.room_members (room_id, user_id, role) values
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-00000000100b', 'member');
insert into public.invites (id, room_id, created_by, kind, invitee_steam_id, max_uses, declined_at) values
  ('00000000-0000-0000-0000-000000001201', '00000000-0000-0000-0000-000000001101',
   '00000000-0000-0000-0000-000000001001', 'direct', '76561190000001008', 1, null),
  ('00000000-0000-0000-0000-000000001202', '00000000-0000-0000-0000-000000001101',
   '00000000-0000-0000-0000-000000001008', 'direct', '76561190000001006', 1, null),
  ('00000000-0000-0000-0000-000000001203', '00000000-0000-0000-0000-000000001101',
   '00000000-0000-0000-0000-000000001008', 'direct', '76561190000001099', 1, null),
  ('00000000-0000-0000-0000-000000001205', '00000000-0000-0000-0000-000000001101',
   '00000000-0000-0000-0000-000000001008', 'direct', '76561190000001098', 1, now()),
  ('00000000-0000-0000-0000-000000001206', '00000000-0000-0000-0000-000000001101',
   '00000000-0000-0000-0000-000000001002', 'direct', '76561190000001008', 1, now());
insert into public.invites (id, room_id, created_by, kind, token_hash) values
  ('00000000-0000-0000-0000-000000001204', '00000000-0000-0000-0000-000000001101',
   '00000000-0000-0000-0000-000000001008', 'link', repeat('e1', 32));

select lives_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001009', '00000000-0000-0000-0000-000000001009') $$,
  'an admin leaves the room'
);
select lives_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001007', '00000000-0000-0000-0000-000000001007') $$,
  'a member leaves the room'
);
select is(
  (select count(*)::int
     from public.remove_member('00000000-0000-0000-0000-000000001101',
            '00000000-0000-0000-0000-00000000100b', '00000000-0000-0000-0000-00000000100b')),
  0, 'a leave with nothing to revoke returns zero rows'
);
select is(
  (select count(*)::int from public.room_members m
    where m.room_id = '00000000-0000-0000-0000-000000001101'
      and m.user_id in ('00000000-0000-0000-0000-000000001009', '00000000-0000-0000-0000-000000001007')),
  0, 'the admin and the member who left no longer have membership rows'
);
select throws_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001001') $$,
  'HX005', null, 'the owner cannot leave (HX005)'
);
select throws_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001002', '00000000-0000-0000-0000-000000001003') $$,
  'HX002', null, 'an admin cannot remove another admin (HX002)'
);
select lives_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001003') $$,
  'the owner removes an admin'
);
select is(
  (select array_agg(row(s.invite_id, s.invitee_profile_id)::text order by s.invite_id)
     from public.remove_member('00000000-0000-0000-0000-000000001101',
            '00000000-0000-0000-0000-000000001002', '00000000-0000-0000-0000-000000001008') s),
  array[
    row('00000000-0000-0000-0000-000000001201'::uuid, '00000000-0000-0000-0000-000000001008'::uuid)::text,
    row('00000000-0000-0000-0000-000000001202'::uuid, '00000000-0000-0000-0000-000000001006'::uuid)::text,
    row('00000000-0000-0000-0000-000000001203'::uuid, null::uuid)::text
  ],
  'an admin removes a member; remove_member returns exactly the direct invites it revoked (addressed to and created by the target), with the invitee profile id or null, and no link invites'
);
select is(
  (select status from public.respond_to_direct_invite(
     '00000000-0000-0000-0000-000000001201', '00000000-0000-0000-0000-000000001008', true)),
  'revoked', 'the removed member cannot rejoin by accepting a direct invite addressed to them (revoked)'
);
select ok(
  (select i.revoked_at is not null from public.invites i
    where i.id = '00000000-0000-0000-0000-000000001204'),
  'the removed member''s link invite is revoked (but not returned)'
);
select ok(
  (select bool_and(i.revoked_at is null) and count(*) = 2 from public.invites i
    where i.id in ('00000000-0000-0000-0000-000000001205', '00000000-0000-0000-0000-000000001206')),
  'declined direct invites created by or addressed to the removed member are left untouched'
);
select ok(
  (select bool_and(i.revoked_at is null) and count(*) = 2 from public.invites i
    where i.room_id = '00000000-0000-0000-0000-000000001101' and i.kind = 'link'
      and i.created_by in ('00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001002')),
  'other members'' link invites stay active'
);
select is(
  (select count(*)::int from public.room_members m
    where m.room_id = '00000000-0000-0000-0000-000000001101'
      and m.user_id in ('00000000-0000-0000-0000-000000001003', '00000000-0000-0000-0000-000000001008')),
  0, 'the removed admin and member no longer have membership rows'
);
select throws_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001004', '00000000-0000-0000-0000-000000001005') $$,
  'HX002', null, 'a member cannot remove another member (HX002)'
);
select throws_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001006') $$,
  'HX003', null, 'removing a non-member raises HX003'
);

-- ---------------------------------------------------------------------------
-- change_role (35-41)
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select public.change_role('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001005', 'admin') $$,
  'the owner promotes a member to admin'
);
select is(
  (select m.role from public.room_members m
    where m.room_id = '00000000-0000-0000-0000-000000001101' and m.user_id = '00000000-0000-0000-0000-000000001005'),
  'admin', 'the promoted member is now an admin'
);
select lives_ok(
  $$ select public.change_role('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001005', 'member') $$,
  'the owner demotes an admin to member'
);
select is(
  (select m.role from public.room_members m
    where m.room_id = '00000000-0000-0000-0000-000000001101' and m.user_id = '00000000-0000-0000-0000-000000001005'),
  'member', 'the demoted admin is now a member'
);
select throws_ok(
  $$ select public.change_role('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001002', '00000000-0000-0000-0000-000000001004', 'admin') $$,
  'HX002', null, 'an admin cannot change roles (HX002)'
);
select throws_ok(
  $$ select public.change_role('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001001', 'admin') $$,
  'HX004', null, 'the owner cannot change their own role (HX004)'
);

-- M is promoted, then may create links.
select public.change_role('00000000-0000-0000-0000-000000001101',
  '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001004', 'admin');
select is(
  (select s.created_by
     from public.create_link_invite('00000000-0000-0000-0000-000000001101',
            '00000000-0000-0000-0000-000000001004', repeat('c3', 32), null, null) s),
  '00000000-0000-0000-0000-000000001004'::uuid,
  'a member promoted to admin can create a link invite'
);

-- ---------------------------------------------------------------------------
-- transfer_ownership (42-46)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.transfer_ownership('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001002', '00000000-0000-0000-0000-000000001005') $$,
  'HX002', null, 'an admin cannot transfer ownership (HX002)'
);
select throws_ok(
  $$ select public.transfer_ownership('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001001') $$,
  'HX004', null, 'transferring ownership to yourself raises HX004'
);
select throws_ok(
  $$ select public.transfer_ownership('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001006') $$,
  'HX003', null, 'transferring ownership to a non-member raises HX003'
);
select lives_ok(
  $$ select public.transfer_ownership('00000000-0000-0000-0000-000000001101',
       '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001005') $$,
  'the owner transfers ownership to a member'
);
select is(
  (select array_agg(m.role order by m.user_id) from public.room_members m
    where m.room_id = '00000000-0000-0000-0000-000000001101'
      and m.user_id in ('00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000001005')),
  array['admin', 'owner'],
  'the old owner is now an admin and the target is the owner'
);

reset role;

select * from finish();
rollback;
