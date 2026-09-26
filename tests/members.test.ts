import { randomUUID } from 'node:crypto';
import type * as PinoModule from 'pino';
import type * as LivekitModule from '../src/lib/livekit.js';
import { ServerError } from 'livekit-server-sdk';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, firstArg, queries, resetFakeDb, results, type DbResult, type RecordedQuery } from './helpers/fakeDb.js';

/*
 * Membership (leave, remove, change role, transfer ownership) through the real app, offline.
 * The database is faked at the supabase-js client with an in-memory "world" whose reads honour
 * only the filters the services actually pass (and PostgREST's `!inner` embed semantics), so a
 * dropped filter shows up as a leak. remove_member, change_role, and transfer_ownership are
 * faked with the rules and SQLSTATEs of supabase/migrations/20260926054446_membership.sql
 * (remove_member, which returns one row per direct invite it revoked) and
 * 20260925010655_core_schema_fixes.sql (change_role, transfer_ownership).
 * Broadcasts are observed at the Realtime REST fetch boundary (so broadcast.ts's schema check
 * runs), LiveKit at livekitRooms.removeParticipant. Every log line (LOG_LEVEL=trace) is captured.
 */

const logLines = vi.hoisted<string[]>(() => []);
const livekit = vi.hoisted(() => ({
  // Typed with the options argument so tests can assert it is never passed.
  removeParticipant: vi.fn<(room: string, identity: string, options?: { revokeTokenTs?: bigint }) => Promise<void>>(),
  deleteRoom: vi.fn<(name: string) => Promise<void>>(),
}));

vi.mock('pino', async (importOriginal) => {
  const actual = await importOriginal<typeof PinoModule>();
  const capture = { write: (line: string) => void logLines.push(line) };
  const pino = Object.assign(
    (options: PinoModule.LoggerOptions) => actual.pino(options, capture),
    actual.pino,
  );
  return { ...actual, pino, default: pino };
});
vi.mock('../src/db/client.js', async () => ({ db: (await import('./helpers/fakeDb.js')).fakeDb }));
vi.mock('../src/lib/livekit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof LivekitModule>()),
  livekitRooms: { removeParticipant: livekit.removeParticipant, deleteRoom: livekit.deleteRoom },
}));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

const savedEnv = { LOG_LEVEL: process.env.LOG_LEVEL };
process.env.LOG_LEVEL = 'trace';

const { createApp } = await import('../src/app.js');
const { newRandomToken, SESSION_COOKIE } = await import('../src/lib/session.js');
const { Member, RoomDetail } = await import('../src/contracts/http/rooms.js');
const { ErrorResponse } = await import('../src/contracts/http/common.js');
const { serverEvents } = await import('../src/contracts/events.js');
const { voiceRemovalRetry } = await import('../src/services/rooms.js');

// No waiting between LiveKit removal retries here (the real delays are tested in voice.test.ts).
voiceRemovalRetry.delaysMs = [0, 0];

afterAll(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

const app = createApp();
const WEB_ORIGIN = 'http://localhost:5173';
const BROADCAST_URL = 'http://127.0.0.1:54321/realtime/v1/api/broadcast';

const ROOM_ID = '1a2b3c4d-0000-4000-8000-00000000b001';
const OTHER_ROOM_ID = '1a2b3c4d-0000-4000-8000-00000000b002';
const OWNER_ID = '0f000000-0000-4000-8000-00000000b101';
const ADMIN_ID = '0f000000-0000-4000-8000-00000000b102';
const ADMIN2_ID = '0f000000-0000-4000-8000-00000000b103';
const MEMBER_ID = '0f000000-0000-4000-8000-00000000b104';
const MEMBER2_ID = '0f000000-0000-4000-8000-00000000b105';
const OUTSIDER_ID = '0f000000-0000-4000-8000-00000000b106';
const GENERAL_ID = 'c0000000-0000-4000-8000-00000000b201';
const VOICE_ID = 'c0000000-0000-4000-8000-00000000b202';
const VOICE2_ID = 'c0000000-0000-4000-8000-00000000b203';
const DELETED_VOICE_ID = 'c0000000-0000-4000-8000-00000000b204';
const OTHER_VOICE_ID = 'c0000000-0000-4000-8000-00000000b205';
const T0 = '2026-09-01T10:00:00.123456+00:00';
const T1 = '2026-09-20T10:00:00.000001+00:00';

type Role = 'owner' | 'admin' | 'member';
type ChannelType = 'text' | 'voice';

interface RoomRow {
  id: string;
  name: string;
  icon_emoji: string | null;
  icon_path: string | null;
  created_at: string;
  deleted_at: string | null;
}

interface ChannelRow {
  id: string;
  room_id: string;
  type: ChannelType;
  name: string;
  position: number;
  created_at: string;
  deleted_at: string | null;
}

interface MemberRow {
  room_id: string;
  user_id: string;
  role: Role;
  joined_at: string;
}

interface ProfileRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
  current_game: string | null;
}

interface InviteRow {
  id: string;
  room_id: string;
  created_by: string;
  kind: 'link' | 'direct';
  /** For direct invites: the invitee's profile id once they have signed in (the DB matches by SteamID). */
  invitee_profile_id: string | null;
  revoked_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
}

interface World {
  me: string;
  token: string;
  rooms: RoomRow[];
  channels: ChannelRow[];
  members: MemberRow[];
  profiles: ProfileRow[];
  invites: InviteRow[];
  failChannelsRead?: boolean;
}

let world: World;

const DB_SECRET_MESSAGE = 'SECRET-DB-MESSAGE violates check';
const DB_DETAILS = 'Failing row contains (ROWVALUE-DETAILS)';

function rpcError(code: string): DbResult {
  return { data: null, error: { code, message: DB_SECRET_MESSAGE, details: DB_DETAILS, hint: 'HINTVALUE' } };
}

function roomRow(id: string, name: string): RoomRow {
  return { id, name, icon_emoji: '🎮', icon_path: null, created_at: T0, deleted_at: null };
}

function channelRow(id: string, type: ChannelType, name: string, position: number, roomId = ROOM_ID): ChannelRow {
  return { id, room_id: roomId, type, name, position, created_at: T0, deleted_at: null };
}

function profile(id: string, name: string): ProfileRow {
  return { id, display_name: name, avatar_url: null, current_game: null };
}

/**
 * ROOM_ID with one text channel, two live voice channels, and one deleted voice channel; the
 * owner, two admins, and two plain members; `me` has `myRole` (null: not a member; as owner,
 * `me` replaces OWNER_ID). OTHER_ROOM_ID has its own voice channel and never includes `me`.
 */
function buildWorld(myRole: Role | null): void {
  const me = world.me;
  world.rooms = [roomRow(ROOM_ID, 'Raid Night'), roomRow(OTHER_ROOM_ID, 'Elsewhere')];
  world.invites = [];
  world.channels = [
    channelRow(GENERAL_ID, 'text', 'general', 0),
    channelRow(VOICE_ID, 'voice', 'lounge', 0),
    channelRow(VOICE2_ID, 'voice', 'raid', 1),
    { ...channelRow(DELETED_VOICE_ID, 'voice', 'old', 2), deleted_at: T0 },
    channelRow(OTHER_VOICE_ID, 'voice', 'elsewhere', 0, OTHER_ROOM_ID),
  ];
  const member = (userId: string, role: Role, roomId = ROOM_ID): MemberRow => ({
    room_id: roomId,
    user_id: userId,
    role,
    joined_at: T0,
  });
  world.members = [
    member(myRole === 'owner' ? me : OWNER_ID, 'owner'),
    member(ADMIN_ID, 'admin'),
    member(ADMIN2_ID, 'admin'),
    member(MEMBER_ID, 'member'),
    member(MEMBER2_ID, 'member'),
    member(OWNER_ID, 'owner', OTHER_ROOM_ID),
    member(OUTSIDER_ID, 'member', OTHER_ROOM_ID),
  ];
  if (myRole && myRole !== 'owner') world.members.push({ ...member(me, myRole), joined_at: T1 });
  world.profiles = [
    profile(me, 'Me'),
    profile(OWNER_ID, 'Olivia'),
    profile(ADMIN_ID, 'Alice'),
    profile(ADMIN2_ID, 'Aaron'),
    profile(MEMBER_ID, 'Mallory'),
    profile(MEMBER2_ID, 'Max'),
    profile(OUTSIDER_ID, 'Oscar'),
  ];
}

function roleOf(userId: string, roomId = ROOM_ID): Role | undefined {
  return world.members.find((m) => m.room_id === roomId && m.user_id === userId)?.role;
}

function setRole(userId: string, role: Role): void {
  const row = world.members.find((m) => m.room_id === ROOM_ID && m.user_id === userId);
  if (!row) throw new Error('no such member');
  row.role = role;
}

// ---------------------------------------------------------------------------
// Fake reads (PostgREST semantics: only the filters the service sends apply)
// ---------------------------------------------------------------------------

function hasCall(query: RecordedQuery, method: string, ...args: unknown[]): boolean {
  return query.calls.some(([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args));
}

/** Applies eq/is filters to columns the row has; nested filters (rooms.*) are handled by callers. */
function matches(row: object, query: RecordedQuery): boolean {
  const record = row as Record<string, unknown>;
  return query.calls.every(([method, args]) => {
    if (method !== 'eq' && method !== 'is') return true;
    const [column, value] = args as [string, unknown];
    return !(column in record) || record[column] === value;
  });
}

function pick(row: object, columns: string): Record<string, unknown> {
  const record = row as Record<string, unknown>;
  return Object.fromEntries(columns.split(', ').map((column) => [column, record[column]]));
}

function isSingle(query: RecordedQuery): boolean {
  return query.calls.some(([m]) => m === 'maybeSingle' || m === 'single');
}

function single(rows: unknown[]): DbResult {
  if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
  return { data: rows[0] ?? null, error: null };
}

const ROOM_COLS = 'id, name, icon_emoji, icon_path, created_at';
const CHANNEL_COLS = 'id, room_id, type, name, position, created_at';
const MEMBER_PROFILE_COLS = 'id, display_name, avatar_url, current_game';

function roomMembersSelect(query: RecordedQuery): DbResult {
  const columns = String(firstArg(query, 'select'));
  const rows = world.members.filter((m) => matches(m, query));
  if (/^role, rooms(!inner)?\(id\)$/.test(columns)) {
    // findMembership (requireRoomMember).
    const row = rows[0];
    if (!row) return { data: null, error: null };
    const room = world.rooms.find((r) => r.id === row.room_id);
    const live = room !== undefined && (room.deleted_at === null || !hasCall(query, 'is', 'rooms.deleted_at', null));
    if (live) return { data: { role: row.role, rooms: { id: row.room_id } }, error: null };
    return { data: columns.includes('rooms!inner(') ? null : { role: row.role, rooms: null }, error: null };
  }
  if (/^user_id, role, joined_at, profiles(!inner)?\(id, display_name, avatar_url, current_game\)$/.test(columns)) {
    // findMember (maybeSingle) and getRoomDetail's member list.
    const inner = columns.includes('profiles!inner(');
    const joined = rows.flatMap((m) => {
      const p = world.profiles.find((x) => x.id === m.user_id);
      if (!p && inner) return [];
      return [{ user_id: m.user_id, role: m.role, joined_at: m.joined_at, profiles: p ? pick(p, MEMBER_PROFILE_COLS) : null }];
    });
    return isSingle(query) ? single(joined) : { data: joined, error: null };
  }
  throw new Error(`unexpected room_members select: ${columns}`);
}

function roomsSelect(query: RecordedQuery): DbResult {
  if (String(firstArg(query, 'select')) !== ROOM_COLS) throw new Error('unexpected rooms select');
  return single(world.rooms.filter((r) => matches(r, query)).map((r) => pick(r, ROOM_COLS)));
}

function channelsSelect(query: RecordedQuery): DbResult {
  if (world.failChannelsRead) {
    return { data: null, error: { code: 'XX000', message: 'SECRET-DB-MESSAGE', details: DB_DETAILS, hint: 'HINTVALUE' } };
  }
  const columns = String(firstArg(query, 'select'));
  if (columns !== 'id' && columns !== CHANNEL_COLS) throw new Error(`unexpected channels select: ${columns}`);
  return { data: world.channels.filter((c) => matches(c, query)).map((c) => pick(c, columns)), error: null };
}

// ---------------------------------------------------------------------------
// Fake Postgres functions (same checks, order, and SQLSTATEs as the migrations)
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid argument as Postgres would read it: null stays null, bad text is 22P02, case is ignored. */
function uuidArg(value: unknown): string | null | DbResult {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !UUID.test(value)) return rpcError('22P02');
  return value.toLowerCase();
}

function uuidArgs(...values: unknown[]): (string | null)[] | DbResult {
  const out: (string | null)[] = [];
  for (const value of values) {
    const parsed = uuidArg(value);
    if (parsed !== null && typeof parsed === 'object') return parsed;
    out.push(parsed);
  }
  return out;
}

function liveRoom(roomId: string): boolean {
  return world.rooms.some((r) => r.id === roomId && r.deleted_at === null);
}

function fakeRemoveMember(args: Record<string, unknown>): DbResult {
  const parsed = uuidArgs(args.p_room, args.p_actor, args.p_target);
  if (!Array.isArray(parsed)) return parsed;
  const [room, actor, target] = parsed;
  if (!room || !actor || !target) return rpcError('22023');
  if (!liveRoom(room)) return rpcError('HX001');
  const actorRole = roleOf(actor, room);
  if (!actorRole) return rpcError('HX001');
  const targetRole = roleOf(target, room);
  if (!targetRole) return rpcError('HX003');
  if (targetRole === 'owner') return rpcError('HX005');
  if (actor !== target && !(actorRole === 'owner' || (actorRole === 'admin' && targetRole === 'member'))) {
    return rpcError('HX002');
  }
  world.members = world.members.filter((m) => !(m.room_id === room && m.user_id === target));

  // Revoke the target's pending invites in this room, and pending direct invites addressed to them;
  // return one row per revoked direct invite.
  const revoked: { invite_id: string; invitee_profile_id: string | null }[] = [];
  for (const invite of world.invites) {
    const pending = invite.revoked_at === null && invite.accepted_at === null && invite.declined_at === null;
    if (invite.room_id !== room || !pending) continue;
    const addressedToTarget = invite.kind === 'direct' && invite.invitee_profile_id === target;
    if (invite.created_by !== target && !addressedToTarget) continue;
    invite.revoked_at = T1;
    if (invite.kind === 'direct') revoked.push({ invite_id: invite.id, invitee_profile_id: invite.invitee_profile_id });
  }
  return { data: revoked, error: null };
}

function fakeChangeRole(args: Record<string, unknown>): DbResult {
  const parsed = uuidArgs(args.p_room, args.p_actor, args.p_target);
  if (!Array.isArray(parsed)) return parsed;
  const [room, actor, target] = parsed;
  const role = args.p_role;
  if (!room || !actor || !target || role === null || role === undefined) return rpcError('22023');
  if (role !== 'admin' && role !== 'member') return rpcError('22023');
  if (!liveRoom(room)) return rpcError('HX001');
  const actorRole = roleOf(actor, room);
  if (!actorRole) return rpcError('HX001');
  if (actorRole !== 'owner') return rpcError('HX002');
  if (actor === target) return rpcError('HX004');
  const row = world.members.find((m) => m.room_id === room && m.user_id === target);
  if (!row) return rpcError('HX003');
  row.role = role;
  return { data: null, error: null };
}

function fakeTransferOwnership(args: Record<string, unknown>): DbResult {
  const parsed = uuidArgs(args.p_room, args.p_from, args.p_to);
  if (!Array.isArray(parsed)) return parsed;
  const [room, from, to] = parsed;
  if (!room || !from || !to) return rpcError('22023');
  if (from === to) return rpcError('HX004');
  if (!liveRoom(room)) return rpcError('HX001');
  const fromRole = roleOf(from, room);
  if (!fromRole) return rpcError('HX001');
  if (fromRole !== 'owner') return rpcError('HX002');
  if (!roleOf(to, room)) return rpcError('HX003');
  for (const m of world.members) {
    if (m.room_id !== room) continue;
    if (m.user_id === from) m.role = 'admin';
    if (m.user_id === to) m.role = 'owner';
  }
  return { data: null, error: null };
}

function install(): void {
  results.selectByTable.sessions = { data: { id: randomUUID(), profile_id: world.me }, error: null };
  results.selectByTable.room_members = roomMembersSelect;
  results.selectByTable.rooms = roomsSelect;
  results.selectByTable.channels = channelsSelect;
  results.rpcByName.remove_member = fakeRemoveMember;
  results.rpcByName.change_role = fakeChangeRole;
  results.rpcByName.transfer_ownership = fakeTransferOwnership;
}

/** Starts over as a brand-new user (fresh session and rate-limit key). */
function newUser(myRole: Role | null): void {
  world = { me: randomUUID(), token: newRandomToken(), rooms: [], channels: [], members: [], profiles: [], invites: [] };
  buildWorld(myRole);
  resetFakeDb();
  install();
}

// ---------------------------------------------------------------------------
// Requests and observations
// ---------------------------------------------------------------------------

type Method = 'post' | 'patch' | 'delete';

interface CallOptions {
  body?: unknown;
  signedIn?: boolean;
  origin?: string | null;
  contentType?: string | null;
}

/** A request as hideout-web sends it: session cookie, WEB_ORIGIN, JSON content type. */
function call(method: Method, path: string, options: CallOptions = {}) {
  let req = request(app)[method](path);
  if (options.signedIn ?? true) req = req.set('Cookie', `${SESSION_COOKIE}=${world.token}`);
  const origin = options.origin === undefined ? WEB_ORIGIN : options.origin;
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (origin !== null) req = req.set('Origin', origin);
  if (contentType !== null) req = req.set('Content-Type', contentType);
  return options.body === undefined ? req : req.send(JSON.stringify(options.body));
}

const leavePath = (roomId = ROOM_ID) => `/api/rooms/${roomId}/members/me`;
const memberPath = (userId: string, roomId = ROOM_ID) => `/api/rooms/${roomId}/members/${userId}`;
const transferPath = (roomId = ROOM_ID) => `/api/rooms/${roomId}/transfer-ownership`;

interface SentBroadcast {
  topic: string;
  event: string;
  payload: unknown;
  private: boolean;
}

function sentBroadcasts(): SentBroadcast[] {
  return fetchMock.mock.calls.flatMap(([url, init]) => {
    expect(url).toBe(BROADCAST_URL);
    return (JSON.parse(init?.body as string) as { messages: SentBroadcast[] }).messages;
  });
}

/** Every broadcast is private and its payload passes the event schema for its topic kind. */
function expectValidBroadcasts(sent: SentBroadcast[]): void {
  for (const b of sent) {
    expect(b.private).toBe(true);
    const kind = b.topic.split(':')[0] as 'room' | 'user';
    const schema = (serverEvents[kind] as Record<string, { parse: (v: unknown) => unknown }>)[b.event];
    expect(schema, `${b.topic} ${b.event}`).toBeDefined();
    expect(schema?.parse(b.payload)).toStrictEqual(b.payload);
  }
}

/**
 * The (room, identity) pairs removed from LiveKit. Every removal passes no options, so LiveKit's
 * default revocation applies (tokens with nbf before now + 1 minute leeway can't rejoin); our own
 * revokeTokenTs would be weaker (same-second tokens, clock skew).
 */
function removedFromVoice(): [string, string][] {
  for (const call of livekit.removeParticipant.mock.calls) {
    expect(call).toHaveLength(2);
  }
  return livekit.removeParticipant.mock.calls.map(([room, identity]) => [room, identity] as [string, string]).sort();
}

/** The LiveKit removals a revocation of `userId` from ROOM_ID must make: every live voice channel, nothing else. */
function voiceRemovalsFor(userId: string): [string, string][] {
  return [
    [`voice_${VOICE_ID}`, userId],
    [`voice_${VOICE2_ID}`, userId],
  ].sort() as [string, string][];
}

interface LogEntry {
  level: number;
  msg: string;
  [key: string]: unknown;
}

function logEntries(): LogEntry[] {
  return logLines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

function logsAt(level: number, text: string): LogEntry[] {
  return logEntries().filter((entry) => entry.level === level && entry.msg.includes(text));
}

function rpcCalls(name: string): Record<string, unknown>[] {
  return fakeDb.rpc.mock.calls.filter(([fn]) => fn === name).map(([, args]) => args);
}

function queriesOn(table: string): RecordedQuery[] {
  return queries.filter((q) => q.table === table);
}

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
  expect(ErrorResponse.parse(res.body)).toStrictEqual(res.body);
}

function detailPaths(res: request.Response): string[] {
  return [...new Set((res.body.error.details as { path: string }[]).map((d) => d.path))];
}

function expectNoSideEffects(): void {
  expect(fetchMock).not.toHaveBeenCalled();
  expect(livekit.removeParticipant).not.toHaveBeenCalled();
  expect(livekit.deleteRoom).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetFakeDb();
  logLines.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 202 })));
  livekit.removeParticipant.mockReset();
  livekit.removeParticipant.mockResolvedValue(undefined);
  livekit.deleteRoom.mockReset();
  livekit.deleteRoom.mockResolvedValue(undefined);
  // A fresh user per test also isolates the per-user rate limiter, whose state is module-level.
  world = { me: randomUUID(), token: newRandomToken(), rooms: [], channels: [], members: [], profiles: [], invites: [] };
  install();
});

afterEach(() => {
  const logs = logLines.join('');
  for (const secret of [
    'test-service-role-key',
    'test-session-secret',
    'test-livekit-secret',
    'test-steam-api-key',
    world.token,
    'ROWVALUE',
    'HINTVALUE',
  ]) {
    expect(logs).not.toContain(secret);
  }
});

/** The four member writes, as a caller who is ROOM_ID's owner would send them; `roomId` is swappable. */
const allWrites: [string, Method, (roomId: string) => string, object | undefined][] = [
  ['leave', 'delete', (roomId) => leavePath(roomId), undefined],
  ['remove', 'delete', (roomId) => memberPath(MEMBER_ID, roomId), undefined],
  ['change role', 'patch', (roomId) => memberPath(ADMIN_ID, roomId), { role: 'member' }],
  ['transfer', 'post', (roomId) => transferPath(roomId), { userId: ADMIN_ID }],
];

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe('members: authentication', () => {
  it.each(allWrites)('returns 401 for %s without a session and touches no data', async (_l, method, path, body) => {
    buildWorld('owner');
    const res = await call(method, path(ROOM_ID), { signedIn: false, body });
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(queries).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});

describe('members: room access', () => {
  it.each(allWrites)('%s returns 404 when a non-member sends it, without any rpc', async (_l, method, path, body) => {
    buildWorld(null);
    const res = await call(method, path(ROOM_ID), { body });
    expectError(res, 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(queriesOn('channels')).toHaveLength(0);
    expectNoSideEffects();
    const [membership] = queriesOn('room_members');
    expect(membership?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    expect(membership?.calls).toContainEqual(['eq', ['user_id', world.me]]);
  });

  it.each(allWrites)(
    '%s returns an identical 404 for a non-member, a missing room, a deleted room, and a malformed roomId',
    async (_l, method, path, body) => {
      buildWorld(null);
      const nonMember = await call(method, path(OTHER_ROOM_ID), { body });
      const missing = await call(method, path(randomUUID()), { body });
      const malformed = await call(method, path('not-a-uuid'), { body });
      const injected = await call(method, path(encodeURIComponent(`${ROOM_ID},user_id.neq.0`)), { body });
      buildWorld('owner');
      world.rooms[0] = { ...(world.rooms[0] as RoomRow), deleted_at: T0 };
      const deleted = await call(method, path(ROOM_ID), { body });

      expectError(nonMember, 404, 'NOT_FOUND');
      for (const res of [missing, malformed, injected, deleted]) {
        expect(res.status).toBe(404);
        expect(res.body).toStrictEqual(nonMember.body);
      }
      expect(fakeDb.rpc).not.toHaveBeenCalled();
      expectNoSideEffects();
    },
  );

  it.each(allWrites)('%s never looks up membership for a malformed roomId', async (_l, method, path, body) => {
    buildWorld('owner');
    for (const roomId of ['not-a-uuid', `${ROOM_ID}x`, '123']) {
      expectError(await call(method, path(roomId), { body }), 404, 'NOT_FOUND');
    }
    expect(queriesOn('room_members')).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it('loses access immediately after leaving: the next write in that room is a 404', async () => {
    buildWorld('admin');
    expect((await call('delete', leavePath())).status).toBe(204);
    fetchMock.mockClear();
    livekit.removeParticipant.mockClear();
    expectError(await call('delete', leavePath()), 404, 'NOT_FOUND');
    expectError(await call('delete', memberPath(MEMBER_ID)), 404, 'NOT_FOUND');
    expect(rpcCalls('remove_member')).toHaveLength(1);
    expectNoSideEffects();
  });

  it('loses access immediately when removed by the owner: the removed admin gets 404 next', async () => {
    buildWorld('admin');
    // The owner (OWNER_ID) removes me directly in the database.
    expect(fakeRemoveMember({ p_room: ROOM_ID, p_actor: OWNER_ID, p_target: world.me }).error).toBeNull();
    expectError(await call('delete', memberPath(MEMBER_ID)), 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Leave: DELETE /api/rooms/:roomId/members/me
// ---------------------------------------------------------------------------

describe('DELETE /api/rooms/:roomId/members/me (leave)', () => {
  it.each<[Role]>([['member'], ['admin']])(
    'lets a %s leave: 204, member:left on the room, and LiveKit removal from every live voice channel only',
    async (role) => {
      buildWorld(role);
      const res = await call('delete', leavePath());
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(rpcCalls('remove_member')).toEqual([{ p_room: ROOM_ID, p_actor: world.me, p_target: world.me }]);
      expect(roleOf(world.me)).toBeUndefined();

      const sent = sentBroadcasts();
      expectValidBroadcasts(sent);
      expect(sent).toEqual([
        { topic: `room:${ROOM_ID}`, event: 'member:left', payload: { roomId: ROOM_ID, userId: world.me }, private: true },
      ]);
      // Not the text channel, not the deleted voice channel, not another room's voice channel.
      expect(removedFromVoice()).toEqual(voiceRemovalsFor(world.me));
      expect(livekit.deleteRoom).not.toHaveBeenCalled();
    },
  );

  it('reads voice channels with room, type, and live filters before the write', async () => {
    buildWorld('member');
    expect((await call('delete', leavePath())).status).toBe(204);
    const [voiceRead] = queriesOn('channels');
    expect(voiceRead?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    expect(voiceRead?.calls).toContainEqual(['eq', ['type', 'voice']]);
    expect(voiceRead?.calls).toContainEqual(['is', ['deleted_at', null]]);
  });

  it('returns 409 OWNER_PROTECTED for the owner, with nothing broadcast and no LiveKit call', async () => {
    buildWorld('owner');
    const res = await call('delete', leavePath());
    expectError(res, 409, 'OWNER_PROTECTED');
    expect(rpcCalls('remove_member')).toHaveLength(1);
    expect(roleOf(world.me)).toBe('owner');
    expectNoSideEffects();
  });

  it('routes `me` to leave before `:userId`: a plain member can leave via `me` (never parsed as a uuid)', async () => {
    buildWorld('member');
    const res = await call('delete', leavePath());
    expect(res.status).toBe(204);
    expect(rpcCalls('remove_member')[0]?.p_target).toBe(world.me);
    expect(JSON.stringify(rpcCalls('remove_member'))).not.toContain('"me"');
  });

  it('treats `ME` like `me` (Express routing is case-insensitive): still only the caller leaves', async () => {
    buildWorld('member');
    expect((await call('delete', memberPath('ME'))).status).toBe(204);
    expect(rpcCalls('remove_member')).toEqual([{ p_room: ROOM_ID, p_actor: world.me, p_target: world.me }]);
    expect(sentBroadcasts().map((b) => b.event)).toEqual(['member:left']);
  });

  it('returns 500 with no rpc, broadcast, or LiveKit call when the voice-channel read fails', async () => {
    buildWorld('member');
    world.failChannelsRead = true;
    const res = await call('delete', leavePath());
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(roleOf(world.me)).toBe('member');
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Remove: DELETE /api/rooms/:roomId/members/:userId
// ---------------------------------------------------------------------------

function expectRemovalEffects(target: string): void {
  const sent = sentBroadcasts();
  expectValidBroadcasts(sent);
  expect(sent).toHaveLength(2);
  expect(sent).toContainEqual({
    topic: `room:${ROOM_ID}`,
    event: 'member:left',
    payload: { roomId: ROOM_ID, userId: target },
    private: true,
  });
  expect(sent).toContainEqual({
    topic: `user:${target}`,
    event: 'member:removed',
    payload: { roomId: ROOM_ID },
    private: true,
  });
  expect(removedFromVoice()).toEqual(voiceRemovalsFor(target));
}

describe('DELETE /api/rooms/:roomId/members/:userId (remove)', () => {
  it.each([
    ['an admin', ADMIN_ID],
    ['a member', MEMBER_ID],
  ])('lets the owner remove %s: 204, member:left, member:removed, and LiveKit removal', async (_l, target) => {
    buildWorld('owner');
    const res = await call('delete', memberPath(target));
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(rpcCalls('remove_member')).toEqual([{ p_room: ROOM_ID, p_actor: world.me, p_target: target }]);
    expect(roleOf(target)).toBeUndefined();
    expectRemovalEffects(target);
  });

  it('lets an admin remove a plain member', async () => {
    buildWorld('admin');
    expect((await call('delete', memberPath(MEMBER_ID))).status).toBe(204);
    expect(roleOf(MEMBER_ID)).toBeUndefined();
    expectRemovalEffects(MEMBER_ID);
  });

  it('returns 403 when an admin removes another admin (the database refuses; the fast path lets it through)', async () => {
    buildWorld('admin');
    const res = await call('delete', memberPath(ADMIN2_ID));
    expectError(res, 403, 'FORBIDDEN');
    expect(rpcCalls('remove_member')).toHaveLength(1);
    expect(roleOf(ADMIN2_ID)).toBe('admin');
    expectNoSideEffects();
  });

  it('returns 409 OWNER_PROTECTED when an admin removes the owner', async () => {
    buildWorld('admin');
    expectError(await call('delete', memberPath(OWNER_ID)), 409, 'OWNER_PROTECTED');
    expect(rpcCalls('remove_member')).toHaveLength(1);
    expect(roleOf(OWNER_ID)).toBe('owner');
    expectNoSideEffects();
  });

  it('returns 409 OWNER_PROTECTED when the owner targets themself by id (a leave)', async () => {
    buildWorld('owner');
    expectError(await call('delete', memberPath(world.me)), 409, 'OWNER_PROTECTED');
    expectNoSideEffects();
  });

  it.each([
    ['another member', MEMBER2_ID],
    ['an admin', ADMIN_ID],
    ['the owner', OWNER_ID],
  ])('returns 403 when a plain member removes %s, without reading channels or calling the rpc', async (_l, target) => {
    buildWorld('member');
    expectError(await call('delete', memberPath(target)), 403, 'FORBIDDEN');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(queriesOn('channels')).toHaveLength(0);
    expect(roleOf(target)).toBeDefined();
    expectNoSideEffects();
  });

  it('returns 404 when the target is not a member of the room (even if they are in another room)', async () => {
    buildWorld('owner');
    const outsider = await call('delete', memberPath(OUTSIDER_ID));
    expectError(outsider, 404, 'NOT_FOUND');
    const unknown = await call('delete', memberPath(randomUUID()));
    expect(unknown.body).toStrictEqual(outsider.body);
    expect(rpcCalls('remove_member')).toHaveLength(2);
    expect(roleOf(OUTSIDER_ID, OTHER_ROOM_ID)).toBe('member');
    expectNoSideEffects();
  });

  it.each<[Role]>([['owner'], ['member']])(
    'returns 404 without an rpc for malformed userIds (caller: %s)',
    async (role) => {
      buildWorld(role);
      for (const userId of ['not-a-uuid', `${MEMBER_ID}x`, '123', encodeURIComponent(`${MEMBER_ID},role.eq.owner`)]) {
        expectError(await call('delete', memberPath(userId)), 404, 'NOT_FOUND');
      }
      expect(fakeDb.rpc).not.toHaveBeenCalled();
      expectNoSideEffects();
    },
  );

  it('lowercases an uppercase userId in the rpc args, the topics, the payloads, and the LiveKit identity', async () => {
    buildWorld('owner');
    expect((await call('delete', memberPath(MEMBER_ID.toUpperCase()))).status).toBe(204);
    expect(rpcCalls('remove_member')).toEqual([{ p_room: ROOM_ID, p_actor: world.me, p_target: MEMBER_ID }]);
    expectRemovalEffects(MEMBER_ID);
  });

  it('lowercases an uppercase roomId in the membership lookup, the rpc, and the topic', async () => {
    buildWorld('owner');
    expect((await call('delete', memberPath(MEMBER_ID, ROOM_ID.toUpperCase()))).status).toBe(204);
    for (const q of queriesOn('room_members')) expect(q.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    expect(rpcCalls('remove_member')[0]?.p_room).toBe(ROOM_ID);
    expectRemovalEffects(MEMBER_ID);
  });

  it.each<[Role]>([['member'], ['admin']])(
    'treats a %s targeting their own id (any case) exactly like leave: member:left only, no member:removed',
    async (role) => {
      buildWorld(role);
      const res = await call('delete', memberPath(world.me.toUpperCase()));
      expect(res.status).toBe(204);
      expect(rpcCalls('remove_member')).toEqual([{ p_room: ROOM_ID, p_actor: world.me, p_target: world.me }]);
      const sent = sentBroadcasts();
      expectValidBroadcasts(sent);
      expect(sent.map((b) => [b.topic, b.event])).toEqual([[`room:${ROOM_ID}`, 'member:left']]);
      expect(sent[0]?.payload).toStrictEqual({ roomId: ROOM_ID, userId: world.me });
      expect(removedFromVoice()).toEqual(voiceRemovalsFor(world.me));
    },
  );

  it('returns 500 with no rpc, broadcast, or LiveKit call when the voice-channel read fails', async () => {
    buildWorld('owner');
    world.failChannelsRead = true;
    expectError(await call('delete', memberPath(MEMBER_ID)), 500, 'INTERNAL');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(roleOf(MEMBER_ID)).toBe('member');
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Side effects after a committed revocation are best-effort
// ---------------------------------------------------------------------------

describe('members: best-effort side effects after leave/remove', () => {
  const notFound = () => new ServerError('not_found', 'participant not found', 404, 'not_found');

  it('still returns 204 when LiveKit reports the participant not found, logging at debug (not warn)', async () => {
    buildWorld('owner');
    livekit.removeParticipant.mockRejectedValue(notFound());
    expect((await call('delete', memberPath(MEMBER_ID))).status).toBe(204);
    expect(livekit.removeParticipant).toHaveBeenCalledTimes(2);
    expect(logsAt(20, 'not in LiveKit room')).toHaveLength(2);
    expect(logsAt(40, 'could not remove participant')).toHaveLength(0);
    expect(sentBroadcasts()).toHaveLength(2);
  });

  it.each([
    ['a LiveKit server error', () => new ServerError('internal', 'boom', 500, 'internal')],
    ['LiveKit being unreachable', () => new Error('fetch failed')],
  ])('still returns 204 on %s, retrying, logging a warning per channel and still broadcasting', async (_l, makeError) => {
    buildWorld('member');
    livekit.removeParticipant.mockRejectedValue(makeError());
    expect((await call('delete', leavePath())).status).toBe(204);
    // 3 attempts for each of the 2 voice channels.
    expect(livekit.removeParticipant).toHaveBeenCalledTimes(6);
    expect(logsAt(40, 'could not remove participant from LiveKit room')).toHaveLength(2);
    expect(sentBroadcasts().map((b) => b.event)).toEqual(['member:left']);
  });

  it('removes from the other voice channel when only one LiveKit call fails', async () => {
    buildWorld('member');
    livekit.removeParticipant.mockImplementation((room) =>
      room === `voice_${VOICE_ID}` ? Promise.reject(new Error('fetch failed')) : Promise.resolve(),
    );
    expect((await call('delete', leavePath())).status).toBe(204);
    // The failing channel is tried 3 times, the other once.
    const calls = removedFromVoice();
    expect(calls.filter(([room]) => room === `voice_${VOICE_ID}`)).toHaveLength(3);
    expect([...new Map(calls.map((c) => [c.join(), c])).values()]).toEqual(voiceRemovalsFor(world.me));
    expect(logsAt(40, 'could not remove participant')).toHaveLength(1);
  });

  it.each([
    ['rejected with a 500', () => Promise.resolve(new Response('{}', { status: 500 }))],
    ['a thrown fetch', () => Promise.reject(new Error('network'))],
  ])('still returns 204 and removes from LiveKit when the broadcast fails (%s)', async (_l, impl) => {
    buildWorld('owner');
    fetchMock.mockImplementation(impl);
    expect((await call('delete', memberPath(ADMIN_ID))).status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(removedFromVoice()).toEqual(voiceRemovalsFor(ADMIN_ID));
    expect(roleOf(ADMIN_ID)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Direct invites revoked by leave/remove: invite:revoked on each signed-in invitee's user topic
// ---------------------------------------------------------------------------

const INV_TO_OUTSIDER = 'e0000000-0000-4000-8000-00000000b301';
const INV_TO_UNSIGNED = 'e0000000-0000-4000-8000-00000000b302';
const INV_LINK = 'e0000000-0000-4000-8000-00000000b303';
const INV_TO_TARGET = 'e0000000-0000-4000-8000-00000000b304';
const INV_ANSWERED = 'e0000000-0000-4000-8000-00000000b305';
const INV_OTHER_ROOM = 'e0000000-0000-4000-8000-00000000b306';
const INV_BY_OTHERS = 'e0000000-0000-4000-8000-00000000b307';

function invite(id: string, createdBy: string, kind: 'link' | 'direct', invitee: string | null, roomId = ROOM_ID): InviteRow {
  return {
    id,
    room_id: roomId,
    created_by: createdBy,
    kind,
    invitee_profile_id: invitee,
    revoked_at: null,
    accepted_at: null,
    declined_at: null,
  };
}

/** Pending and answered invites around `target` in ROOM_ID, plus decoys that must stay untouched. */
function seedInvites(target: string): void {
  world.invites = [
    invite(INV_TO_OUTSIDER, target, 'direct', OUTSIDER_ID),
    invite(INV_TO_UNSIGNED, target, 'direct', null),
    invite(INV_LINK, target, 'link', null),
    invite(INV_TO_TARGET, ADMIN2_ID, 'direct', target),
    { ...invite(INV_ANSWERED, target, 'direct', MEMBER2_ID), accepted_at: T0 },
    invite(INV_OTHER_ROOM, target, 'direct', MEMBER2_ID, OTHER_ROOM_ID),
    invite(INV_BY_OTHERS, ADMIN2_ID, 'direct', MEMBER2_ID),
  ];
}

function revokedIds(): string[] {
  return world.invites
    .filter((i) => i.revoked_at !== null)
    .map((i) => i.id)
    .sort();
}

/** [topic, payload] of every invite:revoked sent, sorted by topic. */
function inviteRevokedBroadcasts(): [string, unknown][] {
  return sentBroadcasts()
    .filter((b) => b.event === 'invite:revoked')
    .map((b): [string, unknown] => [b.topic, b.payload])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function byTopic(entries: [string, unknown][]): [string, unknown][] {
  return [...entries].sort((a, b) => a[0].localeCompare(b[0]));
}

describe('members: invite:revoked for direct invites revoked by leave/remove', () => {
  it('remove: sends invite:revoked to each signed-in invitee of a revoked direct invite, with member:left/member:removed', async () => {
    buildWorld('owner');
    seedInvites(MEMBER_ID);
    expect((await call('delete', memberPath(MEMBER_ID))).status).toBe(204);

    expect(revokedIds()).toEqual([INV_TO_OUTSIDER, INV_TO_UNSIGNED, INV_LINK, INV_TO_TARGET].sort());
    const sent = sentBroadcasts();
    expectValidBroadcasts(sent);
    expect(sent).toHaveLength(4);
    expect(sent.map((b) => b.event).sort()).toEqual(['invite:revoked', 'invite:revoked', 'member:left', 'member:removed']);
    expect(inviteRevokedBroadcasts()).toEqual(
      byTopic([
        [`user:${MEMBER_ID}`, { inviteId: INV_TO_TARGET }],
        [`user:${OUTSIDER_ID}`, { inviteId: INV_TO_OUTSIDER }],
      ]),
    );
    expect(removedFromVoice()).toEqual(voiceRemovalsFor(MEMBER_ID));
  });

  it("leave: sends invite:revoked for the leaver's revoked direct invites alongside member:left", async () => {
    buildWorld('admin');
    seedInvites(world.me);
    expect((await call('delete', leavePath())).status).toBe(204);

    const sent = sentBroadcasts();
    expectValidBroadcasts(sent);
    expect(sent.map((b) => b.event).sort()).toEqual(['invite:revoked', 'invite:revoked', 'member:left']);
    expect(inviteRevokedBroadcasts()).toEqual(
      byTopic([
        [`user:${OUTSIDER_ID}`, { inviteId: INV_TO_OUTSIDER }],
        [`user:${world.me}`, { inviteId: INV_TO_TARGET }],
      ]),
    );
    expect(removedFromVoice()).toEqual(voiceRemovalsFor(world.me));
  });

  it('sends no invite:revoked for rows whose invitee has not signed in (null profile)', async () => {
    buildWorld('owner');
    world.invites = [invite(INV_TO_UNSIGNED, MEMBER_ID, 'direct', null), invite(INV_LINK, MEMBER_ID, 'link', null)];
    expect((await call('delete', memberPath(MEMBER_ID))).status).toBe(204);
    expect(revokedIds()).toEqual([INV_TO_UNSIGNED, INV_LINK].sort());
    expect(inviteRevokedBroadcasts()).toEqual([]);
    expectRemovalEffects(MEMBER_ID);
  });

  it('sends no invite:revoked when remove_member returns no rows', async () => {
    buildWorld('owner');
    expect((await call('delete', memberPath(MEMBER_ID))).status).toBe(204);
    expect(inviteRevokedBroadcasts()).toEqual([]);
    expectRemovalEffects(MEMBER_ID);
  });

  it('lowercases ids from the rows in the topic and the payload', async () => {
    buildWorld('owner');
    results.rpcByName.remove_member = (args) => {
      const out = fakeRemoveMember(args);
      if (out.error) return out;
      return { data: [{ invite_id: INV_TO_OUTSIDER.toUpperCase(), invitee_profile_id: OUTSIDER_ID.toUpperCase() }], error: null };
    };
    expect((await call('delete', memberPath(MEMBER_ID))).status).toBe(204);
    expect(inviteRevokedBroadcasts()).toEqual([[`user:${OUTSIDER_ID}`, { inviteId: INV_TO_OUTSIDER }]]);
  });

  it.each([
    ['rejected with a 500', () => Promise.resolve(new Response('{}', { status: 500 }))],
    ['a thrown fetch', () => Promise.reject(new Error('network'))],
  ])('still returns 204 and removes from LiveKit when the broadcasts fail (%s)', async (_l, impl) => {
    buildWorld('owner');
    seedInvites(MEMBER_ID);
    fetchMock.mockImplementation(impl);
    expect((await call('delete', memberPath(MEMBER_ID))).status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(removedFromVoice()).toEqual(voiceRemovalsFor(MEMBER_ID));
    expect(roleOf(MEMBER_ID)).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['an object instead of an array', { invite_id: INV_TO_OUTSIDER, invitee_profile_id: OUTSIDER_ID }],
    ['a malformed invite id', [{ invite_id: 'ROWVALUE-not-a-uuid', invitee_profile_id: OUTSIDER_ID }]],
    ['a missing field', [{ invite_id: INV_TO_OUTSIDER }]],
    ['a non-string profile id', [{ invite_id: INV_TO_OUTSIDER, invitee_profile_id: 42 }]],
  ])('treats %s as no rows: still 204 with the usual effects, logged without the values', async (_l, data) => {
    buildWorld('owner');
    results.rpcByName.remove_member = (args) => {
      const out = fakeRemoveMember(args);
      return out.error ? out : { data, error: null };
    };
    expect((await call('delete', memberPath(MEMBER_ID))).status).toBe(204);
    expect(roleOf(MEMBER_ID)).toBeUndefined();
    expect(inviteRevokedBroadcasts()).toEqual([]);
    expectRemovalEffects(MEMBER_ID);
    const entries = logsAt(50, 'remove_member returned unexpected rows');
    expect(entries).toHaveLength(1);
    const logged = JSON.stringify(entries[0]);
    for (const value of [INV_TO_OUTSIDER, OUTSIDER_ID, 'ROWVALUE']) expect(logged).not.toContain(value);
  });
});

// ---------------------------------------------------------------------------
// Change role: PATCH /api/rooms/:roomId/members/:userId
// ---------------------------------------------------------------------------

describe('PATCH /api/rooms/:roomId/members/:userId (change role)', () => {
  it.each<[string, string, 'admin' | 'member']>([
    ['demotes an admin', ADMIN_ID, 'member'],
    ['promotes a member', MEMBER_ID, 'admin'],
  ])('lets the owner: %s, returning 200 Member and broadcasting member:role_changed', async (_l, target, role) => {
    buildWorld('owner');
    const res = await call('patch', memberPath(target), { body: { role } });
    expect(res.status).toBe(200);
    expect(Member.parse(res.body)).toStrictEqual(res.body);
    expect(res.body).toMatchObject({ roomId: ROOM_ID, role, user: { id: target } });
    expect(rpcCalls('change_role')).toEqual([{ p_room: ROOM_ID, p_actor: world.me, p_target: target, p_role: role }]);
    expect(roleOf(target)).toBe(role);

    const sent = sentBroadcasts();
    expectValidBroadcasts(sent);
    expect(sent).toEqual([
      { topic: `room:${ROOM_ID}`, event: 'member:role_changed', payload: { roomId: ROOM_ID, userId: target, role }, private: true },
    ]);
    expect(livekit.removeParticipant).not.toHaveBeenCalled();
  });

  it.each<[Role]>([['admin'], ['member']])(
    'returns 403 for an %s caller without calling the rpc, even with an invalid body',
    async (role) => {
      buildWorld(role);
      expectError(await call('patch', memberPath(MEMBER2_ID), { body: { role: 'admin' } }), 403, 'FORBIDDEN');
      expectError(await call('patch', memberPath(MEMBER2_ID), { body: { role: 'owner' } }), 403, 'FORBIDDEN');
      expectError(await call('patch', memberPath(world.me), { body: { role: 'admin' } }), 403, 'FORBIDDEN');
      expect(fakeDb.rpc).not.toHaveBeenCalled();
      expect(roleOf(MEMBER2_ID)).toBe('member');
      expectNoSideEffects();
    },
  );

  it('returns 422 at params.userId when the owner targets themself (any case)', async () => {
    buildWorld('owner');
    for (const id of [world.me, world.me.toUpperCase()]) {
      const res = await call('patch', memberPath(id), { body: { role: 'admin' } });
      expectError(res, 422, 'VALIDATION_FAILED');
      expect(res.body.error.details).toEqual([{ path: 'params.userId', message: 'The request is invalid.' }]);
    }
    expect(rpcCalls('change_role')).toHaveLength(2);
    expect(roleOf(world.me)).toBe('owner');
    expectNoSideEffects();
  });

  it('returns 404 when the target is not a member of the room', async () => {
    buildWorld('owner');
    expectError(await call('patch', memberPath(OUTSIDER_ID), { body: { role: 'admin' } }), 404, 'NOT_FOUND');
    expect(roleOf(OUTSIDER_ID, OTHER_ROOM_ID)).toBe('member');
    expectNoSideEffects();
  });

  it('returns 404 without an rpc for a malformed userId', async () => {
    buildWorld('owner');
    // PATCH has no `me` route, so `me` is just a malformed id here.
    for (const id of ['not-a-uuid', `${ADMIN_ID}x`, 'me']) {
      expectError(await call('patch', memberPath(id), { body: { role: 'admin' } }), 404, 'NOT_FOUND');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each<[string, unknown, string[]]>([
    ["role 'owner'", { role: 'owner' }, ['body.role']],
    ['an uppercase role', { role: 'ADMIN' }, ['body.role']],
    ['an unknown key', { role: 'admin', userId: MEMBER_ID }, ['body']],
    ['a missing role', {}, ['body.role']],
    ['a null role', { role: null }, ['body.role']],
    ['a non-object body', ['admin'], ['body']],
  ])('returns 422 for %s without calling the rpc', async (_l, body, paths) => {
    buildWorld('owner');
    const res = await call('patch', memberPath(ADMIN_ID), { body });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(paths);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(roleOf(ADMIN_ID)).toBe('admin');
    expectNoSideEffects();
  });

  it('lowercases an uppercase userId in the rpc, the broadcast, and the response', async () => {
    buildWorld('owner');
    const res = await call('patch', memberPath(MEMBER_ID.toUpperCase()), { body: { role: 'admin' } });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(MEMBER_ID);
    expect(rpcCalls('change_role')[0]?.p_target).toBe(MEMBER_ID);
    expect(sentBroadcasts()[0]?.payload).toStrictEqual({ roomId: ROOM_ID, userId: MEMBER_ID, role: 'admin' });
  });

  it('returns 404 (after broadcasting the committed change) when the target leaves between the rpc and the read', async () => {
    buildWorld('owner');
    results.rpcByName.change_role = (args) => {
      const out = fakeChangeRole(args);
      world.members = world.members.filter((m) => !(m.room_id === ROOM_ID && m.user_id === ADMIN_ID));
      return out;
    };
    expectError(await call('patch', memberPath(ADMIN_ID), { body: { role: 'member' } }), 404, 'NOT_FOUND');
    const sent = sentBroadcasts();
    expectValidBroadcasts(sent);
    expect(sent.map((b) => b.event)).toEqual(['member:role_changed']);
  });

  it('reads the member while the broadcast is in flight (a slow broadcast is not added to the read)', async () => {
    buildWorld('owner');
    let readStarted = false;
    let readBeforeBroadcastDone: boolean | undefined;
    results.selectByTable.room_members = (query) => {
      if (String(firstArg(query, 'select')).startsWith('user_id, role')) readStarted = true;
      return roomMembersSelect(query);
    };
    fetchMock.mockImplementation(async () => {
      // Wait (bounded) for the read; sequential code would not start it while this is pending.
      for (let i = 0; i < 50 && !readStarted; i++) await new Promise((r) => setTimeout(r, 2));
      readBeforeBroadcastDone = readStarted;
      return new Response(null, { status: 202 });
    });
    const res = await call('patch', memberPath(ADMIN_ID), { body: { role: 'member' } });
    expect(res.status).toBe(200);
    expect(readBeforeBroadcastDone).toBe(true);
    expect(sentBroadcasts().map((b) => b.event)).toEqual(['member:role_changed']);
  });

  it('still sends member:role_changed when the member read fails (500, DB message not echoed)', async () => {
    buildWorld('owner');
    results.selectByTable.room_members = (query) =>
      String(firstArg(query, 'select')).startsWith('user_id, role')
        ? { data: null, error: { code: 'XX000', message: 'SECRET-DB-MESSAGE', details: DB_DETAILS, hint: 'HINTVALUE' } }
        : roomMembersSelect(query);
    const res = await call('patch', memberPath(ADMIN_ID), { body: { role: 'member' } });
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
    expect(roleOf(ADMIN_ID)).toBe('member');
    const sent = sentBroadcasts();
    expectValidBroadcasts(sent);
    expect(sent).toEqual([
      { topic: `room:${ROOM_ID}`, event: 'member:role_changed', payload: { roomId: ROOM_ID, userId: ADMIN_ID, role: 'member' }, private: true },
    ]);
  });

  it('still returns 200 when the broadcast fails', async () => {
    buildWorld('owner');
    fetchMock.mockImplementation(() => Promise.reject(new Error('realtime down')));
    expect((await call('patch', memberPath(ADMIN_ID), { body: { role: 'member' } })).status).toBe(200);
    expect(roleOf(ADMIN_ID)).toBe('member');
  });
});

// ---------------------------------------------------------------------------
// Transfer ownership: POST /api/rooms/:roomId/transfer-ownership
// ---------------------------------------------------------------------------

describe('POST /api/rooms/:roomId/transfer-ownership', () => {
  it('makes the target the owner and the caller an admin, returns RoomDetail, and broadcasts two role changes in order', async () => {
    buildWorld('owner');
    const res = await call('post', transferPath(), { body: { userId: MEMBER_ID } });
    expect(res.status).toBe(200);
    expect(RoomDetail.parse(res.body)).toStrictEqual(res.body);
    expect(res.body.myRole).toBe('admin');
    expect(res.body.room.id).toBe(ROOM_ID);
    const members = res.body.members as { user: { id: string }; role: Role }[];
    expect(members[0]).toMatchObject({ user: { id: MEMBER_ID }, role: 'owner' });
    expect(members.find((m) => m.user.id === world.me)?.role).toBe('admin');
    expect(members.filter((m) => m.role === 'owner')).toHaveLength(1);
    expect(rpcCalls('transfer_ownership')).toEqual([{ p_room: ROOM_ID, p_from: world.me, p_to: MEMBER_ID }]);

    const sent = sentBroadcasts();
    expectValidBroadcasts(sent);
    expect(sent).toEqual([
      { topic: `room:${ROOM_ID}`, event: 'member:role_changed', payload: { roomId: ROOM_ID, userId: world.me, role: 'admin' }, private: true },
      { topic: `room:${ROOM_ID}`, event: 'member:role_changed', payload: { roomId: ROOM_ID, userId: MEMBER_ID, role: 'owner' }, private: true },
    ]);
    expect(livekit.removeParticipant).not.toHaveBeenCalled();
  });

  it('leaves the former owner unable to transfer again (now 403)', async () => {
    buildWorld('owner');
    expect((await call('post', transferPath(), { body: { userId: ADMIN_ID } })).status).toBe(200);
    expectError(await call('post', transferPath(), { body: { userId: MEMBER_ID } }), 403, 'FORBIDDEN');
    expect(rpcCalls('transfer_ownership')).toHaveLength(1);
  });

  it.each<[Role]>([['admin'], ['member']])('returns 403 for an %s caller without calling the rpc', async (role) => {
    buildWorld(role);
    expectError(await call('post', transferPath(), { body: { userId: MEMBER2_ID } }), 403, 'FORBIDDEN');
    expectError(await call('post', transferPath(), { body: { userId: 'nope' } }), 403, 'FORBIDDEN');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(roleOf(OWNER_ID)).toBe('owner');
    expectNoSideEffects();
  });

  it('returns 422 at body.userId when the owner transfers to themself (any case)', async () => {
    buildWorld('owner');
    for (const id of [world.me, world.me.toUpperCase()]) {
      const res = await call('post', transferPath(), { body: { userId: id } });
      expectError(res, 422, 'VALIDATION_FAILED');
      expect(res.body.error.details).toEqual([{ path: 'body.userId', message: 'The request is invalid.' }]);
    }
    expect(rpcCalls('transfer_ownership').map((a) => a.p_to)).toEqual([world.me, world.me]);
    expect(roleOf(world.me)).toBe('owner');
    expectNoSideEffects();
  });

  it('returns 404 when the new owner is not a member of the room', async () => {
    buildWorld('owner');
    expectError(await call('post', transferPath(), { body: { userId: OUTSIDER_ID } }), 404, 'NOT_FOUND');
    expectError(await call('post', transferPath(), { body: { userId: randomUUID() } }), 404, 'NOT_FOUND');
    expect(roleOf(world.me)).toBe('owner');
    expectNoSideEffects();
  });

  it.each<[string, unknown, string[]]>([
    ['a malformed userId', { userId: 'not-a-uuid' }, ['body.userId']],
    ['a filter injection in userId', { userId: `${MEMBER_ID},role.eq.owner` }, ['body.userId']],
    ['a missing userId', {}, ['body.userId']],
    ['an unknown key', { userId: MEMBER_ID, role: 'owner' }, ['body']],
    ['a non-string userId', { userId: 42 }, ['body.userId']],
  ])('returns 422 for %s without calling the rpc', async (_l, body, paths) => {
    buildWorld('owner');
    const res = await call('post', transferPath(), { body });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(paths);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('lowercases an uppercase body userId in the rpc and the broadcasts', async () => {
    buildWorld('owner');
    const res = await call('post', transferPath(), { body: { userId: ADMIN_ID.toUpperCase() } });
    expect(res.status).toBe(200);
    expect(rpcCalls('transfer_ownership')[0]?.p_to).toBe(ADMIN_ID);
    expect(sentBroadcasts().map((b) => b.payload)).toEqual([
      { roomId: ROOM_ID, userId: world.me, role: 'admin' },
      { roomId: ROOM_ID, userId: ADMIN_ID, role: 'owner' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// RPC error mapping: no side effects on any failed write
// ---------------------------------------------------------------------------

describe('members: rpc error mapping', () => {
  // [label, method, path, body, rpc, sqlstate, status, code, 422 detail path]
  const cases: [string, Method, string, object | undefined, string, string, number, string, string | null][] = [
    ['leave', 'delete', leavePath(), undefined, 'remove_member', 'HX001', 404, 'NOT_FOUND', null],
    ['leave', 'delete', leavePath(), undefined, 'remove_member', 'HX005', 409, 'OWNER_PROTECTED', null],
    ['leave', 'delete', leavePath(), undefined, 'remove_member', 'XX000', 500, 'INTERNAL', null],
    ['remove', 'delete', memberPath(MEMBER_ID), undefined, 'remove_member', 'HX001', 404, 'NOT_FOUND', null],
    ['remove', 'delete', memberPath(MEMBER_ID), undefined, 'remove_member', 'HX002', 403, 'FORBIDDEN', null],
    ['remove', 'delete', memberPath(MEMBER_ID), undefined, 'remove_member', 'HX003', 404, 'NOT_FOUND', null],
    ['remove', 'delete', memberPath(MEMBER_ID), undefined, 'remove_member', 'HX005', 409, 'OWNER_PROTECTED', null],
    ['remove', 'delete', memberPath(MEMBER_ID), undefined, 'remove_member', 'XX000', 500, 'INTERNAL', null],
    ['change role', 'patch', memberPath(MEMBER_ID), { role: 'admin' }, 'change_role', 'HX001', 404, 'NOT_FOUND', null],
    ['change role', 'patch', memberPath(MEMBER_ID), { role: 'admin' }, 'change_role', 'HX002', 403, 'FORBIDDEN', null],
    ['change role', 'patch', memberPath(MEMBER_ID), { role: 'admin' }, 'change_role', 'HX003', 404, 'NOT_FOUND', null],
    ['change role', 'patch', memberPath(MEMBER_ID), { role: 'admin' }, 'change_role', 'HX004', 422, 'VALIDATION_FAILED', 'params.userId'],
    ['change role', 'patch', memberPath(MEMBER_ID), { role: 'admin' }, 'change_role', 'XX000', 500, 'INTERNAL', null],
    ['transfer', 'post', transferPath(), { userId: MEMBER_ID }, 'transfer_ownership', 'HX001', 404, 'NOT_FOUND', null],
    ['transfer', 'post', transferPath(), { userId: MEMBER_ID }, 'transfer_ownership', 'HX002', 403, 'FORBIDDEN', null],
    ['transfer', 'post', transferPath(), { userId: MEMBER_ID }, 'transfer_ownership', 'HX003', 404, 'NOT_FOUND', null],
    ['transfer', 'post', transferPath(), { userId: MEMBER_ID }, 'transfer_ownership', 'HX004', 422, 'VALIDATION_FAILED', 'body.userId'],
    ['transfer', 'post', transferPath(), { userId: MEMBER_ID }, 'transfer_ownership', 'XX000', 500, 'INTERNAL', null],
  ];

  it.each(cases)(
    '%s: maps %s/%s %s to %i %s, never echoing the DB error, broadcasting, or calling LiveKit',
    async (label, method, path, body, rpc, sqlstate, status, code, detailPath) => {
      buildWorld(label === 'leave' ? 'member' : 'owner');
      results.rpcByName[rpc] = rpcError(sqlstate);
      const res = await call(method, path, { body });
      expectError(res, status, code);
      expect(rpcCalls(rpc)).toHaveLength(1);
      if (detailPath) expect(res.body.error.details).toEqual([{ path: detailPath, message: 'The request is invalid.' }]);
      else expect(res.body.error.details).toBeUndefined();
      for (const leak of ['SECRET-DB-MESSAGE', 'ROWVALUE', 'HINTVALUE', sqlstate]) expect(res.text).not.toContain(leak);
      if (status < 500) expect(logLines.join('')).not.toContain('SECRET-DB-MESSAGE');
      expectNoSideEffects();
    },
  );
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe('members: CSRF', () => {
  it.each(allWrites)('rejects %s from a foreign or missing Origin with 403 and no rpc', async (_l, method, path, body) => {
    buildWorld('owner');
    for (const origin of ['https://evil.example', 'http://localhost:5173.evil.example', 'null', null]) {
      expectError(await call(method, path(ROOM_ID), { body, origin }), 403, 'ORIGIN_NOT_ALLOWED');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each(allWrites)('rejects %s without a JSON Content-Type with 403 and no rpc', async (_l, method, path, body) => {
    buildWorld('owner');
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) {
      expectError(await call(method, path(ROOM_ID), { body, contentType }), 403, 'UNSUPPORTED_CONTENT_TYPE');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each([
    ['leave', leavePath()],
    ['remove', memberPath(MEMBER_ID)],
  ])('rejects a bodiless %s DELETE with no Content-Type header at all', async (_l, path) => {
    buildWorld('owner');
    const res = await request(app)
      .delete(path)
      .set('Cookie', `${SESSION_COOKIE}=${world.token}`)
      .set('Origin', WEB_ORIGIN);
    expectError(res, 403, 'UNSUPPORTED_CONTENT_TYPE');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Rate limit (memberWriteLimiter: 30/hour/user, shared)
// ---------------------------------------------------------------------------

describe('members: rate limit', () => {
  it('shares one 30/hour budget across all four routes, counting errors raised after the limiter; others are unaffected', async () => {
    const extras = Array.from({ length: 5 }, () => randomUUID());
    newUser('owner');
    for (const id of extras) {
      world.members.push({ room_id: ROOM_ID, user_id: id, role: 'member', joined_at: T0 });
      world.profiles.push(profile(id, `extra-${id.slice(0, 4)}`));
    }

    // 10 successful role changes.
    for (let i = 0; i < 10; i++) {
      const res = await call('patch', memberPath(ADMIN_ID), { body: { role: i % 2 === 0 ? 'member' : 'admin' } });
      expect(res.status).toBe(200);
    }
    // 5 owner leaves: 409 from the database, but past the limiter, so they count.
    for (let i = 0; i < 5; i++) expectError(await call('delete', leavePath()), 409, 'OWNER_PROTECTED');
    // 5 successful removals.
    for (const id of extras) expect((await call('delete', memberPath(id))).status).toBe(204);
    // 4 invalid PATCH bodies: validate() runs after the limiter, so they count too.
    for (let i = 0; i < 4; i++) {
      expectError(await call('patch', memberPath(ADMIN_ID), { body: { role: 'owner' } }), 422, 'VALIDATION_FAILED');
    }
    // 5 invalid transfer bodies (count), then 1 transfer that succeeds: 30 in total.
    for (let i = 0; i < 5; i++) {
      expectError(await call('post', transferPath(), { body: { userId: 'nope' } }), 422, 'VALIDATION_FAILED');
    }
    expect((await call('post', transferPath(), { body: { userId: ADMIN_ID } })).status).toBe(200);
    expect(roleOf(world.me)).toBe('admin');

    // The 31st (a leave that would now succeed) is limited and never reaches the database.
    const removeCallsBefore = rpcCalls('remove_member').length;
    fetchMock.mockClear();
    livekit.removeParticipant.mockClear();
    expectError(await call('delete', leavePath()), 429, 'RATE_LIMITED');
    expect(rpcCalls('remove_member')).toHaveLength(removeCallsBefore);
    expect(roleOf(world.me)).toBe('admin');
    expectNoSideEffects();

    // A different user is unaffected.
    newUser('member');
    expect((await call('delete', leavePath())).status).toBe(204);
  });

  it('does not charge requests rejected before the limiter (401, 404 room/target, fast-path 403)', async () => {
    newUser('member');
    for (let i = 0; i < 5; i++) expectError(await call('delete', leavePath(), { signedIn: false }), 401, 'UNAUTHENTICATED');
    for (let i = 0; i < 8; i++) expectError(await call('delete', leavePath(OTHER_ROOM_ID)), 404, 'NOT_FOUND');
    for (let i = 0; i < 8; i++) expectError(await call('delete', memberPath('not-a-uuid')), 404, 'NOT_FOUND');
    for (let i = 0; i < 8; i++) expectError(await call('delete', memberPath(MEMBER2_ID)), 403, 'FORBIDDEN');
    for (let i = 0; i < 8; i++) {
      expectError(await call('patch', memberPath(MEMBER2_ID), { body: { role: 'admin' } }), 403, 'FORBIDDEN');
    }
    for (let i = 0; i < 8; i++) {
      expectError(await call('post', transferPath(), { body: { userId: MEMBER2_ID } }), 403, 'FORBIDDEN');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();

    // Promoted to owner in the database: the full budget of 30 is still there.
    const oldOwner = world.members.find((m) => m.room_id === ROOM_ID && m.role === 'owner');
    if (oldOwner) oldOwner.role = 'admin';
    setRole(world.me, 'owner');
    for (let i = 0; i < 30; i++) {
      const res = await call('patch', memberPath(MEMBER2_ID), { body: { role: i % 2 === 0 ? 'admin' : 'member' } });
      expect(res.status).toBe(200);
    }
    expectError(await call('patch', memberPath(MEMBER2_ID), { body: { role: 'admin' } }), 429, 'RATE_LIMITED');
    expect(rpcCalls('change_role')).toHaveLength(30);
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe('members: secrets', () => {
  it('never logs, returns, or broadcasts the session token, service key, or DB details across every route', async () => {
    buildWorld('owner');
    livekit.removeParticipant.mockRejectedValue(new ServerError('internal', 'boom', 500, 'internal'));
    const texts: string[] = [];
    texts.push((await call('delete', memberPath(MEMBER_ID))).text);
    texts.push((await call('patch', memberPath(ADMIN_ID), { body: { role: 'member' } })).text);
    texts.push((await call('delete', leavePath())).text);
    texts.push((await call('post', transferPath(), { body: { userId: ADMIN_ID } })).text);
    results.rpcByName.remove_member = rpcError('XX000');
    texts.push((await call('delete', memberPath(MEMBER2_ID))).text);
    world.failChannelsRead = true;
    texts.push((await call('delete', memberPath(MEMBER2_ID))).text);

    const logs = logLines.join('');
    expect(logs).toContain('remove_member failed');
    expect(logsAt(40, 'could not remove participant')).toHaveLength(2);
    for (const text of [...texts, logs, JSON.stringify(sentBroadcasts())]) {
      expect(text).not.toContain(world.token);
      expect(text).not.toContain('test-service-role-key');
      expect(text).not.toContain('test-livekit-secret');
      expect(text).not.toContain('ROWVALUE-DETAILS');
      expect(text).not.toContain('HINTVALUE');
    }
    for (const text of texts) expect(text).not.toContain('SECRET-DB-MESSAGE');
  });
});
