import { randomUUID } from 'node:crypto';
import type * as PinoModule from 'pino';
import type * as LivekitModule from '../src/lib/livekit.js';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, firstArg, queries, resetFakeDb, results, type DbResult, type RecordedQuery } from './helpers/fakeDb.js';

/*
 * Messages (POST/GET /api/channels/:channelId/messages, PATCH/DELETE /api/messages/:messageId)
 * through the real app, offline. The database is faked at the supabase-js client with an
 * in-memory "world" whose reads honour only the filters the services actually pass (and
 * PostgREST's `!inner` embed semantics, and the keyset `or`/`gte`/`neq`/`order`/`limit` calls of
 * the list), so a dropped filter shows up as a leak. send_message / edit_message /
 * delete_message are faked with the semantics, return shapes, and SQLSTATEs of
 * supabase/migrations/20260926004614_messages.sql. Broadcasts are observed at the Realtime REST
 * fetch boundary (so broadcast.ts's schema check runs). Every log line (LOG_LEVEL=trace) is
 * captured and checked for secrets, bodies, and Idempotency-Key values.
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
const { Message, MessagePage } = await import('../src/contracts/http/messages.js');
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
const EX_MEMBER_ID = '0f000000-0000-4000-8000-000000000004';
const GENERAL_ID = 'c0000000-0000-4000-8000-00000000000a';
const RANDOM_ID = 'c0000000-0000-4000-8000-00000000000b';
const VOICE_ID = 'c0000000-0000-4000-8000-00000000000c';
const DELETED_TEXT_ID = 'c0000000-0000-4000-8000-00000000000e';
const OTHER_CHANNEL_ID = 'c0000000-0000-4000-8000-00000000000f';
const MY_MSG_ID = 'e0000000-0000-4000-8000-000000000001';
const MEMBER_MSG_ID = 'e0000000-0000-4000-8000-000000000002';
const ORPHAN_MSG_ID = 'e0000000-0000-4000-8000-000000000003';
const DELETED_MSG_ID = 'e0000000-0000-4000-8000-000000000004';
const IN_DELETED_CHANNEL_MSG_ID = 'e0000000-0000-4000-8000-000000000005';
const FOREIGN_MSG_ID = 'e0000000-0000-4000-8000-000000000006';
const RANDOM_MSG_ID = 'e0000000-0000-4000-8000-000000000007';

const BASE_MICROS = Date.parse('2026-09-26T10:00:00Z') * 1000;

/** A timestamp as PostgREST renders timestamptz (microseconds, +00:00). */
function pgTs(micros: number): string {
  const seconds = Math.floor(micros / 1_000_000);
  const frac = String(micros - seconds * 1_000_000).padStart(6, '0');
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${frac}+00:00`;
}

/** Microseconds since the epoch for any ISO timestamp the service or the fake produces. */
function toMicros(ts: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(ts);
  if (!m) throw new Error(`fake db: unparseable timestamp ${ts}`);
  return Date.parse(`${m[1]}${m[3]}`) * 1000 + Number((m[2] ?? '').padEnd(6, '0'));
}

/** BASE plus an offset in milliseconds (and extra microseconds). */
const at = (offsetMs: number, extraMicros = 0) => pgTs(BASE_MICROS + offsetMs * 1000 + extraMicros);

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
  deleted_at: string | null;
}
interface MemberRow {
  room_id: string;
  user_id: string;
  role: Role;
}
interface ProfileRow {
  id: string;
  display_name: string;
  avatar_url: string | null;
}
interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string | null;
  body: string;
  idempotency_key: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

interface World {
  me: string;
  token: string;
  rooms: RoomRow[];
  channels: ChannelRow[];
  members: MemberRow[];
  profiles: ProfileRow[];
  messages: MessageRow[];
  /** Microsecond clock for clock_timestamp() in the fake functions. */
  clock: number;
}

let world: World;

function nextTs(): string {
  world.clock += 1001;
  return pgTs(world.clock);
}

function msg(id: string, channelId: string, authorId: string | null, createdAt: string, extra: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    channel_id: channelId,
    author_id: authorId,
    body: `body of ${id}`,
    idempotency_key: null,
    created_at: createdAt,
    edited_at: null,
    deleted_at: null,
    ...extra,
  };
}

/** ROOM_ID with text/voice/deleted channels and a few messages; `me` has `myRole` (null: not a member). */
function buildWorld(myRole: Role | null): void {
  const me = world.me;
  world.rooms = [
    { id: ROOM_ID, deleted_at: null },
    { id: OTHER_ROOM_ID, deleted_at: null },
  ];
  world.channels = [
    { id: GENERAL_ID, room_id: ROOM_ID, type: 'text', deleted_at: null },
    { id: RANDOM_ID, room_id: ROOM_ID, type: 'text', deleted_at: null },
    { id: VOICE_ID, room_id: ROOM_ID, type: 'voice', deleted_at: null },
    { id: DELETED_TEXT_ID, room_id: ROOM_ID, type: 'text', deleted_at: at(-1000) },
    { id: OTHER_CHANNEL_ID, room_id: OTHER_ROOM_ID, type: 'text', deleted_at: null },
  ];
  const members: MemberRow[] = [
    { room_id: ROOM_ID, user_id: myRole === 'owner' ? me : OWNER_ID, role: 'owner' },
    { room_id: ROOM_ID, user_id: ADMIN_ID, role: 'admin' },
    { room_id: ROOM_ID, user_id: MEMBER_ID, role: 'member' },
    { room_id: OTHER_ROOM_ID, user_id: OWNER_ID, role: 'owner' },
  ];
  if (myRole && myRole !== 'owner') members.push({ room_id: ROOM_ID, user_id: me, role: myRole });
  world.members = members;
  world.profiles = [
    { id: me, display_name: 'Me', avatar_url: 'https://avatars.test/me.jpg' },
    { id: OWNER_ID, display_name: 'Owner', avatar_url: 'https://avatars.test/owner.jpg' },
    { id: ADMIN_ID, display_name: 'Admin', avatar_url: null },
    { id: MEMBER_ID, display_name: 'Member', avatar_url: 'https://avatars.test/member.jpg' },
    { id: EX_MEMBER_ID, display_name: 'Former', avatar_url: 'https://avatars.test/former.jpg' },
  ];
  world.messages = [
    msg(MY_MSG_ID, GENERAL_ID, me, at(-60_000)),
    msg(MEMBER_MSG_ID, GENERAL_ID, MEMBER_ID, at(-50_000)),
    msg(ORPHAN_MSG_ID, GENERAL_ID, null, at(-40_000)),
    msg(DELETED_MSG_ID, GENERAL_ID, me, at(-30_000), { deleted_at: at(-20_000), body: 'ROWVALUE-DELETED-BODY' }),
    msg(IN_DELETED_CHANNEL_MSG_ID, DELETED_TEXT_ID, me, at(-45_000)),
    msg(FOREIGN_MSG_ID, OTHER_CHANNEL_ID, OWNER_ID, at(-45_000)),
    msg(RANDOM_MSG_ID, RANDOM_ID, me, at(-45_000)),
  ];
}

function hasCall(query: RecordedQuery, method: string, ...args: unknown[]): boolean {
  return query.calls.some(([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args));
}

/** Applies eq/is filters to columns the row has; embedded-table filters are handled by callers. */
function matches(row: object, query: RecordedQuery): boolean {
  const record = row as Record<string, unknown>;
  return query.calls.every(([method, args]) => {
    if (method !== 'eq' && method !== 'is') return true;
    const [column, value] = args as [string, unknown];
    return !(column in record) || record[column] === value;
  });
}

function single(rows: unknown[]): DbResult {
  if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
  return { data: rows[0] ?? null, error: null };
}

/** requireChannelMember's lookup (same semantics as tests/channels.test.ts). */
function channelsSelect(query: RecordedQuery): DbResult {
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
  return single(rows);
}

const ACCESS_SELECT = /^id, channel_id, author_id, channels(!inner)?\(room_id, rooms(!inner)?\(room_members(!inner)?\(role\)\)\)$/;
const LIST_SELECT = 'id, channel_id, author_id, body, created_at, edited_at, profiles(id, display_name, avatar_url)';

/**
 * requireMessageMember's lookup, with PostgREST semantics: nested filters apply only when sent,
 * and a filtered-out embed drops the parent row only when it (and each level above) is `!inner`.
 */
function messageAccessSelect(query: RecordedQuery): DbResult {
  const columns = String(firstArg(query, 'select'));
  const innerChannels = columns.includes('channels!inner(');
  const innerRooms = columns.includes('rooms!inner(');
  const innerMembers = columns.includes('room_members!inner(');
  const userFilter = query.calls.find(([m, a]) => m === 'eq' && a[0] === 'channels.rooms.room_members.user_id')?.[1][1];
  const rows = world.messages
    .filter((m) => matches(m, query))
    .flatMap((m) => {
      const channel = world.channels.find((c) => c.id === m.channel_id);
      let channelEmbed: { room_id: string; rooms: { room_members: { role: Role }[] } | null } | null = null;
      if (channel && (channel.deleted_at === null || !hasCall(query, 'is', 'channels.deleted_at', null))) {
        const room = world.rooms.find((r) => r.id === channel.room_id);
        let roomEmbed: { room_members: { role: Role }[] } | null = null;
        if (room && (room.deleted_at === null || !hasCall(query, 'is', 'channels.rooms.deleted_at', null))) {
          const roomMembers = world.members
            .filter((rm) => rm.room_id === room.id && (userFilter === undefined || rm.user_id === userFilter))
            .map((rm) => ({ role: rm.role }));
          roomEmbed = roomMembers.length === 0 && innerMembers ? null : { room_members: roomMembers };
        }
        channelEmbed = roomEmbed === null && innerRooms ? null : { room_id: channel.room_id, rooms: roomEmbed };
      }
      if (channelEmbed === null && innerChannels) return [];
      return [{ id: m.id, channel_id: m.channel_id, author_id: m.author_id, channels: channelEmbed }];
    });
  return single(rows);
}

const OR_FILTER =
  /^created_at\.(lt|gt)\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.(lt|gt)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/;

function compareRows(column: string, a: MessageRow, b: MessageRow): number {
  if (column === 'created_at') return Math.sign(toMicros(a.created_at) - toMicros(b.created_at));
  if (column === 'id') return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  throw new Error(`fake db: unexpected order column ${column}`);
}

/** The history/backfill list: eq/is, gte, neq, the keyset `or`, order, and limit, as sent. */
function messageListSelect(query: RecordedQuery): DbResult {
  let rows = world.messages.filter((m) => matches(m, query));
  for (const [method, args] of query.calls) {
    if (method === 'gte') {
      const [column, value] = args as [string, string];
      if (column !== 'created_at') throw new Error(`fake db: unexpected gte on ${column}`);
      rows = rows.filter((m) => toMicros(m.created_at) >= toMicros(value));
    } else if (method === 'neq') {
      const [column, value] = args as [string, string];
      if (column !== 'id') throw new Error(`fake db: unexpected neq on ${column}`);
      rows = rows.filter((m) => m.id !== value);
    } else if (method === 'or') {
      const parsed = OR_FILTER.exec(String(args[0]));
      if (!parsed) throw new Error(`fake db: unexpected or filter ${String(args[0])}`);
      const [, op, ts, tsEq, idOp, id] = parsed as unknown as [string, 'lt' | 'gt', string, string, 'lt' | 'gt', string];
      if (ts !== tsEq || op !== idOp) throw new Error('fake db: inconsistent keyset filter');
      const t = toMicros(ts);
      rows = rows.filter((m) => {
        const mt = toMicros(m.created_at);
        const before = op === 'lt' ? mt < t : mt > t;
        const tie = mt === t && (idOp === 'lt' ? m.id < id : m.id > id);
        return before || tie;
      });
    } else if (['gt', 'lt', 'lte', 'in', 'range'].includes(method)) {
      throw new Error(`fake db: unexpected ${method} on messages list`);
    }
  }
  const orders = query.calls
    .filter(([m]) => m === 'order')
    .map(([, a]) => a as [string, { ascending?: boolean } | undefined]);
  rows = [...rows].sort((a, b) => {
    for (const [column, options] of orders) {
      const c = compareRows(column, a, b);
      if (c !== 0) return options?.ascending === false ? -c : c;
    }
    return 0;
  });
  const limit = firstArg(query, 'limit');
  if (typeof limit === 'number') rows = rows.slice(0, limit);
  return {
    data: rows.map((m) => ({
      id: m.id,
      channel_id: m.channel_id,
      author_id: m.author_id,
      body: m.body,
      created_at: m.created_at,
      edited_at: m.edited_at,
      profiles: world.profiles.find((p) => p.id === m.author_id) ?? null,
    })),
    error: null,
  };
}

/** The `after` anchor: any message (even deleted) by id and channel. */
function anchorSelect(query: RecordedQuery): DbResult {
  return single(world.messages.filter((m) => matches(m, query)).map((m) => ({ id: m.id, created_at: m.created_at })));
}

function messagesSelect(query: RecordedQuery): DbResult {
  const columns = String(firstArg(query, 'select'));
  if (ACCESS_SELECT.test(columns)) return messageAccessSelect(query);
  if (columns === 'id, created_at') return anchorSelect(query);
  if (columns === LIST_SELECT) return messageListSelect(query);
  throw new Error(`unexpected messages select: ${columns}`);
}

const DB_SECRET_MESSAGE = 'SECRET-DB-MESSAGE violates check';
const DB_DETAILS = 'Failing row contains (ROWVALUE-DETAILS)';

function rpcError(code: string): DbResult {
  return { data: null, error: { code, message: DB_SECRET_MESSAGE, details: DB_DETAILS, hint: 'HINTVALUE' } };
}

const liveRoom = (id: string | undefined) => world.rooms.find((r) => r.id === id && r.deleted_at === null);
const memberOf = (roomId: string, userId: unknown) => world.members.find((m) => m.room_id === roomId && m.user_id === userId);
const bodyOk = (body: string) => Array.from(body).length >= 1 && Array.from(body).length <= 2000 && /\S/.test(body);

/** The author_display_name / author_avatar_url columns send_message and edit_message join in. */
function authorColumns(row: MessageRow): { author_display_name: string | null; author_avatar_url: string | null } {
  const profile = world.profiles.find((p) => p.id === row.author_id);
  return { author_display_name: profile?.display_name ?? null, author_avatar_url: profile?.avatar_url ?? null };
}

/** send_message: returns a one-row array (RETURNS TABLE): message columns, author columns, replayed. */
function fakeSendMessage(args: Record<string, unknown>): DbResult {
  const { p_channel, p_author, p_body } = args as Record<string, string | null | undefined>;
  const p_idempotency_key = (args.p_idempotency_key as string | null | undefined) ?? null;
  if (!p_channel || !p_author || p_body === null || p_body === undefined) return rpcError('22023');
  const channel = world.channels.find((c) => c.id === p_channel);
  if (!channel || !liveRoom(channel.room_id) || channel.deleted_at !== null) return rpcError('HX001');
  if (!memberOf(channel.room_id, p_author)) return rpcError('HX001');
  if (channel.type !== 'text') return rpcError('HX009');
  if (!bodyOk(p_body)) return rpcError('23514');
  if (p_idempotency_key !== null && (p_idempotency_key.length < 1 || p_idempotency_key.length > 128)) return rpcError('23514');
  if (p_idempotency_key !== null) {
    const existing = world.messages.find((m) => m.author_id === p_author && m.idempotency_key === p_idempotency_key);
    if (existing) {
      if (existing.deleted_at !== null || existing.channel_id !== p_channel || existing.body !== p_body) return rpcError('HX010');
      return { data: [{ ...existing, ...authorColumns(existing), replayed: true }], error: null };
    }
  }
  const row = msg(randomUUID(), p_channel, p_author, nextTs(), { body: p_body, idempotency_key: p_idempotency_key ?? null });
  world.messages.push(row);
  return { data: [{ ...row, ...authorColumns(row), replayed: false }], error: null };
}

function lockedMessage(messageId: unknown, actor: unknown): { message: MessageRow; role: Role } | DbResult {
  const message = world.messages.find((m) => m.id === messageId);
  const channel = world.channels.find((c) => c.id === message?.channel_id);
  if (!message || !channel || !liveRoom(channel.room_id)) return rpcError('HX001');
  const member = memberOf(channel.room_id, actor);
  if (!member) return rpcError('HX001');
  if (channel.deleted_at !== null || message.deleted_at !== null) return rpcError('HX001');
  return { message, role: member.role };
}

/** edit_message: returns a one-row array (RETURNS TABLE): the message columns (no key or deleted_at) and author columns. */
function fakeEditMessage(args: Record<string, unknown>): DbResult {
  if (!args.p_message || !args.p_actor || typeof args.p_body !== 'string') return rpcError('22023');
  const found = lockedMessage(args.p_message, args.p_actor);
  if ('error' in found) return found;
  if (found.message.author_id !== args.p_actor) return rpcError('HX002');
  if (!bodyOk(args.p_body)) return rpcError('23514');
  found.message.body = args.p_body;
  found.message.edited_at = nextTs();
  const { id, channel_id, author_id, body, created_at, edited_at } = found.message;
  return {
    data: [{ id, channel_id, author_id, body, created_at, edited_at, ...authorColumns(found.message) }],
    error: null,
  };
}

/** delete_message: soft-deletes and returns the row (body included) as an object. */
function fakeDeleteMessage(args: Record<string, unknown>): DbResult {
  if (!args.p_message || !args.p_actor) return rpcError('22023');
  const found = lockedMessage(args.p_message, args.p_actor);
  if ('error' in found) return found;
  if (found.message.author_id !== args.p_actor && found.role === 'member') return rpcError('HX002');
  found.message.deleted_at = nextTs();
  return { data: { ...found.message }, error: null };
}

function install(): void {
  results.selectByTable.sessions = () => ({ data: { id: randomUUID(), profile_id: world.me }, error: null });
  results.selectByTable.channels = channelsSelect;
  results.selectByTable.messages = messagesSelect;
  results.rpcByName.send_message = fakeSendMessage;
  results.rpcByName.edit_message = fakeEditMessage;
  results.rpcByName.delete_message = fakeDeleteMessage;
}

/** Signs in as a brand-new user (fresh rate-limit budget) with `role` in ROOM_ID. */
function becomeNewUser(role: Role | null): void {
  world.me = randomUUID();
  world.token = newRandomToken();
  buildWorld(role);
  install();
}

type Method = 'get' | 'post' | 'patch' | 'delete';

interface CallOptions {
  body?: unknown;
  signedIn?: boolean;
  origin?: string | null;
  contentType?: string | null;
  headers?: Record<string, string>;
}

/** A request as hideout-web sends it: session cookie, WEB_ORIGIN, JSON content type. */
function call(method: Method, path: string, options: CallOptions = {}) {
  let req = request(app)[method](path);
  if (options.signedIn ?? true) req = req.set('Cookie', `${SESSION_COOKIE}=${world.token}`);
  const origin = options.origin === undefined ? WEB_ORIGIN : options.origin;
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (origin !== null) req = req.set('Origin', origin);
  if (contentType !== null) req = req.set('Content-Type', contentType);
  for (const [name, value] of Object.entries(options.headers ?? {})) req = req.set(name, value);
  return options.body === undefined ? req : req.send(JSON.stringify(options.body));
}

const channelMessagesPath = (channelId: string) => `/api/channels/${channelId}/messages`;
const messagePath = (messageId: string) => `/api/messages/${messageId}`;

const send = (channelId: string, body: unknown, options: Omit<CallOptions, 'body'> = {}) =>
  call('post', channelMessagesPath(channelId), { ...options, body });
const list = (channelId: string, query = '') => call('get', `${channelMessagesPath(channelId)}${query}`, { contentType: null });
const edit = (messageId: string, body: unknown) => call('patch', messagePath(messageId), { body });
const remove = (messageId: string) => call('delete', messagePath(messageId));

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

/** Asserts exactly one broadcast, on channel:<channelId>, whose payload passes the event schema; returns its payload. */
function expectOneChannelBroadcast(event: keyof typeof serverEvents.channel, channelId = GENERAL_ID): unknown {
  const sent = sentBroadcasts();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.topic).toBe(`channel:${channelId}`);
  expect(sent[0]?.event).toBe(event);
  expect(sent[0]?.private).toBe(true);
  expect(serverEvents.channel[event].parse(sent[0]?.payload)).toStrictEqual(sent[0]?.payload);
  return sent[0]?.payload;
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

function rpcCalls(name: string): Record<string, unknown>[] {
  return fakeDb.rpc.mock.calls.filter(([fn]) => fn === name).map(([, args]) => args);
}

function queriesOn(table: string): RecordedQuery[] {
  return queries.filter((q) => q.table === table);
}

function listQueries(): RecordedQuery[] {
  return queriesOn('messages').filter((q) => firstArg(q, 'select') === LIST_SELECT);
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

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

beforeEach(() => {
  resetFakeDb();
  logLines.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 202 })));
  livekit.deleteRoom.mockReset();
  livekit.deleteRoom.mockResolvedValue(undefined);
  // A fresh user per test also isolates the per-user rate limiters, whose state is module-level.
  world = {
    me: randomUUID(),
    token: newRandomToken(),
    rooms: [],
    channels: [],
    members: [],
    profiles: [],
    messages: [],
    clock: BASE_MICROS,
  };
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
  // Message routes never touch LiveKit.
  expect(livekit.deleteRoom).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('messages: authentication', () => {
  it.each<[string, Method, string, object | undefined]>([
    ['send', 'post', channelMessagesPath(GENERAL_ID), { body: 'hi' }],
    ['list', 'get', channelMessagesPath(GENERAL_ID), undefined],
    ['edit', 'patch', messagePath(MY_MSG_ID), { body: 'hi' }],
    ['delete', 'delete', messagePath(MY_MSG_ID), undefined],
  ])('returns 401 for %s without a session and touches no data', async (_l, method, path, body) => {
    buildWorld('owner');
    const res = await call(method, path, { signedIn: false, body });
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(queries).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Channel-scoped access: send and list
// ---------------------------------------------------------------------------

const channelRoutes: [string, (channelId: string) => request.Test][] = [
  ['send', (channelId) => send(channelId, { body: 'hello' })],
  ['list', (channelId) => list(channelId)],
];

describe('messages: channel-scoped access (send, list)', () => {
  it.each(channelRoutes)(
    '%s returns an identical 404 for a non-member, unknown, deleted, deleted-room, and other-room channel',
    async (_l, route) => {
      buildWorld(null);
      const nonMember = await route(GENERAL_ID);
      expectError(nonMember, 404, 'NOT_FOUND');

      buildWorld('owner');
      const others = [
        await route(randomUUID()),
        await route(DELETED_TEXT_ID),
        await route(OTHER_CHANNEL_ID),
        await route('not-a-uuid'),
      ];
      world.rooms[0] = { id: ROOM_ID, deleted_at: at(-1) };
      others.push(await route(GENERAL_ID));

      for (const res of others) {
        expect(res.status).toBe(404);
        expect(res.body).toStrictEqual(nonMember.body);
      }
      expect(queriesOn('messages')).toHaveLength(0);
      expect(fakeDb.rpc).not.toHaveBeenCalled();
      expectNoSideEffects();
    },
  );

  it.each(channelRoutes)('%s returns 404 without any channel lookup for malformed channelIds', async (_l, route) => {
    buildWorld('owner');
    for (const id of ['not-a-uuid', `${GENERAL_ID}x`, `${GENERAL_ID},deleted_at.not.is.null`, '123']) {
      expectError(await route(encodeURIComponent(id)), 404, 'NOT_FOUND');
    }
    expect(queries.filter((q) => q.table !== 'sessions')).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it.each<[Role]>([['owner'], ['admin'], ['member']])('lets an %s send and list', async (role) => {
    buildWorld(role);
    expect((await send(GENERAL_ID, { body: 'hello' })).status).toBe(201);
    expect((await list(GENERAL_ID)).status).toBe(200);
  });

  it('loses access immediately when removed: the next send and list are 404s', async () => {
    buildWorld('member');
    expect((await send(GENERAL_ID, { body: 'first' })).status).toBe(201);
    world.members = world.members.filter((m) => m.user_id !== world.me);
    expectError(await send(GENERAL_ID, { body: 'second' }), 404, 'NOT_FOUND');
    expectError(await list(GENERAL_ID), 404, 'NOT_FOUND');
    expect(rpcCalls('send_message')).toHaveLength(1);
    expect(listQueries()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Message-scoped access: edit and delete
// ---------------------------------------------------------------------------

const messageRoutes: [string, (messageId: string) => request.Test][] = [
  ['edit', (messageId) => edit(messageId, { body: 'changed' })],
  ['delete', (messageId) => remove(messageId)],
];

describe('messages: message-scoped access (edit, delete)', () => {
  it.each(messageRoutes)('%s returns 404 without any message lookup for malformed messageIds', async (_l, route) => {
    buildWorld('owner');
    for (const id of ['not-a-uuid', `${MY_MSG_ID}x`, `${MY_MSG_ID},deleted_at.not.is.null`, '123']) {
      expectError(await route(encodeURIComponent(id)), 404, 'NOT_FOUND');
    }
    expect(queriesOn('messages')).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it.each(messageRoutes)(
    '%s returns an identical 404 for unknown, deleted, deleted-channel, deleted-room, and other-room messages',
    async (_l, route) => {
      buildWorld('owner');
      const unknown = await route(randomUUID());
      expectError(unknown, 404, 'NOT_FOUND');
      const others = [await route(DELETED_MSG_ID), await route(IN_DELETED_CHANNEL_MSG_ID), await route(FOREIGN_MSG_ID)];
      world.rooms[0] = { id: ROOM_ID, deleted_at: at(-1) };
      others.push(await route(MY_MSG_ID));
      for (const res of others) {
        expect(res.status).toBe(404);
        expect(res.body).toStrictEqual(unknown.body);
      }
      expect(fakeDb.rpc).not.toHaveBeenCalled();
      expectNoSideEffects();
    },
  );

  it.each(messageRoutes)('%s returns 404 for a non-member and for a removed author', async (_l, route) => {
    buildWorld(null);
    expectError(await route(MEMBER_MSG_ID), 404, 'NOT_FOUND');
    buildWorld('member');
    world.members = world.members.filter((m) => m.user_id !== world.me);
    expectError(await route(MY_MSG_ID), 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('filters the lookup by message id, live message, live channel, live room, and my membership, with inner joins', async () => {
    buildWorld('member');
    expect((await edit(MY_MSG_ID, { body: 'x' })).status).toBe(200);
    const [lookup] = queriesOn('messages');
    expect(lookup).toBeDefined();
    const select = String(firstArg(lookup as RecordedQuery, 'select'));
    expect(select).toContain('channels!inner(');
    expect(select).toContain('rooms!inner(');
    expect(select).toContain('room_members!inner(');
    expect(lookup?.calls).toContainEqual(['eq', ['id', MY_MSG_ID]]);
    expect(lookup?.calls).toContainEqual(['is', ['deleted_at', null]]);
    expect(lookup?.calls).toContainEqual(['is', ['channels.deleted_at', null]]);
    expect(lookup?.calls).toContainEqual(['is', ['channels.rooms.deleted_at', null]]);
    expect(lookup?.calls).toContainEqual(['eq', ['channels.rooms.room_members.user_id', world.me]]);
  });

  it('(fake fidelity) leaks without the filters or without !inner, so the assertions above are meaningful', () => {
    buildWorld(null);
    world.rooms[0] = { id: ROOM_ID, deleted_at: at(-1) };
    const inner = 'id, channel_id, author_id, channels!inner(room_id, rooms!inner(room_members!inner(role)))';
    // No deleted/room/membership filters: a deleted message in a deleted channel of a deleted room comes back with a role.
    const unfiltered: RecordedQuery = {
      table: 'messages',
      calls: [
        ['select', [inner]],
        ['eq', ['id', IN_DELETED_CHANNEL_MSG_ID]],
      ],
    };
    const leaked = messageAccessSelect(unfiltered).data as { channels: { rooms: { room_members: { role: Role }[] } } };
    expect(leaked.channels.rooms.room_members[0]?.role).toBe('owner');

    const deletedMessage: RecordedQuery = { table: 'messages', calls: [['select', [inner]], ['eq', ['id', DELETED_MSG_ID]]] };
    expect(messageAccessSelect(deletedMessage).data).not.toBeNull();

    world.rooms[0] = { id: ROOM_ID, deleted_at: null };
    const filters: RecordedQuery['calls'] = [
      ['eq', ['id', MEMBER_MSG_ID]],
      ['is', ['deleted_at', null]],
      ['is', ['channels.deleted_at', null]],
      ['is', ['channels.rooms.deleted_at', null]],
      ['eq', ['channels.rooms.room_members.user_id', world.me]],
    ];
    // Fully filtered with !inner: a non-member gets nothing.
    expect(messageAccessSelect({ table: 'messages', calls: [['select', [inner]], ...filters] }).data).toBeNull();
    // Without !inner on the members embed, the non-member still gets the row (with no members).
    const outerMembers = 'id, channel_id, author_id, channels!inner(room_id, rooms!inner(room_members(role)))';
    expect(messageAccessSelect({ table: 'messages', calls: [['select', [outerMembers]], ...filters] }).data).toStrictEqual({
      id: MEMBER_MSG_ID,
      channel_id: GENERAL_ID,
      author_id: MEMBER_ID,
      channels: { room_id: ROOM_ID, rooms: { room_members: [] } },
    });
    // Without !inner on channels, a message in a deleted channel still comes back (with a null channel).
    const outerChannels = 'id, channel_id, author_id, channels(room_id, rooms!inner(room_members!inner(role)))';
    buildWorld('owner');
    const inDeleted: RecordedQuery['calls'] = [
      ['eq', ['id', IN_DELETED_CHANNEL_MSG_ID]],
      ['is', ['deleted_at', null]],
      ['is', ['channels.deleted_at', null]],
    ];
    expect(messageAccessSelect({ table: 'messages', calls: [['select', [outerChannels]], ...inDeleted] }).data).toMatchObject({
      id: IN_DELETED_CHANNEL_MSG_ID,
      channels: null,
    });
  });

  it.each<[Role]>([['member'], ['admin'], ['owner']])(
    "returns 403 without calling edit_message when an %s edits someone else's message, even with an invalid body",
    async (role) => {
      buildWorld(role);
      expectError(await edit(MEMBER_MSG_ID, { body: 'rewritten' }), 403, 'FORBIDDEN');
      expectError(await edit(MEMBER_MSG_ID, { bogus: true }), 403, 'FORBIDDEN');
      expect(fakeDb.rpc).not.toHaveBeenCalled();
      expectNoSideEffects();
    },
  );

  it("returns 403 without calling delete_message when a plain member deletes someone else's message", async () => {
    buildWorld('member');
    world.messages.push(msg(randomUUID(), GENERAL_ID, ADMIN_ID, at(-1)));
    expectError(await remove(world.messages.at(-1)?.id ?? ''), 403, 'FORBIDDEN');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each<[Role]>([['admin'], ['owner']])("lets an %s delete someone else's message", async (role) => {
    buildWorld(role);
    expect((await remove(MEMBER_MSG_ID)).status).toBe(204);
    expect(rpcCalls('delete_message')).toEqual([{ p_message: MEMBER_MSG_ID, p_actor: world.me }]);
  });

  it.each<[Role]>([['member'], ['admin'], ['owner']])('lets an %s author edit and delete their own message', async (role) => {
    buildWorld(role);
    expect((await edit(MY_MSG_ID, { body: 'fixed typo' })).status).toBe(200);
    expect((await remove(MY_MSG_ID)).status).toBe(204);
  });

  it('treats a message whose author profile was deleted as authored by nobody', async () => {
    buildWorld('owner');
    expectError(await edit(ORPHAN_MSG_ID, { body: 'claim it' }), 403, 'FORBIDDEN');
    expect(rpcCalls('edit_message')).toHaveLength(0);

    becomeNewUser('member');
    expectError(await remove(ORPHAN_MSG_ID), 403, 'FORBIDDEN');
    expect(rpcCalls('delete_message')).toHaveLength(0);

    becomeNewUser('admin');
    expect((await remove(ORPHAN_MSG_ID)).status).toBe(204);
    expect(expectOneChannelBroadcast('message:deleted')).toStrictEqual({ id: ORPHAN_MSG_ID, channelId: GENERAL_ID });
  });

  it('lowercases an uppercase messageId in the lookup, the rpc, and the broadcast', async () => {
    buildWorld('member');
    expect((await edit(MY_MSG_ID.toUpperCase(), { body: 'x' })).status).toBe(200);
    expect((await remove(MY_MSG_ID.toUpperCase())).status).toBe(204);
    for (const q of queriesOn('messages')) expect(q.calls).toContainEqual(['eq', ['id', MY_MSG_ID]]);
    expect(rpcCalls('edit_message')[0]?.p_message).toBe(MY_MSG_ID);
    expect(rpcCalls('delete_message')[0]?.p_message).toBe(MY_MSG_ID);
    expect(sentBroadcasts()[1]?.payload).toStrictEqual({ id: MY_MSG_ID, channelId: GENERAL_ID });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a null embedded channel', { id: MY_MSG_ID, channel_id: GENERAL_ID, author_id: null, channels: null }],
    ['a null embedded room', { id: MY_MSG_ID, channel_id: GENERAL_ID, author_id: null, channels: { room_id: ROOM_ID, rooms: null } }],
    ['an empty member list', { id: MY_MSG_ID, channel_id: GENERAL_ID, author_id: null, channels: { room_id: ROOM_ID, rooms: { room_members: [] } } }],
  ])('returns 404 (not 500) and calls no rpc when the lookup row has %s', async (_l, row) => {
    buildWorld('owner');
    results.selectByTable.messages = { data: row, error: null };
    expectError(await remove(MY_MSG_ID), 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('returns a generic 500 and calls no rpc when the message lookup fails', async () => {
    buildWorld('owner');
    results.selectByTable.messages = rpcError('XX000');
    const res = await remove(MY_MSG_ID);
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

const writes: [string, Method, string, object | undefined][] = [
  ['send', 'post', channelMessagesPath(GENERAL_ID), { body: 'hi' }],
  ['edit', 'patch', messagePath(MY_MSG_ID), { body: 'hi' }],
  ['delete', 'delete', messagePath(MY_MSG_ID), undefined],
];

describe('messages: CSRF', () => {
  it.each(writes)('rejects %s from a foreign or missing Origin with 403 ORIGIN_NOT_ALLOWED', async (_l, method, path, body) => {
    buildWorld('owner');
    for (const origin of ['https://evil.example', 'http://localhost:5173.evil.example', 'null', null]) {
      expectError(await call(method, path, { body, origin }), 403, 'ORIGIN_NOT_ALLOWED');
    }
    expect(queries).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each(writes)('rejects %s without a JSON Content-Type with 403 UNSUPPORTED_CONTENT_TYPE', async (_l, method, path, body) => {
    buildWorld('owner');
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) {
      expectError(await call(method, path, { body, contentType }), 403, 'UNSUPPORTED_CONTENT_TYPE');
    }
    expect(queries).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('rejects a bodiless DELETE with no Content-Type header at all', async () => {
    buildWorld('owner');
    const res = await request(app)
      .delete(messagePath(MY_MSG_ID))
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

const badBodies: [string, unknown, string[]][] = [
  ['a missing body', {}, ['body.body']],
  ['a numeric body', { body: 42 }, ['body.body']],
  ['a null body', { body: null }, ['body.body']],
  ['an array body', { body: ['hi'] }, ['body.body']],
  ['an empty body', { body: '' }, ['body.body']],
  ['a whitespace-only body', { body: '  \n\t  ' }, ['body.body']],
  ['a CRLF-only body', { body: '\r\n\r\n' }, ['body.body']],
  ['2001 ASCII characters', { body: 'a'.repeat(2001) }, ['body.body']],
  ['2001 emoji (code points, not UTF-16 units)', { body: '🎮'.repeat(2001) }, ['body.body']],
  ['a lone CR', { body: 'a\rb' }, ['body.body']],
  ['a NUL', { body: 'a\u0000b' }, ['body.body']],
  ['an ESC', { body: 'a\u001Bb' }, ['body.body']],
  ['a DEL', { body: 'a\u007Fb' }, ['body.body']],
  ['a C1 control (NEL)', { body: 'a\u0085b' }, ['body.body']],
  ['a vertical tab', { body: 'a\u000Bb' }, ['body.body']],
  ['a form feed', { body: 'a\u000Cb' }, ['body.body']],
  ['a lone high surrogate', { body: '\ud800' }, ['body.body']],
  ['text with a lone low surrogate', { body: 'hi \udc00' }, ['body.body']],
  ['only a zero-width space', { body: '\u200B' }, ['body.body']],
  ['only zero-width characters', { body: '\u200B\u200D' }, ['body.body']],
  ['only the braille blank', { body: '\u2800' }, ['body.body']],
  ['only a Hangul filler', { body: '\u3164' }, ['body.body']],
  ['only the halfwidth Hangul filler', { body: '\uFFA0' }, ['body.body']],
  ['only Hangul choseong/jungseong fillers', { body: '\u115F\u1160' }, ['body.body']],
  ['a lone combining mark', { body: '\u0301' }, ['body.body']],
  ['a lone enclosing mark', { body: '\u20DD' }, ['body.body']],
  ['only a right-to-left override', { body: '\u202E' }, ['body.body']],
  ['only bidi controls and spaces', { body: ' \u202B \u202C ' }, ['body.body']],
  ['an unknown key', { body: 'hi', channelId: OTHER_CHANNEL_ID }, ['body']],
  ['an authorId', { body: 'hi', authorId: MEMBER_ID }, ['body']],
  ['a non-object body', ['hi'], ['body']],
];

describe('messages: body validation', () => {
  it.each(badBodies)('send returns 422 for %s without calling send_message', async (_l, body, paths) => {
    buildWorld('member');
    const res = await send(GENERAL_ID, body);
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(paths);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each(badBodies)('edit returns 422 for %s without calling edit_message', async (_l, body, paths) => {
    buildWorld('member');
    const res = await edit(MY_MSG_ID, body);
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(paths);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each<[string, string, string]>([
    ['2000 emoji (4000 UTF-16 units)', '🎮'.repeat(2000), '🎮'.repeat(2000)],
    ['2000 ASCII characters', 'b'.repeat(2000), 'b'.repeat(2000)],
    ['CRLF, stored as LF', 'line one\r\nline two\r\n', 'line one\nline two\n'],
    ['1000 "a\\r\\n" (3000 before, 2000 after CRLF -> LF)', 'a\r\n'.repeat(1000), 'a\n'.repeat(1000)],
    ['tabs and line feeds', 'a\tb\nc', 'a\tb\nc'],
    ['surrounding whitespace, untrimmed', '  spaced out  \n\n', '  spaced out  \n\n'],
    ['a ZWJ emoji sequence', '👨‍👩‍👧', '👨‍👩‍👧'],
    ['a single character', '.', '.'],
    ['Arabic text', 'مرحبا', 'مرحبا'],
    ['a zero-width space between letters', 'a\u200Bb', 'a\u200Bb'],
    ['text and an emoji', 'hi 👋', 'hi 👋'],
    ['RTL text in a right-to-left embedding', '\u202Bשלום\u202C', '\u202Bשלום\u202C'],
    ['a letter with a combining mark', 'e\u0301', 'e\u0301'],
  ])('accepts a body with %s on send and edit, passing the normalized text to the rpc', async (_l, input, stored) => {
    buildWorld('member');
    const sent = await send(GENERAL_ID, { body: input });
    expect(sent.status).toBe(201);
    expect(rpcCalls('send_message')[0]?.p_body).toBe(stored);
    expect(sent.body.body).toBe(stored);
    expect((await edit(MY_MSG_ID, { body: input })).status).toBe(200);
    expect(rpcCalls('edit_message')[0]?.p_body).toBe(stored);
  });

  it.each<[string, string]>([
    ['129 characters', 'k'.repeat(129)],
    ['a space', 'my key'],
    ['a dot', 'a.b'],
    ['a slash', 'a/b'],
    ['a comma (two headers joined)', 'a,b'],
    ['an empty value', ''],
  ])('returns 422 at headers.idempotency-key for a key with %s, without calling send_message', async (_l, key) => {
    buildWorld('member');
    const res = await send(GENERAL_ID, { body: 'hi' }, { headers: { 'Idempotency-Key': key } });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['headers.idempotency-key']);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('reports header and body issues together', async () => {
    buildWorld('member');
    const res = await send(GENERAL_ID, { body: '' }, { headers: { 'Idempotency-Key': 'bad key' } });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['headers.idempotency-key', 'body.body']);
  });

  it('passes a 128-character key through and a missing key as null', async () => {
    buildWorld('member');
    const key = `${'K'.repeat(64)}${'_-'.repeat(32)}`;
    expect((await send(GENERAL_ID, { body: 'one' }, { headers: { 'Idempotency-Key': key } })).status).toBe(201);
    expect((await send(GENERAL_ID, { body: 'two' })).status).toBe(201);
    expect(rpcCalls('send_message').map((a) => a.p_idempotency_key)).toEqual([key, null]);
  });
});

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

describe('POST /api/channels/:channelId/messages', () => {
  it('sends as the session user, returns 201 Message with the author, and broadcasts message:created once', async () => {
    buildWorld('member');
    const res = await send(GENERAL_ID.toUpperCase(), { body: 'gg, one more?' }, { headers: { 'Idempotency-Key': 'key-1' } });
    expect(res.status).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(Message.parse(res.body)).toStrictEqual(res.body);
    expect(rpcCalls('send_message')).toEqual([
      { p_channel: GENERAL_ID, p_author: world.me, p_body: 'gg, one more?', p_idempotency_key: 'key-1' },
    ]);
    const stored = world.messages.at(-1);
    expect(res.body).toStrictEqual({
      id: stored?.id,
      channelId: GENERAL_ID,
      author: { id: world.me, displayName: 'Me', avatarUrl: 'https://avatars.test/me.jpg' },
      body: 'gg, one more?',
      createdAt: stored?.created_at,
      editedAt: null,
    });
    expect(res.text).not.toMatch(/idempotency|replayed|deleted/i);
    expect(expectOneChannelBroadcast('message:created')).toStrictEqual({ message: res.body });
  });

  it('drops a non-https avatar to null in the response and the broadcast', async () => {
    buildWorld('member');
    world.profiles = world.profiles.map((p) => (p.id === world.me ? { ...p, avatar_url: 'http://insecure.test/a.jpg' } : p));
    const res = await send(GENERAL_ID, { body: 'hi' });
    expect(res.status).toBe(201);
    expect(res.body.author).toStrictEqual({ id: world.me, displayName: 'Me', avatarUrl: null });
    expect(expectOneChannelBroadcast('message:created')).toStrictEqual({ message: res.body });
  });

  it('replays a retry with the same key: 200, Idempotent-Replayed: true, the same message, broadcast again (once per attempt)', async () => {
    buildWorld('member');
    const first = await send(GENERAL_ID, { body: 'once' }, { headers: { 'Idempotency-Key': 'retry-me' } });
    const second = await send(GENERAL_ID, { body: 'once' }, { headers: { 'Idempotency-Key': 'retry-me' } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(Message.parse(second.body)).toStrictEqual(second.body);
    expect(second.body).toStrictEqual(first.body);
    expect(world.messages.filter((m) => m.body === 'once')).toHaveLength(1);
    // Replays broadcast too (a lost first response may mean a lost first broadcast); clients dedupe by id.
    const broadcasts = sentBroadcasts();
    expect(broadcasts.map((b) => b.event)).toEqual(['message:created', 'message:created']);
    expect(broadcasts.map((b) => b.payload)).toStrictEqual([{ message: first.body }, { message: first.body }]);
  });

  it('exposes Idempotent-Replayed to WEB_ORIGIN via CORS, with credentials, and allows the Idempotency-Key header', async () => {
    buildWorld('member');
    const res = await send(GENERAL_ID, { body: 'hi' }, { headers: { 'Idempotency-Key': 'cors-key' } });
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(String(res.headers['access-control-expose-headers']).split(',').map((h) => h.trim())).toContain('Idempotent-Replayed');

    const preflight = await request(app)
      .options(channelMessagesPath(GENERAL_ID))
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,idempotency-key');
    expect(preflight.status).toBe(204);
    expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain('idempotency-key');

    const foreign = await request(app).options(channelMessagesPath(GENERAL_ID)).set('Origin', 'https://evil.example');
    expect(foreign.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it.each<[string, () => { channel: string; body: string }]>([
    ['a different body', () => ({ channel: GENERAL_ID, body: 'second body' })],
    ['a different channel', () => ({ channel: RANDOM_ID, body: 'first body' })],
    [
      'a message that was deleted since',
      () => {
        const row = world.messages.find((m) => m.idempotency_key === 'reused');
        if (row) row.deleted_at = at(1);
        return { channel: GENERAL_ID, body: 'first body' };
      },
    ],
  ])('returns 409 IDEMPOTENCY_KEY_REUSED for a key reused with %s, and broadcasts nothing more', async (_l, arrange) => {
    buildWorld('member');
    expect((await send(GENERAL_ID, { body: 'first body' }, { headers: { 'Idempotency-Key': 'reused' } })).status).toBe(201);
    fetchMock.mockClear();
    const { channel, body } = arrange();
    const res = await send(channel, { body }, { headers: { 'Idempotency-Key': 'reused' } });
    expectError(res, 409, 'IDEMPOTENCY_KEY_REUSED');
    expect(res.text).not.toContain('first body');
    expectNoSideEffects();
  });

  it('returns 409 CHANNEL_NOT_TEXT for a voice channel (from the rpc) and broadcasts nothing', async () => {
    buildWorld('member');
    const res = await send(VOICE_ID, { body: 'hello?' });
    expectError(res, 409, 'CHANNEL_NOT_TEXT');
    expect(rpcCalls('send_message')).toHaveLength(1);
    expectNoSideEffects();
  });

  it('returns 404 when the sender is removed between the membership check and the rpc (race)', async () => {
    buildWorld('member');
    results.rpcByName.send_message = (args) => {
      world.members = world.members.filter((m) => m.user_id !== world.me);
      return fakeSendMessage(args);
    };
    expectError(await send(GENERAL_ID, { body: 'too late' }), 404, 'NOT_FOUND');
    expectNoSideEffects();
  });

  it.each<[string, number, string, string | null]>([
    ['HX001', 404, 'NOT_FOUND', null],
    ['HX002', 403, 'FORBIDDEN', null],
    ['HX009', 409, 'CHANNEL_NOT_TEXT', null],
    ['HX010', 409, 'IDEMPOTENCY_KEY_REUSED', null],
    ['23514', 422, 'VALIDATION_FAILED', 'body.body'],
    ['22023', 422, 'VALIDATION_FAILED', 'body.body'],
    ['40001', 500, 'INTERNAL', null],
    ['23505', 500, 'INTERNAL', null],
    ['XX000', 500, 'INTERNAL', null],
  ])('maps %s from send_message to %i %s, never echoing the DB error or broadcasting', async (sqlstate, status, code, path) => {
    buildWorld('member');
    results.rpcByName.send_message = rpcError(sqlstate);
    const res = await send(GENERAL_ID, { body: 'hi' });
    expectError(res, status, code);
    if (path) expect(res.body.error.details).toEqual([{ path, message: 'The request is invalid.' }]);
    else expect(res.body.error.details).toBeUndefined();
    for (const leak of ['SECRET-DB-MESSAGE', 'ROWVALUE', 'HINTVALUE', sqlstate]) expect(res.text).not.toContain(leak);
    if (status < 500) expect(logLines.join('')).not.toContain('SECRET-DB-MESSAGE');
    expectNoSideEffects();
  });

  it.each<[string, unknown]>([
    ['an empty array', []],
    ['two rows', [{}, {}]],
    ['null', null],
    ['a row without replayed', [{ id: randomUUID(), channel_id: GENERAL_ID, author_id: null, body: 'ROWVALUE', created_at: at(0), edited_at: null, author_display_name: null, author_avatar_url: null }]],
    ['a row without the author columns', [{ id: randomUUID(), channel_id: GENERAL_ID, author_id: null, body: 'ROWVALUE', created_at: at(0), edited_at: null, replayed: false }]],
    ['a row with a bad timestamp', [{ id: randomUUID(), channel_id: GENERAL_ID, author_id: null, body: 'ROWVALUE', created_at: 'ROWVALUE-TS', edited_at: null, author_display_name: null, author_avatar_url: null, replayed: false }]],
  ])('returns a generic 500 and broadcasts nothing when send_message returns %s', async (_l, data) => {
    buildWorld('member');
    results.rpcByName.send_message = { data, error: null };
    const res = await send(GENERAL_ID, { body: 'hi' });
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
    expect(res.text).not.toContain('ROWVALUE');
    expectNoSideEffects();
  });

  it('builds the author from the rpc row without reading profiles', async () => {
    buildWorld('member');
    expect((await send(GENERAL_ID, { body: 'hi' })).status).toBe(201);
    expect(queriesOn('profiles')).toHaveLength(0);
  });

  it('returns a generic 500 and broadcasts nothing when the row has an author id but no author profile; a retry replays and broadcasts it', async () => {
    buildWorld('member');
    results.rpcByName.send_message = (args) => {
      const result = fakeSendMessage(args);
      return { ...result, data: (result.data as Record<string, unknown>[]).map((r) => ({ ...r, author_display_name: null })) };
    };
    const failed = await send(GENERAL_ID, { body: 'hi' }, { headers: { 'Idempotency-Key': 'after-500' } });
    expectError(failed, 500, 'INTERNAL');
    expectNoSideEffects();

    results.rpcByName.send_message = fakeSendMessage;
    const retry = await send(GENERAL_ID, { body: 'hi' }, { headers: { 'Idempotency-Key': 'after-500' } });
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    // The committed send reaches online members through the retry's broadcast.
    expect(expectOneChannelBroadcast('message:created')).toStrictEqual({ message: retry.body });
  });

  it('returns the message with author null when the row has no author (profile deleted)', async () => {
    buildWorld('member');
    results.rpcByName.send_message = (args) => {
      const result = fakeSendMessage(args);
      const rows = (result.data as Record<string, unknown>[]).map((r) => ({
        ...r,
        author_id: null,
        author_display_name: null,
        author_avatar_url: null,
      }));
      return { ...result, data: rows };
    };
    const res = await send(GENERAL_ID, { body: 'ghost' });
    expect(res.status).toBe(201);
    expect(res.body.author).toBeNull();
    expect(expectOneChannelBroadcast('message:created')).toStrictEqual({ message: res.body });
  });

  it.each<[string, () => void]>([
    ['rejected with a 500', () => fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 })))],
    ['throws', () => fetchMock.mockImplementation(() => Promise.reject(new Error('network')))],
  ])('still returns 201 when the broadcast is %s (the write committed)', async (_l, arrange) => {
    buildWorld('member');
    arrange();
    expect((await send(GENERAL_ID, { body: 'hi' })).status).toBe(201);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** Follows nextCursor until null (bounded, so a cursor loop fails instead of hanging). */
async function walk(channelId: string, firstQuery: string, limit: number): Promise<{ pages: string[][]; ids: string[] }> {
  const pages: string[][] = [];
  let res = await list(channelId, `${firstQuery}${firstQuery ? '&' : '?'}limit=${limit}`);
  for (let i = 0; i < 50; i++) {
    expect(res.status).toBe(200);
    const page = MessagePage.parse(res.body);
    expect(page).toStrictEqual(res.body);
    expect(page.data.length).toBeLessThanOrEqual(limit);
    pages.push(page.data.map((m) => m.id));
    if (page.nextCursor === null) return { pages, ids: pages.flat() };
    res = await list(channelId, `?cursor=${encodeURIComponent(page.nextCursor)}&limit=${limit}`);
  }
  throw new Error('paging did not terminate');
}

/** Replaces GENERAL's messages with `rows` (other channels keep theirs). */
function seedGeneral(rows: MessageRow[]): void {
  world.messages = [...world.messages.filter((m) => m.channel_id !== GENERAL_ID), ...rows];
}

const byNewest = (a: MessageRow, b: MessageRow) => -compareRows('created_at', a, b) || -compareRows('id', a, b);
const byOldest = (a: MessageRow, b: MessageRow) => compareRows('created_at', a, b) || compareRows('id', a, b);

describe('GET /api/channels/:channelId/messages', () => {
  it('returns 409 CHANNEL_NOT_TEXT for a voice channel without querying messages, even with after', async () => {
    buildWorld('member');
    expectError(await list(VOICE_ID), 409, 'CHANNEL_NOT_TEXT');
    expectError(await list(VOICE_ID, `?after=${MY_MSG_ID}`), 409, 'CHANNEL_NOT_TEXT');
    expect(queriesOn('messages')).toHaveLength(0);
  });

  it('returns history newest first with author embeds, no-store, and never deleted messages', async () => {
    buildWorld('member');
    const res = await list(GENERAL_ID);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(MessagePage.parse(res.body)).toStrictEqual(res.body);
    expect(res.body.nextCursor).toBeNull();
    expect(MessagePage.parse(res.body).data.map((m) => m.id)).toEqual([ORPHAN_MSG_ID, MEMBER_MSG_ID, MY_MSG_ID]);
    expect(res.text).not.toContain('ROWVALUE-DELETED-BODY');
    const [query] = listQueries();
    expect(query?.calls).toContainEqual(['eq', ['channel_id', GENERAL_ID]]);
    expect(query?.calls).toContainEqual(['is', ['deleted_at', null]]);
    expect(query?.calls).toContainEqual(['limit', [51]]);
  });

  it('returns author null for a deleted profile, keeps a former member as author, and drops non-https avatars', async () => {
    buildWorld('member');
    world.profiles = world.profiles.map((p) => (p.id === MEMBER_ID ? { ...p, avatar_url: 'javascript:alert(1)' } : p));
    seedGeneral([
      msg(ORPHAN_MSG_ID, GENERAL_ID, null, at(-3)),
      msg(randomUUID(), GENERAL_ID, EX_MEMBER_ID, at(-2)),
      msg(MEMBER_MSG_ID, GENERAL_ID, MEMBER_ID, at(-1)),
    ]);
    const res = await list(GENERAL_ID);
    const authors = MessagePage.parse(res.body).data.map((m) => m.author);
    expect(authors).toEqual([
      { id: MEMBER_ID, displayName: 'Member', avatarUrl: null },
      { id: EX_MEMBER_ID, displayName: 'Former', avatarUrl: 'https://avatars.test/former.jpg' },
      null,
    ]);
  });

  it('pages history newest first with a keyset cursor: ties on created_at broken by id, no repeats, no gaps, deleted skipped', async () => {
    buildWorld('member');
    const rows: MessageRow[] = [];
    for (let i = 0; i < 9; i++) {
      // Three messages share each timestamp, to exercise the id tie-break across page boundaries.
      rows.push(msg(randomUUID(), GENERAL_ID, MEMBER_ID, at(Math.floor(i / 3) * 1000, 7)));
    }
    const deleted = msg(randomUUID(), GENERAL_ID, MEMBER_ID, at(1000, 7), { deleted_at: at(5000) });
    seedGeneral([...rows, deleted]);

    const { pages, ids } = await walk(GENERAL_ID, '', 2);
    expect(ids).toEqual([...rows].sort(byNewest).map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(pages).toHaveLength(5);
    expect(ids).not.toContain(deleted.id);

    const [firstPage, secondPage] = listQueries();
    expect(firstPage?.calls.some(([m]) => m === 'or')).toBe(false);
    expect(firstPage?.calls).toContainEqual(['order', ['created_at', { ascending: false }]]);
    expect(firstPage?.calls).toContainEqual(['order', ['id', { ascending: false }]]);
    expect(secondPage?.calls.find(([m]) => m === 'or')?.[1][0]).toMatch(/^created_at\.lt\."[^"]+",and\(created_at\.eq\."[^"]+",id\.lt\.[0-9a-f-]{36}\)$/);
  });

  it('keeps created_at microseconds in the cursor so rows 1µs apart are neither skipped nor repeated', async () => {
    buildWorld('member');
    const rows = [0, 1, 2, 3].map((micro) => msg(randomUUID(), GENERAL_ID, MEMBER_ID, at(0, micro)));
    seedGeneral(rows);
    const { ids } = await walk(GENERAL_ID, '', 1);
    expect(ids).toEqual([...rows].sort(byNewest).map((m) => m.id));
  });

  it('backfills oldest first from 5 s before the anchor (inclusive), never returning the anchor on any page, and continues strictly newer', async () => {
    buildWorld('member');
    const anchor = msg(randomUUID(), GENERAL_ID, MEMBER_ID, at(0, 500));
    const tooOld = msg(randomUUID(), GENERAL_ID, MEMBER_ID, at(-5001));
    const edge = msg(randomUUID(), GENERAL_ID, MEMBER_ID, at(-5000));
    // More rows inside the overlap window than one page holds, some sharing the anchor's timestamp.
    const inWindow = [-4000, -3000, -2000, -1000, -1].map((ms) => msg(randomUUID(), GENERAL_ID, MEMBER_ID, at(ms)));
    const sameTime = [1, 2].map(() => msg(randomUUID(), GENERAL_ID, MEMBER_ID, at(0, 500)));
    const newer = [1000, 2000, 3000].map((ms) => msg(randomUUID(), GENERAL_ID, MEMBER_ID, at(ms)));
    const deletedNewer = msg(randomUUID(), GENERAL_ID, MEMBER_ID, at(1500), { deleted_at: at(4000) });
    seedGeneral([anchor, tooOld, edge, ...inWindow, ...sameTime, ...newer, deletedNewer]);

    const { pages, ids } = await walk(GENERAL_ID, `?after=${anchor.id}`, 2);
    const expected = [edge, ...inWindow, ...sameTime, ...newer].sort(byOldest).map((m) => m.id);

    // Terminates, never repeats a row, misses nothing newer than the window start, and the anchor
    // (which sorts among the sameTime rows, i.e. on a later page) never appears on any page.
    expect(pages.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(tooOld.id);
    expect(ids).not.toContain(deletedNewer.id);
    for (const page of pages) expect(page).not.toContain(anchor.id);
    expect(ids).toEqual(expected);
    expect(pages[0]).toEqual([edge.id, inWindow[0]?.id]);

    const listed = listQueries();
    const [first, second] = listed;
    expect(first?.calls).toContainEqual(['gte', ['created_at', new Date(Date.parse(anchor.created_at) - 5000).toISOString()]]);
    expect(first?.calls).toContainEqual(['order', ['created_at', { ascending: true }]]);
    expect(first?.calls).toContainEqual(['order', ['id', { ascending: true }]]);
    expect(first?.calls).toContainEqual(['is', ['deleted_at', null]]);
    expect(second?.calls.find(([m]) => m === 'or')?.[1][0]).toMatch(/^created_at\.gt\."[^"]+",and\(created_at\.eq\."[^"]+",id\.gt\.[0-9a-f-]{36}\)$/);
    // Every backfill page (the first and each cursor continuation) excludes the anchor.
    expect(listed).toHaveLength(pages.length);
    for (const query of listed) expect(query.calls).toContainEqual(['neq', ['id', anchor.id]]);
  });

  it('backfills from a deleted anchor message in the same channel', async () => {
    buildWorld('member');
    const res = await list(GENERAL_ID, `?after=${DELETED_MSG_ID.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(MessagePage.parse(res.body).data.map((m) => m.id)).toEqual([]);
    const anchorLookup = queriesOn('messages').find((q) => firstArg(q, 'select') === 'id, created_at');
    expect(anchorLookup?.calls).toContainEqual(['eq', ['id', DELETED_MSG_ID]]);
    expect(anchorLookup?.calls).toContainEqual(['eq', ['channel_id', GENERAL_ID]]);
  });

  it.each<[string, string]>([
    ['an unknown message', randomUUID()],
    ['a message in another channel of the same room', RANDOM_MSG_ID],
    ["a message in another room's channel", FOREIGN_MSG_ID],
  ])('returns 422 at query.after for %s without listing', async (_l, after) => {
    buildWorld('member');
    const res = await list(GENERAL_ID, `?after=${after}`);
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['query.after']);
    expect(listQueries()).toHaveLength(0);
  });

  it.each<[string, string, string[]]>([
    ['cursor and after together', `?cursor=${encodeCursor(['older', at(0), MY_MSG_ID])}&after=${MY_MSG_ID}`, ['query.after']],
    ['a non-uuid after', '?after=not-a-uuid', ['query.after']],
    ['an empty after', '?after=', ['query.after']],
    ['a filter injection in after', `?after=${MY_MSG_ID},id.neq.0`, ['query.after']],
    ['limit 0', '?limit=0', ['query.limit']],
    ['limit 101', '?limit=101', ['query.limit']],
    ['a fractional limit', '?limit=1.5', ['query.limit']],
    ['a non-numeric limit', '?limit=abc', ['query.limit']],
    ['a cursor over 256 characters', `?cursor=${'a'.repeat(257)}`, ['query.cursor']],
    ['two cursors', '?cursor=a&cursor=b', ['query.cursor']],
  ])('returns 422 for %s without listing', async (_l, query, paths) => {
    buildWorld('member');
    const res = await list(GENERAL_ID, query);
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(paths);
    expect(queriesOn('messages')).toHaveLength(0);
  });

  it.each<[string, string]>([
    ['not base64url JSON', 'garbage!!'],
    ['JSON that is not a tuple', encodeCursor({ direction: 'older' })],
    ['an unknown direction', encodeCursor(['sideways', at(0), MY_MSG_ID])],
    ['a non-uuid id', encodeCursor(['older', at(0), 'nope'])],
    ['an id with a filter injection', encodeCursor(['older', at(0), `${MY_MSG_ID}),id.gt.(0`])],
    ['a timestamp with a quote injection', encodeCursor(['older', '2026-09-26T10:00:00Z",id.gt.0', MY_MSG_ID])],
    ['a timestamp without an offset', encodeCursor(['older', '2026-09-26T10:00:00', MY_MSG_ID])],
    ['year 0000', encodeCursor(['older', '0000-01-01T00:00:00Z', MY_MSG_ID])],
    ['an impossible date', encodeCursor(['older', '2026-02-30T10:00:00Z', MY_MSG_ID])],
    ['extra tuple items', encodeCursor(['older', at(0), MY_MSG_ID, 'x'])],
    ['an older cursor with an anchor', encodeCursor(['older', at(0), MY_MSG_ID, MEMBER_MSG_ID])],
    ['a newer cursor with a non-uuid anchor', encodeCursor(['newer', at(0), MY_MSG_ID, 'nope'])],
    ['a newer cursor with an anchor filter injection', encodeCursor(['newer', at(0), MY_MSG_ID, `${MY_MSG_ID}),id.gt.(0`])],
    ['a newer cursor with a null anchor', encodeCursor(['newer', at(0), MY_MSG_ID, null])],
    ['a newer cursor with five items', encodeCursor(['newer', at(0), MY_MSG_ID, MEMBER_MSG_ID, MEMBER_MSG_ID])],
  ])('returns 422 at query.cursor for a cursor that is %s, without listing', async (_l, cursor) => {
    buildWorld('member');
    const res = await list(GENERAL_ID, `?cursor=${encodeURIComponent(cursor)}`);
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['query.cursor']);
    expect(listQueries()).toHaveLength(0);
  });

  it('accepts limit bounds 1 and 100 and asks the database for one extra row', async () => {
    buildWorld('member');
    expect((await list(GENERAL_ID, '?limit=1')).body.data).toHaveLength(1);
    expect((await list(GENERAL_ID, '?limit=100')).status).toBe(200);
    expect(listQueries().map((q) => firstArg(q, 'limit'))).toEqual([2, 101]);
  });

  it('returns a generic 500 when the list query fails, without leaking the DB error', async () => {
    buildWorld('member');
    const original = messagesSelect;
    results.selectByTable.messages = (q) => (firstArg(q, 'select') === LIST_SELECT ? rpcError('XX000') : original(q));
    const res = await list(GENERAL_ID);
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
  });
});

// ---------------------------------------------------------------------------
// Edit and delete
// ---------------------------------------------------------------------------

describe('PATCH /api/messages/:messageId', () => {
  it('edits as the session user, returns 200 Message with editedAt and the author, and broadcasts message:updated once', async () => {
    buildWorld('member');
    const res = await edit(MY_MSG_ID, { body: 'edited\r\ntext' });
    expect(res.status).toBe(200);
    expect(Message.parse(res.body)).toStrictEqual(res.body);
    expect(rpcCalls('edit_message')).toEqual([{ p_message: MY_MSG_ID, p_actor: world.me, p_body: 'edited\ntext' }]);
    const stored = world.messages.find((m) => m.id === MY_MSG_ID);
    expect(res.body).toStrictEqual({
      id: MY_MSG_ID,
      channelId: GENERAL_ID,
      author: { id: world.me, displayName: 'Me', avatarUrl: 'https://avatars.test/me.jpg' },
      body: 'edited\ntext',
      createdAt: stored?.created_at,
      editedAt: stored?.edited_at,
    });
    expect(res.body.editedAt).not.toBeNull();
    expect(expectOneChannelBroadcast('message:updated')).toStrictEqual({ message: res.body });
  });

  it('broadcasts to the channel of the edited message (RANDOM, not GENERAL)', async () => {
    buildWorld('member');
    expect((await edit(RANDOM_MSG_ID, { body: 'x' })).status).toBe(200);
    expectOneChannelBroadcast('message:updated', RANDOM_ID);
  });

  it.each<[string, number, string, string | null]>([
    ['HX001', 404, 'NOT_FOUND', null],
    ['HX002', 403, 'FORBIDDEN', null],
    ['23514', 422, 'VALIDATION_FAILED', 'body.body'],
    ['22023', 422, 'VALIDATION_FAILED', 'body.body'],
    ['XX000', 500, 'INTERNAL', null],
  ])('maps %s from edit_message to %i %s without echoing the DB error or broadcasting', async (sqlstate, status, code, path) => {
    buildWorld('member');
    results.rpcByName.edit_message = rpcError(sqlstate);
    const res = await edit(MY_MSG_ID, { body: 'x' });
    expectError(res, status, code);
    if (path) expect(res.body.error.details).toEqual([{ path, message: 'The request is invalid.' }]);
    for (const leak of ['SECRET-DB-MESSAGE', 'ROWVALUE', 'HINTVALUE', sqlstate]) expect(res.text).not.toContain(leak);
    expectNoSideEffects();
  });

  it('returns 404 when the message is deleted between the membership check and the rpc (race)', async () => {
    buildWorld('member');
    results.rpcByName.edit_message = (args) => {
      const row = world.messages.find((m) => m.id === MY_MSG_ID);
      if (row) row.deleted_at = at(1);
      return fakeEditMessage(args);
    };
    expectError(await edit(MY_MSG_ID, { body: 'x' }), 404, 'NOT_FOUND');
    expectNoSideEffects();
  });

  it.each<[string, unknown]>([
    ['a partial row', [{ id: MY_MSG_ID }]],
    ['null', null],
    ['an empty array', []],
    ['a bare row without edited_at', { id: MY_MSG_ID, channel_id: GENERAL_ID, author_id: null, body: 'x', created_at: at(0), author_display_name: null, author_avatar_url: null }],
    ['a row without body', [{ id: MY_MSG_ID, channel_id: GENERAL_ID, author_id: null, created_at: at(0), edited_at: at(1), author_display_name: null, author_avatar_url: null }]],
    ['a row without the author columns', [{ id: MY_MSG_ID, channel_id: GENERAL_ID, author_id: null, body: 'x', created_at: at(0), edited_at: at(1) }]],
    ['an author id without the author profile', [{ id: MY_MSG_ID, channel_id: GENERAL_ID, author_id: MEMBER_ID, body: 'x', created_at: at(0), edited_at: at(1), author_display_name: null, author_avatar_url: null }]],
  ])('returns a generic 500 and broadcasts nothing when edit_message returns %s', async (_l, data) => {
    buildWorld('member');
    results.rpcByName.edit_message = { data, error: null };
    expectError(await edit(MY_MSG_ID, { body: 'x' }), 500, 'INTERNAL');
    expectNoSideEffects();
  });

  it('still returns 200 when the broadcast fails', async () => {
    buildWorld('member');
    fetchMock.mockImplementation(() => Promise.reject(new Error('network')));
    expect((await edit(MY_MSG_ID, { body: 'x' })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('DELETE /api/messages/:messageId', () => {
  it('deletes as the session user: 204 with no body, and message:deleted {id, channelId} once, without the body', async () => {
    buildWorld('member');
    const res = await remove(MY_MSG_ID);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(rpcCalls('delete_message')).toEqual([{ p_message: MY_MSG_ID, p_actor: world.me }]);
    expect(expectOneChannelBroadcast('message:deleted')).toStrictEqual({ id: MY_MSG_ID, channelId: GENERAL_ID });
    expect(JSON.stringify(sentBroadcasts())).not.toContain(`body of ${MY_MSG_ID}`);
    expect(world.messages.find((m) => m.id === MY_MSG_ID)?.deleted_at).not.toBeNull();
  });

  it('uses the ids from the membership check, whatever row delete_message returns', async () => {
    buildWorld('member');
    results.rpcByName.delete_message = { data: { id: FOREIGN_MSG_ID, channel_id: OTHER_CHANNEL_ID, body: 'ROWVALUE' }, error: null };
    expect((await remove(RANDOM_MSG_ID)).status).toBe(204);
    expect(expectOneChannelBroadcast('message:deleted', RANDOM_ID)).toStrictEqual({ id: RANDOM_MSG_ID, channelId: RANDOM_ID });
  });

  it('returns 404 for a second delete of the same message, with one rpc call and one broadcast', async () => {
    buildWorld('admin');
    expect((await remove(MEMBER_MSG_ID)).status).toBe(204);
    expectError(await remove(MEMBER_MSG_ID), 404, 'NOT_FOUND');
    expect(rpcCalls('delete_message')).toHaveLength(1);
    expect(sentBroadcasts()).toHaveLength(1);
  });

  it('hides a deleted message from history right away', async () => {
    buildWorld('member');
    expect((await remove(MY_MSG_ID)).status).toBe(204);
    const res = await list(GENERAL_ID);
    expect(MessagePage.parse(res.body).data.map((m) => m.id)).not.toContain(MY_MSG_ID);
  });

  it.each<[string, number, string]>([
    ['HX001', 404, 'NOT_FOUND'],
    ['HX002', 403, 'FORBIDDEN'],
    ['22023', 422, 'VALIDATION_FAILED'],
    ['XX000', 500, 'INTERNAL'],
  ])('maps %s from delete_message to %i %s without echoing the DB error or broadcasting', async (sqlstate, status, code) => {
    buildWorld('admin');
    results.rpcByName.delete_message = rpcError(sqlstate);
    const res = await remove(MEMBER_MSG_ID);
    expectError(res, status, code);
    for (const leak of ['SECRET-DB-MESSAGE', 'ROWVALUE', 'HINTVALUE', sqlstate]) expect(res.text).not.toContain(leak);
    expectNoSideEffects();
  });

  it('returns 403 when an admin is demoted between the membership check and the rpc (race)', async () => {
    buildWorld('admin');
    results.rpcByName.delete_message = (args) => {
      world.members = world.members.map((m) => (m.user_id === world.me ? { ...m, role: 'member' } : m));
      return fakeDeleteMessage(args);
    };
    expectError(await remove(MEMBER_MSG_ID), 403, 'FORBIDDEN');
    expectNoSideEffects();
  });

  it('still returns 204 when the broadcast is rejected', async () => {
    buildWorld('member');
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 })));
    expect((await remove(MY_MSG_ID)).status).toBe(204);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

describe('messages: rate limits', () => {
  it('shares one 10-per-10s write budget across send, edit, and delete; other users are unaffected', async () => {
    buildWorld('member');
    const mine = [1, 2, 3].map((i) => msg(randomUUID(), GENERAL_ID, world.me, at(-i)));
    world.messages.push(...mine);
    for (let i = 0; i < 4; i++) expect((await send(GENERAL_ID, { body: `s${i}` })).status).toBe(201);
    for (let i = 0; i < 3; i++) expect((await edit(MY_MSG_ID, { body: `e${i}` })).status).toBe(200);
    for (const m of mine) expect((await remove(m.id)).status).toBe(204);

    expectError(await send(GENERAL_ID, { body: 'eleventh' }), 429, 'RATE_LIMITED');
    expectError(await edit(MY_MSG_ID, { body: 'eleventh' }), 429, 'RATE_LIMITED');
    expectError(await remove(MY_MSG_ID), 429, 'RATE_LIMITED');
    expect(rpcCalls('send_message')).toHaveLength(4);
    expect(rpcCalls('edit_message')).toHaveLength(3);
    expect(rpcCalls('delete_message')).toHaveLength(3);
    expect(sentBroadcasts()).toHaveLength(10);

    // Reads have their own budget.
    expect((await list(GENERAL_ID)).status).toBe(200);

    becomeNewUser('member');
    expect((await send(GENERAL_ID, { body: 'fresh' })).status).toBe(201);
  });

  it('gives reads their own 120/minute budget, which does not consume the write budget', async () => {
    buildWorld('member');
    for (let i = 0; i < 120; i++) expect((await list(GENERAL_ID, '?limit=1')).status).toBe(200);
    expectError(await list(GENERAL_ID), 429, 'RATE_LIMITED');
    expect(listQueries()).toHaveLength(120);
    for (let i = 0; i < 10; i++) expect((await send(GENERAL_ID, { body: `w${i}` })).status).toBe(201);
    expectError(await send(GENERAL_ID, { body: 'w10' }), 429, 'RATE_LIMITED');
  });

  it('does not charge the write budget for 401, 404, or 403 responses', async () => {
    buildWorld('member');
    for (let i = 0; i < 12; i++) {
      expectError(await send(GENERAL_ID, { body: 'x' }, { signedIn: false }), 401, 'UNAUTHENTICATED');
      expectError(await send(OTHER_CHANNEL_ID, { body: 'x' }), 404, 'NOT_FOUND');
      expectError(await remove(FOREIGN_MSG_ID), 404, 'NOT_FOUND');
      expectError(await edit(MEMBER_MSG_ID, { body: 'x' }), 403, 'FORBIDDEN');
      expectError(await remove(MEMBER_MSG_ID), 403, 'FORBIDDEN');
    }
    for (let i = 0; i < 10; i++) expect((await send(GENERAL_ID, { body: `ok${i}` })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Logs and secrets
// ---------------------------------------------------------------------------

describe('messages: logs and secrets', () => {
  it('never logs message bodies, Idempotency-Key values, the session token, the service key, or DB details', async () => {
    buildWorld('owner');
    const texts: string[] = [];
    const key = 'IDEMKEY-5f0c2a8e1b7d4c55';
    texts.push((await send(GENERAL_ID, { body: 'SENTBODY-alpha' }, { headers: { 'Idempotency-Key': key } })).text);
    texts.push((await send(GENERAL_ID, { body: 'SENTBODY-alpha' }, { headers: { 'Idempotency-Key': key } })).text);
    texts.push((await send(GENERAL_ID, { body: 'SENTBODY-bravo' }, { headers: { 'Idempotency-Key': 'IDEMKEY bad' } })).text);
    texts.push((await edit(MY_MSG_ID, { body: 'EDITBODY-charlie' })).text);
    texts.push((await list(GENERAL_ID)).text);
    texts.push((await list(GENERAL_ID, `?after=${MY_MSG_ID}`)).text);
    results.rpcByName.edit_message = rpcError('23514');
    texts.push((await edit(MY_MSG_ID, { body: 'EDITBODY-echo' })).text);
    texts.push((await remove(MY_MSG_ID)).text);
    results.rpcByName.send_message = rpcError('XX000');
    texts.push((await send(GENERAL_ID, { body: 'SENTBODY-delta' }, { headers: { 'Idempotency-Key': 'IDEMKEY-2' } })).text);

    const logs = logLines.join('');
    expect(logEntries().filter((e) => e.req !== undefined).length).toBeGreaterThanOrEqual(9);
    expect(logs).toContain('send_message failed');
    expect(logs).toContain('[redacted]');
    for (const secret of ['SENTBODY', 'EDITBODY', 'IDEMKEY', 'body of ', world.token, 'test-service-role-key', 'ROWVALUE', 'HINTVALUE']) {
      expect(logs).not.toContain(secret);
    }
    for (const text of [...texts, JSON.stringify(sentBroadcasts())]) {
      expect(text).not.toContain(world.token);
      expect(text).not.toContain('test-service-role-key');
      expect(text).not.toContain('SECRET-DB-MESSAGE');
      expect(text).not.toContain('ROWVALUE');
      expect(text).not.toContain('IDEMKEY');
    }
  });
});
