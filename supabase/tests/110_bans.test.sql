-- 20260926130308_bans: ban_member(), unban(), ban enforcement in redeem_invite_link(),
-- respond_to_direct_invite(), and create_direct_invite(), and delete_room() returning the
-- direct invites it revoked.
-- Runs inside the runner's transaction, which is always rolled back.
begin;

select plan(66);

-- ---------------------------------------------------------------------------
-- Fixtures (as the owner role)
-- ---------------------------------------------------------------------------
-- Profiles: O owner, A and B admins, M, P, E members, N never a member.
-- Room R (1311): live; O owner, A/B admins, M/P/E members.
-- Room D (1312): soft-deleted; O owner, M member.
-- Room K (1313): live; O owner, P member; used for delete_room.
insert into public.profiles (id, steam_id, display_name) values
  ('00000000-0000-0000-0000-000000001301', '76561190000001301', 'Owner O'),
  ('00000000-0000-0000-0000-000000001302', '76561190000001302', 'Admin A'),
  ('00000000-0000-0000-0000-000000001303', '76561190000001303', 'Admin B'),
  ('00000000-0000-0000-0000-000000001304', '76561190000001304', 'Member M'),
  ('00000000-0000-0000-0000-000000001305', '76561190000001305', 'Member P'),
  ('00000000-0000-0000-0000-000000001306', '76561190000001306', 'Outsider N'),
  ('00000000-0000-0000-0000-000000001307', '76561190000001307', 'Member E');

insert into public.rooms (id, name, icon_emoji, deleted_at) values
  ('00000000-0000-0000-0000-000000001311', 'Room R', 'x', null),
  ('00000000-0000-0000-0000-000000001312', 'Room D', 'x', now()),
  ('00000000-0000-0000-0000-000000001313', 'Room K', 'x', null);

insert into public.room_members (room_id, user_id, role) values
  ('00000000-0000-0000-0000-000000001311', '00000000-0000-0000-0000-000000001301', 'owner'),
  ('00000000-0000-0000-0000-000000001311', '00000000-0000-0000-0000-000000001302', 'admin'),
  ('00000000-0000-0000-0000-000000001311', '00000000-0000-0000-0000-000000001303', 'admin'),
  ('00000000-0000-0000-0000-000000001311', '00000000-0000-0000-0000-000000001304', 'member'),
  ('00000000-0000-0000-0000-000000001311', '00000000-0000-0000-0000-000000001305', 'member'),
  ('00000000-0000-0000-0000-000000001311', '00000000-0000-0000-0000-000000001307', 'member'),
  ('00000000-0000-0000-0000-000000001312', '00000000-0000-0000-0000-000000001301', 'owner'),
  ('00000000-0000-0000-0000-000000001312', '00000000-0000-0000-0000-000000001304', 'member'),
  ('00000000-0000-0000-0000-000000001313', '00000000-0000-0000-0000-000000001301', 'owner'),
  ('00000000-0000-0000-0000-000000001313', '00000000-0000-0000-0000-000000001305', 'member');

-- ---------------------------------------------------------------------------
-- Privileges and function shape (1-7)
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('public', 'public.ban_member(uuid, uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.ban_member(uuid, uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.ban_member(uuid, uuid, uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.ban_member(uuid, uuid, uuid, text)', 'execute'),
  'ban_member is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.unban(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.unban(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.unban(uuid, uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.unban(uuid, uuid, text)', 'execute'),
  'unban is executable by service_role only'
);
select ok(
  (select bool_and(
            not has_function_privilege('public', f::oid, 'execute')
            and not has_function_privilege('anon', f::oid, 'execute')
            and not has_function_privilege('authenticated', f::oid, 'execute')
            and has_function_privilege('service_role', f::oid, 'execute'))
     from unnest(array[
       'public.redeem_invite_link(text, uuid)'::regprocedure,
       'public.respond_to_direct_invite(uuid, uuid, boolean)'::regprocedure,
       'public.create_direct_invite(uuid, uuid, text, timestamptz)'::regprocedure,
       'public.delete_room(uuid, uuid)'::regprocedure]) as f),
  'the replaced redeem_invite_link, respond_to_direct_invite, create_direct_invite, and delete_room are still service_role only'
);
select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) and count(*) = 6
     from pg_catalog.pg_proc p
    where p.oid in (
      'public.ban_member(uuid, uuid, uuid, text)'::regprocedure,
      'public.unban(uuid, uuid, text)'::regprocedure,
      'public.redeem_invite_link(text, uuid)'::regprocedure,
      'public.respond_to_direct_invite(uuid, uuid, boolean)'::regprocedure,
      'public.create_direct_invite(uuid, uuid, text, timestamptz)'::regprocedure,
      'public.delete_room(uuid, uuid)'::regprocedure)),
  'new and replaced functions are security definer with an empty search_path'
);
select is(
  pg_catalog.pg_get_function_result('public.delete_room(uuid, uuid)'::regprocedure),
  'TABLE(invite_id uuid, invitee_profile_id uuid)',
  'delete_room returns TABLE(invite_id uuid, invitee_profile_id uuid)'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000001301","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001301', '00000000-0000-0000-0000-000000001304', null) $$,
  '42501', null, 'authenticated cannot execute ban_member, even as the room owner'
);
select throws_ok(
  $$ select public.unban('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001301', '76561190000001304') $$,
  '42501', null, 'authenticated cannot execute unban, even as the room owner'
);
reset role;

-- ---------------------------------------------------------------------------
-- ban_member: argument, membership, and role checks (8-22)
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select * from public.ban_member(null,
       '00000000-0000-0000-0000-000000001301', '00000000-0000-0000-0000-000000001304', null) $$,
  '22023', null, 'ban_member rejects a null room'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001311',
       null, '00000000-0000-0000-0000-000000001304', null) $$,
  '22023', null, 'ban_member rejects a null actor'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001301', null, 'reason') $$,
  '22023', null, 'ban_member rejects a null target'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001304', '00000000-0000-0000-0000-000000001304', null) $$,
  'HX004', null, 'a member cannot ban themself (HX004, not HX002)'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-0000000013ff',
       '00000000-0000-0000-0000-000000001306', '00000000-0000-0000-0000-000000001306', null) $$,
  'HX004', null, 'the self-ban check runs before the room check (HX004 for an unknown room)'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-0000000013ff',
       '00000000-0000-0000-0000-000000001301', '00000000-0000-0000-0000-000000001304', null) $$,
  'HX001', null, 'ban_member on an unknown room raises HX001'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001312',
       '00000000-0000-0000-0000-000000001301', '00000000-0000-0000-0000-000000001304', null) $$,
  'HX001', null, 'ban_member on a soft-deleted room raises HX001, even for its owner'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001306', '00000000-0000-0000-0000-000000001304', null) $$,
  'HX001', null, 'ban_member by a non-member raises HX001'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001301', '00000000-0000-0000-0000-000000001306', null) $$,
  'HX003', null, 'banning a non-member raises HX003'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001302', '00000000-0000-0000-0000-000000001301', null) $$,
  'HX005', null, 'nobody can ban the owner (HX005)'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001302', '00000000-0000-0000-0000-000000001303', null) $$,
  'HX002', null, 'an admin cannot ban another admin (HX002)'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001304', '00000000-0000-0000-0000-000000001305', null) $$,
  'HX002', null, 'a member cannot ban another member (HX002)'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001304', '00000000-0000-0000-0000-000000001302', null) $$,
  'HX002', null, 'a member cannot ban an admin (HX002)'
);
select throws_ok(
  $$ select * from public.ban_member('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001301', '00000000-0000-0000-0000-000000001305', repeat('r', 201)) $$,
  '23514', null, 'a 201-character ban reason raises 23514'
);
select ok(
  exists (select 1 from public.room_members m
           where m.room_id = '00000000-0000-0000-0000-000000001311'
             and m.user_id = '00000000-0000-0000-0000-000000001305')
  and not exists (select 1 from public.room_bans b
                   where b.room_id = '00000000-0000-0000-0000-000000001311'
                     and b.steam_id = '76561190000001305'),
  'the failed ban left the member in the room and wrote no ban'
);

-- ---------------------------------------------------------------------------
-- ban_member: the owner bans an admin (23-25)
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
     from public.ban_member('00000000-0000-0000-0000-000000001311',
            '00000000-0000-0000-0000-000000001301', '00000000-0000-0000-0000-000000001303', null)),
  0, 'the owner bans an admin (no reason); nothing to revoke, so zero rows'
);
select is(
  (select array_agg(row(b.steam_id, b.banned_by, b.reason, b.created_at is not null)::text)
     from public.room_bans b where b.room_id = '00000000-0000-0000-0000-000000001311'),
  array[row('76561190000001303', '00000000-0000-0000-0000-000000001301'::uuid, null::text, true)::text],
  'the ban row records the admin''s SteamID, the owner as banned_by, and a null reason'
);
select is(
  (select count(*)::int from public.room_members m
    where m.room_id = '00000000-0000-0000-0000-000000001311'
      and m.user_id = '00000000-0000-0000-0000-000000001303'),
  0, 'the banned admin no longer has a membership row'
);

-- ---------------------------------------------------------------------------
-- ban_member: an admin bans a member with invites (26-31)
-- ---------------------------------------------------------------------------
-- Invites in R (inserted directly):
--   1321 pending direct from O addressed to E
--   1322 pending direct from E to N (has a profile)
--   1323 pending direct from E to a SteamID with no profile
--   1324 pending link from E (created before links became owner/admin only)
--   1325 declined direct from E
--   1326 pending link from A (stays active; used for the redeem checks below)
reset role;
insert into public.invites (id, room_id, created_by, kind, invitee_steam_id, max_uses, declined_at) values
  ('00000000-0000-0000-0000-000000001321', '00000000-0000-0000-0000-000000001311',
   '00000000-0000-0000-0000-000000001301', 'direct', '76561190000001307', 1, null),
  ('00000000-0000-0000-0000-000000001322', '00000000-0000-0000-0000-000000001311',
   '00000000-0000-0000-0000-000000001307', 'direct', '76561190000001306', 1, null),
  ('00000000-0000-0000-0000-000000001323', '00000000-0000-0000-0000-000000001311',
   '00000000-0000-0000-0000-000000001307', 'direct', '76561190000001399', 1, null),
  ('00000000-0000-0000-0000-000000001325', '00000000-0000-0000-0000-000000001311',
   '00000000-0000-0000-0000-000000001307', 'direct', '76561190000001398', 1, now());
insert into public.invites (id, room_id, created_by, kind, token_hash) values
  ('00000000-0000-0000-0000-000000001324', '00000000-0000-0000-0000-000000001311',
   '00000000-0000-0000-0000-000000001307', 'link', repeat('d1', 32)),
  ('00000000-0000-0000-0000-000000001326', '00000000-0000-0000-0000-000000001311',
   '00000000-0000-0000-0000-000000001302', 'link', repeat('d2', 32));
set local role service_role;

select is(
  (select array_agg(row(s.invite_id, s.invitee_profile_id)::text order by s.invite_id)
     from public.ban_member('00000000-0000-0000-0000-000000001311',
            '00000000-0000-0000-0000-000000001302', '00000000-0000-0000-0000-000000001307', 'spam') s),
  array[
    row('00000000-0000-0000-0000-000000001321'::uuid, '00000000-0000-0000-0000-000000001307'::uuid)::text,
    row('00000000-0000-0000-0000-000000001322'::uuid, '00000000-0000-0000-0000-000000001306'::uuid)::text,
    row('00000000-0000-0000-0000-000000001323'::uuid, null::uuid)::text
  ],
  'an admin bans a member; ban_member returns exactly the direct invites it revoked (addressed to and created by the target), with the invitee profile id or null, and no link invites'
);
select is(
  (select row(b.banned_by, b.reason)::text from public.room_bans b
    where b.room_id = '00000000-0000-0000-0000-000000001311' and b.steam_id = '76561190000001307'),
  row('00000000-0000-0000-0000-000000001302'::uuid, 'spam')::text,
  'the ban row records the member''s SteamID, the admin as banned_by, and the reason'
);
select is(
  (select count(*)::int from public.room_members m
    where m.room_id = '00000000-0000-0000-0000-000000001311'
      and m.user_id = '00000000-0000-0000-0000-000000001307'),
  0, 'the banned member no longer has a membership row'
);
select ok(
  (select bool_and(i.revoked_at is not null) and count(*) = 3 from public.invites i
    where i.id in ('00000000-0000-0000-0000-000000001322', '00000000-0000-0000-0000-000000001323',
                   '00000000-0000-0000-0000-000000001324')),
  'the banned member''s pending invites (direct and link) are revoked'
);
select ok(
  (select i.revoked_at is not null from public.invites i
    where i.id = '00000000-0000-0000-0000-000000001321'),
  'the pending direct invite addressed to the banned member is revoked'
);
select ok(
  (select bool_and(i.revoked_at is null) and count(*) = 2 from public.invites i
    where i.id in ('00000000-0000-0000-0000-000000001325', '00000000-0000-0000-0000-000000001326')),
  'answered invites and other members'' invites are untouched'
);

-- ---------------------------------------------------------------------------
-- ban_member: an existing ban row for a current member is overwritten (32-34)
-- ---------------------------------------------------------------------------
reset role;
insert into public.room_bans (room_id, steam_id, banned_by, reason) values
  ('00000000-0000-0000-0000-000000001311', '76561190000001304', '00000000-0000-0000-0000-000000001302', 'old');
set local role service_role;

select is(
  (select count(*)::int
     from public.ban_member('00000000-0000-0000-0000-000000001311',
            '00000000-0000-0000-0000-000000001301', '00000000-0000-0000-0000-000000001304', 'again')),
  0, 'banning a member whose SteamID already has a ban row succeeds'
);
select is(
  (select array_agg(row(b.banned_by, b.reason)::text) from public.room_bans b
    where b.room_id = '00000000-0000-0000-0000-000000001311' and b.steam_id = '76561190000001304'),
  array[row('00000000-0000-0000-0000-000000001301'::uuid, 'again')::text],
  'the existing ban row is updated with the new banned_by and reason (one row)'
);
select is(
  (select count(*)::int from public.room_members m
    where m.room_id = '00000000-0000-0000-0000-000000001311'
      and m.user_id = '00000000-0000-0000-0000-000000001304'),
  0, 'the member is removed'
);

-- ---------------------------------------------------------------------------
-- unban: checks (35-40)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select public.unban('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001301', null) $$,
  '22023', null, 'unban rejects a null Steam ID'
);
select throws_ok(
  $$ select public.unban('00000000-0000-0000-0000-0000000013ff',
       '00000000-0000-0000-0000-000000001301', '76561190000001303') $$,
  'HX001', null, 'unban on an unknown room raises HX001'
);
select throws_ok(
  $$ select public.unban('00000000-0000-0000-0000-000000001312',
       '00000000-0000-0000-0000-000000001301', '76561190000001303') $$,
  'HX001', null, 'unban on a soft-deleted room raises HX001'
);
select throws_ok(
  $$ select public.unban('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001306', '76561190000001303') $$,
  'HX001', null, 'unban by a non-member raises HX001'
);
select throws_ok(
  $$ select public.unban('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001305', '76561190000001303') $$,
  'HX002', null, 'a plain member cannot unban (HX002)'
);
select throws_ok(
  $$ select public.unban('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001301', '76561190000001306') $$,
  'HX003', null, 'unbanning a SteamID that is not banned raises HX003'
);

-- ---------------------------------------------------------------------------
-- create_direct_invite refuses a banned SteamID; the owner unbans (41-45)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001301', '76561190000001303', null) $$,
  'HX013', null, 'create_direct_invite for a banned SteamID raises HX013'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001306', '76561190000001303', null) $$,
  'HX001', null, 'a non-member inviting a banned SteamID still gets HX001 (checked before HX013)'
);
select lives_ok(
  $$ select public.unban('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001301', '76561190000001303') $$,
  'the owner unbans a SteamID'
);
select is(
  (select count(*)::int from public.room_bans b
    where b.room_id = '00000000-0000-0000-0000-000000001311' and b.steam_id = '76561190000001303'),
  0, 'the ban row is deleted'
);
select is(
  (select row(s.kind, s.invitee_steam_id, s.invitee_profile_id)::text
     from public.create_direct_invite('00000000-0000-0000-0000-000000001311',
            '00000000-0000-0000-0000-000000001301', '76561190000001303', null) s),
  row('direct', '76561190000001303', '00000000-0000-0000-0000-000000001303'::uuid)::text,
  'after the unban, create_direct_invite for that SteamID succeeds'
);

-- ---------------------------------------------------------------------------
-- redeem_invite_link and respond_to_direct_invite refuse a banned user (46-53)
-- ---------------------------------------------------------------------------
select is(
  (select status from public.redeem_invite_link(repeat('d2', 32), '00000000-0000-0000-0000-000000001307')),
  'banned', 'a banned user redeeming a live link gets banned'
);
select ok(
  (select i.uses = 0 from public.invites i where i.id = '00000000-0000-0000-0000-000000001326')
  and not exists (select 1 from public.room_members m
                   where m.room_id = '00000000-0000-0000-0000-000000001311'
                     and m.user_id = '00000000-0000-0000-0000-000000001307'),
  'the banned redemption consumed no use and added no member row'
);
select is(
  (select status from public.redeem_invite_link(repeat('d1', 32), '00000000-0000-0000-0000-000000001307')),
  'banned', 'banned is reported before revoked for a link'
);
select is(
  (select status from public.respond_to_direct_invite(
     '00000000-0000-0000-0000-000000001321', '00000000-0000-0000-0000-000000001307', true)),
  'banned', 'accepting a revoked direct invite while banned reports banned (checked before revoked)'
);

-- A pending direct invite addressed to the banned user (written outside the functions).
reset role;
insert into public.invites (id, room_id, created_by, kind, invitee_steam_id, max_uses) values
  ('00000000-0000-0000-0000-000000001327', '00000000-0000-0000-0000-000000001311',
   '00000000-0000-0000-0000-000000001301', 'direct', '76561190000001307', 1);
set local role service_role;

select is(
  (select status from public.respond_to_direct_invite(
     '00000000-0000-0000-0000-000000001327', '00000000-0000-0000-0000-000000001307', true)),
  'banned', 'a banned user accepting a pending direct invite gets banned'
);
select ok(
  (select i.accepted_at is null and i.declined_at is null and i.revoked_at is null and i.uses = 0
     from public.invites i where i.id = '00000000-0000-0000-0000-000000001327')
  and not exists (select 1 from public.room_members m
                   where m.room_id = '00000000-0000-0000-0000-000000001311'
                     and m.user_id = '00000000-0000-0000-0000-000000001307'),
  'the banned accept wrote nothing: the invite is still pending and no member row was added'
);
select is(
  (select status from public.respond_to_direct_invite(
     '00000000-0000-0000-0000-000000001327', '00000000-0000-0000-0000-000000001307', false)),
  'declined', 'a banned user can still decline a pending direct invite'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001301', '76561190000001307', null) $$,
  'HX013', null, 'create_direct_invite for the banned member raises HX013'
);

-- ---------------------------------------------------------------------------
-- An admin unbans; the user can rejoin (54-56)
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select public.unban('00000000-0000-0000-0000-000000001311',
       '00000000-0000-0000-0000-000000001302', '76561190000001307') $$,
  'an admin unbans a SteamID'
);
select is(
  (select status from public.redeem_invite_link(repeat('d2', 32), '00000000-0000-0000-0000-000000001307')),
  'joined', 'after the unban, the user joins through a live link'
);
select ok(
  (select m.role = 'member' from public.room_members m
    where m.room_id = '00000000-0000-0000-0000-000000001311'
      and m.user_id = '00000000-0000-0000-0000-000000001307')
  and (select i.uses = 1 from public.invites i where i.id = '00000000-0000-0000-0000-000000001326'),
  'the rejoined user is a plain member and the link use was consumed'
);

-- ---------------------------------------------------------------------------
-- delete_room returns the direct invites it revoked (57-66)
-- ---------------------------------------------------------------------------
-- Room K: channels general (text) and lounge (voice); invites
--   1331 pending direct to N (has a profile)
--   1332 pending direct to a SteamID with no profile
--   1333 pending link
--   1334 accepted direct
reset role;
insert into public.channels (room_id, type, name, position) values
  ('00000000-0000-0000-0000-000000001313', 'text', 'general', 0),
  ('00000000-0000-0000-0000-000000001313', 'voice', 'lounge', 0);
insert into public.invites (id, room_id, created_by, kind, invitee_steam_id, max_uses, uses, accepted_at) values
  ('00000000-0000-0000-0000-000000001331', '00000000-0000-0000-0000-000000001313',
   '00000000-0000-0000-0000-000000001301', 'direct', '76561190000001306', 1, 0, null),
  ('00000000-0000-0000-0000-000000001332', '00000000-0000-0000-0000-000000001313',
   '00000000-0000-0000-0000-000000001301', 'direct', '76561190000001397', 1, 0, null),
  ('00000000-0000-0000-0000-000000001334', '00000000-0000-0000-0000-000000001313',
   '00000000-0000-0000-0000-000000001301', 'direct', '76561190000001396', 1, 1, now());
insert into public.invites (id, room_id, created_by, kind, token_hash) values
  ('00000000-0000-0000-0000-000000001333', '00000000-0000-0000-0000-000000001313',
   '00000000-0000-0000-0000-000000001301', 'link', repeat('d3', 32));
set local role service_role;

select throws_ok(
  $$ select * from public.delete_room('00000000-0000-0000-0000-000000001313', null) $$,
  '22023', null, 'delete_room rejects a null actor'
);
select throws_ok(
  $$ select * from public.delete_room('00000000-0000-0000-0000-000000001313',
       '00000000-0000-0000-0000-000000001306') $$,
  'HX001', null, 'delete_room by a non-member raises HX001'
);
select throws_ok(
  $$ select * from public.delete_room('00000000-0000-0000-0000-000000001313',
       '00000000-0000-0000-0000-000000001305') $$,
  'HX002', null, 'delete_room by a member who is not the owner raises HX002'
);
select is(
  (select array_agg(row(s.invite_id, s.invitee_profile_id)::text order by s.invite_id)
     from public.delete_room('00000000-0000-0000-0000-000000001313',
            '00000000-0000-0000-0000-000000001301') s),
  array[
    row('00000000-0000-0000-0000-000000001331'::uuid, '00000000-0000-0000-0000-000000001306'::uuid)::text,
    row('00000000-0000-0000-0000-000000001332'::uuid, null::uuid)::text
  ],
  'the owner deletes the room; delete_room returns the pending direct invites it revoked, with the invitee profile id or null, and no link invites'
);
select ok(
  (select r.deleted_at is not null from public.rooms r where r.id = '00000000-0000-0000-0000-000000001313'),
  'delete_room sets rooms.deleted_at'
);
select is(
  (select count(*)::int from public.channels c
    where c.room_id = '00000000-0000-0000-0000-000000001313' and c.deleted_at is null),
  0, 'delete_room soft-deletes every live channel'
);
select ok(
  (select bool_and(i.revoked_at is not null) and count(*) = 3 from public.invites i
    where i.id in ('00000000-0000-0000-0000-000000001331', '00000000-0000-0000-0000-000000001332',
                   '00000000-0000-0000-0000-000000001333')),
  'delete_room revokes every pending invite, including the link it does not return'
);
select ok(
  (select i.revoked_at is null from public.invites i where i.id = '00000000-0000-0000-0000-000000001334'),
  'delete_room leaves an accepted direct invite untouched'
);
select is(
  (select count(*)::int from public.room_members m where m.room_id = '00000000-0000-0000-0000-000000001313'),
  2, 'delete_room keeps member rows for Node''s broadcasts and LiveKit removal'
);
select throws_ok(
  $$ select * from public.delete_room('00000000-0000-0000-0000-000000001313',
       '00000000-0000-0000-0000-000000001301') $$,
  'HX001', null, 'deleting an already-deleted room raises HX001'
);

reset role;

select * from finish();
rollback;
