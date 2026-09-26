import { randomUUID } from 'node:crypto';
import type * as PinoModule from 'pino';
import type * as LivekitModule from '../src/lib/livekit.js';
import { ServerError } from 'livekit-server-sdk';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, firstArg, queries, resetFakeDb, results, type DbResult, type RecordedQuery } from './helpers/fakeDb.js';

/*
 * Channel management (POST /api/rooms/:roomId/channels, PUT /api/rooms/:roomId/channels/order,
 * PATCH/DELETE /api/channels/:channelId) through the real app, offline. The database is faked
 * at the supabase-js client with an in-memory "world" whose reads honour only the filters the
 * services actually pass (and PostgREST's `!inner` embed semantics), so a dropped filter shows
 * up as a leak. The channel functions are faked with the semantics and SQLSTATEs of
 * supabase/migrations/20260925231826_channels_management.sql. Broadcasts are observed at the
 * Realtime REST fetch boundary (so broadcast.ts's schema check runs), LiveKit at
 * livekitRooms.deleteRoom. Every log line (LOG_LEVEL=trace) is captured and checked.
 */

const logLines = vi.hoisted<string[]>(() => []);
const livekit = vi.hoisted(() => ({
  deleteRoom: vi.fn<(name: string) => Promise<void>>(),
  listParticipants: vi.fn<(room: string) => Promise<{ identity: string }[]>>(),
  // Typed with the options argument so tests can assert it is never passed.
  removeParticipant: vi.fn<(room: string, identity: string, options?: { revokeTokenTs?: bigint }) => Promise<void>>(),
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
  livekitRooms: {
    deleteRoom: livekit.deleteRoom,
    listParticipants: livekit.listParticipants,
    removeParticipant: livekit.removeParticipant,
  },
}));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

const savedEnv = { LOG_LEVEL: process.env.LOG_LEVEL };
process.env.LOG_LEVEL = 'trace';

const { createApp } = await import('../src/app.js');
const { newRandomToken, SESSION_COOKIE } = await import('../src/lib/session.js');
const { Channel } = await import('../src/contracts/http/rooms.js');
const { ChannelList } = await import('../src/contracts/http/channels.js');
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
const GENERAL_ID = 'c0000000-0000-4000-8000-00000000000a';
const RANDOM_ID = 'c0000000-0000-4000-8000-00000000000b';
const VOICE_ID = 'c0000000-0000-4000-8000-00000000000c';
const VOICE2_ID = 'c0000000-0000-4000-8000-00000000000d';
const DELETED_TEXT_ID = 'c0000000-0000-4000-8000-00000000000e';
const OTHER_CHANNEL_ID = 'c0000000-0000-4000-8000-00000000000f';
const NEW_CHANNEL_ID = 'c0000000-0000-4000-8000-0000000000aa';
const T0 = '2026-09-01T10:00:00.123456+00:00';
const T1 = '2026-09-26T10:00:00.000001+00:00';

type Role = 'owner' | 'admin' | 'member';
type ChannelType = 'text' | 'voice';

interface RoomRow {
  id: string;
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
}

interface World {
  me: string;
  token: string;
  rooms: RoomRow[];
  channels: ChannelRow[];
  members: MemberRow[];
  failChannelsRead?: boolean;
  /** Replaces the channel lookup's result (e.g. a row whose embedded room is null). */
  channelsReadResult?: DbResult;
}

let world: World;

function channelRow(id: string, type: ChannelType, name: string, position: number, roomId = ROOM_ID): ChannelRow {
  return { id, room_id: roomId, type, name, position, created_at: T0, deleted_at: null };
}

/** ROOM_ID with two text and two voice channels (and one deleted text channel); `me` has `myRole` (null: not a member). */
function buildWorld(myRole: Role | null): void {
  const me = world.me;
  world.rooms = [
    { id: ROOM_ID, deleted_at: null },
    { id: OTHER_ROOM_ID, deleted_at: null },
  ];
  world.channels = [
    channelRow(GENERAL_ID, 'text', 'general', 0),
    channelRow(RANDOM_ID, 'text', 'random', 1),
    channelRow(VOICE_ID, 'voice', 'lounge', 0),
    channelRow(VOICE2_ID, 'voice', 'raid', 1),
    { ...channelRow(DELETED_TEXT_ID, 'text', 'old', 2), deleted_at: T0 },
    channelRow(OTHER_CHANNEL_ID, 'text', 'elsewhere', 0, OTHER_ROOM_ID),
  ];
  const members: MemberRow[] = [
    { room_id: ROOM_ID, user_id: myRole === 'owner' ? me : OWNER_ID, role: 'owner' },
    { room_id: ROOM_ID, user_id: ADMIN_ID, role: 'admin' },
    { room_id: ROOM_ID, user_id: MEMBER_ID, role: 'member' },
    // Someone else's room, where `me` is never a member.
    { room_id: OTHER_ROOM_ID, user_id: OWNER_ID, role: 'owner' },
  ];
  if (myRole && myRole !== 'owner') members.push({ room_id: ROOM_ID, user_id: me, role: myRole });
  world.members = members;
}

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

/** requireRoomMember's lookup: `role, rooms!inner(id)` filtered by room_id, user_id, rooms.deleted_at. */
function roomMembersSelect(query: RecordedQuery): DbResult {
  const columns = String(firstArg(query, 'select'));
  if (!columns.startsWith('role, rooms')) throw new Error(`unexpected room_members select: ${columns}`);
  const row = world.members.find((m) => matches(m, query));
  if (!row) return { data: null, error: null };
  const room = world.rooms.find((r) => r.id === row.room_id);
  const live = room !== undefined && (room.deleted_at === null || !hasCall(query, 'is', 'rooms.deleted_at', null));
  if (live) return { data: { role: row.role, rooms: { id: row.room_id } }, error: null };
  return { data: columns.includes('rooms!inner(') ? null : { role: row.role, rooms: null }, error: null };
}

/**
 * requireChannelMember's lookup, with PostgREST semantics: filters apply only when the service
 * sends them, and a filtered-out embed drops the parent row only when the embed is `!inner`
 * (otherwise it comes back as null / an empty array).
 */
function channelsSelect(query: RecordedQuery): DbResult {
  if (world.failChannelsRead) {
    return { data: null, error: { code: 'XX000', message: 'SECRET-DB-MESSAGE', details: DB_DETAILS, hint: 'HINTVALUE' } };
  }
  if (world.channelsReadResult) return world.channelsReadResult;
  const columns = String(firstArg(query, 'select'));
  if (!/^id, room_id, type, rooms(!inner)?\(room_members(!inner)?\(role\)\)$/.test(columns)) {
    throw new Error(`unexpected channels select: ${columns}`);
  }
  const innerRooms = columns.includes('rooms!inner(');
  const innerMembers = columns.includes('room_members!inner(');
  const userFilter = query.calls.find(([m, a]) => m === 'eq' && a[0] === 'rooms.room_members.user_id')?.[1][1];

  const rows = world.channels
    .filter((c) => matches(c, query))
    .flatMap((c) => {
      const room = world.rooms.find((r) => r.id === c.room_id);
      let embed: { room_members: { role: Role }[] } | null = null;
      if (room && (room.deleted_at === null || !hasCall(query, 'is', 'rooms.deleted_at', null))) {
        const roomMembers = world.members
          .filter((m) => m.room_id === c.room_id && (userFilter === undefined || m.user_id === userFilter))
          .map((m) => ({ role: m.role }));
        embed = roomMembers.length === 0 && innerMembers ? null : { room_members: roomMembers };
      }
      if (embed === null && innerRooms) return [];
      return [{ id: c.id, room_id: c.room_id, type: c.type, rooms: embed }];
    });
  if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
  return { data: rows[0] ?? null, error: null };
}

const DB_SECRET_MESSAGE = 'SECRET-DB-MESSAGE violates check';
const DB_DETAILS = 'Failing row contains (ROWVALUE-DETAILS)';

function rpcError(code: string): DbResult {
  return { data: null, error: { code, message: DB_SECRET_MESSAGE, details: DB_DETAILS, hint: 'HINTVALUE' } };
}

function liveChannels(roomId: string, type?: ChannelType): ChannelRow[] {
  return world.channels.filter((c) => c.room_id === roomId && c.deleted_at === null && (!type || c.type === type));
}

/** The shared checks every channel function makes: live room/channel and membership (HX001), role (HX002). */
function actorCheck(roomId: string | undefined, actor: unknown): DbResult | null {
  const room = world.rooms.find((r) => r.id === roomId && r.deleted_at === null);
  const member = world.members.find((m) => m.room_id === roomId && m.user_id === actor);
  if (!room || !member) return rpcError('HX001');
  if (member.role === 'member') return rpcError('HX002');
  return null;
}

function asRpcRow(c: ChannelRow): Record<string, unknown> {
  return { ...c };
}

function fakeCreateChannel(args: Record<string, unknown>): DbResult {
  const roomId = args.p_room as string;
  const failure = actorCheck(roomId, args.p_actor);
  if (failure) return failure;
  if (liveChannels(roomId).length >= 50) return rpcError('HX006');
  const type = args.p_type as ChannelType;
  const name = args.p_name as string;
  if (liveChannels(roomId, type).some((c) => c.name.toLowerCase() === name.toLowerCase())) return rpcError('23505');
  const row = { ...channelRow(NEW_CHANNEL_ID, type, name, liveChannels(roomId, type).length, roomId), created_at: T1 };
  world.channels.push(row);
  return { data: asRpcRow(row), error: null };
}

function findLiveChannel(id: unknown): ChannelRow | undefined {
  return world.channels.find((c) => c.id === id && c.deleted_at === null);
}

function fakeRenameChannel(args: Record<string, unknown>): DbResult {
  const channel = findLiveChannel(args.p_channel);
  const failure = actorCheck(channel?.room_id, args.p_actor);
  if (failure || !channel) return failure ?? rpcError('HX001');
  const name = args.p_name as string;
  const taken = liveChannels(channel.room_id, channel.type).some(
    (c) => c.id !== channel.id && c.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) return rpcError('23505');
  channel.name = name;
  return { data: asRpcRow(channel), error: null };
}

function fakeReorderChannels(args: Record<string, unknown>): DbResult {
  const roomId = args.p_room as string;
  const failure = actorCheck(roomId, args.p_actor);
  if (failure) return failure;
  const ids = args.p_channel_ids as string[];
  const live = liveChannels(roomId, args.p_type as ChannelType);
  const sameSet = ids.length === live.length && live.every((c) => ids.includes(c.id));
  if (!sameSet) return rpcError('HX007');
  for (const c of live) c.position = ids.indexOf(c.id);
  return { data: [...live].sort((a, b) => a.position - b.position).map(asRpcRow), error: null };
}

function fakeDeleteChannel(args: Record<string, unknown>): DbResult {
  const channel = findLiveChannel(args.p_channel);
  const failure = actorCheck(channel?.room_id, args.p_actor);
  if (failure || !channel) return failure ?? rpcError('HX001');
  if (channel.type === 'text' && liveChannels(channel.room_id, 'text').length === 1) return rpcError('HX008');
  channel.deleted_at = T1;
  return { data: asRpcRow(channel), error: null };
}

function install(): void {
  results.selectByTable.sessions = { data: { id: randomUUID(), profile_id: world.me }, error: null };
  results.selectByTable.room_members = roomMembersSelect;
  results.selectByTable.channels = channelsSelect;
  results.rpcByName.create_channel = fakeCreateChannel;
  results.rpcByName.rename_channel = fakeRenameChannel;
  results.rpcByName.reorder_channels = fakeReorderChannels;
  results.rpcByName.delete_channel = fakeDeleteChannel;
}

type Method = 'post' | 'put' | 'patch' | 'delete';

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

const createPath = (roomId = ROOM_ID) => `/api/rooms/${roomId}/channels`;
const orderPath = (roomId = ROOM_ID) => `/api/rooms/${roomId}/channels/order`;
const channelPath = (channelId: string) => `/api/channels/${channelId}`;

const createBody = { type: 'text', name: 'strategy' };
const renameBody = { name: 'lobby' };
const reorderBody = { type: 'text', channelIds: [RANDOM_ID, GENERAL_ID] };

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

/** Asserts exactly one broadcast, on room:<ROOM_ID>, whose payload passes the event schema; returns its payload. */
function expectOneRoomBroadcast(event: keyof typeof serverEvents.room): unknown {
  const sent = sentBroadcasts();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.topic).toBe(`room:${ROOM_ID}`);
  expect(sent[0]?.event).toBe(event);
  expect(sent[0]?.private).toBe(true);
  expect(serverEvents.room[event].parse(sent[0]?.payload)).toStrictEqual(sent[0]?.payload);
  return sent[0]?.payload;
}

interface LogEntry {
  level: number;
  msg: string;
  [key: string]: unknown;
}

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

function detailPaths(res: request.Response): string[] {
  return [...new Set((res.body.error.details as { path: string }[]).map((d) => d.path))];
}

function expectNoSideEffects(): void {
  expect(fetchMock).not.toHaveBeenCalled();
  expect(livekit.deleteRoom).not.toHaveBeenCalled();
}

beforeEach(() => {
  resetFakeDb();
  logLines.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 202 })));
  livekit.deleteRoom.mockReset();
  livekit.deleteRoom.mockResolvedValue(undefined);
  // Nobody joined by default: LiveKit reports the room not found.
  livekit.listParticipants.mockReset();
  livekit.listParticipants.mockRejectedValue(new ServerError('not_found', 'no room', 404, 'not_found'));
  livekit.removeParticipant.mockReset();
  livekit.removeParticipant.mockResolvedValue(undefined);
  // A fresh user per test also isolates the per-user rate limiter, whose state is module-level.
  world = { me: randomUUID(), token: newRandomToken(), rooms: [], channels: [], members: [] };
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

/** Every channel write, as [label, method, path, body] for an owner of ROOM_ID. */
const allWrites: [string, Method, string, object | undefined][] = [
  ['create', 'post', createPath(), createBody],
  ['rename', 'patch', channelPath(GENERAL_ID), renameBody],
  ['reorder', 'put', orderPath(), reorderBody],
  ['delete', 'delete', channelPath(VOICE_ID), undefined],
];

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('channels: authentication', () => {
  it.each(allWrites)('returns 401 for %s without a session and touches no data', async (_label, method, path, body) => {
    buildWorld('owner');
    const res = await call(method, path, { signedIn: false, body });
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(queries).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Room-scoped routes: create and reorder
// ---------------------------------------------------------------------------

const roomWrites: [string, Method, (roomId: string) => string, object][] = [
  ['create', 'post', createPath, createBody],
  ['reorder', 'put', orderPath, reorderBody],
];

describe('channels: room-scoped access (create, reorder)', () => {
  it.each(roomWrites)('%s returns 404 when a non-member sends it, without calling the rpc', async (_l, method, path, body) => {
    buildWorld(null);
    const res = await call(method, path(ROOM_ID), { body });
    expectError(res, 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
    const [membership] = queriesOn('room_members');
    expect(membership?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    expect(membership?.calls).toContainEqual(['eq', ['user_id', world.me]]);
  });

  it.each(roomWrites)('%s returns the same 404 body for a non-member as for a missing room', async (_l, method, path, body) => {
    buildWorld(null);
    const nonMember = await call(method, path(ROOM_ID), { body });
    const missing = await call(method, path(randomUUID()), { body });
    expect(nonMember.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(nonMember.body).toStrictEqual(missing.body);
  });

  it.each(roomWrites)('%s returns 404 on a deleted room, even for its owner', async (_l, method, path, body) => {
    buildWorld('owner');
    world.rooms[0] = { id: ROOM_ID, deleted_at: T0 };
    expectError(await call(method, path(ROOM_ID), { body }), 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each(roomWrites)('%s returns 404 (not 422) for malformed roomIds without any lookup', async (_l, method, path, body) => {
    buildWorld('owner');
    for (const roomId of ['not-a-uuid', `${ROOM_ID}x`, `${ROOM_ID},user_id.neq.0`, '123']) {
      expectError(await call(method, path(encodeURIComponent(roomId)), { body }), 404, 'NOT_FOUND');
    }
    expect(queriesOn('room_members')).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it.each(roomWrites)('%s returns 403 for a plain member without calling the rpc, even with an invalid body', async (_l, method, path, body) => {
    buildWorld('member');
    expectError(await call(method, path(ROOM_ID), { body }), 403, 'FORBIDDEN');
    expectError(await call(method, path(ROOM_ID), { body: { bogus: true } }), 403, 'FORBIDDEN');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each<[Role]>([['admin'], ['owner']])('lets an %s create and reorder', async (role) => {
    buildWorld(role);
    expect((await call('post', createPath(), { body: createBody })).status).toBe(201);
    expect((await call('put', orderPath(), { body: { type: 'text', channelIds: [RANDOM_ID, GENERAL_ID, NEW_CHANNEL_ID] } })).status).toBe(200);
  });

  it('loses access immediately when removed: the next create is a 404', async () => {
    buildWorld('admin');
    expect((await call('post', createPath(), { body: createBody })).status).toBe(201);
    world.members = world.members.filter((m) => m.user_id !== world.me);
    expectError(await call('post', createPath(), { body: { type: 'text', name: 'again' } }), 404, 'NOT_FOUND');
    expect(rpcCalls('create_channel')).toHaveLength(1);
  });

  it('lowercases an uppercase roomId in the lookup, the rpc, and the broadcast topic', async () => {
    buildWorld('owner');
    const upper = ROOM_ID.toUpperCase();
    expect((await call('post', createPath(upper), { body: createBody })).status).toBe(201);
    expect((await call('put', orderPath(upper), { body: { type: 'voice', channelIds: [VOICE2_ID, VOICE_ID] } })).status).toBe(200);
    for (const q of queriesOn('room_members')) expect(q.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    expect(rpcCalls('create_channel')[0]?.p_room).toBe(ROOM_ID);
    expect(rpcCalls('reorder_channels')[0]?.p_room).toBe(ROOM_ID);
    expect(sentBroadcasts().map((b) => b.topic)).toEqual([`room:${ROOM_ID}`, `room:${ROOM_ID}`]);
  });
});

// ---------------------------------------------------------------------------
// Channel-scoped routes: rename and delete
// ---------------------------------------------------------------------------

const channelWrites: [string, Method, object | undefined][] = [
  ['rename', 'patch', renameBody],
  ['delete', 'delete', undefined],
];

describe('channels: channel-scoped access (rename, delete)', () => {
  it.each(channelWrites)('%s returns 404 (no query) for malformed channelIds', async (_l, method, body) => {
    buildWorld('owner');
    for (const id of ['not-a-uuid', `${GENERAL_ID}x`, `${GENERAL_ID},deleted_at.not.is.null`, '123']) {
      expectError(await call(method, channelPath(encodeURIComponent(id)), { body }), 404, 'NOT_FOUND');
    }
    expect(queriesOn('channels')).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it.each(channelWrites)('%s returns an identical 404 for unknown, deleted, deleted-room, and foreign-room channels', async (_l, method, body) => {
    buildWorld('owner');
    const unknown = await call(method, channelPath(randomUUID()), { body });
    expectError(unknown, 404, 'NOT_FOUND');

    const deleted = await call(method, channelPath(DELETED_TEXT_ID), { body });
    const foreign = await call(method, channelPath(OTHER_CHANNEL_ID), { body });
    world.rooms[0] = { id: ROOM_ID, deleted_at: T0 };
    const deletedRoom = await call(method, channelPath(GENERAL_ID), { body });

    for (const res of [deleted, foreign, deletedRoom]) {
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual(unknown.body);
      expect(res.text).not.toContain('elsewhere');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each(channelWrites)('%s returns 404 for a removed member', async (_l, method, body) => {
    buildWorld('admin');
    world.members = world.members.filter((m) => m.user_id !== world.me);
    expectError(await call(method, channelPath(VOICE_ID), { body }), 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each(channelWrites)('%s returns 403 for a plain member without calling the rpc, even with an invalid body', async (_l, method, body) => {
    buildWorld('member');
    expectError(await call(method, channelPath(VOICE_ID), { body }), 403, 'FORBIDDEN');
    if (body) expectError(await call(method, channelPath(VOICE_ID), { body: {} }), 403, 'FORBIDDEN');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each<[Role]>([['admin'], ['owner']])('lets an %s rename and delete', async (role) => {
    buildWorld(role);
    expect((await call('patch', channelPath(VOICE_ID), { body: renameBody })).status).toBe(200);
    expect((await call('delete', channelPath(VOICE_ID))).status).toBe(204);
  });

  it('filters the lookup by channel id, live channel, live room, and my membership, with inner joins', async () => {
    buildWorld('admin');
    expect((await call('patch', channelPath(GENERAL_ID), { body: renameBody })).status).toBe(200);
    const [lookup] = queriesOn('channels');
    expect(lookup).toBeDefined();
    const select = String(firstArg(lookup as RecordedQuery, 'select'));
    expect(select).toContain('rooms!inner(');
    expect(select).toContain('room_members!inner(');
    expect(lookup?.calls).toContainEqual(['eq', ['id', GENERAL_ID]]);
    expect(lookup?.calls).toContainEqual(['is', ['deleted_at', null]]);
    expect(lookup?.calls).toContainEqual(['is', ['rooms.deleted_at', null]]);
    expect(lookup?.calls).toContainEqual(['eq', ['rooms.room_members.user_id', world.me]]);
  });

  it('(fake fidelity) leaks without the filters or without !inner, so the assertions above are meaningful', () => {
    buildWorld(null);
    world.rooms[0] = { id: ROOM_ID, deleted_at: T0 };
    const unfiltered: RecordedQuery = {
      table: 'channels',
      calls: [
        ['select', ['id, room_id, type, rooms!inner(room_members!inner(role))']],
        ['eq', ['id', DELETED_TEXT_ID]],
      ],
    };
    // No deleted_at / room / membership filters: a deleted channel in a deleted room comes back with a role.
    const leaked = channelsSelect(unfiltered).data as { id: string; rooms: { room_members: { role: Role }[] } };
    expect(leaked.id).toBe(DELETED_TEXT_ID);
    expect(leaked.rooms.room_members[0]?.role).toBe('owner');

    world.rooms[0] = { id: ROOM_ID, deleted_at: null };
    const outer: RecordedQuery = {
      table: 'channels',
      calls: [
        ['select', ['id, room_id, type, rooms(room_members(role))']],
        ['eq', ['id', GENERAL_ID]],
        ['is', ['deleted_at', null]],
        ['is', ['rooms.deleted_at', null]],
        ['eq', ['rooms.room_members.user_id', world.me]],
      ],
    };
    // Without !inner, a non-member still gets the channel row back (with no members).
    expect(channelsSelect(outer).data).toStrictEqual({ id: GENERAL_ID, room_id: ROOM_ID, type: 'text', rooms: { room_members: [] } });
  });

  it('lowercases an uppercase channelId in the lookup, the rpc, the broadcast topic, and the LiveKit room', async () => {
    buildWorld('owner');
    expect((await call('patch', channelPath(VOICE_ID.toUpperCase()), { body: renameBody })).status).toBe(200);
    expect((await call('delete', channelPath(VOICE_ID.toUpperCase()))).status).toBe(204);
    for (const q of queriesOn('channels')) expect(q.calls).toContainEqual(['eq', ['id', VOICE_ID]]);
    expect(rpcCalls('rename_channel')[0]?.p_channel).toBe(VOICE_ID);
    expect(rpcCalls('delete_channel')[0]?.p_channel).toBe(VOICE_ID);
    const sent = sentBroadcasts();
    expect(sent.map((b) => b.topic)).toEqual([`room:${ROOM_ID}`, `room:${ROOM_ID}`]);
    expect(sent[1]?.payload).toStrictEqual({ id: VOICE_ID, roomId: ROOM_ID });
    expect(livekit.deleteRoom.mock.calls).toEqual([[`voice_${VOICE_ID}`]]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a null embedded room', { id: GENERAL_ID, room_id: ROOM_ID, type: 'text', rooms: null }],
    ['a missing embedded room', { id: GENERAL_ID, room_id: ROOM_ID, type: 'text' }],
    ['an empty member list', { id: GENERAL_ID, room_id: ROOM_ID, type: 'text', rooms: { room_members: [] } }],
  ])('returns 404 (not 500) and calls no rpc when the lookup row has %s', async (_l, row) => {
    buildWorld('owner');
    world.channelsReadResult = { data: row, error: null };
    expectError(await call('patch', channelPath(GENERAL_ID), { body: renameBody }), 404, 'NOT_FOUND');
    expectError(await call('delete', channelPath(GENERAL_ID)), 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('still returns a generic 500 when the lookup row is otherwise malformed', async () => {
    buildWorld('owner');
    world.channelsReadResult = { data: { id: 'ROWVALUE', room_id: ROOM_ID, type: 'text', rooms: null }, error: null };
    const res = await call('patch', channelPath(GENERAL_ID), { body: renameBody });
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toContain('ROWVALUE');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('returns a generic 500 and calls no rpc when the channel lookup fails', async () => {
    buildWorld('owner');
    world.failChannelsRead = true;
    const res = await call('patch', channelPath(GENERAL_ID), { body: renameBody });
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe('channels: CSRF', () => {
  it.each(allWrites)('rejects %s from a foreign or missing Origin with 403 ORIGIN_NOT_ALLOWED', async (_l, method, path, body) => {
    buildWorld('owner');
    for (const origin of ['https://evil.example', 'http://localhost:5173.evil.example', 'null', null]) {
      expectError(await call(method, path, { body, origin }), 403, 'ORIGIN_NOT_ALLOWED');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each(allWrites)('rejects %s without a JSON Content-Type with 403 UNSUPPORTED_CONTENT_TYPE', async (_l, method, path, body) => {
    buildWorld('owner');
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) {
      expectError(await call(method, path, { body, contentType }), 403, 'UNSUPPORTED_CONTENT_TYPE');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('rejects a bodiless DELETE with no Content-Type header at all', async () => {
    buildWorld('owner');
    const res = await request(app)
      .delete(channelPath(VOICE_ID))
      .set('Cookie', `${SESSION_COOKIE}=${world.token}`)
      .set('Origin', WEB_ORIGIN);
    expectError(res, 403, 'UNSUPPORTED_CONTENT_TYPE');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const badNames: [string, unknown][] = [
  ['a blank name', ''],
  ['a whitespace-only name', '  \t '],
  ['a 33-character name', 'a'.repeat(33)],
  ['a zero-width-space name', '​'],
  ['a name with a zero-width space inside', 'gen​eral'],
  ['a name with a right-to-left override', 'a‮b'],
  ['a name with a bidi isolate', '⁦x'],
  ['a name with an Arabic letter mark (U+061C)', 'a\u061Cb'],
  ['a name with a soft hyphen inside', 'gen\u00ADeral'],
  ['a name with a Mongolian vowel separator (U+180E)', 'a\u180Eb'],
  ['a name with an interlinear annotation anchor (U+FFF9)', 'a\uFFF9b'],
  ['a name with a stray tag character', 'a\u{E0041}b'],
  ['an emoji followed by a stray tag character', '🎮\u{E0041}'],
  ['a name with a line separator inside', 'a\u2028b'],
  ['a name with a paragraph separator inside', 'a\u2029b'],
  ['a Hangul filler (U+3164) alone', '\u3164'],
  ['a braille blank (U+2800) alone', '\u2800'],
  ['a Hangul choseong filler (U+115F) alone', '\u115F'],
  ['a Hangul filler (U+3164) inside', 'a\u3164b'],
  ['a halfwidth Hangul filler (U+FFA0) alone', '\uFFA0'],
  ['33 characters after NFC', 'e\u0301'.repeat(33)],
  ['a non-string name', 42],
  ['a null name', null],
];

describe('channels: validation', () => {
  it.each(badNames)('POST returns 422 for %s without calling create_channel', async (_l, name) => {
    buildWorld('owner');
    const res = await call('post', createPath(), { body: { type: 'text', name } });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['body.name']);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it.each(badNames)('PATCH returns 422 for %s without calling rename_channel', async (_l, name) => {
    buildWorld('owner');
    const res = await call('patch', channelPath(GENERAL_ID), { body: { name } });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['body.name']);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it.each<[string, Method, () => string, unknown, string[]]>([
    ['POST: an unknown type', 'post', () => createPath(), { type: 'category', name: 'x' }, ['body.type']],
    ['POST: a missing type', 'post', () => createPath(), { name: 'x' }, ['body.type']],
    ['POST: an uppercase type', 'post', () => createPath(), { type: 'TEXT', name: 'x' }, ['body.type']],
    ['POST: an empty body', 'post', () => createPath(), {}, ['body.type', 'body.name']],
    ['POST: an unknown key', 'post', () => createPath(), { type: 'text', name: 'x', position: 0 }, ['body']],
    ['POST: a client-supplied roomId', 'post', () => createPath(), { type: 'text', name: 'x', roomId: OTHER_ROOM_ID }, ['body']],
    ['POST: a non-object body', 'post', () => createPath(), ['text', 'x'], ['body']],
    ['PATCH: a missing name', 'patch', () => channelPath(GENERAL_ID), {}, ['body.name']],
    ['PATCH: a type change', 'patch', () => channelPath(GENERAL_ID), { name: 'x', type: 'voice' }, ['body']],
    ['PATCH: a position', 'patch', () => channelPath(GENERAL_ID), { name: 'x', position: 3 }, ['body']],
    ['PUT: an unknown type', 'put', () => orderPath(), { type: 'all', channelIds: [GENERAL_ID] }, ['body.type']],
    ['PUT: an empty list', 'put', () => orderPath(), { type: 'text', channelIds: [] }, ['body.channelIds']],
    [
      'PUT: 51 channel ids',
      'put',
      () => orderPath(),
      { type: 'text', channelIds: Array.from({ length: 51 }, () => randomUUID()) },
      ['body.channelIds'],
    ],
    ['PUT: a duplicate id', 'put', () => orderPath(), { type: 'text', channelIds: [GENERAL_ID, GENERAL_ID] }, ['body.channelIds']],
    [
      'PUT: a duplicate id differing only in case',
      'put',
      () => orderPath(),
      { type: 'text', channelIds: [GENERAL_ID, GENERAL_ID.toUpperCase()] },
      ['body.channelIds'],
    ],
    ['PUT: a non-uuid id', 'put', () => orderPath(), { type: 'text', channelIds: [GENERAL_ID, 'nope'] }, ['body.channelIds.1']],
    [
      'PUT: a filter injection in an id',
      'put',
      () => orderPath(),
      { type: 'text', channelIds: [`${GENERAL_ID},id.neq.0`] },
      ['body.channelIds.0'],
    ],
    ['PUT: a non-array list', 'put', () => orderPath(), { type: 'text', channelIds: GENERAL_ID }, ['body.channelIds']],
    ['PUT: an unknown key', 'put', () => orderPath(), { ...reorderBody, roomId: OTHER_ROOM_ID }, ['body']],
    ['PUT: a missing list', 'put', () => orderPath(), { type: 'text' }, ['body.channelIds']],
  ])('%s returns 422 with those detail paths and calls no rpc', async (_l, method, path, body, paths) => {
    buildWorld('owner');
    const res = await call(method, path(), { body });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(paths);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each([
    ['surrounding whitespace, trimmed', '  voice-chat \n', 'voice-chat'],
    ['an emoji name', '🔊 lounge', '🔊 lounge'],
    ['a ZWJ emoji sequence', '👨‍👩‍👧 family', '👨‍👩‍👧 family'],
    ['a ZWJ family emoji alone', '👨‍👩‍👧', '👨‍👩‍👧'],
    ['a tag-sequence flag emoji', '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}', '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'],
    ['text plus an emoji', 'Squad 🎮', 'Squad 🎮'],
    ['a composed accented letter', 'Caf\u00E9', 'Caf\u00E9'],
    ['a decomposed accented letter, sent as NFC', 'Cafe\u0301', 'Caf\u00E9'],
    ['a lone decomposed é, sent as the composed form', 'e\u0301', '\u00E9'],
    ['32 characters after NFC (64 code units decomposed)', 'e\u0301'.repeat(32), '\u00E9'.repeat(32)],
    ['exactly 32 characters', 'c'.repeat(32), 'c'.repeat(32)],
    ['32 characters after trimming', ` ${'d'.repeat(32)} `, 'd'.repeat(32)],
  ])('accepts a name with %s on create and rename', async (_l, input, stored) => {
    buildWorld('owner');
    expect((await call('post', createPath(), { body: { type: 'voice', name: input } })).status).toBe(201);
    expect((await call('patch', channelPath(GENERAL_ID), { body: { name: input } })).status).toBe(200);
    expect(rpcCalls('create_channel')[0]?.p_name).toBe(stored);
    expect(rpcCalls('rename_channel')[0]?.p_name).toBe(stored);
  });

  it('accepts exactly 50 channel ids (reaching the rpc)', async () => {
    buildWorld('owner');
    const ids = Array.from({ length: 50 }, () => randomUUID());
    const res = await call('put', orderPath(), { body: { type: 'text', channelIds: ids } });
    expectError(res, 409, 'CHANNEL_ORDER_STALE');
    expect(rpcCalls('reorder_channels')[0]?.p_channel_ids).toEqual(ids);
  });
});

// ---------------------------------------------------------------------------
// RPC error mapping
// ---------------------------------------------------------------------------

describe('channels: rpc error mapping', () => {
  const cases: [string, Method, string, object | undefined, string, string, number, string, string | null][] = [
    // [label, method, path, body, rpc, sqlstate, status, code, 422 detail path]
    ['create', 'post', createPath(), createBody, 'create_channel', 'HX001', 404, 'NOT_FOUND', null],
    ['create', 'post', createPath(), createBody, 'create_channel', 'HX002', 403, 'FORBIDDEN', null],
    ['create', 'post', createPath(), createBody, 'create_channel', 'HX006', 409, 'CHANNEL_LIMIT_REACHED', null],
    ['create', 'post', createPath(), createBody, 'create_channel', '23505', 409, 'CHANNEL_NAME_TAKEN', null],
    ['create', 'post', createPath(), createBody, 'create_channel', '23514', 422, 'VALIDATION_FAILED', 'body.name'],
    ['create', 'post', createPath(), createBody, 'create_channel', '22023', 422, 'VALIDATION_FAILED', 'body.name'],
    ['create', 'post', createPath(), createBody, 'create_channel', 'XX000', 500, 'INTERNAL', null],
    ['rename', 'patch', channelPath(VOICE_ID), renameBody, 'rename_channel', 'HX001', 404, 'NOT_FOUND', null],
    ['rename', 'patch', channelPath(VOICE_ID), renameBody, 'rename_channel', 'HX002', 403, 'FORBIDDEN', null],
    ['rename', 'patch', channelPath(VOICE_ID), renameBody, 'rename_channel', '23505', 409, 'CHANNEL_NAME_TAKEN', null],
    ['rename', 'patch', channelPath(VOICE_ID), renameBody, 'rename_channel', '23514', 422, 'VALIDATION_FAILED', 'body.name'],
    ['rename', 'patch', channelPath(VOICE_ID), renameBody, 'rename_channel', '22023', 422, 'VALIDATION_FAILED', 'body.name'],
    ['rename', 'patch', channelPath(VOICE_ID), renameBody, 'rename_channel', 'XX000', 500, 'INTERNAL', null],
    ['reorder', 'put', orderPath(), reorderBody, 'reorder_channels', 'HX001', 404, 'NOT_FOUND', null],
    ['reorder', 'put', orderPath(), reorderBody, 'reorder_channels', 'HX002', 403, 'FORBIDDEN', null],
    ['reorder', 'put', orderPath(), reorderBody, 'reorder_channels', 'HX007', 409, 'CHANNEL_ORDER_STALE', null],
    ['reorder', 'put', orderPath(), reorderBody, 'reorder_channels', '22023', 422, 'VALIDATION_FAILED', 'body.channelIds'],
    ['reorder', 'put', orderPath(), reorderBody, 'reorder_channels', '23514', 422, 'VALIDATION_FAILED', 'body.channelIds'],
    // No unique constraint is expected from reorder, so 23505 there is a server bug.
    ['reorder', 'put', orderPath(), reorderBody, 'reorder_channels', '23505', 500, 'INTERNAL', null],
    ['reorder', 'put', orderPath(), reorderBody, 'reorder_channels', 'XX000', 500, 'INTERNAL', null],
    ['delete', 'delete', channelPath(VOICE_ID), undefined, 'delete_channel', 'HX001', 404, 'NOT_FOUND', null],
    ['delete', 'delete', channelPath(VOICE_ID), undefined, 'delete_channel', 'HX002', 403, 'FORBIDDEN', null],
    ['delete', 'delete', channelPath(VOICE_ID), undefined, 'delete_channel', 'HX008', 409, 'LAST_TEXT_CHANNEL', null],
    ['delete', 'delete', channelPath(VOICE_ID), undefined, 'delete_channel', '23505', 500, 'INTERNAL', null],
    ['delete', 'delete', channelPath(VOICE_ID), undefined, 'delete_channel', 'XX000', 500, 'INTERNAL', null],
  ];

  it.each(cases)(
    '%s: maps %s/%s %s from the rpc to %i %s, never echoing the DB error, broadcasting, or calling LiveKit',
    async (_l, method, path, body, rpc, sqlstate, status, code, detailPath) => {
      buildWorld('admin');
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

  it('returns 409 CHANNEL_NAME_TAKEN when creating a name taken by a same-type channel, ignoring case', async () => {
    buildWorld('owner');
    const res = await call('post', createPath(), { body: { type: 'text', name: 'GENERAL' } });
    expectError(res, 409, 'CHANNEL_NAME_TAKEN');
    expect(res.body.error.message).toBe('A channel with this name already exists in this room.');
    // The same name in the other type is fine.
    expect((await call('post', createPath(), { body: { type: 'voice', name: 'general' } })).status).toBe(201);
    expect(sentBroadcasts().map((b) => b.event)).toEqual(['channel:created']);
  });

  it('returns 409 CHANNEL_LIMIT_REACHED when the room already has 50 live channels', async () => {
    buildWorld('owner');
    for (let i = 0; i < 46; i++) world.channels.push(channelRow(randomUUID(), 'text', `t${i}`, i + 2));
    expectError(await call('post', createPath(), { body: createBody }), 409, 'CHANNEL_LIMIT_REACHED');
    expectNoSideEffects();
  });

  it('returns 409 CHANNEL_ORDER_STALE for a stale reorder list (a channel missing from it)', async () => {
    buildWorld('owner');
    const res = await call('put', orderPath(), { body: { type: 'text', channelIds: [GENERAL_ID] } });
    expectError(res, 409, 'CHANNEL_ORDER_STALE');
    expect(res.body.error.message).toBe('The channel list changed. Reload and try again.');
    // Including a deleted channel is stale too.
    expectError(
      await call('put', orderPath(), { body: { type: 'text', channelIds: [GENERAL_ID, RANDOM_ID, DELETED_TEXT_ID] } }),
      409,
      'CHANNEL_ORDER_STALE',
    );
    expectNoSideEffects();
  });

  it("returns 409 LAST_TEXT_CHANNEL when deleting the room's only text channel", async () => {
    buildWorld('owner');
    expect((await call('delete', channelPath(RANDOM_ID))).status).toBe(204);
    fetchMock.mockClear();
    const res = await call('delete', channelPath(GENERAL_ID));
    expectError(res, 409, 'LAST_TEXT_CHANNEL');
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

describe('POST /api/rooms/:roomId/channels', () => {
  it('creates the channel as the session user, returns 201 Channel, and broadcasts channel:created once', async () => {
    buildWorld('admin');
    const res = await call('post', createPath(), { body: { type: 'voice', name: '  Raid Night  ' } });
    expect(res.status).toBe(201);
    expect(Channel.parse(res.body)).toStrictEqual(res.body);
    expect(res.body).toStrictEqual({ id: NEW_CHANNEL_ID, roomId: ROOM_ID, type: 'voice', name: 'Raid Night', position: 2 });
    expect(rpcCalls('create_channel')).toEqual([
      { p_room: ROOM_ID, p_actor: world.me, p_type: 'voice', p_name: 'Raid Night' },
    ]);
    expect(expectOneRoomBroadcast('channel:created')).toStrictEqual({ channel: res.body });
    expect(JSON.stringify(sentBroadcasts())).not.toMatch(/created_?at|deleted_?at/i);
    expect(res.text).not.toMatch(/created_?at|deleted_?at/i);
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
  });

  it('still returns 201 when the broadcast is rejected (best-effort, the write committed)', async () => {
    buildWorld('owner');
    fetchMock.mockImplementation(() => Promise.reject(new Error('realtime down')));
    expect((await call('post', createPath(), { body: createBody })).status).toBe(201);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('PATCH /api/channels/:channelId', () => {
  it('renames as the session user, returns 200 Channel, and broadcasts channel:updated once', async () => {
    buildWorld('owner');
    const res = await call('patch', channelPath(RANDOM_ID), { body: { name: ' off-topic ' } });
    expect(res.status).toBe(200);
    expect(Channel.parse(res.body)).toStrictEqual(res.body);
    expect(res.body).toStrictEqual({ id: RANDOM_ID, roomId: ROOM_ID, type: 'text', name: 'off-topic', position: 1 });
    expect(rpcCalls('rename_channel')).toEqual([{ p_channel: RANDOM_ID, p_actor: world.me, p_name: 'off-topic' }]);
    expect(expectOneRoomBroadcast('channel:updated')).toStrictEqual({ channel: res.body });
  });

  it('allows renaming a channel to a different case of its own name', async () => {
    buildWorld('owner');
    expect((await call('patch', channelPath(GENERAL_ID), { body: { name: 'General' } })).status).toBe(200);
  });
});

describe('PUT /api/rooms/:roomId/channels/order', () => {
  it('reorders as the session user, returns 200 ChannelList in the new order, and broadcasts it once', async () => {
    buildWorld('admin');
    const res = await call('put', orderPath(), { body: { type: 'voice', channelIds: [VOICE2_ID.toUpperCase(), VOICE_ID] } });
    expect(res.status).toBe(200);
    expect(ChannelList.parse(res.body)).toStrictEqual(res.body);
    expect(res.body).toStrictEqual({
      data: [
        { id: VOICE2_ID, roomId: ROOM_ID, type: 'voice', name: 'raid', position: 0 },
        { id: VOICE_ID, roomId: ROOM_ID, type: 'voice', name: 'lounge', position: 1 },
      ],
    });
    expect(rpcCalls('reorder_channels')).toEqual([
      { p_room: ROOM_ID, p_actor: world.me, p_type: 'voice', p_channel_ids: [VOICE2_ID, VOICE_ID] },
    ]);
    expect(expectOneRoomBroadcast('channel:reordered')).toStrictEqual({
      roomId: ROOM_ID,
      type: 'voice',
      channelIds: [VOICE2_ID, VOICE_ID],
    });
  });

  it('orders the response and the broadcast by the returned positions, whatever order the rows come in', async () => {
    buildWorld('owner');
    results.rpcByName.reorder_channels = (args) => {
      const out = fakeReorderChannels(args);
      return { ...out, data: [...(out.data as object[])].reverse() };
    };
    const res = await call('put', orderPath(), { body: { type: 'text', channelIds: [RANDOM_ID, GENERAL_ID] } });
    expect(res.status).toBe(200);
    const ids = ChannelList.parse(res.body).data.map((c) => c.id);
    expect(ids).toEqual([RANDOM_ID, GENERAL_ID]);
    expect((expectOneRoomBroadcast('channel:reordered') as { channelIds: string[] }).channelIds).toEqual(ids);
  });
});

describe('DELETE /api/channels/:channelId', () => {
  it('deletes a text channel: 204, channel:deleted once, and no LiveKit call', async () => {
    buildWorld('admin');
    const res = await call('delete', channelPath(RANDOM_ID));
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(rpcCalls('delete_channel')).toEqual([{ p_channel: RANDOM_ID, p_actor: world.me }]);
    expect(expectOneRoomBroadcast('channel:deleted')).toStrictEqual({ id: RANDOM_ID, roomId: ROOM_ID });
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
  });

  it('deletes a voice channel: 204, channel:deleted once, and ends its LiveKit room once', async () => {
    buildWorld('owner');
    expect((await call('delete', channelPath(VOICE_ID))).status).toBe(204);
    expect(expectOneRoomBroadcast('channel:deleted')).toStrictEqual({ id: VOICE_ID, roomId: ROOM_ID });
    expect(livekit.deleteRoom.mock.calls).toEqual([[`voice_${VOICE_ID}`]]);
  });

  it("removes each connected participant (no options, so LiveKit's default token revocation applies) before ending the room", async () => {
    buildWorld('owner');
    livekit.listParticipants.mockResolvedValue([{ identity: MEMBER_ID }, { identity: 'Not-A-Uuid' }, { identity: MEMBER_ID }]);
    expect((await call('delete', channelPath(VOICE_ID))).status).toBe(204);
    expect(livekit.listParticipants.mock.calls).toEqual([[`voice_${VOICE_ID}`]]);
    // Deduped by identity; exactly two arguments, so LiveKit applies its now + 1 minute revocation leeway.
    expect(livekit.removeParticipant.mock.calls).toEqual([
      [`voice_${VOICE_ID}`, MEMBER_ID],
      [`voice_${VOICE_ID}`, 'Not-A-Uuid'],
    ]);
    const lastRemove = Math.max(...livekit.removeParticipant.mock.invocationCallOrder);
    expect(livekit.deleteRoom.mock.invocationCallOrder[0]).toBeGreaterThan(lastRemove);
  });

  it('still ends the room when listing its participants fails, logging a warning', async () => {
    buildWorld('owner');
    livekit.listParticipants.mockRejectedValue(new ServerError('internal', 'boom', 500, 'internal'));
    expect((await call('delete', channelPath(VOICE_ID))).status).toBe(204);
    expect(livekit.removeParticipant).not.toHaveBeenCalled();
    expect(livekit.deleteRoom).toHaveBeenCalledOnce();
    expect(logsAt(40, 'could not list LiveKit participants')).toHaveLength(1);
  });

  it('removes no one from a text channel', async () => {
    buildWorld('owner');
    livekit.listParticipants.mockResolvedValue([{ identity: MEMBER_ID }]);
    expect((await call('delete', channelPath(GENERAL_ID))).status).toBe(204);
    expect(livekit.listParticipants).not.toHaveBeenCalled();
    expect(livekit.removeParticipant).not.toHaveBeenCalled();
  });

  it('returns 404 for a second delete of the same channel, with no rpc call', async () => {
    buildWorld('owner');
    expect((await call('delete', channelPath(VOICE_ID))).status).toBe(204);
    expectError(await call('delete', channelPath(VOICE_ID)), 404, 'NOT_FOUND');
    expect(rpcCalls('delete_channel')).toHaveLength(1);
    expect(livekit.deleteRoom).toHaveBeenCalledOnce();
  });

  it.each<[string, () => void, number, number]>([
    ['LiveKit reports the room not found', () => livekit.deleteRoom.mockRejectedValue(new ServerError('not_found', 'no room', 404, 'not_found')), 20, 1],
    ['LiveKit fails', () => livekit.deleteRoom.mockRejectedValue(new ServerError('internal', 'boom', 500, 'internal')), 40, 1],
    ['LiveKit is unreachable', () => livekit.deleteRoom.mockRejectedValue(new Error('fetch failed')), 40, 1],
    ['the broadcast is rejected with a 500', () => fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 }))), 40, 1],
    ['the broadcast fetch throws', () => fetchMock.mockImplementation(() => Promise.reject(new Error('network'))), 40, 1],
  ])('still returns 204 and does both side effects when %s (the delete committed)', async (_l, arrange, level, count) => {
    buildWorld('owner');
    arrange();
    expect((await call('delete', channelPath(VOICE_ID))).status).toBe(204);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(livekit.deleteRoom).toHaveBeenCalledOnce();
    const logged = logLines.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEntry);
    expect(logged.filter((e) => e.level === level && /LiveKit|broadcast/.test(e.msg))).toHaveLength(count);
  });

  it('logs a LiveKit not-found at debug, not warn', async () => {
    buildWorld('owner');
    livekit.deleteRoom.mockRejectedValue(new ServerError('not_found', 'no room', 404, 'not_found'));
    expect((await call('delete', channelPath(VOICE_ID))).status).toBe(204);
    expect(logsAt(20, 'no LiveKit room to end')).toHaveLength(1);
    expect(logsAt(40, 'could not end LiveKit room')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Malformed rows from the database
// ---------------------------------------------------------------------------

describe('channels: malformed rpc rows', () => {
  const badRow = { room_id: ROOM_ID, type: 'text', name: 'ROWVALUE-NAME', position: 0, created_at: T1 };

  it.each<[string, Method, string, object, string, unknown]>([
    ['create returns a row without an id', 'post', createPath(), createBody, 'create_channel', badRow],
    ['create returns null', 'post', createPath(), createBody, 'create_channel', null],
    ['create returns an unknown type', 'post', createPath(), createBody, 'create_channel', { ...badRow, id: NEW_CHANNEL_ID, type: 'ROWVALUE-TYPE' }],
    ['rename returns a row without an id', 'patch', channelPath(GENERAL_ID), renameBody, 'rename_channel', badRow],
    ['rename returns an array', 'patch', channelPath(GENERAL_ID), renameBody, 'rename_channel', [{ ...badRow, id: GENERAL_ID }]],
    [
      'reorder returns one bad row',
      'put',
      orderPath(),
      reorderBody,
      'reorder_channels',
      [{ ...badRow, id: RANDOM_ID, position: 0 }, badRow],
    ],
    ['reorder returns a non-array', 'put', orderPath(), reorderBody, 'reorder_channels', { ...badRow, id: RANDOM_ID }],
  ])('returns a generic 500 and broadcasts nothing when %s, without logging row values', async (_l, method, path, body, rpc, data) => {
    buildWorld('owner');
    results.rpcByName[rpc] = { data, error: null };
    const res = await call(method, path, { body });
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
    expect(res.text).not.toContain('ROWVALUE');
    expect(logLines.join('')).not.toContain('ROWVALUE');
    expect(logsAt(50, 'internal error')).toHaveLength(1);
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

describe('channels: rate limit', () => {
  it('shares one 60/hour budget across all channel writes per user; 401s do not count; other users are unaffected', async () => {
    buildWorld('owner');
    for (let i = 0; i < 5; i++) {
      expectError(await call('post', createPath(), { body: createBody, signedIn: false }), 401, 'UNAUTHENTICATED');
    }
    for (let i = 0; i < 20; i++) {
      expect((await call('post', createPath(), { body: { type: 'voice', name: `v${i}` } })).status).toBe(201);
      // create_channel's fake always returns the same id; keep the world's channel ids unique.
      const created = world.channels.find((c) => c.id === NEW_CHANNEL_ID);
      if (created) created.id = randomUUID();
    }
    for (let i = 0; i < 20; i++) {
      expect((await call('patch', channelPath(GENERAL_ID), { body: { name: `g${i}` } })).status).toBe(200);
    }
    for (let i = 0; i < 20; i++) {
      expect((await call('put', orderPath(), { body: reorderBody })).status).toBe(200);
    }

    const limited = await call('delete', channelPath(RANDOM_ID));
    expectError(limited, 429, 'RATE_LIMITED');
    expect(rpcCalls('delete_channel')).toHaveLength(0);

    world.me = randomUUID();
    world.token = newRandomToken();
    buildWorld('owner');
    install();
    expect((await call('delete', channelPath(RANDOM_ID))).status).toBe(204);
  });

  it('does not charge the limit for requests rejected by the membership check', async () => {
    buildWorld('member');
    for (let i = 0; i < 61; i++) expectError(await call('delete', channelPath(RANDOM_ID)), 403, 'FORBIDDEN');
    world.members = world.members.map((m) => (m.user_id === world.me ? { ...m, role: 'admin' } : m));
    expect((await call('delete', channelPath(RANDOM_ID))).status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe('channels: secrets', () => {
  it('never logs, returns, or broadcasts the session token, service key, or DB details across every route', async () => {
    buildWorld('owner');
    const texts: string[] = [];
    texts.push((await call('post', createPath(), { body: createBody })).text);
    texts.push((await call('patch', channelPath(GENERAL_ID), { body: renameBody })).text);
    texts.push((await call('put', orderPath(), { body: { type: 'text', channelIds: [RANDOM_ID, GENERAL_ID, NEW_CHANNEL_ID] } })).text);
    texts.push((await call('delete', channelPath(VOICE_ID))).text);
    results.rpcByName.delete_channel = rpcError('XX000');
    texts.push((await call('delete', channelPath(VOICE2_ID))).text);

    const logs = logLines.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).toContain('delete_channel failed');
    for (const text of [...texts, logs, JSON.stringify(sentBroadcasts())]) {
      expect(text).not.toContain(world.token);
      expect(text).not.toContain('test-service-role-key');
      expect(text).not.toContain('ROWVALUE-DETAILS');
      expect(text).not.toContain('HINTVALUE');
    }
    for (const text of texts) expect(text).not.toContain('SECRET-DB-MESSAGE');
  });
});
