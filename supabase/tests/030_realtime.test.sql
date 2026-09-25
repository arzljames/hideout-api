-- Realtime authorization: private.can_access_topic() and the realtime.messages policies.
-- Runs inside the runner's transaction, which is always rolled back (so the test rows
-- inserted into realtime.messages are never committed and never broadcast).
--
-- Topic access for browsers:
--   receive  room:<id>, channel:<id>, typing:<id>, user:<id> (as can_access_topic allows)
--   send     Presence on room:<id> only; Broadcast on typing:<channelId> only
--
-- Assumptions (hosted Supabase; see the migration's Realtime section):
--   * realtime.topic() reads the `realtime.topic` setting, which the Realtime server sets
--     with set_config before running the policy checks. Assertion 1 verifies this.
--   * auth.jwt() reads `request.jwt.claims`.
--   * realtime.messages is partitioned by inserted_at. If no partition covers today, the
--     probe below creates one (rolled back with the file). If rows still can't be inserted,
--     assertion 33 fails and the policy-level assertions are reported as skipped.
--     Creating that partition takes a strong lock on realtime.messages that is held until the
--     file's transaction rolls back, briefly blocking Realtime's own checks. Acceptable on the
--     dev project only; this runner never targets anything else.
begin;

select plan(69);

-- ---------------------------------------------------------------------------
-- Fixtures (as the owner role)
-- ---------------------------------------------------------------------------
-- A: member of room R1. B: never a member. C: joined R1, then removed.
insert into public.profiles (id, steam_id, display_name) values
  ('00000000-0000-0000-0000-00000000b301', '76561190000000301', 'Member A'),
  ('00000000-0000-0000-0000-00000000b302', '76561190000000302', 'Outsider B'),
  ('00000000-0000-0000-0000-00000000b303', '76561190000000303', 'Removed C');

select set_config('test.r1',
  public.create_room('00000000-0000-0000-0000-00000000b301', 'Room One', 'x', null)::text, true) is not null as _r1;
select set_config('test.r2',
  public.create_room('00000000-0000-0000-0000-00000000b301', 'Room Two', 'x', null)::text, true) is not null as _r2;

select set_config('test.ch1',
  (select id::text from public.channels
    where room_id = current_setting('test.r1')::uuid and type = 'text' and name = 'general'), true) is not null as _ch1;
select set_config('test.r2ch',
  (select id::text from public.channels
    where room_id = current_setting('test.r2')::uuid and type = 'text' and name = 'general'), true) is not null as _r2ch;

insert into public.channels (room_id, type, name, position, deleted_at)
values (current_setting('test.r1')::uuid, 'text', 'archived', 1, now());
select set_config('test.chdel',
  (select id::text from public.channels
    where room_id = current_setting('test.r1')::uuid and name = 'archived'), true) is not null as _chdel;

insert into public.room_members (room_id, user_id, role)
values (current_setting('test.r1')::uuid, '00000000-0000-0000-0000-00000000b303', 'member');
delete from public.room_members
where room_id = current_setting('test.r1')::uuid and user_id = '00000000-0000-0000-0000-00000000b303';

select public.delete_room(current_setting('test.r2')::uuid, '00000000-0000-0000-0000-00000000b301');

-- Probe realtime.messages and insert the rows the read checks select (mirrors the Realtime
-- server, which inserts with its own role and then selects as the JWT role).
do $$
declare
  v_ready boolean := false;
  v_day   timestamp := date_trunc('day', localtimestamp);
begin
  begin
    insert into realtime.messages (topic, extension, event, payload, private)
    values ('hideout-test:probe', 'broadcast', 'probe', '{}'::jsonb, true);
    v_ready := true;
  exception when others then
    begin
      execute format(
        'create table realtime.%I partition of realtime.messages for values from (%L) to (%L)',
        'messages_hideout_test', v_day, v_day + interval '1 day'
      );
      insert into realtime.messages (topic, extension, event, payload, private)
      values ('hideout-test:probe', 'broadcast', 'probe', '{}'::jsonb, true);
      v_ready := true;
    exception when others then
      raise notice 'realtime.messages not writable in tests: % (%)', sqlerrm, sqlstate;
      v_ready := false;
    end;
  end;

  if v_ready then
    insert into realtime.messages (topic, extension, event, payload, private) values
      ('room:' || current_setting('test.r1'),       'broadcast', 'hideout-test', '{}'::jsonb, true),
      ('room:' || current_setting('test.r1'),       'presence',  'hideout-test', '{}'::jsonb, true),
      ('channel:' || current_setting('test.ch1'),   'broadcast', 'hideout-test', '{}'::jsonb, true),
      ('typing:' || current_setting('test.ch1'),    'broadcast', 'hideout-test', '{}'::jsonb, true),
      ('channel:' || current_setting('test.chdel'), 'broadcast', 'hideout-test', '{}'::jsonb, true),
      ('room:' || current_setting('test.r2'),       'broadcast', 'hideout-test', '{}'::jsonb, true),
      ('user:00000000-0000-0000-0000-00000000b301', 'broadcast', 'hideout-test', '{}'::jsonb, true),
      ('user:00000000-0000-0000-0000-00000000b302', 'broadcast', 'hideout-test', '{}'::jsonb, true);
  end if;

  perform set_config('test.rt_ready', v_ready::text, true);
end
$$;

-- ---------------------------------------------------------------------------
-- Helper, realtime.topic(), and policy structure (1-7)
-- ---------------------------------------------------------------------------
select set_config('realtime.topic', 'room:probe', true) is not null as _t;
select is(realtime.topic(), 'room:probe', 'realtime.topic() returns the realtime.topic setting');

select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""'] and p.provolatile = 's'
     from pg_catalog.pg_proc p where p.oid = 'private.can_access_topic(text)'::regprocedure),
  'can_access_topic is stable, security definer, with an empty search_path'
);
select ok(
  has_function_privilege('authenticated', 'private.can_access_topic(text)', 'execute')
  and not has_function_privilege('anon', 'private.can_access_topic(text)', 'execute')
  and not has_function_privilege('public', 'private.can_access_topic(text)', 'execute'),
  'can_access_topic is executable by authenticated, not by anon or PUBLIC'
);
select ok(
  has_schema_privilege('authenticated', 'private', 'usage')
  and not has_schema_privilege('anon', 'private', 'usage')
  and not has_schema_privilege('public', 'private', 'usage'),
  'schema private is usable by authenticated only (not anon or PUBLIC)'
);

set local role anon;
select throws_ok(
  $$ select private.can_access_topic('room:' || current_setting('test.r1')) $$,
  '42501', null, 'anon cannot execute can_access_topic'
);
reset role;

select is(
  (select count(*)::int from pg_catalog.pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and roles = array['authenticated']::name[]
      and policyname in (
        'hideout: members receive on accessible topics',
        'hideout: members track presence on room topics',
        'hideout: members broadcast on typing topics')),
  3,
  'the three Hideout policies on realtime.messages exist, for authenticated only'
);
select is(
  (select count(*)::int from pg_catalog.pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and roles && array['anon', 'public']::name[]),
  0,
  'realtime.messages has no policies for anon or PUBLIC'
);

-- ---------------------------------------------------------------------------
-- can_access_topic: member A (8-20)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b301","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;

select ok(private.can_access_topic('room:' || current_setting('test.r1')), 'member can access room:<id> of their room');
select ok(private.can_access_topic('channel:' || current_setting('test.ch1')), 'member can access channel:<id> in their room');
select ok(private.can_access_topic('typing:' || current_setting('test.ch1')), 'member can access typing:<id> in their room');
select ok(private.can_access_topic('user:00000000-0000-0000-0000-00000000b301'), 'user can access their own user:<id>');
select ok(not private.can_access_topic('user:00000000-0000-0000-0000-00000000b302'), 'user cannot access another user:<id>');
select ok(not private.can_access_topic('channel:' || current_setting('test.chdel')), 'member cannot access a deleted channel');
select ok(not private.can_access_topic('typing:' || current_setting('test.chdel')), 'member cannot access typing:<id> of a deleted channel');
select ok(not private.can_access_topic('room:' || current_setting('test.r2')), 'member cannot access a deleted room');
select ok(not private.can_access_topic('channel:' || current_setting('test.r2ch')), 'member cannot access a channel of a deleted room');
select ok(not private.can_access_topic('room:not-a-uuid'), 'a malformed topic id is denied');
select ok(not private.can_access_topic('guild:' || current_setting('test.r1')), 'an unknown topic prefix is denied');
select ok(not private.can_access_topic('room'), 'a topic without an id is denied');
select ok(not private.can_access_topic(null), 'a null topic is denied');

-- ---------------------------------------------------------------------------
-- can_access_topic: non-member B, removed member C, bad JWTs (21-32)
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b302","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select ok(not private.can_access_topic('room:' || current_setting('test.r1')), 'non-member cannot access room:<id>');
select ok(not private.can_access_topic('channel:' || current_setting('test.ch1')), 'non-member cannot access channel:<id>');
select ok(not private.can_access_topic('typing:' || current_setting('test.ch1')), 'non-member cannot access typing:<id>');
select ok(private.can_access_topic('user:00000000-0000-0000-0000-00000000b302'), 'non-member can still access their own user:<id>');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b303","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select ok(not private.can_access_topic('room:' || current_setting('test.r1')), 'removed member cannot access room:<id>');
select ok(not private.can_access_topic('channel:' || current_setting('test.ch1')), 'removed member cannot access channel:<id>');
select ok(not private.can_access_topic('typing:' || current_setting('test.ch1')), 'removed member cannot access typing:<id>');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b301","role":"authenticated","iss":"supabase"}', true) is not null as _c;
select ok(not private.can_access_topic('room:' || current_setting('test.r1')), 'a JWT with another issuer cannot access room:<id>');
select ok(not private.can_access_topic('user:00000000-0000-0000-0000-00000000b301'), 'a JWT with another issuer cannot access user:<id>');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b301","role":"authenticated"}', true) is not null as _c;
select ok(not private.can_access_topic('room:' || current_setting('test.r1')), 'a JWT without an issuer is denied');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b301","role":"anon","iss":"hideout-api"}', true) is not null as _c;
select ok(not private.can_access_topic('room:' || current_setting('test.r1')), 'a JWT whose role claim is not authenticated is denied');

select set_config('request.jwt.claims',
  '{"sub":"not-a-uuid","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select ok(not private.can_access_topic('room:' || current_setting('test.r1')), 'a JWT with a non-uuid sub is denied');
reset role;

-- ---------------------------------------------------------------------------
-- realtime.messages select (receive) policy (33-49)
-- ---------------------------------------------------------------------------
select ok(current_setting('test.rt_ready')::boolean,
  'realtime.messages accepts test rows (policy-level tests below can run)');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b301","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;

select set_config('realtime.topic', 'room:' || current_setting('test.r1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages
    where topic = realtime.topic() and extension = 'broadcast' and event = 'hideout-test'),
  1, 'member receives broadcast on room:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages
    where topic = realtime.topic() and extension = 'presence' and event = 'hideout-test'),
  1, 'member receives presence on room:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

select set_config('realtime.topic', 'channel:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  1, 'member receives on channel:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

select set_config('realtime.topic', 'typing:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  1, 'member receives on typing:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

select set_config('realtime.topic', 'user:00000000-0000-0000-0000-00000000b301', true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  1, 'user receives on their own user:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

select set_config('realtime.topic', 'user:00000000-0000-0000-0000-00000000b302', true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  0, 'user does not receive on another user:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

select set_config('realtime.topic', 'channel:' || current_setting('test.chdel'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  0, 'member does not receive on a deleted channel')
  else skip('realtime.messages not writable in tests', 1) end;

select set_config('realtime.topic', 'room:' || current_setting('test.r2'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  0, 'member does not receive on a deleted room')
  else skip('realtime.messages not writable in tests', 1) end;

-- Non-member B
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b302","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select set_config('realtime.topic', 'room:' || current_setting('test.r1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  0, 'non-member does not receive on room:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select set_config('realtime.topic', 'channel:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  0, 'non-member does not receive on channel:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select set_config('realtime.topic', 'typing:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  0, 'non-member does not receive on typing:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

-- Removed member C
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b303","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select set_config('realtime.topic', 'room:' || current_setting('test.r1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  0, 'removed member does not receive on room:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select set_config('realtime.topic', 'channel:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  0, 'removed member does not receive on channel:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select set_config('realtime.topic', 'typing:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  0, 'removed member does not receive on typing:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

-- Member A with a JWT from another issuer
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b301","role":"authenticated","iss":"supabase"}', true) is not null as _c;
select set_config('realtime.topic', 'room:' || current_setting('test.r1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then is(
  (select count(*)::int from realtime.messages where topic = realtime.topic() and event = 'hideout-test'),
  0, 'a JWT with another issuer does not receive on room:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
reset role;

-- anon: no policies, so no rows (or no privilege at all).
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true) is not null as _c;
select set_config('realtime.topic', 'room:' || current_setting('test.r1'), true) is not null as _t;
do $$
declare
  v_count integer;
begin
  begin
    select count(*)::int into v_count from realtime.messages where event = 'hideout-test';
  exception when insufficient_privilege then
    v_count := 0;
  end;
  perform set_config('test.anon_rt_count', v_count::text, true);
end
$$;
reset role;
select case when current_setting('test.rt_ready')::boolean then is(
  current_setting('test.anon_rt_count')::int,
  0, 'anon receives nothing from realtime.messages')
  else skip('realtime.messages not writable in tests', 1) end;

-- ---------------------------------------------------------------------------
-- realtime.messages insert (send) policies (50-69)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b301","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;

-- typing:<id> for member A
select set_config('realtime.topic', 'typing:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then lives_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'broadcast', 'typing',
             '{"userId":"00000000-0000-0000-0000-00000000b301"}'::jsonb, true) $$,
  'member can broadcast typing on typing:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
-- The row the Realtime server inserts for its once-per-join write check (no event, no payload).
select case when current_setting('test.rt_ready')::boolean then lives_ok(
  $$ insert into realtime.messages (topic, extension, private)
     values (realtime.topic(), 'broadcast', true) $$,
  'join-time broadcast write check (no event/payload) passes on typing:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
-- Documents that the database can't restrict events: clients must treat typing: as untrusted.
select case when current_setting('test.rt_ready')::boolean then lives_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'broadcast', 'anything', '{}'::jsonb, true) $$,
  'no per-event check on typing:<id> (clients must treat payloads as untrusted)')
  else skip('realtime.messages not writable in tests', 1) end;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'presence', 'hideout-test', '{}'::jsonb, true) $$,
  '42501', null, 'member cannot track presence on typing:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

select set_config('realtime.topic', 'typing:' || current_setting('test.chdel'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'broadcast', 'typing', '{}'::jsonb, true) $$,
  '42501', null, 'member cannot broadcast on typing:<id> of a deleted channel')
  else skip('realtime.messages not writable in tests', 1) end;

-- channel:<id> is receive-only
select set_config('realtime.topic', 'channel:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'broadcast', 'typing', '{}'::jsonb, true) $$,
  '42501', null, 'member cannot broadcast on channel:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, private)
     values (realtime.topic(), 'broadcast', true) $$,
  '42501', null, 'join-time broadcast write check is denied on channel:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'presence', 'hideout-test', '{}'::jsonb, true) $$,
  '42501', null, 'member cannot track presence on channel:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

-- room:<id>: Presence only
select set_config('realtime.topic', 'room:' || current_setting('test.r1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then lives_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'presence', 'hideout-test', '{}'::jsonb, true) $$,
  'member can track presence on room:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'broadcast', 'typing', '{}'::jsonb, true) $$,
  '42501', null, 'member cannot broadcast on room:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

-- user:<id> is receive-only
select set_config('realtime.topic', 'user:00000000-0000-0000-0000-00000000b301', true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'broadcast', 'typing', '{}'::jsonb, true) $$,
  '42501', null, 'user cannot broadcast on their own user:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'presence', 'hideout-test', '{}'::jsonb, true) $$,
  '42501', null, 'user cannot track presence on user:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

-- Non-member B
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b302","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select set_config('realtime.topic', 'typing:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'broadcast', 'typing', '{}'::jsonb, true) $$,
  '42501', null, 'non-member cannot broadcast on typing:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select set_config('realtime.topic', 'room:' || current_setting('test.r1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'presence', 'hideout-test', '{}'::jsonb, true) $$,
  '42501', null, 'non-member cannot track presence on room:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

-- Removed member C
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b303","role":"authenticated","iss":"hideout-api"}', true) is not null as _c;
select set_config('realtime.topic', 'typing:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'broadcast', 'typing', '{}'::jsonb, true) $$,
  '42501', null, 'removed member cannot broadcast on typing:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select set_config('realtime.topic', 'room:' || current_setting('test.r1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'presence', 'hideout-test', '{}'::jsonb, true) $$,
  '42501', null, 'removed member cannot track presence on room:<id>')
  else skip('realtime.messages not writable in tests', 1) end;

-- Member A with a JWT from another issuer
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000b301","role":"authenticated","iss":"supabase"}', true) is not null as _c;
select set_config('realtime.topic', 'typing:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'broadcast', 'typing', '{}'::jsonb, true) $$,
  '42501', null, 'a JWT with another issuer cannot broadcast on typing:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select set_config('realtime.topic', 'room:' || current_setting('test.r1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'presence', 'hideout-test', '{}'::jsonb, true) $$,
  '42501', null, 'a JWT with another issuer cannot track presence on room:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
reset role;

-- anon
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true) is not null as _c;
select set_config('realtime.topic', 'room:' || current_setting('test.r1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'presence', 'hideout-test', '{}'::jsonb, true) $$,
  '42501', null, 'anon cannot track presence on room:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
select set_config('realtime.topic', 'typing:' || current_setting('test.ch1'), true) is not null as _t;
select case when current_setting('test.rt_ready')::boolean then throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values (realtime.topic(), 'broadcast', 'typing', '{}'::jsonb, true) $$,
  '42501', null, 'anon cannot broadcast on typing:<id>')
  else skip('realtime.messages not writable in tests', 1) end;
reset role;

select * from finish();
rollback;
