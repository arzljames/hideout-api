-- profiles, sessions, create_login_session(), and the schema-wide default-privilege lockdown.
-- Runs inside the runner's transaction, which is always rolled back.
begin;

select plan(61);

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'sessions', 'sessions table exists');

select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.profiles'::regclass),
  'RLS is enabled on profiles'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.sessions'::regclass),
  'RLS is enabled on sessions'
);

select is(
  (select count(*)::int from pg_catalog.pg_policies
    where schemaname = 'public' and tablename in ('profiles', 'sessions')),
  0,
  'profiles and sessions have no RLS policies'
);

select is(
  (select count(*)::int from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('profiles', 'sessions')),
  0,
  'profiles and sessions are not in the supabase_realtime publication'
);

select has_index('public', 'sessions', 'sessions_profile_id_idx', 'sessions has an index on profile_id');
select has_index('public', 'sessions', 'sessions_expires_at_idx', 'sessions has an index on expires_at');

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
select ok(
  not has_table_privilege('anon', 'public.profiles', 'select, insert, update, delete, truncate, references, trigger'),
  'anon has no privileges on profiles'
);
select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'select, insert, update, delete, truncate, references, trigger'),
  'authenticated has no privileges on profiles'
);
select ok(
  not has_table_privilege('anon', 'public.sessions', 'select, insert, update, delete, truncate, references, trigger'),
  'anon has no privileges on sessions'
);
select ok(
  not has_table_privilege('authenticated', 'public.sessions', 'select, insert, update, delete, truncate, references, trigger'),
  'authenticated has no privileges on sessions'
);
select ok(
  has_table_privilege('service_role', 'public.profiles', 'select')
  and has_table_privilege('service_role', 'public.profiles', 'insert')
  and has_table_privilege('service_role', 'public.profiles', 'update')
  and has_table_privilege('service_role', 'public.profiles', 'delete'),
  'service_role can select/insert/update/delete on profiles'
);
select ok(
  has_table_privilege('service_role', 'public.sessions', 'select')
  and has_table_privilege('service_role', 'public.sessions', 'insert')
  and has_table_privilege('service_role', 'public.sessions', 'update')
  and has_table_privilege('service_role', 'public.sessions', 'delete'),
  'service_role can select/insert/update/delete on sessions'
);

-- anon: every operation on both tables is denied
set local role anon;
select throws_ok($$ select * from public.profiles $$, '42501', null, 'anon cannot select profiles');
select throws_ok(
  $$ insert into public.profiles (steam_id, display_name) values ('00000000000000009', 'x') $$,
  '42501', null, 'anon cannot insert profiles'
);
select throws_ok($$ update public.profiles set display_name = 'x' $$, '42501', null, 'anon cannot update profiles');
select throws_ok($$ delete from public.profiles $$, '42501', null, 'anon cannot delete profiles');
select throws_ok($$ select * from public.sessions $$, '42501', null, 'anon cannot select sessions');
select throws_ok(
  $$ insert into public.sessions (profile_id, token_hash, expires_at)
     values (gen_random_uuid(), repeat('0', 64), now() + interval '1 day') $$,
  '42501', null, 'anon cannot insert sessions'
);
select throws_ok($$ update public.sessions set expires_at = now() $$, '42501', null, 'anon cannot update sessions');
select throws_ok($$ delete from public.sessions $$, '42501', null, 'anon cannot delete sessions');
reset role;

-- authenticated: every operation on both tables is denied
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true) is not null as _claims;
select throws_ok($$ select * from public.profiles $$, '42501', null, 'authenticated cannot select profiles');
select throws_ok(
  $$ insert into public.profiles (steam_id, display_name) values ('00000000000000009', 'x') $$,
  '42501', null, 'authenticated cannot insert profiles'
);
select throws_ok($$ update public.profiles set display_name = 'x' $$, '42501', null, 'authenticated cannot update profiles');
select throws_ok($$ delete from public.profiles $$, '42501', null, 'authenticated cannot delete profiles');
select throws_ok($$ select * from public.sessions $$, '42501', null, 'authenticated cannot select sessions');
select throws_ok(
  $$ insert into public.sessions (profile_id, token_hash, expires_at)
     values (gen_random_uuid(), repeat('0', 64), now() + interval '1 day') $$,
  '42501', null, 'authenticated cannot insert sessions'
);
select throws_ok($$ update public.sessions set expires_at = now() $$, '42501', null, 'authenticated cannot update sessions');
select throws_ok($$ delete from public.sessions $$, '42501', null, 'authenticated cannot delete sessions');
reset role;

-- create_login_session: only service_role may execute
set local role anon;
select throws_ok(
  $$ select public.create_login_session('00000000000000009', 'x', null, repeat('0', 64), now() + interval '1 day') $$,
  '42501', null, 'anon cannot execute create_login_session'
);
reset role;

set local role authenticated;
select throws_ok(
  $$ select public.create_login_session('00000000000000009', 'x', null, repeat('0', 64), now() + interval '1 day') $$,
  '42501', null, 'authenticated cannot execute create_login_session'
);
reset role;

select ok(
  not has_function_privilege('public', 'public.create_login_session(text, text, text, text, timestamptz, boolean)', 'execute'),
  'PUBLIC cannot execute create_login_session'
);

select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_catalog.pg_proc p
    where p.oid = 'public.create_login_session(text, text, text, text, timestamptz, boolean)'::regprocedure),
  'create_login_session is security definer with an empty search_path'
);

-- ---------------------------------------------------------------------------
-- create_login_session behavior
-- ---------------------------------------------------------------------------
set local role service_role;
select ok(
  set_config(
    'test.p1',
    public.create_login_session(
      '00000000000000001', 'Alice', 'https://avatars.example/a1.jpg', repeat('a', 64), now() + interval '1 day'
    )::text,
    true
  ) is not null,
  'service_role can execute create_login_session (new profile)'
);
reset role;

select is(
  (select display_name from public.profiles where id = current_setting('test.p1')::uuid),
  'Alice',
  'first login creates the profile with the given display_name'
);
select is(
  (select avatar_url from public.profiles where id = current_setting('test.p1')::uuid),
  'https://avatars.example/a1.jpg',
  'first login stores the given avatar_url'
);
select is(
  (select count(*)::int from public.sessions
    where profile_id = current_setting('test.p1')::uuid and token_hash = repeat('a', 64)),
  1,
  'first login creates a session for the profile'
);

-- An expired session for the same profile, which the next login should prune.
insert into public.sessions (profile_id, token_hash, created_at, expires_at)
values (current_setting('test.p1')::uuid, repeat('e', 64), now() - interval '2 hours', now() - interval '1 hour');

set local role service_role;
select is(
  public.create_login_session(
    '00000000000000001', 'Alice Renamed', 'https://avatars.example/a2.jpg', repeat('b', 64), now() + interval '1 day'
  ),
  current_setting('test.p1')::uuid,
  'second login with the same steam_id returns the same profile id'
);
reset role;

select is(
  (select count(*)::int from public.profiles where steam_id = '00000000000000001'),
  1,
  'second login does not create a second profile'
);
select is(
  (select display_name from public.profiles where id = current_setting('test.p1')::uuid),
  'Alice Renamed',
  'second login updates display_name'
);
select is(
  (select avatar_url from public.profiles where id = current_setting('test.p1')::uuid),
  'https://avatars.example/a2.jpg',
  'second login updates avatar_url'
);
select is(
  (select count(*)::int from public.sessions where token_hash = repeat('e', 64)),
  0,
  'login deletes the profile''s expired sessions'
);
select is(
  (select count(*)::int from public.sessions where profile_id = current_setting('test.p1')::uuid),
  2,
  'login keeps unexpired sessions and adds the new one'
);

set local role service_role;
select is(
  public.create_login_session(
    '00000000000000001', 'Fallback Name', null, repeat('c', 64), now() + interval '1 day', true
  ),
  current_setting('test.p1')::uuid,
  'p_keep_existing_profile login returns the existing profile id'
);
reset role;

select is(
  (select display_name from public.profiles where id = current_setting('test.p1')::uuid),
  'Alice Renamed',
  'p_keep_existing_profile leaves display_name unchanged'
);
select is(
  (select avatar_url from public.profiles where id = current_setting('test.p1')::uuid),
  'https://avatars.example/a2.jpg',
  'p_keep_existing_profile leaves avatar_url unchanged'
);

set local role service_role;
select ok(
  set_config(
    'test.p3',
    public.create_login_session(
      '00000000000000003', 'Fallback Name', null, repeat('d', 64), now() + interval '1 day', true
    )::text,
    true
  ) is not null,
  'p_keep_existing_profile login succeeds for a new steam_id'
);
reset role;

select is(
  (select display_name from public.profiles where id = current_setting('test.p3')::uuid),
  'Fallback Name',
  'p_keep_existing_profile uses the given display_name for a new profile'
);

-- Failure cases
set local role service_role;
select throws_ok(
  $$ select public.create_login_session('7656119', 'Bob', null, repeat('f', 64), now() + interval '1 day') $$,
  '23514', null, 'invalid steam_id is rejected'
);
select throws_ok(
  $$ select public.create_login_session('00000000000000002', 'Bob', null, 'NOT-A-HASH', now() + interval '1 day') $$,
  '23514', null, 'invalid token_hash is rejected'
);
select throws_ok(
  $$ select public.create_login_session('00000000000000002', 'Bob', null, repeat('f', 64), now() - interval '1 minute') $$,
  '22023', null, 'expires_at in the past is rejected'
);
select throws_ok(
  $$ select public.create_login_session('00000000000000002', 'Bob', null, repeat('a', 64), now() + interval '1 day') $$,
  '23505', null, 'duplicate token_hash is rejected'
);
select throws_ok(
  $$ select public.create_login_session('00000000000000002', 'Bob', 'http://insecure.example/a.jpg', repeat('f', 64), now() + interval '1 day') $$,
  '23514', null, 'non-https avatar_url is rejected'
);
reset role;

-- Deleting a profile cascades to its sessions
delete from public.profiles where id = current_setting('test.p3')::uuid;
select is(
  (select count(*)::int from public.sessions where profile_id = current_setting('test.p3')::uuid),
  0,
  'deleting a profile deletes its sessions'
);

-- ---------------------------------------------------------------------------
-- Default privileges: objects created later in public are locked down too
-- ---------------------------------------------------------------------------
create table public._lockdown_probe (x int);
create sequence public._lockdown_probe_seq;

set local role anon;
select throws_ok($$ select * from public._lockdown_probe $$, '42501', null, 'anon cannot select a newly created table');
reset role;

set local role authenticated;
select throws_ok($$ select * from public._lockdown_probe $$, '42501', null, 'authenticated cannot select a newly created table');
reset role;

set local role service_role;
select lives_ok($$ select * from public._lockdown_probe $$, 'service_role can select a newly created table');
reset role;

select ok(
  not has_sequence_privilege('anon', 'public._lockdown_probe_seq', 'usage, select, update'),
  'anon has no privileges on a newly created sequence'
);
select ok(
  not has_sequence_privilege('authenticated', 'public._lockdown_probe_seq', 'usage, select, update'),
  'authenticated has no privileges on a newly created sequence'
);
select ok(
  has_sequence_privilege('service_role', 'public._lockdown_probe_seq', 'usage'),
  'service_role can use a newly created sequence'
);

select * from finish();
rollback;
