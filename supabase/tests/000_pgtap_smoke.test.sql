-- Confirms the runner, the connection, pgTAP, and role impersonation work.
-- Real tests go alongside this file.
select plan(3);

select ok(true, 'pgTAP runs');
select has_schema('realtime', 'Realtime schema exists');

set local role authenticated;
select is(current_user::text, 'authenticated', 'can impersonate the authenticated role');
reset role;

select * from finish();
