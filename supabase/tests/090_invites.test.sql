-- 20260926045852_invites: create_link_invite(), create_direct_invite(), revoke_invite()
-- privileges, argument checks, rule-4 error codes, HX011/HX012, expired-pending replacement
-- (and the returned replaced_invite_id), role checks, idempotent revoke, the returned
-- invitee_profile_id, no function returning token_hash, integration with the unchanged
-- redeem_invite_link() and respond_to_direct_invite(), and the new remove_member() revoking
-- the target's pending invites (removal and voluntary leave).
-- Updated for 20260926054446_membership: create_link_invite is owner/admin only (a plain
-- member gets HX002), so links "created by a plain member" are inserted directly as fixtures
-- (links members created before that migration still exist and must keep behaving).
-- Runs inside the runner's transaction, which is always rolled back.
begin;

select plan(90);

-- ---------------------------------------------------------------------------
-- Fixtures (as the owner role)
-- ---------------------------------------------------------------------------
-- Profiles: O owner, A admin, M member, P member, N never a member, Q and X direct invitees
-- (not members), Y and Z redeem links.
-- Steam IDs 76561190000000950-951 have no profile (the person hasn't signed in yet).
-- Room L (f901): live; O owner, A admin, M member, P member.
-- Room D (f902): soft-deleted; O owner, M member; link invite 9d1 created by O.
insert into public.profiles (id, steam_id, display_name) values
  ('00000000-0000-0000-0000-00000000e901', '76561190000000901', 'Owner O'),
  ('00000000-0000-0000-0000-00000000e902', '76561190000000902', 'Admin A'),
  ('00000000-0000-0000-0000-00000000e903', '76561190000000903', 'Member M'),
  ('00000000-0000-0000-0000-00000000e904', '76561190000000904', 'Member P'),
  ('00000000-0000-0000-0000-00000000e905', '76561190000000905', 'Outsider N'),
  ('00000000-0000-0000-0000-00000000e906', '76561190000000906', 'Invitee Q'),
  ('00000000-0000-0000-0000-00000000e907', '76561190000000907', 'Invitee X'),
  ('00000000-0000-0000-0000-00000000e908', '76561190000000908', 'Linker Y'),
  ('00000000-0000-0000-0000-00000000e909', '76561190000000909', 'Linker Z');

insert into public.rooms (id, name, icon_emoji, deleted_at) values
  ('00000000-0000-0000-0000-00000000f901', 'Room L', 'x', null),
  ('00000000-0000-0000-0000-00000000f902', 'Room D', 'x', '2000-01-02');

insert into public.room_members (room_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000e901', 'owner'),
  ('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000e902', 'admin'),
  ('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000e903', 'member'),
  ('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000e904', 'member'),
  ('00000000-0000-0000-0000-00000000f902', '00000000-0000-0000-0000-00000000e901', 'owner'),
  ('00000000-0000-0000-0000-00000000f902', '00000000-0000-0000-0000-00000000e903', 'member');

insert into public.invites (id, room_id, created_by, kind, token_hash) values
  ('00000000-0000-0000-0000-0000000009d1', '00000000-0000-0000-0000-00000000f902',
   '00000000-0000-0000-0000-00000000e901', 'link', repeat('96', 32));

-- ---------------------------------------------------------------------------
-- Structure and privileges (1-12)
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('public', 'public.create_link_invite(uuid, uuid, text, integer, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.create_link_invite(uuid, uuid, text, integer, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.create_link_invite(uuid, uuid, text, integer, timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.create_link_invite(uuid, uuid, text, integer, timestamptz)', 'execute'),
  'create_link_invite is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.create_direct_invite(uuid, uuid, text, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.create_direct_invite(uuid, uuid, text, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.create_direct_invite(uuid, uuid, text, timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.create_direct_invite(uuid, uuid, text, timestamptz)', 'execute'),
  'create_direct_invite is executable by service_role only'
);
select ok(
  not has_function_privilege('public', 'public.revoke_invite(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.revoke_invite(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.revoke_invite(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.revoke_invite(uuid, uuid)', 'execute'),
  'revoke_invite is executable by service_role only'
);

select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.create_link_invite(uuid, uuid, text, integer, timestamptz)'::regprocedure),
  'create_link_invite is security definer with an empty search_path'
);
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.create_direct_invite(uuid, uuid, text, timestamptz)'::regprocedure),
  'create_direct_invite is security definer with an empty search_path'
);
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.revoke_invite(uuid, uuid)'::regprocedure),
  'revoke_invite is security definer with an empty search_path'
);

set local role anon;
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', repeat('90', 32), null, null) $$,
  '42501', null, 'anon cannot execute create_link_invite'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', '76561190000000950', null) $$,
  '42501', null, 'anon cannot execute create_direct_invite'
);
select throws_ok(
  $$ select * from public.revoke_invite('00000000-0000-0000-0000-0000000009d1',
       '00000000-0000-0000-0000-00000000e901') $$,
  '42501', null, 'anon cannot execute revoke_invite'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000e903","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', repeat('90', 32), null, null) $$,
  '42501', null, 'authenticated cannot execute create_link_invite, even as a member'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', '76561190000000950', null) $$,
  '42501', null, 'authenticated cannot execute create_direct_invite, even as a member'
);
select throws_ok(
  $$ select * from public.revoke_invite('00000000-0000-0000-0000-0000000009d1',
       '00000000-0000-0000-0000-00000000e901') $$,
  '42501', null, 'authenticated cannot execute revoke_invite'
);
reset role;

-- ---------------------------------------------------------------------------
-- create_link_invite (13-28)
-- ---------------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$ select * from public.create_link_invite(null,
       '00000000-0000-0000-0000-00000000e903', repeat('90', 32), null, null) $$,
  '22023', null, 'create_link_invite rejects a null room'
);
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
       null, repeat('90', 32), null, null) $$,
  '22023', null, 'create_link_invite rejects a null actor'
);
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', null, null, null) $$,
  '22023', null, 'create_link_invite rejects a null token hash'
);
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', repeat('90', 32), null, now() - interval '1 minute') $$,
  '22023', null, 'create_link_invite rejects an expiry in the past'
);
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-0000000009ff',
       '00000000-0000-0000-0000-00000000e903', repeat('90', 32), null, null) $$,
  'HX001', null, 'create_link_invite for an unknown room raises HX001'
);
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-00000000f902',
       '00000000-0000-0000-0000-00000000e903', repeat('90', 32), null, null) $$,
  'HX001', null, 'create_link_invite for a soft-deleted room raises HX001, even for a member'
);
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e905', repeat('90', 32), null, null) $$,
  'HX001', null, 'create_link_invite by a non-member raises HX001'
);
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', repeat('90', 32), null, null) $$,
  'HX002', null, 'create_link_invite by a plain member raises HX002'
);

select set_config('test.l1',
  (select row_to_json(s)::text
     from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
            '00000000-0000-0000-0000-00000000e902', repeat('91', 32), 2, null) s),
  true) is not null as _l1;

select is(
  (select row(j ->> 'room_id', j ->> 'created_by', j ->> 'kind',
              j ->> 'invitee_steam_id', j ->> 'max_uses', j ->> 'uses', j ->> 'expires_at',
              j ->> 'revoked_at')::text
     from (select current_setting('test.l1')::jsonb as j) x),
  row('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000e902', 'link',
      null::text, '2', '0', null::text, null::text)::text,
  'an admin creates a link invite; created_by is the actor'
);
select is(
  (select array_agg(k order by k collate "C")
     from jsonb_object_keys(current_setting('test.l1')::jsonb) k),
  array['accepted_at', 'created_at', 'created_by', 'declined_at', 'expires_at', 'id',
        'invitee_steam_id', 'kind', 'max_uses', 'revoked_at', 'room_id', 'uses'],
  'create_link_invite returns the invites columns without token_hash'
);
select ok(
  exists (
    select 1 from public.invites i
    where i.id = (current_setting('test.l1')::jsonb ->> 'id')::uuid
      and i.token_hash = repeat('91', 32) and i.created_at is not null
  ),
  'the link invite is stored'
);
select is(
  (select row(s.created_by, s.max_uses is null, s.expires_at > now())::text
     from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
            '00000000-0000-0000-0000-00000000e901', repeat('92', 32), null,
            now() + interval '1 day') s),
  row('00000000-0000-0000-0000-00000000e901'::uuid, true, true)::text,
  'the owner creates an unlimited link with a future expiry'
);
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e902', repeat('A', 64), null, null) $$,
  '23514', null, 'a token hash that is not 64 lowercase hex characters raises 23514'
);
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e902', repeat('90', 32), 0, null) $$,
  '23514', null, 'max_uses 0 raises 23514'
);
select throws_ok(
  $$ select * from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e902', repeat('91', 32), null, null) $$,
  '23505', null, 'a duplicate token hash raises 23505'
);
select is(
  (select count(*)::int from public.invites where room_id = '00000000-0000-0000-0000-00000000f901'),
  2, 'only the two successful calls stored an invite'
);

-- ---------------------------------------------------------------------------
-- create_direct_invite (29-55)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select * from public.create_direct_invite(null,
       '00000000-0000-0000-0000-00000000e903', '76561190000000950', null) $$,
  '22023', null, 'create_direct_invite rejects a null room'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       null, '76561190000000950', null) $$,
  '22023', null, 'create_direct_invite rejects a null actor'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', null, null) $$,
  '22023', null, 'create_direct_invite rejects a null Steam ID'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', '76561190000000950', now() - interval '1 minute') $$,
  '22023', null, 'create_direct_invite rejects an expiry in the past'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-0000000009ff',
       '00000000-0000-0000-0000-00000000e903', '76561190000000950', null) $$,
  'HX001', null, 'create_direct_invite for an unknown room raises HX001'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f902',
       '00000000-0000-0000-0000-00000000e903', '76561190000000950', null) $$,
  'HX001', null, 'create_direct_invite for a soft-deleted room raises HX001, even for a member'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e905', '76561190000000950', null) $$,
  'HX001', null, 'create_direct_invite by a non-member raises HX001'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', '76561190000000903', null) $$,
  'HX011', null, 'inviting yourself raises HX011'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', '76561190000000901', null) $$,
  'HX011', null, 'inviting an existing member raises HX011'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e903', '123', null) $$,
  '23514', null, 'a malformed Steam ID raises 23514'
);

select set_config('test.d1',
  (select row_to_json(s)::text
     from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
            '00000000-0000-0000-0000-00000000e903', '76561190000000950', null) s),
  true) is not null as _d1;

select is(
  (select row(j ->> 'room_id', j ->> 'created_by', j ->> 'kind', j ->> 'invitee_steam_id',
              j ->> 'max_uses', j ->> 'uses', j ->> 'revoked_at', j ->> 'replaced_invite_id',
              j ->> 'invitee_profile_id')::text
     from (select current_setting('test.d1')::jsonb as j) x),
  row('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000e903', 'direct',
      '76561190000000950', '1', '0', null::text, null::text, null::text)::text,
  'a new direct invite to a Steam account with no profile: replaced_invite_id and invitee_profile_id are null'
);
select is(
  (select array_agg(k order by k collate "C")
     from jsonb_object_keys(current_setting('test.d1')::jsonb) k),
  array['accepted_at', 'created_at', 'created_by', 'declined_at', 'expires_at', 'id',
        'invitee_profile_id', 'invitee_steam_id', 'kind', 'max_uses', 'replaced_invite_id',
        'revoked_at', 'room_id', 'uses'],
  'create_direct_invite returns the invites columns without token_hash, plus replaced_invite_id and invitee_profile_id'
);

select set_config('test.dq',
  (select row_to_json(s)::text
     from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
            '00000000-0000-0000-0000-00000000e902', '76561190000000906',
            now() + interval '1 day') s),
  true) is not null as _dq;

select is(
  current_setting('test.dq')::jsonb ->> 'invitee_profile_id',
  '00000000-0000-0000-0000-00000000e906',
  'inviting a Steam account with a profile returns that profile id'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e901', '76561190000000950', null) $$,
  'HX012', null, 'a second pending invite (no expiry) for the same Steam account raises HX012'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e904', '76561190000000906', null) $$,
  'HX012', null, 'a second pending invite (future expiry) for the same Steam account raises HX012'
);

-- An expired pending direct invite for 951 (created before it expired).
reset role;
insert into public.invites (id, room_id, created_by, kind, invitee_steam_id, max_uses, expires_at, created_at)
values ('00000000-0000-0000-0000-0000000009e1', '00000000-0000-0000-0000-00000000f901',
        '00000000-0000-0000-0000-00000000e901', 'direct', '76561190000000951', 1,
        now() - interval '1 hour', now() - interval '2 hours');
set local role service_role;

select set_config('test.de',
  (select row_to_json(s)::text
     from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
            '00000000-0000-0000-0000-00000000e903', '76561190000000951', null) s),
  true) is not null as _de;
select ok(
  (select (j ->> 'id') <> '00000000-0000-0000-0000-0000000009e1' and (j ->> 'revoked_at') is null
          and (j ->> 'invitee_steam_id') = '76561190000000951'
     from (select current_setting('test.de')::jsonb as j) x),
  'an expired pending invite does not block a new one'
);
select is(
  current_setting('test.de')::jsonb ->> 'replaced_invite_id',
  '00000000-0000-0000-0000-0000000009e1',
  'replacing an expired pending invite returns its id as replaced_invite_id'
);
select ok(
  (select i.revoked_at is not null from public.invites i where i.id = '00000000-0000-0000-0000-0000000009e1'),
  'the expired pending invite was revoked'
);
select is(
  (select count(*)::int from public.invites i
    where i.room_id = '00000000-0000-0000-0000-00000000f901' and i.invitee_steam_id = '76561190000000951'
      and i.revoked_at is null and i.accepted_at is null and i.declined_at is null),
  1, 'exactly one invite is pending for that Steam account'
);

-- After a decline, a new invite is allowed.
select is(
  (select status from public.respond_to_direct_invite(
     (current_setting('test.dq')::jsonb ->> 'id')::uuid, '00000000-0000-0000-0000-00000000e906', false)),
  'declined', 'the invitee declines a created direct invite'
);
select set_config('test.dq2',
  (select row_to_json(s)::text
     from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
            '00000000-0000-0000-0000-00000000e903', '76561190000000906', null) s),
  true) is not null as _dq2;
select ok(
  (current_setting('test.dq2')::jsonb ->> 'id') <> (current_setting('test.dq')::jsonb ->> 'id')
  and (current_setting('test.dq2')::jsonb ->> 'revoked_at') is null,
  'after a decline, a new direct invite for the same Steam account is allowed'
);

-- After an accept (and leaving), a new invite is allowed.
select set_config('test.dx',
  (select s.id::text
     from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
            '00000000-0000-0000-0000-00000000e901', '76561190000000907', null) s),
  true) is not null as _dx;
select is(
  (select status from public.respond_to_direct_invite(
     current_setting('test.dx')::uuid, '00000000-0000-0000-0000-00000000e906', true)),
  'invalid', 'another profile cannot answer a created direct invite'
);
select ok(
  (select i.accepted_at is null and i.declined_at is null and i.revoked_at is null
     from public.invites i where i.id = current_setting('test.dx')::uuid),
  'the invite is still pending after another profile tried to answer it'
);
select is(
  (select status from public.respond_to_direct_invite(
     current_setting('test.dx')::uuid, '00000000-0000-0000-0000-00000000e907', true)),
  'accepted', 'the right profile accepts a created direct invite'
);
select is(
  (select m.role from public.room_members m
    where m.room_id = '00000000-0000-0000-0000-00000000f901' and m.user_id = '00000000-0000-0000-0000-00000000e907'),
  'member', 'accepting adds the invitee as a member'
);
select throws_ok(
  $$ select * from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
       '00000000-0000-0000-0000-00000000e901', '76561190000000907', null) $$,
  'HX011', null, 'inviting someone who accepted and is now a member raises HX011'
);
select public.remove_member('00000000-0000-0000-0000-00000000f901',
  '00000000-0000-0000-0000-00000000e907', '00000000-0000-0000-0000-00000000e907');
select ok(
  (select s.id <> current_setting('test.dx')::uuid and s.revoked_at is null
          and s.invitee_profile_id = '00000000-0000-0000-0000-00000000e907'
     from public.create_direct_invite('00000000-0000-0000-0000-00000000f901',
            '00000000-0000-0000-0000-00000000e901', '76561190000000907', null) s),
  'after an accepted invite (and leaving), a new direct invite is allowed'
);

-- ---------------------------------------------------------------------------
-- revoke_invite (56-70)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select * from public.revoke_invite(null, '00000000-0000-0000-0000-00000000e903') $$,
  '22023', null, 'revoke_invite rejects a null invite'
);
select throws_ok(
  $$ select * from public.revoke_invite((current_setting('test.l1')::jsonb ->> 'id')::uuid, null) $$,
  '22023', null, 'revoke_invite rejects a null actor'
);
select throws_ok(
  $$ select * from public.revoke_invite('00000000-0000-0000-0000-0000000009ff',
       '00000000-0000-0000-0000-00000000e901') $$,
  'HX001', null, 'revoking an unknown invite raises HX001'
);
select throws_ok(
  $$ select * from public.revoke_invite('00000000-0000-0000-0000-0000000009d1',
       '00000000-0000-0000-0000-00000000e901') $$,
  'HX001', null, 'revoking an invite of a soft-deleted room raises HX001, even for its owner'
);
select throws_ok(
  $$ select * from public.revoke_invite((current_setting('test.l1')::jsonb ->> 'id')::uuid,
       '00000000-0000-0000-0000-00000000e905') $$,
  'HX001', null, 'revoke_invite by a non-member raises HX001'
);
select throws_ok(
  $$ select * from public.revoke_invite((current_setting('test.l1')::jsonb ->> 'id')::uuid,
       '00000000-0000-0000-0000-00000000e904') $$,
  'HX002', null, 'a plain member cannot revoke an admin''s invite (HX002)'
);
select ok(
  (select i.revoked_at is null from public.invites i
    where i.id = (current_setting('test.l1')::jsonb ->> 'id')::uuid),
  'the invite is unchanged after the rejected revoke'
);
select is(
  (select row(s.id, s.kind, s.revoked_at is not null, s.invitee_profile_id)::text
     from public.revoke_invite((current_setting('test.l1')::jsonb ->> 'id')::uuid,
            '00000000-0000-0000-0000-00000000e902') s),
  row((current_setting('test.l1')::jsonb ->> 'id')::uuid, 'link', true, null::uuid)::text,
  'the creator (an admin) revokes their link; invitee_profile_id is null for a link'
);
select ok(
  (select i.revoked_at is not null from public.invites i
    where i.id = (current_setting('test.l1')::jsonb ->> 'id')::uuid),
  'the revoke is stored'
);

-- now() is fixed within the transaction, so pin revoked_at to prove a repeat leaves it alone.
reset role;
update public.invites set revoked_at = '2001-02-03 00:00:00+00'
where id = (current_setting('test.l1')::jsonb ->> 'id')::uuid;
set local role service_role;

select is(
  (select s.revoked_at from public.revoke_invite((current_setting('test.l1')::jsonb ->> 'id')::uuid,
     '00000000-0000-0000-0000-00000000e902') s),
  '2001-02-03 00:00:00+00'::timestamptz,
  'revoking an already-revoked invite returns it unchanged'
);
select is(
  (select array_agg(k order by k collate "C")
     from public.revoke_invite((current_setting('test.l1')::jsonb ->> 'id')::uuid,
            '00000000-0000-0000-0000-00000000e902') s,
          jsonb_object_keys(row_to_json(s)::jsonb) k),
  array['accepted_at', 'created_at', 'created_by', 'declined_at', 'expires_at', 'id',
        'invitee_profile_id', 'invitee_steam_id', 'kind', 'max_uses', 'revoked_at', 'room_id',
        'uses'],
  'revoke_invite returns the invites columns without token_hash, plus invitee_profile_id'
);
select ok(
  (select s.revoked_at is not null and s.invitee_profile_id is null
     from public.revoke_invite((current_setting('test.d1')::jsonb ->> 'id')::uuid,
            '00000000-0000-0000-0000-00000000e901') s),
  'the owner revokes a member''s direct invite; invitee_profile_id is null without a profile'
);
select ok(
  (select s.revoked_at is not null
     from public.revoke_invite((select i.id from public.invites i where i.token_hash = repeat('92', 32)),
            '00000000-0000-0000-0000-00000000e902') s),
  'an admin revokes the owner''s link'
);
select is(
  (select s.invitee_profile_id
     from public.revoke_invite((current_setting('test.dq2')::jsonb ->> 'id')::uuid,
            '00000000-0000-0000-0000-00000000e902') s),
  '00000000-0000-0000-0000-00000000e906'::uuid,
  'an admin revokes a member''s direct invite; the invitee''s profile id is returned'
);
select is(
  (select status from public.respond_to_direct_invite(
     (current_setting('test.dq2')::jsonb ->> 'id')::uuid, '00000000-0000-0000-0000-00000000e906', true)),
  'revoked', 'accepting a direct invite revoked via revoke_invite returns revoked'
);

-- ---------------------------------------------------------------------------
-- redeem_invite_link on created links (71-77)
-- ---------------------------------------------------------------------------
select id from public.create_link_invite('00000000-0000-0000-0000-00000000f901',
  '00000000-0000-0000-0000-00000000e902', repeat('93', 32), 1, null);

select is(
  (select status from public.redeem_invite_link(repeat('93', 32), '00000000-0000-0000-0000-00000000e908')),
  'joined', 'a created link joins the room'
);
select is(
  (select status from public.redeem_invite_link(repeat('93', 32), '00000000-0000-0000-0000-00000000e908')),
  'already_member', 'redeeming a created link again returns already_member'
);
select is(
  (select status from public.redeem_invite_link(repeat('93', 32), '00000000-0000-0000-0000-00000000e909')),
  'used_up', 'a created link is used_up after max_uses'
);

-- A link plain member P created before links became owner/admin only (inserted directly).
reset role;
insert into public.invites (room_id, created_by, kind, token_hash) values
  ('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000e904', 'link', repeat('94', 32));
set local role service_role;
select ok(
  (select s.revoked_at is not null
     from public.revoke_invite((select i.id from public.invites i where i.token_hash = repeat('94', 32)),
            '00000000-0000-0000-0000-00000000e904') s),
  'a plain member revokes their own link'
);
select is(
  (select status from public.redeem_invite_link(repeat('94', 32), '00000000-0000-0000-0000-00000000e909')),
  'revoked', 'a link revoked via revoke_invite returns revoked'
);

-- An expired link plain member M created before links became owner/admin only.
reset role;
insert into public.invites (room_id, created_by, kind, token_hash, created_at, expires_at) values
  ('00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000e903', 'link',
   repeat('95', 32), now() - interval '2 hours', now() - interval '1 hour');
set local role service_role;

select is(
  (select status from public.redeem_invite_link(repeat('95', 32), '00000000-0000-0000-0000-00000000e909')),
  'expired', 'an expired created link returns expired'
);
select ok(
  not exists (
    select 1 from public.room_members m
    where m.room_id = '00000000-0000-0000-0000-00000000f901' and m.user_id = '00000000-0000-0000-0000-00000000e909'
  ),
  'failed redemptions did not add a member'
);

-- ---------------------------------------------------------------------------
-- remove_member revokes the target's pending invites (78-90)
-- ---------------------------------------------------------------------------
-- Room K (f903): O owner, A admin, M member, P member, X member.
-- M's invites in K: pending link a1, pending direct to N (905), an accepted direct (957), a
-- declined direct (958). P's pending link a2; A's pending direct to Q (906). X's pending link
-- a3 and pending direct to 956 (no profile). The members' links a1-a3 are inserted directly
-- (links created before links became owner/admin only).
reset role;
insert into public.rooms (id, name, icon_emoji) values
  ('00000000-0000-0000-0000-00000000f903', 'Room K', 'x');
insert into public.room_members (room_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000f903', '00000000-0000-0000-0000-00000000e901', 'owner'),
  ('00000000-0000-0000-0000-00000000f903', '00000000-0000-0000-0000-00000000e902', 'admin'),
  ('00000000-0000-0000-0000-00000000f903', '00000000-0000-0000-0000-00000000e903', 'member'),
  ('00000000-0000-0000-0000-00000000f903', '00000000-0000-0000-0000-00000000e904', 'member'),
  ('00000000-0000-0000-0000-00000000f903', '00000000-0000-0000-0000-00000000e907', 'member');
insert into public.invites (id, room_id, created_by, kind, invitee_steam_id, max_uses, uses, accepted_at, declined_at) values
  ('00000000-0000-0000-0000-0000000009a7', '00000000-0000-0000-0000-00000000f903',
   '00000000-0000-0000-0000-00000000e903', 'direct', '76561190000000957', 1, 1, now(), null),
  ('00000000-0000-0000-0000-0000000009a8', '00000000-0000-0000-0000-00000000f903',
   '00000000-0000-0000-0000-00000000e903', 'direct', '76561190000000958', 1, 0, null, now());
insert into public.invites (room_id, created_by, kind, token_hash) values
  ('00000000-0000-0000-0000-00000000f903', '00000000-0000-0000-0000-00000000e903', 'link', repeat('a1', 32)),
  ('00000000-0000-0000-0000-00000000f903', '00000000-0000-0000-0000-00000000e904', 'link', repeat('a2', 32)),
  ('00000000-0000-0000-0000-00000000f903', '00000000-0000-0000-0000-00000000e907', 'link', repeat('a3', 32));
set local role service_role;

select set_config('test.km',
  (select s.id::text
     from public.create_direct_invite('00000000-0000-0000-0000-00000000f903',
            '00000000-0000-0000-0000-00000000e903', '76561190000000905', null) s),
  true) is not null as _km;
select id from public.create_direct_invite('00000000-0000-0000-0000-00000000f903',
  '00000000-0000-0000-0000-00000000e902', '76561190000000906', null);
select id from public.create_direct_invite('00000000-0000-0000-0000-00000000f903',
  '00000000-0000-0000-0000-00000000e907', '76561190000000956', null);

-- Existing behaviour is unchanged (spot checks; full coverage in 050_core_fixes).
select throws_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-00000000f903',
       '00000000-0000-0000-0000-00000000e904', '00000000-0000-0000-0000-00000000e903') $$,
  'HX002', null, 'a plain member cannot remove another member (HX002)'
);
select throws_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-00000000f903',
       '00000000-0000-0000-0000-00000000e902', '00000000-0000-0000-0000-00000000e901') $$,
  'HX005', null, 'an admin cannot remove the owner (HX005)'
);

-- The owner removes M.
select lives_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-00000000f903',
       '00000000-0000-0000-0000-00000000e901', '00000000-0000-0000-0000-00000000e903') $$,
  'the owner removes member M'
);
select is(
  (select count(*)::int from public.invites i
    where i.room_id = '00000000-0000-0000-0000-00000000f903'
      and i.created_by = '00000000-0000-0000-0000-00000000e903'
      and i.revoked_at is null and i.accepted_at is null and i.declined_at is null),
  0, 'removing M revoked all of M''s pending invites in the room'
);
select is(
  (select status from public.redeem_invite_link(repeat('a1', 32), '00000000-0000-0000-0000-00000000e903')),
  'revoked', 'the removed member cannot rejoin with their own link (revoked)'
);
select is(
  (select status from public.respond_to_direct_invite(
     current_setting('test.km')::uuid, '00000000-0000-0000-0000-00000000e905', true)),
  'revoked', 'a direct invite created by the removed member returns revoked'
);
select ok(
  (select bool_and(i.revoked_at is null) and count(*) = 2
     from public.invites i
    where i.room_id = '00000000-0000-0000-0000-00000000f903'
      and i.created_by in ('00000000-0000-0000-0000-00000000e902', '00000000-0000-0000-0000-00000000e904')),
  'other members'' pending invites stay active'
);
select is(
  (select status from public.redeem_invite_link(repeat('a2', 32), '00000000-0000-0000-0000-00000000e909')),
  'joined', 'another member''s link still works after the removal'
);
select ok(
  (select bool_and(i.revoked_at is null) and count(*) = 2
     from public.invites i
    where i.id in ('00000000-0000-0000-0000-0000000009a7', '00000000-0000-0000-0000-0000000009a8')),
  'the removed member''s accepted and declined invites are left untouched'
);
select ok(
  (select i.revoked_at is null from public.invites i where i.token_hash = repeat('95', 32)),
  'the removed member''s invites in other rooms are left untouched'
);

-- X leaves voluntarily (actor = target).
select lives_ok(
  $$ select public.remove_member('00000000-0000-0000-0000-00000000f903',
       '00000000-0000-0000-0000-00000000e907', '00000000-0000-0000-0000-00000000e907') $$,
  'member X leaves the room'
);
select is(
  (select count(*)::int from public.invites i
    where i.room_id = '00000000-0000-0000-0000-00000000f903'
      and i.created_by = '00000000-0000-0000-0000-00000000e907'
      and i.revoked_at is null and i.accepted_at is null and i.declined_at is null),
  0, 'leaving revoked all of X''s pending invites (link and direct)'
);
select is(
  (select status from public.redeem_invite_link(repeat('a3', 32), '00000000-0000-0000-0000-00000000e907')),
  'revoked', 'a member who left cannot rejoin with their own link (revoked)'
);

reset role;

select * from finish();
rollback;
