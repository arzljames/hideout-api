-- invites constraints, redeem_invite_link(), respond_to_direct_invite().
-- Runs inside the runner's transaction, which is always rolled back.
begin;

select plan(54);

-- ---------------------------------------------------------------------------
-- Fixtures (as the owner role)
-- ---------------------------------------------------------------------------
-- O owns room R and room RD (deleted). M is an existing member of R.
-- U, V, W, T redeem links; X, Y, Z respond to direct invites.
-- Invites that are already expired get a created_at before their expires_at
-- (invites_expires_after_created).
insert into public.profiles (id, steam_id, display_name) values
  ('00000000-0000-0000-0000-00000000c401', '76561190000000401', 'Owner O'),
  ('00000000-0000-0000-0000-00000000c402', '76561190000000402', 'User U'),
  ('00000000-0000-0000-0000-00000000c403', '76561190000000403', 'User V'),
  ('00000000-0000-0000-0000-00000000c404', '76561190000000404', 'Member M'),
  ('00000000-0000-0000-0000-00000000c405', '76561190000000405', 'User W'),
  ('00000000-0000-0000-0000-00000000c406', '76561190000000406', 'User X'),
  ('00000000-0000-0000-0000-00000000c407', '76561190000000407', 'User Y'),
  ('00000000-0000-0000-0000-00000000c408', '76561190000000408', 'User Z'),
  ('00000000-0000-0000-0000-00000000c409', '76561190000000409', 'User T');

select set_config('test.r',
  public.create_room('00000000-0000-0000-0000-00000000c401', 'Invites Room', 'x', null)::text, true) is not null as _r;
select set_config('test.rd',
  public.create_room('00000000-0000-0000-0000-00000000c401', 'Doomed Room', 'x', null)::text, true) is not null as _rd;
select public.delete_room(current_setting('test.rd')::uuid, '00000000-0000-0000-0000-00000000c401');

insert into public.room_members (room_id, user_id, role)
values (current_setting('test.r')::uuid, '00000000-0000-0000-0000-00000000c404', 'member');

-- ---------------------------------------------------------------------------
-- Constraints (1-17)
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ insert into public.invites (room_id, kind) values (current_setting('test.r')::uuid, 'link') $$,
  '23514', null, 'a link invite needs a token_hash'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, token_hash, invitee_steam_id)
     values (current_setting('test.r')::uuid, 'link', repeat('1', 64), '76561190000000499') $$,
  '23514', null, 'a link invite cannot have an invitee'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, token_hash, accepted_at)
     values (current_setting('test.r')::uuid, 'link', repeat('1', 64), now()) $$,
  '23514', null, 'a link invite cannot be accepted'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, max_uses) values (current_setting('test.r')::uuid, 'direct', 1) $$,
  '23514', null, 'a direct invite needs an invitee_steam_id'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, invitee_steam_id, token_hash, max_uses)
     values (current_setting('test.r')::uuid, 'direct', '76561190000000499', repeat('1', 64), 1) $$,
  '23514', null, 'a direct invite cannot have a token_hash'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, invitee_steam_id, max_uses)
     values (current_setting('test.r')::uuid, 'direct', '76561190000000499', 2) $$,
  '23514', null, 'a direct invite must have max_uses = 1'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, invitee_steam_id)
     values (current_setting('test.r')::uuid, 'direct', '76561190000000499') $$,
  '23514', null, 'a direct invite cannot have unlimited uses'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, invitee_steam_id, max_uses, accepted_at, declined_at)
     values (current_setting('test.r')::uuid, 'direct', '76561190000000498', 1, now(), now()) $$,
  '23514', null, 'an invite cannot be both accepted and declined'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, token_hash, max_uses, uses)
     values (current_setting('test.r')::uuid, 'link', repeat('2', 64), 1, 2) $$,
  '23514', null, 'uses cannot exceed max_uses'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, token_hash, max_uses)
     values (current_setting('test.r')::uuid, 'link', repeat('2', 64), 0) $$,
  '23514', null, 'max_uses must be positive'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, token_hash)
     values (current_setting('test.r')::uuid, 'link', repeat('A', 64)) $$,
  '23514', null, 'token_hash must be 64 lowercase hex characters'
);
select throws_ok(
  $$ insert into public.invites (room_id, kind, invitee_steam_id, max_uses)
     values (current_setting('test.r')::uuid, 'direct', '123', 1) $$,
  '23514', null, 'invitee_steam_id must be 17 digits'
);

insert into public.invites (room_id, kind, token_hash)
values (current_setting('test.r')::uuid, 'link', repeat('3', 64));
select throws_ok(
  $$ insert into public.invites (room_id, kind, token_hash)
     values (current_setting('test.r')::uuid, 'link', repeat('3', 64)) $$,
  '23505', null, 'token_hash is unique'
);

insert into public.invites (id, room_id, kind, invitee_steam_id, max_uses)
values ('d0000000-0000-0000-0000-000000000099', current_setting('test.r')::uuid, 'direct', '76561190000000499', 1);
select throws_ok(
  $$ insert into public.invites (room_id, kind, invitee_steam_id, max_uses)
     values (current_setting('test.r')::uuid, 'direct', '76561190000000499', 1) $$,
  '23505', null, 'only one pending direct invite per room and invitee'
);
update public.invites set declined_at = now() where id = 'd0000000-0000-0000-0000-000000000099';
select lives_ok(
  $$ insert into public.invites (room_id, kind, invitee_steam_id, max_uses)
     values (current_setting('test.r')::uuid, 'direct', '76561190000000499', 1) $$,
  'a new direct invite is allowed once the previous one was answered'
);

select has_index('public', 'invites', 'invites_pending_direct_invitee_idx', 'invites has the invitee inbox index');
select has_index('public', 'invites', 'invites_room_created_idx', 'invites has the (room_id, created_at desc) index');

-- ---------------------------------------------------------------------------
-- redeem_invite_link (18-35)
-- ---------------------------------------------------------------------------
insert into public.invites (id, room_id, kind, token_hash, max_uses, uses, expires_at, revoked_at) values
  ('e0000000-0000-0000-0000-00000000000a', current_setting('test.r')::uuid,  'link', repeat('a', 64), 2,    0, null,                       null),
  ('e0000000-0000-0000-0000-00000000000b', current_setting('test.r')::uuid,  'link', repeat('b', 64), null, 0, null,                       now()),
  ('e0000000-0000-0000-0000-00000000000d', current_setting('test.r')::uuid,  'link', repeat('d', 64), 1,    1, null,                       null),
  ('e0000000-0000-0000-0000-00000000000e', current_setting('test.r')::uuid,  'link', repeat('e', 64), null, 0, now() + interval '1 day',  null),
  ('e0000000-0000-0000-0000-000000000009', current_setting('test.rd')::uuid, 'link', repeat('9', 64), null, 0, null,                       null);
insert into public.invites (id, room_id, kind, token_hash, expires_at, created_at) values
  ('e0000000-0000-0000-0000-00000000000c', current_setting('test.r')::uuid, 'link', repeat('c', 64),
   now() - interval '1 hour', now() - interval '2 hours');

set local role service_role;

select is(
  (select status from public.redeem_invite_link(repeat('f', 64), '00000000-0000-0000-0000-00000000c402')),
  'invalid', 'an unknown token hash is invalid'
);
select ok(
  (select room_id is null from public.redeem_invite_link(repeat('f', 64), '00000000-0000-0000-0000-00000000c402')),
  'an invalid redemption returns no room_id'
);
select is(
  (select status from public.redeem_invite_link(repeat('a', 64), '00000000-0000-0000-0000-00000000c402')),
  'joined', 'a valid link joins the room'
);
select is(
  (select role from public.room_members
    where room_id = current_setting('test.r')::uuid and user_id = '00000000-0000-0000-0000-00000000c402'),
  'member', 'redeeming a link adds the user as a member'
);
select is(
  (select uses from public.invites where id = 'e0000000-0000-0000-0000-00000000000a'),
  1, 'redeeming a link consumes one use'
);
select is(
  (select status from public.redeem_invite_link(repeat('a', 64), '00000000-0000-0000-0000-00000000c402')),
  'already_member', 'redeeming again as a member returns already_member'
);
select is(
  (select uses from public.invites where id = 'e0000000-0000-0000-0000-00000000000a'),
  1, 'already_member does not consume a use'
);
select is(
  (select status from public.redeem_invite_link(repeat('b', 64), '00000000-0000-0000-0000-00000000c403')),
  'revoked', 'a revoked link returns revoked'
);
select is(
  (select count(*)::int from public.room_members
    where room_id = current_setting('test.r')::uuid and user_id = '00000000-0000-0000-0000-00000000c403'),
  0, 'a failed redemption does not add a member'
);
select is(
  (select status from public.redeem_invite_link(repeat('c', 64), '00000000-0000-0000-0000-00000000c403')),
  'expired', 'an expired link returns expired'
);
select is(
  (select status from public.redeem_invite_link(repeat('d', 64), '00000000-0000-0000-0000-00000000c403')),
  'used_up', 'a link with no uses left returns used_up'
);
select is(
  (select status from public.redeem_invite_link(repeat('9', 64), '00000000-0000-0000-0000-00000000c403')),
  'room_deleted', 'a link to a deleted room returns room_deleted'
);
select is(
  (select status || ':' || room_id::text
     from public.redeem_invite_link(repeat('a', 64), '00000000-0000-0000-0000-00000000c403')),
  'joined:' || current_setting('test.r'), 'the last use joins and returns the room id'
);
select is(
  (select status from public.redeem_invite_link(repeat('a', 64), '00000000-0000-0000-0000-00000000c405')),
  'used_up', 'a link is used_up once uses reach max_uses'
);
select is(
  (select status from public.redeem_invite_link(repeat('b', 64), '00000000-0000-0000-0000-00000000c404')),
  'already_member', 'an existing member gets already_member even on a revoked link'
);
select is(
  (select status from public.redeem_invite_link(repeat('e', 64), '00000000-0000-0000-0000-00000000c409')),
  'joined', 'a link with a future expires_at joins the room'
);
select throws_ok(
  $$ select * from public.redeem_invite_link(null, '00000000-0000-0000-0000-00000000c402') $$,
  '22023', null, 'redeem_invite_link rejects a null token hash'
);
select throws_ok(
  $$ select * from public.redeem_invite_link(repeat('e', 64), '00000000-0000-0000-0000-0000000000ff') $$,
  '23503', null, 'redeem_invite_link rejects an unknown profile'
);

reset role;

-- ---------------------------------------------------------------------------
-- respond_to_direct_invite (36-54)
-- ---------------------------------------------------------------------------
insert into public.invites (id, room_id, kind, invitee_steam_id, max_uses, expires_at, revoked_at) values
  ('d0000000-0000-0000-0000-00000000000a', current_setting('test.r')::uuid,  'direct', '76561190000000406', 1, null,                       null),
  ('d0000000-0000-0000-0000-00000000000b', current_setting('test.r')::uuid,  'direct', '76561190000000407', 1, now() + interval '1 day',  null),
  ('d0000000-0000-0000-0000-00000000000c', current_setting('test.r')::uuid,  'direct', '76561190000000408', 1, null,                       now()),
  ('d0000000-0000-0000-0000-00000000000e', current_setting('test.r')::uuid,  'direct', '76561190000000404', 1, null,                       null),
  ('d0000000-0000-0000-0000-00000000000f', current_setting('test.rd')::uuid, 'direct', '76561190000000406', 1, null,                       null);
insert into public.invites (id, room_id, kind, invitee_steam_id, max_uses, expires_at, created_at) values
  ('d0000000-0000-0000-0000-00000000000d', current_setting('test.r')::uuid, 'direct', '76561190000000408', 1,
   now() - interval '1 hour', now() - interval '2 hours');

set local role service_role;

select is(
  (select status from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000c406', true)),
  'accepted', 'the invitee can accept a direct invite'
);
select is(
  (select role from public.room_members
    where room_id = current_setting('test.r')::uuid and user_id = '00000000-0000-0000-0000-00000000c406'),
  'member', 'accepting adds the invitee as a member'
);
select ok(
  (select accepted_at is not null and uses = 1 from public.invites where id = 'd0000000-0000-0000-0000-00000000000a'),
  'accepting sets accepted_at and uses = 1'
);
select is(
  (select status from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000c407', false)),
  'declined', 'the invitee can decline a direct invite'
);
select ok(
  (select declined_at is not null from public.invites where id = 'd0000000-0000-0000-0000-00000000000b')
  and not exists (
    select 1 from public.room_members
    where room_id = current_setting('test.r')::uuid and user_id = '00000000-0000-0000-0000-00000000c407'),
  'declining sets declined_at and adds no member'
);
select is(
  (select status from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000c406', true)),
  'already_responded', 'responding to an accepted invite returns already_responded'
);
select is(
  (select status from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000c407', true)),
  'already_responded', 'accepting a declined invite returns already_responded'
);
select is(
  (select status from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000c408', true)),
  'revoked', 'a revoked direct invite returns revoked'
);
select is(
  (select status from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000c408', true)),
  'expired', 'an expired direct invite returns expired'
);
select is(
  (select status from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-00000000c404', true)),
  'already_member', 'accepting as an existing member returns already_member'
);
select ok(
  (select accepted_at is not null and uses = 1 from public.invites where id = 'd0000000-0000-0000-0000-00000000000e'),
  'already_member still marks the direct invite accepted with uses = 1'
);
select is(
  (select status from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-00000000c406', true)),
  'room_deleted', 'a direct invite to a deleted room returns room_deleted'
);

reset role;
-- A new pending invite for Y, which X will try to answer.
insert into public.invites (id, room_id, kind, invitee_steam_id, max_uses)
values ('d0000000-0000-0000-0000-000000000010', current_setting('test.r')::uuid, 'direct', '76561190000000407', 1);
set local role service_role;

select is(
  (select status from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-00000000c406', true)),
  'invalid', 'another user''s direct invite is invalid'
);
select ok(
  (select room_id is null from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-00000000c406', false)),
  'an invalid response returns no room_id'
);
select ok(
  (select accepted_at is null and declined_at is null from public.invites where id = 'd0000000-0000-0000-0000-000000000010'),
  'another user''s response leaves the invite pending'
);
select is(
  (select status from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000c406', true)),
  'invalid', 'an unknown invite id is invalid'
);
select is(
  (select status from public.respond_to_direct_invite(
     'd0000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-0000000000ff', true)),
  'invalid', 'an unknown profile gets invalid from respond_to_direct_invite'
);
select is(
  (select status from public.respond_to_direct_invite(
     'e0000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-00000000c402', true)),
  'invalid', 'a link invite id is invalid for respond_to_direct_invite'
);
select throws_ok(
  $$ select * from public.respond_to_direct_invite(
       'd0000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-00000000c407', null) $$,
  '22023', null, 'respond_to_direct_invite rejects a null accept flag'
);

reset role;

select * from finish();
rollback;
