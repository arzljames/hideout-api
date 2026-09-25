import { randomUUID } from 'node:crypto';
import type * as PinoModule from 'pino';
import type * as LivekitModule from '../src/lib/livekit.js';
import { ServerError } from 'livekit-server-sdk';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeDb,
  firstArg,
  queries,
  resetFakeDb,
  results,
  storageCalls,
  type DbResult,
  type RecordedQuery,
} from './helpers/fakeDb.js';

/*
 * Rooms core (POST/GET /api/rooms, GET/PATCH/DELETE /api/rooms/:roomId) through the real
 * app, offline. The database is faked at the supabase-js client with a small in-memory
 * "world" that honours the filters the services pass (eq / is / or / limit), so a missing
 * filter shows up as a wrong result. Broadcasts are observed at the Realtime REST fetch
 * boundary (so the real schema check in realtime/broadcast.ts runs), LiveKit at
 * livekitRooms.deleteRoom. Every log line (LOG_LEVEL=trace) is captured and checked.
 */

const logLines = vi.hoisted<string[]>(() => []);
const livekit = vi.hoisted(() => ({ deleteRoom: vi.fn<(name: string) => Promise<void>>() }));

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
  livekitRooms: { deleteRoom: livekit.deleteRoom },
}));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

const savedEnv = { LOG_LEVEL: process.env.LOG_LEVEL };
process.env.LOG_LEVEL = 'trace';

const { createApp } = await import('../src/app.js');
const { newRandomToken, SESSION_COOKIE } = await import('../src/lib/session.js');
const { MyRoomPage, RoomDetail } = await import('../src/contracts/http/rooms.js');
const { ErrorResponse } = await import('../src/contracts/http/common.js');
const { serverEvents } = await import('../src/contracts/events.js');

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

const ROOM_ID = '1a2b3c4d-0000-4000-8000-00000000a001';
const OTHER_ROOM_ID = '1a2b3c4d-0000-4000-8000-00000000a002';
const OWNER_ID = '0f000000-0000-4000-8000-000000000001';
const ADMIN_ID = '0f000000-0000-4000-8000-000000000002';
const MEMBER_ID = '0f000000-0000-4000-8000-000000000003';
const GENERAL_ID = 'c0000000-0000-4000-8000-000000000001';
const RANDOM_ID = 'c0000000-0000-4000-8000-000000000002';
const VOICE_ID = 'c0000000-0000-4000-8000-000000000003';
const VOICE2_ID = 'c0000000-0000-4000-8000-000000000004';
const DELETED_TEXT_ID = 'c0000000-0000-4000-8000-000000000005';
const DELETED_VOICE_ID = 'c0000000-0000-4000-8000-000000000006';
const AVATAR = 'https://avatars.steamstatic.com/abc_full.jpg';
const T0 = '2026-09-01T10:00:00.123456+00:00';

type Role = 'owner' | 'admin' | 'member';

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
  type: 'text' | 'voice';
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
  profiles: { id: string; display_name: string; avatar_url: string | null; current_game: string | null };
}

interface MyRoomRow {
  role: Role;
  joined_at: string;
  room_id: string;
  /** null only as PostgREST returns it: the embedded room was filtered out and the join is not `!inner`. */
  rooms: RoomRow | null;
}

/** In-memory database state the fake queries read from. Rebuilt for every test. */
interface World {
  me: string;
  token: string;
  rooms: RoomRow[];
  channels: ChannelRow[];
  members: MemberRow[];
  myRooms: MyRoomRow[];
  /** Force an error from one table's reads. */
  failTable?: { table: string; error: NonNullable<DbResult['error']> };
}

let world: World;

function roomRow(overrides: Partial<RoomRow> = {}): RoomRow {
  return {
    id: ROOM_ID,
    name: 'Friday Night Raids',
    icon_emoji: '🎮',
    icon_path: null,
    created_at: T0,
    deleted_at: null,
    ...overrides,
  };
}

function channelRow(id: string, type: 'text' | 'voice', name: string, position: number, deleted = false): ChannelRow {
  return { id, room_id: ROOM_ID, type, name, position, created_at: T0, deleted_at: deleted ? T0 : null };
}

function memberRow(userId: string, role: Role, displayName: string, avatar: string | null = AVATAR): MemberRow {
  return {
    room_id: ROOM_ID,
    user_id: userId,
    role,
    joined_at: T0,
    profiles: { id: userId, display_name: displayName, avatar_url: avatar, current_game: null },
  };
}

/** The standard room: `me` has `myRole` (null: not a member), plus an owner/admin/member. */
function buildWorld(myRole: Role | null): void {
  const me = world.me;
  const others: MemberRow[] = [
    memberRow(OWNER_ID, 'owner', 'Olivia'),
    memberRow(ADMIN_ID, 'admin', 'Adam'),
    memberRow(MEMBER_ID, 'member', 'Mia'),
  ];
  const members = myRole === 'owner' ? [memberRow(me, 'owner', 'Me'), ...others.slice(1)] : others;
  if (myRole && myRole !== 'owner') members.push(memberRow(me, myRole, 'Me'));
  world.rooms = [roomRow(), roomRow({ id: OTHER_ROOM_ID, name: 'Elsewhere' })];
  world.channels = [
    channelRow(GENERAL_ID, 'text', 'general', 0),
    channelRow(VOICE_ID, 'voice', 'voice', 0),
  ];
  world.members = members;
  // Someone else's room, which must never be reachable through ROOM_ID.
  world.members.push({ ...memberRow(OWNER_ID, 'owner', 'Olivia'), room_id: OTHER_ROOM_ID });
}

/** Applies eq/is filters to columns the row has; nested filters (e.g. rooms.deleted_at) are handled by callers. */
function matches(row: object, query: RecordedQuery): boolean {
  const record = row as Record<string, unknown>;
  return query.calls.every(([method, args]) => {
    if (method !== 'eq' && method !== 'is') return true;
    const [column, value] = args as [string, unknown];
    return !(column in record) || record[column] === value;
  });
}

function hasCall(query: RecordedQuery, method: string, ...args: unknown[]): boolean {
  return query.calls.some(([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args));
}

function roomIsLive(roomId: string, query: RecordedQuery): boolean {
  const room = world.rooms.find((r) => r.id === roomId);
  if (!room) return false;
  // Emulates the inner join: a deleted room is only excluded when the service asks for it.
  return room.deleted_at === null || !hasCall(query, 'is', 'rooms.deleted_at', null);
}

function tableError(table: string): DbResult | undefined {
  return world.failTable?.table === table ? { data: null, error: world.failTable.error } : undefined;
}

function roomMembersSelect(query: RecordedQuery): DbResult {
  const failure = tableError('room_members');
  if (failure) return failure;
  const columns = String(firstArg(query, 'select'));
  const rows = world.members.filter((row) => matches(row, query));
  // PostgREST embeds: with `rooms!inner(...)` a row whose room is filtered out (rooms.deleted_at)
  // is dropped; without `!inner` the row stays and its embed is null. Dropping `!inner` from a
  // service query therefore shows up as a deleted room leaking through.
  const innerRooms = columns.includes('rooms!inner(');

  if (/^role, rooms(!inner)?\(/.test(columns)) {
    // requireRoomMember's membership check (maybeSingle).
    const row = rows[0];
    if (!row) return { data: null, error: null };
    if (roomIsLive(row.room_id, query)) return { data: { role: row.role, rooms: { id: row.room_id } }, error: null };
    return { data: innerRooms ? null : { role: row.role, rooms: null }, error: null };
  }
  if (columns.startsWith('role, joined_at, room_id')) {
    // GET /api/rooms: keyset page over world.myRooms.
    const filtered = hasCall(query, 'is', 'rooms.deleted_at', null);
    let page = world.myRooms.flatMap((row): MyRoomRow[] => {
      if (row.rooms && (row.rooms.deleted_at === null || !filtered)) return [row];
      return innerRooms ? [] : [{ ...row, rooms: null }];
    });
    const or = firstArg(query, 'or');
    if (typeof or === 'string') {
      const match = /^joined_at\.gt\."([^"]+)",and\(joined_at\.eq\."([^"]+)",room_id\.gt\.([0-9a-f-]+)\)$/.exec(or);
      if (!match) throw new Error(`unexpected or filter: ${or}`);
      const [, after, , afterRoom] = match as unknown as [string, string, string, string];
      page = page.filter((r) => r.joined_at > after || (r.joined_at === after && r.room_id > afterRoom));
    }
    const limit = firstArg(query, 'limit');
    return { data: typeof limit === 'number' ? page.slice(0, limit) : page, error: null };
  }
  if (columns.startsWith('user_id, role, joined_at')) {
    return { data: rows.map(({ room_id: _roomId, ...rest }) => rest), error: null };
  }
  if (columns === 'user_id') return { data: rows.map((r) => ({ user_id: r.user_id })), error: null };
  throw new Error(`unexpected room_members select: ${columns}`);
}

const UPDATED_AT = '2026-09-25T12:00:00.000001+00:00';

/** update_room: applies the change to the world's live room and returns the rooms row, like the Postgres function. */
function fakeUpdateRoom(args: Record<string, unknown>): DbResult {
  const room = world.rooms.find((r) => r.id === args.p_room && r.deleted_at === null);
  if (!room) return rpcError('HX001');
  if (typeof args.p_name === 'string') room.name = args.p_name;
  if (typeof args.p_icon_emoji === 'string') {
    room.icon_emoji = args.p_icon_emoji;
    room.icon_path = null;
  }
  return { data: { ...room, updated_at: UPDATED_AT }, error: null };
}

/** delete_room: soft-deletes the room and its channels; member rows are kept. */
function fakeDeleteRoom(args: Record<string, unknown>): DbResult {
  const room = world.rooms.find((r) => r.id === args.p_room && r.deleted_at === null);
  if (!room) return rpcError('HX001');
  room.deleted_at = UPDATED_AT;
  for (const channel of world.channels) {
    if (channel.room_id === room.id && channel.deleted_at === null) channel.deleted_at = UPDATED_AT;
  }
  return { data: null, error: null };
}

function install(): void {
  results.selectByTable.sessions = { data: { id: randomUUID(), profile_id: world.me }, error: null };
  results.selectByTable.room_members = roomMembersSelect;
  results.selectByTable.rooms = (query) =>
    tableError('rooms') ?? { data: world.rooms.find((row) => matches(row, query)) ?? null, error: null };
  results.selectByTable.channels = (query) =>
    tableError('channels') ?? { data: world.channels.filter((row) => matches(row, query)), error: null };
  results.rpcByName.update_room = fakeUpdateRoom;
  results.rpcByName.delete_room = fakeDeleteRoom;
}

type Method = 'get' | 'post' | 'patch' | 'delete';

interface CallOptions {
  body?: object;
  signedIn?: boolean;
  origin?: string | null;
  contentType?: string | null;
}

/** A request as hideout-web sends it: session cookie, WEB_ORIGIN, JSON content type on writes. */
function call(method: Method, path: string, options: CallOptions = {}) {
  let req = request(app)[method](path);
  if (options.signedIn ?? true) req = req.set('Cookie', `${SESSION_COOKIE}=${world.token}`);
  if (method !== 'get') {
    const origin = options.origin === undefined ? WEB_ORIGIN : options.origin;
    const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
    if (origin !== null) req = req.set('Origin', origin);
    if (contentType !== null) req = req.set('Content-Type', contentType);
  }
  return options.body === undefined ? req : req.send(JSON.stringify(options.body));
}

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

interface LogEntry {
  level: number;
  msg: string;
  [key: string]: unknown;
}

/** Captured log lines at a pino level (20 debug, 30 info, 40 warn, 50 error) whose msg contains `text`. */
function logsAt(level: number, text: string): LogEntry[] {
  return logLines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry)
    .filter((entry) => entry.level === level && entry.msg.includes(text));
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

/** Distinct detail paths (one field can fail several rules, e.g. an empty name fails min and the regex). */
function detailPaths(res: request.Response): string[] {
  return [...new Set((res.body.error.details as { path: string }[]).map((d) => d.path))];
}

const DB_SECRET_MESSAGE = 'SECRET-DB-MESSAGE relation "rooms" violates check';
const DB_DETAILS = 'Failing row contains (ROWVALUE-DETAILS)';

function rpcError(code: string): DbResult {
  return { data: null, error: { code, message: DB_SECRET_MESSAGE, details: DB_DETAILS, hint: 'HINTVALUE' } };
}

beforeEach(() => {
  resetFakeDb();
  logLines.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 202 })));
  livekit.deleteRoom.mockReset();
  livekit.deleteRoom.mockResolvedValue(undefined);
  // A fresh user per test also isolates the per-user rate limiters, whose state is module-level.
  world = { me: randomUUID(), token: newRandomToken(), rooms: [], channels: [], members: [], myRooms: [] };
  install();
});

afterEach(() => {
  const logs = logLines.join('');
  for (const secret of [
    'test-service-role-key',
    'test-session-secret',
    'test-supabase-jwt-secret',
    'test-livekit-secret',
    'test-steam-api-key',
    world.token,
    'ROWVALUE-DETAILS',
    'HINTVALUE',
  ]) {
    expect(logs).not.toContain(secret);
  }
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe('rooms: authentication', () => {
  it.each<[Method, string]>([
    ['post', '/api/rooms'],
    ['get', '/api/rooms'],
    ['get', `/api/rooms/${ROOM_ID}`],
    ['patch', `/api/rooms/${ROOM_ID}`],
    ['delete', `/api/rooms/${ROOM_ID}`],
  ])('returns 401 for %s %s without a session and touches no room data', async (method, path) => {
    buildWorld('owner');
    const body = method === 'post' || method === 'patch' ? { name: 'x', icon: { kind: 'emoji', emoji: '🎮' } } : undefined;
    const res = await call(method, path, { signedIn: false, body });
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(queries.filter((q) => q.table !== 'sessions')).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('rooms/:roomId: membership (404, never 403, for non-members)', () => {
  it.each<[Method, object | undefined]>([
    ['get', undefined],
    ['patch', { name: 'Hijacked' }],
    ['delete', undefined],
  ])('returns 404 when a non-member sends %s', async (method, body) => {
    buildWorld(null);
    const res = await call(method, `/api/rooms/${ROOM_ID}`, { body });
    expectError(res, 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
    // The membership check is scoped to the caller and the room.
    const [membership] = queriesOn('room_members');
    expect(membership?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    expect(membership?.calls).toContainEqual(['eq', ['user_id', world.me]]);
  });

  it('returns the same 404 body for a non-member as for a room that does not exist', async () => {
    buildWorld(null);
    const nonMember = await call('get', `/api/rooms/${ROOM_ID}`);
    const missing = await call('get', `/api/rooms/${randomUUID()}`);
    expect(nonMember.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(nonMember.body).toStrictEqual(missing.body);
  });

  it.each<[Method, object | undefined]>([
    ['get', undefined],
    ['patch', { name: 'Revived' }],
    ['delete', undefined],
  ])('returns 404 for %s on a deleted room, even for its owner', async (method, body) => {
    buildWorld('owner');
    world.rooms[0] = roomRow({ deleted_at: T0 });
    const res = await call(method, `/api/rooms/${ROOM_ID}`, { body });
    expectError(res, 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['not a uuid', 'not-a-uuid'],
    ['a uuid with a suffix', `${ROOM_ID}x`],
    ['a filter injection', `${ROOM_ID},user_id.neq.0`],
    ['a numeric id', '123'],
  ])('returns 404 (not 422) for a malformed roomId (%s) without querying rooms', async (_name, roomId) => {
    buildWorld('owner');
    for (const method of ['get', 'patch', 'delete'] as const) {
      const res = await call(method, `/api/rooms/${encodeURIComponent(roomId)}`, {
        body: method === 'patch' ? { name: 'x' } : undefined,
      });
      expectError(res, 404, 'NOT_FOUND');
    }
    expect(queriesOn('room_members')).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it('normalizes an uppercase roomId to lowercase for the lookup, the rpc, and the broadcast topic', async () => {
    buildWorld('owner');
    const res = await call('patch', `/api/rooms/${ROOM_ID.toUpperCase()}`, { body: { name: 'Renamed' } });
    expect(res.status).toBe(200);
    expect(queriesOn('room_members')[0]?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    expect(rpcCalls('update_room')[0]?.p_room).toBe(ROOM_ID);
    expect(sentBroadcasts().map((b) => b.topic)).toEqual([`room:${ROOM_ID}`]);
  });

  it('loses access immediately when removed: the next request after removal is a 404', async () => {
    buildWorld('member');
    expect((await call('get', `/api/rooms/${ROOM_ID}`)).status).toBe(200);
    world.members = world.members.filter((m) => m.user_id !== world.me);
    expectError(await call('get', `/api/rooms/${ROOM_ID}`), 404, 'NOT_FOUND');
  });

  it("never returns another room's data when a member of one room asks for another", async () => {
    buildWorld('owner');
    const res = await call('get', `/api/rooms/${OTHER_ROOM_ID}`);
    expectError(res, 404, 'NOT_FOUND');
    expect(res.text).not.toContain('Elsewhere');
  });
});

describe('PATCH /api/rooms/:roomId: roles', () => {
  it('returns 403 FORBIDDEN for a plain member and never calls update_room', async () => {
    buildWorld('member');
    const res = await call('patch', `/api/rooms/${ROOM_ID}`, { body: { name: 'Mine now' } });
    expectError(res, 403, 'FORBIDDEN');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 403 (not 422) for a plain member even with an invalid body', async () => {
    buildWorld('member');
    const res = await call('patch', `/api/rooms/${ROOM_ID}`, { body: {} });
    expectError(res, 403, 'FORBIDDEN');
  });

  it.each<Role>(['admin', 'owner'])('returns 200 for an %s and calls update_room as that user', async (role) => {
    buildWorld(role);
    const res = await call('patch', `/api/rooms/${ROOM_ID}`, {
      body: { name: '  Saturday Raids  ', icon: { kind: 'emoji', emoji: '🐉' } },
    });
    expect(res.status).toBe(200);
    expect(RoomDetail.parse(res.body)).toStrictEqual(res.body);
    expect(res.body.myRole).toBe(role);
    expect(rpcCalls('update_room')).toEqual([
      { p_room: ROOM_ID, p_actor: world.me, p_name: 'Saturday Raids', p_icon_emoji: '🐉' },
    ]);
  });

  it('passes null for the field that was not provided', async () => {
    buildWorld('owner');
    await call('patch', `/api/rooms/${ROOM_ID}`, { body: { icon: { kind: 'emoji', emoji: '🐉' } } });
    await call('patch', `/api/rooms/${ROOM_ID}`, { body: { name: 'Only name' } });
    expect(rpcCalls('update_room')).toEqual([
      { p_room: ROOM_ID, p_actor: world.me, p_name: null, p_icon_emoji: '🐉' },
      { p_room: ROOM_ID, p_actor: world.me, p_name: 'Only name', p_icon_emoji: null },
    ]);
  });

  it('returns 403 when update_room raises HX002 (demoted between the check and the write)', async () => {
    buildWorld('admin');
    results.rpcByName.update_room = rpcError('HX002');
    const res = await call('patch', `/api/rooms/${ROOM_ID}`, { body: { name: 'Race' } });
    expectError(res, 403, 'FORBIDDEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 when update_room raises HX001 (removed or room deleted between the check and the write)', async () => {
    buildWorld('owner');
    results.rpcByName.update_room = rpcError('HX001');
    const res = await call('patch', `/api/rooms/${ROOM_ID}`, { body: { name: 'Race' } });
    expectError(res, 404, 'NOT_FOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/rooms/:roomId: roles', () => {
  it.each<Role>(['member', 'admin'])('returns 403 for an %s and never calls delete_room', async (role) => {
    buildWorld(role);
    const res = await call('delete', `/api/rooms/${ROOM_ID}`);
    expectError(res, 403, 'FORBIDDEN');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
  });

  it('returns 204 with no body for the owner and calls delete_room as the owner', async () => {
    buildWorld('owner');
    const res = await call('delete', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(rpcCalls('delete_room')).toEqual([{ p_room: ROOM_ID, p_actor: world.me }]);
  });

  it.each([
    ['HX001', 404, 'NOT_FOUND'],
    ['HX002', 403, 'FORBIDDEN'],
  ])('maps a delete_room %s race to %i and broadcasts nothing', async (code, status, errorCode) => {
    buildWorld('owner');
    results.rpcByName.delete_room = rpcError(code);
    const res = await call('delete', `/api/rooms/${ROOM_ID}`);
    expectError(res, status, errorCode);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe('rooms: CSRF', () => {
  const writes: [Method, string, object | undefined][] = [
    ['post', '/api/rooms', { name: 'x', icon: { kind: 'emoji', emoji: '🎮' } }],
    ['patch', `/api/rooms/${ROOM_ID}`, { name: 'x' }],
    ['delete', `/api/rooms/${ROOM_ID}`, undefined],
  ];

  it.each(writes)('rejects %s %s from a foreign Origin with 403 ORIGIN_NOT_ALLOWED', async (method, path, body) => {
    buildWorld('owner');
    for (const origin of ['https://evil.example', 'http://localhost:5173.evil.example', 'null', null]) {
      const res = await call(method, path, { body, origin });
      expectError(res, 403, 'ORIGIN_NOT_ALLOWED');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
  });

  it.each(writes)('rejects %s %s without a JSON Content-Type with 403 UNSUPPORTED_CONTENT_TYPE', async (method, path, body) => {
    buildWorld('owner');
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) {
      const res = await call(method, path, { body, contentType });
      expectError(res, 403, 'UNSUPPORTED_CONTENT_TYPE');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not grant CORS credentials to a foreign origin on preflight', async () => {
    const res = await request(app)
      .options('/api/rooms')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('rooms: validation', () => {
  const emoji = { kind: 'emoji', emoji: '🎮' };

  it.each<[string, object, string[]]>([
    ['a blank name', { name: '', icon: emoji }, ['body.name']],
    ['a whitespace-only name', { name: '   \t ', icon: emoji }, ['body.name']],
    ['a 49-character name', { name: 'a'.repeat(49), icon: emoji }, ['body.name']],
    ['a non-string name', { name: 42, icon: emoji }, ['body.name']],
    ['a non-emoji icon', { name: 'Raid', icon: { kind: 'emoji', emoji: 'a' } }, ['body.icon.emoji']],
    ['two emojis', { name: 'Raid', icon: { kind: 'emoji', emoji: '🎮🎮' } }, ['body.icon.emoji']],
    ['emoji plus text', { name: 'Raid', icon: { kind: 'emoji', emoji: '🎮x' } }, ['body.icon.emoji']],
    ['an unknown icon kind', { name: 'Raid', icon: { kind: 'image', path: 'x.png' } }, ['body.icon.kind']],
    ['a missing icon', { name: 'Raid' }, ['body.icon']],
    ['a missing name', { icon: emoji }, ['body.name']],
    ['an unknown top-level key', { name: 'Raid', icon: emoji, owner: OWNER_ID }, ['body']],
    ['a client-supplied icon_path', { name: 'Raid', icon: emoji, icon_path: 'x.png' }, ['body']],
    ['an unknown key in the icon', { name: 'Raid', icon: { ...emoji, path: 'x.png' } }, ['body.icon']],
    ['a zero-width-space name', { name: '\u200B', icon: emoji }, ['body.name']],
    ['a name with a right-to-left override', { name: 'a\u202Eb', icon: emoji }, ['body.name']],
    ['a name with a bidi isolate', { name: '\u2066x', icon: emoji }, ['body.name']],
    ['a name with a word joiner', { name: 'a\u2060b', icon: emoji }, ['body.name']],
    ['a name with a BOM inside', { name: 'a\uFEFFb', icon: emoji }, ['body.name']],
    ['a name with an interior tab', { name: 'a\tb', icon: emoji }, ['body.name']],
    ['a name with only combining marks', { name: '\u0301\u0301', icon: emoji }, ['body.name']],
  ])('POST returns 422 for %s without calling create_room', async (_name, body, paths) => {
    const res = await call('post', '/api/rooms', { body });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(paths);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it.each<[string, object, string[]]>([
    ['an empty body', {}, ['body']],
    ['a blank name', { name: ' ' }, ['body.name']],
    ['a 49-character name', { name: 'a'.repeat(49) }, ['body.name']],
    ['two emojis', { icon: { kind: 'emoji', emoji: '🐉🐉' } }, ['body.icon.emoji']],
    ['an unknown key', { name: 'Raid', deleted_at: null }, ['body']],
    ['null name', { name: null }, ['body.name']],
    ['a zero-width-space name', { name: '\u200B' }, ['body.name']],
    ['an unknown key in the icon', { icon: { kind: 'emoji', emoji: '🐉', url: 'https://x.test/a.png' } }, ['body.icon']],
  ])('PATCH returns 422 for %s without calling update_room', async (_name, body, paths) => {
    buildWorld('owner');
    const res = await call('patch', `/api/rooms/${ROOM_ID}`, { body });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(paths);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a ZWJ family', '👨‍👩‍👧'],
    ['a flag', '🇯🇵'],
    ['a skin-tone modifier', '👍🏽'],
    ['a keycap', '1️⃣'],
  ])('accepts %s as a single emoji', async (_name, value) => {
    buildWorld('owner');
    results.rpcByName.create_room = { data: ROOM_ID, error: null };
    const res = await call('post', '/api/rooms', { body: { name: 'Raid', icon: { kind: 'emoji', emoji: value } } });
    expect(res.status).toBe(201);
    expect(rpcCalls('create_room')[0]?.p_icon_emoji).toBe(value);
  });

  it.each([
    ['text plus an emoji', 'Squad 🎮'],
    ['an accented letter', 'Café'],
    ['a ZWJ emoji sequence', 'Family 👨‍👩‍👧'],
    ['emoji only', '🐉'],
    ['punctuation only', '!!!'],
  ])('accepts a name with %s', async (_name, value) => {
    buildWorld('owner');
    results.rpcByName.create_room = { data: ROOM_ID, error: null };
    const res = await call('post', '/api/rooms', { body: { name: value, icon: emoji } });
    expect(res.status).toBe(201);
    expect(rpcCalls('create_room')[0]?.p_name).toBe(value);
  });

  it('trims the name and accepts exactly 48 characters after trimming', async () => {
    buildWorld('owner');
    results.rpcByName.create_room = { data: ROOM_ID, error: null };
    const name = 'n'.repeat(48);
    const res = await call('post', '/api/rooms', { body: { name: `  ${name}\n`, icon: emoji } });
    expect(res.status).toBe(201);
    expect(rpcCalls('create_room')[0]?.p_name).toBe(name);
  });

  it.each(['0', '101', 'abc', '1.5', '-1'])('GET /api/rooms returns 422 for limit=%s', async (limit) => {
    const res = await call('get', `/api/rooms?limit=${limit}`);
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['query.limit']);
    expect(queriesOn('room_members')).toHaveLength(0);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['base64 of non-JSON', Buffer.from('hello').toString('base64url')],
    ['a wrong shape', Buffer.from(JSON.stringify({ a: 1 })).toString('base64url')],
    ['a non-uuid room id', Buffer.from(JSON.stringify([T0, 'x'])).toString('base64url')],
    [
      'a filter injection in the room id',
      Buffer.from(JSON.stringify([T0, `${ROOM_ID}),id.neq.(0`])).toString('base64url'),
    ],
    [
      'a filter injection in the timestamp',
      Buffer.from(JSON.stringify(['2026-09-01T10:00:00Z",room_id.neq."0', ROOM_ID])).toString('base64url'),
    ],
    ['February 30th', Buffer.from(JSON.stringify(['2026-02-30T10:00:00+00:00', ROOM_ID])).toString('base64url')],
    ['month 13', Buffer.from(JSON.stringify(['2026-13-01T10:00:00+00:00', ROOM_ID])).toString('base64url')],
    ['hour 24', Buffer.from(JSON.stringify(['2026-09-01T24:00:00+00:00', ROOM_ID])).toString('base64url')],
    ['year 0', Buffer.from(JSON.stringify(['0000-01-01T00:00:00+00:00', ROOM_ID])).toString('base64url')],
    ['a timestamp without an offset', Buffer.from(JSON.stringify(['2026-09-01T10:00:00', ROOM_ID])).toString('base64url')],
    ['a cursor over 256 characters', 'a'.repeat(257)],
  ])('GET /api/rooms returns 422 for an invalid cursor (%s) and runs no query', async (_name, cursor) => {
    const res = await call('get', `/api/rooms?cursor=${encodeURIComponent(cursor)}`);
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['query.cursor']);
    // The builder is created before the cursor is decoded, but never filtered with it or sent.
    for (const query of queriesOn('room_members')) {
      expect(query.calls.map(([m]) => m)).not.toContain('or');
      expect(query.calls.map(([m]) => m)).not.toContain('limit');
    }
  });

  it.each([
    ['23514', 'post'],
    ['22023', 'post'],
    ['23514', 'patch'],
    ['22023', 'patch'],
  ] as const)('maps a %s from the %s rpc to 422 without echoing the database message', async (code, method) => {
    buildWorld('owner');
    results.rpcByName.create_room = rpcError(code);
    results.rpcByName.update_room = rpcError(code);
    const body = method === 'post' ? { name: 'Raid', icon: emoji } : { name: 'Raid' };
    const path = method === 'post' ? '/api/rooms' : `/api/rooms/${ROOM_ID}`;
    const res = await call(method, path, { body });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(res.body.error.details).toEqual([{ path: 'body', message: 'The request is invalid.' }]);
    for (const leak of ['SECRET-DB-MESSAGE', 'ROWVALUE', 'HINTVALUE', code]) expect(res.text).not.toContain(leak);
    expect(logLines.join('')).not.toContain('SECRET-DB-MESSAGE');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('rooms: rate limits', () => {
  it('returns 429 RATE_LIMITED on the 11th room created within the hour, per user', async () => {
    buildWorld('owner');
    results.rpcByName.create_room = { data: ROOM_ID, error: null };
    const body = { name: 'Raid', icon: { kind: 'emoji', emoji: '🎮' } };
    for (let i = 0; i < 10; i++) expect((await call('post', '/api/rooms', { body })).status).toBe(201);

    expectError(await call('post', '/api/rooms', { body }), 429, 'RATE_LIMITED');
    expect(rpcCalls('create_room')).toHaveLength(10);

    // Another user is not affected by this user's limit.
    world.me = randomUUID();
    buildWorld('owner');
    install();
    expect((await call('post', '/api/rooms', { body })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// POST /api/rooms
// ---------------------------------------------------------------------------

describe('POST /api/rooms', () => {
  it('creates the room as the session user and returns 201 RoomDetail with myRole owner', async () => {
    buildWorld('owner');
    world.channels = [channelRow(VOICE_ID, 'voice', 'voice', 0), channelRow(GENERAL_ID, 'text', 'general', 0)];
    results.rpcByName.create_room = { data: ROOM_ID, error: null };
    const res = await call('post', '/api/rooms', {
      body: { name: 'Friday Night Raids', icon: { kind: 'emoji', emoji: '🎮' } },
    });

    expect(res.status).toBe(201);
    expect(RoomDetail.parse(res.body)).toStrictEqual(res.body);
    expect(rpcCalls('create_room')).toEqual([
      { p_owner: world.me, p_name: 'Friday Night Raids', p_icon_emoji: '🎮', p_icon_path: null },
    ]);
    expect(res.body.myRole).toBe('owner');
    expect(res.body.defaultChannelId).toBe(GENERAL_ID);
    expect(res.body.room).toStrictEqual({
      id: ROOM_ID,
      name: 'Friday Night Raids',
      icon: { kind: 'emoji', emoji: '🎮' },
      createdAt: T0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a generic 500 when create_room returns something that is not a room id', async () => {
    buildWorld('owner');
    results.rpcByName.create_room = { data: 'nope', error: null };
    const res = await call('post', '/api/rooms', { body: { name: 'Raid', icon: { kind: 'emoji', emoji: '🎮' } } });
    expectError(res, 500, 'INTERNAL');
  });

  it('returns a generic 500 for an unmapped rpc error, logging the message but not details or hints', async () => {
    results.rpcByName.create_room = rpcError('XX000');
    const res = await call('post', '/api/rooms', { body: { name: 'Raid', icon: { kind: 'emoji', emoji: '🎮' } } });
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
    expect(logLines.join('')).toContain('create_room failed');
  });
});

// ---------------------------------------------------------------------------
// GET /api/rooms
// ---------------------------------------------------------------------------

function myRoomRow(id: string, joinedAt: string, overrides: Partial<RoomRow> = {}): MyRoomRow {
  return { role: 'member', joined_at: joinedAt, room_id: id, rooms: roomRow({ id, name: `Room ${id.slice(-3)}`, ...overrides }) };
}

describe('GET /api/rooms', () => {
  const ids = ['e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000003'];

  it('lists only live rooms of the caller, ordered by (joined_at, room_id), with Cache-Control no-store', async () => {
    world.myRooms = [
      myRoomRow(ids[0] as string, '2026-09-01T10:00:00.000001+00:00'),
      myRoomRow(ids[1] as string, '2026-09-02T10:00:00+00:00', { deleted_at: T0, name: 'Deleted room' }),
      myRoomRow(ids[2] as string, '2026-09-03T10:00:00+00:00'),
    ];
    const res = await call('get', '/api/rooms');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(MyRoomPage.parse(res.body)).toStrictEqual(res.body);
    expect(MyRoomPage.parse(res.body).data.map((r) => r.room.id)).toEqual([ids[0], ids[2]]);
    expect(res.text).not.toContain('Deleted room');
    expect(res.body.nextCursor).toBeNull();

    const [query] = queriesOn('room_members');
    expect(query?.calls).toContainEqual(['eq', ['user_id', world.me]]);
    expect(query?.calls).toContainEqual(['is', ['rooms.deleted_at', null]]);
    expect(query?.calls.filter(([m]) => m === 'order')).toEqual([
      ['order', ['joined_at', { ascending: true }]],
      ['order', ['room_id', { ascending: true }]],
    ]);
    expect(query?.calls).toContainEqual(['limit', [51]]);
  });

  it('returns nextCursor when limit+1 rows come back, and the cursor fetches the rest with no gaps or repeats', async () => {
    // Two rooms joined in the same microsecond: the room_id tiebreak must keep both.
    world.myRooms = [
      myRoomRow(ids[0] as string, '2026-09-01T10:00:00.123456+00:00'),
      myRoomRow(ids[1] as string, '2026-09-01T10:00:00.123456+00:00'),
      myRoomRow(ids[2] as string, '2026-09-02T10:00:00+00:00'),
    ];
    const first = await call('get', '/api/rooms?limit=1');
    expect(first.status).toBe(200);
    expect(MyRoomPage.parse(first.body).data.map((r) => r.room.id)).toEqual([ids[0]]);
    expect(typeof first.body.nextCursor).toBe('string');
    expect(queriesOn('room_members')[0]?.calls).toContainEqual(['limit', [2]]);

    const seen = [ids[0]];
    let cursor = first.body.nextCursor as string | null;
    while (cursor) {
      const next = await call('get', `/api/rooms?limit=1&cursor=${encodeURIComponent(cursor)}`);
      expect(next.status).toBe(200);
      expect(MyRoomPage.parse(next.body)).toStrictEqual(next.body);
      seen.push(...MyRoomPage.parse(next.body).data.map((r) => r.room.id));
      cursor = next.body.nextCursor as string | null;
    }
    expect(seen).toEqual(ids);
  });

  it('accepts a leap day in a cursor', async () => {
    world.myRooms = [myRoomRow(ids[1] as string, T0)];
    const leap = '2028-02-29T10:00:00.5+00:00';
    const cursor = Buffer.from(JSON.stringify([leap, ids[0]])).toString('base64url');
    const res = await call('get', `/api/rooms?cursor=${cursor}`);
    expect(res.status).toBe(200);
    expect(String(firstArg(queriesOn('room_members')[0] as RecordedQuery, 'or'))).toContain(`joined_at.gt."${leap}"`);
  });

  it('accepts a cursor with an uppercase room id and lowercases it in the filter', async () => {
    world.myRooms = [myRoomRow(ids[1] as string, T0)];
    const cursor = Buffer.from(JSON.stringify([T0, (ids[0] as string).toUpperCase()])).toString('base64url');
    const res = await call('get', `/api/rooms?cursor=${cursor}`);
    expect(res.status).toBe(200);
    expect(firstArg(queriesOn('room_members')[0] as RecordedQuery, 'or')).toBe(
      `joined_at.gt."${T0}",and(joined_at.eq."${T0}",room_id.gt.${ids[0] as string})`,
    );
  });

  it('uses inner joins for the membership lookup and the list, so deleted rooms are dropped, not returned as null', async () => {
    buildWorld('member');
    await call('get', `/api/rooms/${ROOM_ID}`);
    await call('get', '/api/rooms');
    const selects = queriesOn('room_members').map((q) => String(firstArg(q, 'select')));
    expect(selects.find((c) => c.startsWith('role, rooms'))).toContain('rooms!inner(');
    expect(selects.find((c) => c.startsWith('role, joined_at, room_id'))).toContain('rooms!inner(');
  });

  it('(fake fidelity) returns rooms: null for a filtered-out room when a query omits !inner', () => {
    buildWorld('owner');
    world.rooms[0] = roomRow({ deleted_at: T0 });
    world.myRooms = [myRoomRow(ids[0] as string, T0, { deleted_at: T0 })];
    const membership: RecordedQuery = {
      table: 'room_members',
      calls: [
        ['select', ['role, rooms(id)']],
        ['eq', ['room_id', ROOM_ID]],
        ['eq', ['user_id', world.me]],
        ['is', ['rooms.deleted_at', null]],
      ],
    };
    expect(roomMembersSelect(membership).data).toStrictEqual({ role: 'owner', rooms: null });
    const list: RecordedQuery = {
      table: 'room_members',
      calls: [
        ['select', ['role, joined_at, room_id, rooms(id)']],
        ['is', ['rooms.deleted_at', null]],
      ],
    };
    expect(roomMembersSelect(list).data).toStrictEqual([{ ...world.myRooms[0], rooms: null }]);
  });

  it('returns a generic 500 when the list query fails', async () => {
    world.failTable = { table: 'room_members', error: { code: 'XX000', message: 'db down', details: DB_DETAILS } };
    const res = await call('get', '/api/rooms');
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toContain('db down');
  });
});

// ---------------------------------------------------------------------------
// GET /api/rooms/:roomId
// ---------------------------------------------------------------------------

describe('GET /api/rooms/:roomId', () => {
  it('sorts channels text first then by position, excluding deleted ones, and picks the default text channel', async () => {
    buildWorld('member');
    world.channels = [
      channelRow(VOICE2_ID, 'voice', 'voice-2', 1),
      channelRow(RANDOM_ID, 'text', 'random', 2),
      channelRow(VOICE_ID, 'voice', 'voice', 0),
      channelRow(GENERAL_ID, 'text', 'general', 1),
      channelRow(DELETED_TEXT_ID, 'text', 'old', 0, true),
    ];
    const res = await call('get', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(RoomDetail.parse(res.body)).toStrictEqual(res.body);
    expect(RoomDetail.parse(res.body).channels.map((c) => c.id)).toEqual([GENERAL_ID, RANDOM_ID, VOICE_ID, VOICE2_ID]);
    expect(res.body.defaultChannelId).toBe(GENERAL_ID);
    expect(res.text).not.toContain(DELETED_TEXT_ID);
  });

  it('returns defaultChannelId null when there is no live text channel', async () => {
    buildWorld('member');
    world.channels = [channelRow(VOICE_ID, 'voice', 'voice', 0), channelRow(DELETED_TEXT_ID, 'text', 'old', 0, true)];
    const res = await call('get', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.defaultChannelId).toBeNull();
    expect(RoomDetail.parse(res.body)).toStrictEqual(res.body);
  });

  it('sorts members owner, admins, members, each by name case-insensitively', async () => {
    buildWorld('member');
    const zed = 'ab000000-0000-4000-8000-000000000001';
    const amy = 'ab000000-0000-4000-8000-000000000002';
    world.members.push(memberRow(zed, 'admin', 'zed'), memberRow(amy, 'member', 'Amy'));
    const res = await call('get', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(200);
    expect(RoomDetail.parse(res.body).members.map((m) => m.user.displayName)).toEqual([
      'Olivia',
      'Adam',
      'zed',
      'Amy',
      'Me',
      'Mia',
    ]);
    expect(RoomDetail.parse(res.body).members.map((m) => m.role)).toEqual([
      'owner',
      'admin',
      'admin',
      'member',
      'member',
      'member',
    ]);
    // Only this room's members.
    expect(res.body.members).toHaveLength(6);
    expect(RoomDetail.parse(res.body)).toStrictEqual(res.body);
  });

  it.each([
    ['http', 'http://avatars.steamstatic.com/a.jpg'],
    ['javascript:', 'javascript:alert(1)'],
    ['garbage', 'not a url'],
  ])('returns avatarUrl null for a stored %s avatar instead of failing', async (_name, avatar) => {
    buildWorld('member');
    world.members.push(memberRow('ab000000-0000-4000-8000-000000000009', 'member', 'Bad Avatar', avatar));
    const res = await call('get', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(200);
    const bad = (res.body.members as { user: { displayName: string; avatarUrl: string | null } }[]).find(
      (m) => m.user.displayName === 'Bad Avatar',
    );
    expect(bad?.user.avatarUrl).toBeNull();
    expect(res.text).not.toContain(avatar);
    expect(RoomDetail.parse(res.body)).toStrictEqual(res.body);
  });

  it('serves an image icon as the signed URL and never exposes icon_path', async () => {
    buildWorld('member');
    const iconPath = `${ROOM_ID}/SECRET-ICON-PATH.png`;
    world.rooms[0] = roomRow({ icon_emoji: null, icon_path: iconPath });
    results.signUrls = (paths) => ({
      data: paths.map((path) => ({ path, signedUrl: 'https://cdn.test/opaque?token=abc', error: null })),
      error: null,
    });
    const res = await call('get', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.room.icon).toStrictEqual({ kind: 'image', url: 'https://cdn.test/opaque?token=abc' });
    expect(res.text).not.toContain('SECRET-ICON-PATH');
    expect(res.text).not.toMatch(/icon_?path/i);
    expect(storageCalls).toEqual([{ bucket: 'room-icons', paths: [iconPath], expiresIn: 3600 }]);
    expect(logLines.join('')).not.toContain('SECRET-ICON-PATH');
    expect(logLines.join('')).not.toContain('token=abc');
    expect(RoomDetail.parse(res.body)).toStrictEqual(res.body);
  });

  it.each<[string, (paths: string[]) => ReturnType<typeof results.signUrls>]>([
    ['the storage call errors', () => ({ data: null, error: { message: 'bucket gone' } })],
    ['the item errors', (paths) => ({ data: paths.map((path) => ({ path, signedUrl: '', error: 'Object not found' })), error: null })],
    [
      'the signed URL is not https',
      (paths) => ({ data: paths.map((path) => ({ path, signedUrl: 'http://cdn.test/x', error: null })), error: null }),
    ],
    ['the storage call throws', () => Promise.reject(new Error('network'))],
  ])('falls back to an emoji icon when %s', async (_name, signUrls) => {
    buildWorld('member');
    const iconPath = `${ROOM_ID}/SECRET-ICON-PATH.png`;
    world.rooms[0] = roomRow({ icon_emoji: null, icon_path: iconPath });
    results.signUrls = signUrls;
    const res = await call('get', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.room.icon).toStrictEqual({ kind: 'emoji', emoji: '💬' });
    expect(res.text).not.toContain('SECRET-ICON-PATH');
    expect(logLines.join('')).not.toContain('SECRET-ICON-PATH');
    expect(RoomDetail.parse(res.body)).toStrictEqual(res.body);
  });

  it('does not call storage for emoji-only rooms', async () => {
    buildWorld('member');
    const res = await call('get', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.room.icon).toStrictEqual({ kind: 'emoji', emoji: '🎮' });
    expect(storageCalls).toHaveLength(0);
  });

  it.each(['rooms', 'channels'])('returns a generic 500 when the %s read fails', async (table) => {
    buildWorld('member');
    world.failTable = { table, error: { code: 'XX000', message: 'db down', details: DB_DETAILS, hint: 'HINTVALUE' } };
    const res = await call('get', `/api/rooms/${ROOM_ID}`);
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toContain('db down');
  });
});

// ---------------------------------------------------------------------------
// Broadcasts and LiveKit
// ---------------------------------------------------------------------------

describe('PATCH /api/rooms/:roomId: broadcasts', () => {
  it('broadcasts exactly one room:updated to room:<id> with the updated Room, before reading the response', async () => {
    buildWorld('admin');
    const res = await call('patch', `/api/rooms/${ROOM_ID}`, {
      body: { name: 'Saturday Raids', icon: { kind: 'emoji', emoji: '🐉' } },
    });
    expect(res.status).toBe(200);

    const sent = sentBroadcasts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toStrictEqual({
      topic: `room:${ROOM_ID}`,
      event: 'room:updated',
      payload: { room: res.body.room },
      private: true,
    });
    expect(serverEvents.room['room:updated'].parse(sent[0]?.payload)).toStrictEqual(sent[0]?.payload);
    expect(res.body.room).toStrictEqual({
      id: ROOM_ID,
      name: 'Saturday Raids',
      icon: { kind: 'emoji', emoji: '🐉' },
      createdAt: T0,
    });
    expect(JSON.stringify(sent)).not.toMatch(/icon_?path|updated_?at|deleted_?at/i);

    // The broadcast goes out before the detail read (channels are only read for the response).
    const channelIndex = fakeDb.from.mock.calls.findIndex(([table]) => table === 'channels');
    const channelReadAt = fakeDb.from.mock.invocationCallOrder[channelIndex] as number;
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(channelReadAt);
  });

  it('still broadcasts room:updated when the detail read after the committed update fails (500)', async () => {
    buildWorld('owner');
    world.failTable = { table: 'channels', error: { code: 'XX000', message: 'db down', details: DB_DETAILS } };
    const res = await call('patch', `/api/rooms/${ROOM_ID}`, { body: { name: 'After Commit' } });
    expectError(res, 500, 'INTERNAL');
    expect(rpcCalls('update_room')).toHaveLength(1);
    const sent = sentBroadcasts();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.event).toBe('room:updated');
    expect(sent[0]?.payload).toStrictEqual({
      room: { id: ROOM_ID, name: 'After Commit', icon: { kind: 'emoji', emoji: '🎮' }, createdAt: T0 },
    });
  });

  it('broadcasts a signed image icon built from the returned row, never icon_path', async () => {
    buildWorld('owner');
    const iconPath = `${ROOM_ID}/SECRET-ICON-PATH.png`;
    world.rooms[0] = roomRow({ icon_emoji: null, icon_path: iconPath });
    const res = await call('patch', `/api/rooms/${ROOM_ID}`, { body: { name: 'Pictured' } });
    expect(res.status).toBe(200);
    const [sent] = sentBroadcasts();
    expect(sent?.payload).toStrictEqual({
      room: {
        id: ROOM_ID,
        name: 'Pictured',
        icon: { kind: 'image', url: `https://storage.test/sign/${iconPath}?token=signed` },
        createdAt: T0,
      },
    });
    expect(JSON.stringify(sent)).not.toMatch(/icon_?path/i);
  });

  it.each<[string, unknown]>([
    ['no row', null],
    ['a row without an id', { name: 'x', icon_emoji: '🎮', icon_path: null, created_at: T0 }],
  ])('returns a generic 500 and broadcasts nothing when update_room returns %s', async (_name, data) => {
    buildWorld('owner');
    results.rpcByName.update_room = { data, error: null };
    expectError(await call('patch', `/api/rooms/${ROOM_ID}`, { body: { name: 'x' } }), 500, 'INTERNAL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('broadcasts nothing when the rpc fails with an unmapped error (500)', async () => {
    buildWorld('owner');
    results.rpcByName.update_room = rpcError('XX000');
    expectError(await call('patch', `/api/rooms/${ROOM_ID}`, { body: { name: 'x' } }), 500, 'INTERNAL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still returns 200 when the broadcast is rejected (best-effort, the write committed)', async () => {
    buildWorld('owner');
    fetchMock.mockImplementation(() => Promise.reject(new Error('realtime down')));
    const res = await call('patch', `/api/rooms/${ROOM_ID}`, { body: { name: 'x' } });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('DELETE /api/rooms/:roomId: broadcasts and LiveKit', () => {
  function deleteWorld(): void {
    buildWorld('owner');
    world.channels = [
      channelRow(GENERAL_ID, 'text', 'general', 0),
      channelRow(VOICE_ID, 'voice', 'voice', 0),
      channelRow(VOICE2_ID, 'voice', 'voice-2', 1),
      channelRow(DELETED_VOICE_ID, 'voice', 'old', 2, true),
    ];
  }

  it('broadcasts room:deleted once, member:removed to every member, and ends each live voice room', async () => {
    deleteWorld();
    const res = await call('delete', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(204);

    const sent = sentBroadcasts();
    const roomEvents = sent.filter((b) => b.topic.startsWith('room:'));
    expect(roomEvents).toStrictEqual([
      { topic: `room:${ROOM_ID}`, event: 'room:deleted', payload: { id: ROOM_ID }, private: true },
    ]);
    const removed = sent.filter((b) => b.event === 'member:removed');
    expect(removed.map((b) => b.topic).sort()).toEqual(
      [world.me, ADMIN_ID, MEMBER_ID].map((id) => `user:${id}`).sort(),
    );
    for (const b of removed) {
      expect(b.payload).toStrictEqual({ roomId: ROOM_ID });
      expect(serverEvents.user['member:removed'].parse(b.payload)).toStrictEqual(b.payload);
    }
    expect(sent).toHaveLength(4);
    // OTHER_ROOM_ID's owner is not a member here and is not told anything.
    expect(sent.map((b) => b.topic)).not.toContain(`user:${OWNER_ID}`);

    expect(livekit.deleteRoom.mock.calls.map(([name]) => name).sort()).toEqual(
      [`voice_${VOICE_ID}`, `voice_${VOICE2_ID}`].sort(),
    );
  });

  it('reads voice channels before delete_room (it soft-deletes them) and members after it commits', async () => {
    deleteWorld();
    expect((await call('delete', `/api/rooms/${ROOM_ID}`)).status).toBe(204);
    const rpcAt = fakeDb.rpc.mock.invocationCallOrder[0] as number;
    const at = (pick: (q: RecordedQuery) => boolean) =>
      queries.flatMap((q, i) => (pick(q) ? [fakeDb.from.mock.invocationCallOrder[i] as number] : []));

    const voiceReads = at((q) => q.table === 'channels');
    expect(voiceReads).toHaveLength(1);
    expect(voiceReads[0]).toBeLessThan(rpcAt);
    const voiceQuery = queriesOn('channels')[0];
    expect(voiceQuery?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    expect(voiceQuery?.calls).toContainEqual(['eq', ['type', 'voice']]);
    expect(voiceQuery?.calls).toContainEqual(['is', ['deleted_at', null]]);

    const memberReads = at((q) => q.table === 'room_members' && firstArg(q, 'select') === 'user_id');
    expect(memberReads).toHaveLength(1);
    expect(memberReads[0]).toBeGreaterThan(rpcAt);
    const memberQuery = queriesOn('room_members').find((q) => firstArg(q, 'select') === 'user_id');
    expect(memberQuery?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
  });

  it.each<[string, () => void]>([
    ['LiveKit rejects', () => livekit.deleteRoom.mockRejectedValue(new Error('network down'))],
    ['every broadcast is rejected', () => fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 })))],
    ['broadcast fetch throws', () => fetchMock.mockImplementation(() => Promise.reject(new Error('network')))],
  ])('still returns 204 when %s (the delete has committed)', async (_name, arrange) => {
    deleteWorld();
    arrange();
    const res = await call('delete', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(204);
    expect(livekit.deleteRoom).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['HX001 (404)', rpcError('HX001')],
    ['an unmapped error (500)', rpcError('XX000')],
  ])('sends no broadcast and makes no LiveKit call when delete_room fails with %s', async (_name, error) => {
    deleteWorld();
    results.rpcByName.delete_room = error;
    const res = await call('delete', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
  });

  it('still returns 204, sends room:deleted, and ends voice rooms when the post-delete member read fails', async () => {
    deleteWorld();
    const original = results.selectByTable.room_members as (q: RecordedQuery) => DbResult;
    results.selectByTable.room_members = (q) =>
      firstArg(q, 'select') === 'user_id'
        ? { data: null, error: { code: 'XX000', message: 'SECRET-DB-MESSAGE', details: DB_DETAILS } }
        : original(q);
    const res = await call('delete', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(204);
    expect(rpcCalls('delete_room')).toHaveLength(1);
    expect(sentBroadcasts()).toStrictEqual([
      { topic: `room:${ROOM_ID}`, event: 'room:deleted', payload: { id: ROOM_ID }, private: true },
    ]);
    expect(livekit.deleteRoom).toHaveBeenCalledTimes(2);
    const [warning] = logsAt(40, 'could not list members of deleted room');
    expect(warning).toMatchObject({ roomId: ROOM_ID, dbCode: 'XX000' });
    expect(logLines.join('')).not.toContain('SECRET-DB-MESSAGE');
  });

  it('does not delete when the pre-delete voice channel read fails', async () => {
    deleteWorld();
    world.failTable = { table: 'channels', error: { code: 'XX000', message: 'db down' } };
    const res = await call('delete', `/api/rooms/${ROOM_ID}`);
    expectError(res, 500, 'INTERNAL');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
  });

  it.each([
    ['a Twirp not_found', new ServerError('not_found', 'requested room does not exist', 404, 'not_found')],
    ['an HTTP 404 without a code', new ServerError('Not Found', 'not found', 404)],
  ])('logs %s from LiveKit (room never joined) at debug, not warn', async (_name, err) => {
    deleteWorld();
    livekit.deleteRoom.mockRejectedValue(err);
    expect((await call('delete', `/api/rooms/${ROOM_ID}`)).status).toBe(204);
    expect(logsAt(20, 'no LiveKit room to end')).toHaveLength(2);
    expect(logsAt(40, 'could not end LiveKit room')).toHaveLength(0);
  });

  it.each([
    ['a LiveKit server error', new ServerError('internal', 'boom', 500, 'internal')],
    ['a permission error', new ServerError('permission_denied', 'no', 403, 'permission_denied')],
    ['a network error', new Error('fetch failed')],
  ])('logs %s at warn', async (_name, err) => {
    deleteWorld();
    livekit.deleteRoom.mockRejectedValue(err);
    expect((await call('delete', `/api/rooms/${ROOM_ID}`)).status).toBe(204);
    expect(logsAt(40, 'could not end LiveKit room')).toHaveLength(2);
    expect(logsAt(20, 'no LiveKit room to end')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Secrets in logs and responses
// ---------------------------------------------------------------------------

describe('rooms: secrets', () => {
  it('never logs or returns the session token, service key, or DB details across a full create/read/update/delete', async () => {
    buildWorld('owner');
    results.rpcByName.create_room = { data: ROOM_ID, error: null };
    const bodies: string[] = [];
    bodies.push((await call('post', '/api/rooms', { body: { name: 'Raid', icon: { kind: 'emoji', emoji: '🎮' } } })).text);
    bodies.push((await call('get', '/api/rooms')).text);
    bodies.push((await call('get', `/api/rooms/${ROOM_ID}`)).text);
    bodies.push((await call('patch', `/api/rooms/${ROOM_ID}`, { body: { name: 'Raid 2' } })).text);
    results.rpcByName.delete_room = rpcError('XX000');
    bodies.push((await call('delete', `/api/rooms/${ROOM_ID}`)).text);

    const logs = logLines.join('');
    expect(logs.length).toBeGreaterThan(0);
    for (const text of [...bodies, logs, JSON.stringify(sentBroadcasts())]) {
      expect(text).not.toContain(world.token);
      expect(text).not.toContain('test-service-role-key');
      expect(text).not.toContain('ROWVALUE-DETAILS');
      expect(text).not.toContain('HINTVALUE');
    }
    for (const body of bodies) expect(body).not.toContain('SECRET-DB-MESSAGE');
  });
});
