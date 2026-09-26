import { createHash, randomUUID } from 'node:crypto';
import type * as PinoModule from 'pino';
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
 * Invites through the real app, offline:
 *   POST/GET /api/rooms/:roomId/invites, DELETE /api/invites/:inviteId,
 *   GET /api/invites/:token/preview (public), POST /api/invites/:token/redeem,
 *   GET /api/me/invites, POST /api/me/invites/:inviteId/accept|decline.
 * The database is faked at the supabase-js client with an in-memory world whose reads honour
 * only the filters the services actually send (and PostgREST's `!inner` embed semantics, the
 * `or` trees, order, and limit), so a dropped filter shows up as a leak. create_link_invite /
 * create_direct_invite / revoke_invite mirror supabase/migrations/20260926045852_invites.sql, and
 * redeem_invite_link / respond_to_direct_invite mirror 20260925010655_core_schema_fixes.sql
 * (statuses, check order, return shapes, SQLSTATEs). Broadcasts are observed at the Realtime
 * REST fetch boundary (so broadcast.ts's schema check runs). Every log line (LOG_LEVEL=trace) is
 * captured and checked for link tokens, token hashes, and secrets.
 */

const logLines = vi.hoisted<string[]>(() => []);

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

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

// See every log line, and key the per-IP preview limiter by X-Forwarded-For so each test gets its own bucket.
const savedEnv = { LOG_LEVEL: process.env.LOG_LEVEL, TRUST_PROXY: process.env.TRUST_PROXY };
process.env.LOG_LEVEL = 'trace';
process.env.TRUST_PROXY = '1';

const { createApp } = await import('../src/app.js');
const { hashSessionToken, newRandomToken, SESSION_COOKIE } = await import('../src/lib/session.js');
const { AcceptInviteResult, CreatedInvite, InboxPage, INVITE_EXPIRY_MS, InvitePage, InvitePreview, RedeemInviteResult } =
  await import('../src/contracts/http/invites.js');
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

const ROOM_ID = '2b000000-0000-4000-8000-00000000a001';
const OTHER_ROOM_ID = '2b000000-0000-4000-8000-00000000a002';
const DELETED_ROOM_ID = '2b000000-0000-4000-8000-00000000a003';
const OWNER_ID = '0e000000-0000-4000-8000-000000000001';
const ADMIN_ID = '0e000000-0000-4000-8000-000000000002';
const MEMBER_ID = '0e000000-0000-4000-8000-000000000003';
const OUTSIDER_ID = '0e000000-0000-4000-8000-000000000004';
/** A creator whose profile was deleted (invites.created_by is then null in the DB). */
const GONE_ID = '0e000000-0000-4000-8000-000000000005';
const OWNER_STEAM = '76561198000000001';
const ADMIN_STEAM = '76561198000000002';
const MEMBER_STEAM = '76561198000000003';
const OUTSIDER_STEAM = '76561198000000004';
/** A Steam account that has never signed in (no profile). */
const NEW_STEAM = '76561198000000099';
const GENERAL_ID = 'c1000000-0000-4000-8000-00000000000a';
const VOICE_ID = 'c1000000-0000-4000-8000-00000000000b';
const OTHER_GENERAL_ID = 'c1000000-0000-4000-8000-00000000000c';
const ICON_PATH = 'rooms/2b000000/icon.png';
const MY_AVATAR = 'https://avatars.test/me.jpg';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.now();

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
  return Date.parse(`${m[1] ?? ''}${m[3] ?? ''}`) * 1000 + Number((m[2] ?? '').padEnd(6, '0'));
}

/** NOW (file load) plus an offset in milliseconds, in PostgREST's format. */
const ts = (offsetMs: number, extraMicros = 0) => pgTs((NOW + offsetMs) * 1000 + extraMicros);

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type Role = 'owner' | 'admin' | 'member';

interface RoomRow {
  id: string;
  name: string;
  icon_emoji: string | null;
  icon_path: string | null;
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
  steam_id: string;
  display_name: string;
  avatar_url: string | null;
  current_game: string | null;
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
interface InviteRow {
  id: string;
  room_id: string;
  created_by: string | null;
  kind: 'link' | 'direct';
  token_hash: string | null;
  invitee_steam_id: string | null;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  revoked_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  created_at: string;
}

interface World {
  me: string;
  mySteam: string;
  token: string;
  rooms: RoomRow[];
  members: MemberRow[];
  profiles: ProfileRow[];
  channels: ChannelRow[];
  invites: InviteRow[];
  /** Microsecond clock for now() in the fake functions (never behind the real clock). */
  clock: number;
  /** Microsecond clock for seeded created_at values (strictly increasing). */
  seedClock: number;
}

let world: World;
/** Session cookie token -> profile id. */
const sessions = new Map<string, string>();
/** Raw link tokens and token hashes seen in this test; none may ever reach a log line. */
const credentials: string[] = [];
/** Invite selects that actually ran (a builder that is created but never awaited doesn't count). */
const executedInviteSelects: RecordedQuery[] = [];

let steamCounter = 0;
function freshSteamId(): string {
  steamCounter += 1;
  return `76561199${String(steamCounter).padStart(9, '0')}`;
}

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.9.${String(ipCounter >> 8)}.${String(ipCounter & 255)}`;
}

function nowTs(): string {
  world.clock = Math.max(world.clock + 1, Date.now() * 1000);
  return pgTs(world.clock);
}

function seededCreatedAt(): string {
  world.seedClock += 1_000_000;
  return pgTs(world.seedClock);
}

function profile(id: string, steamId: string, displayName: string, avatar: string | null): ProfileRow {
  return { id, steam_id: steamId, display_name: displayName, avatar_url: avatar, current_game: null };
}

/** ROOM_ID (emoji icon) with owner/admin/member, OTHER_ROOM_ID (image icon, OWNER only), DELETED_ROOM_ID (me owner). */
function buildWorld(myRole: Role | null): void {
  const me = world.me;
  world.rooms = [
    { id: ROOM_ID, name: 'Night Raid', icon_emoji: '🎮', icon_path: null, created_at: ts(-30 * DAY), deleted_at: null },
    { id: OTHER_ROOM_ID, name: 'Elsewhere', icon_emoji: null, icon_path: ICON_PATH, created_at: ts(-20 * DAY), deleted_at: null },
    { id: DELETED_ROOM_ID, name: 'Gone', icon_emoji: '👻', icon_path: null, created_at: ts(-10 * DAY), deleted_at: ts(-DAY) },
  ];
  const joined = ts(-5 * DAY);
  world.members = [
    { room_id: ROOM_ID, user_id: myRole === 'owner' ? me : OWNER_ID, role: 'owner', joined_at: joined },
    { room_id: ROOM_ID, user_id: ADMIN_ID, role: 'admin', joined_at: joined },
    { room_id: ROOM_ID, user_id: MEMBER_ID, role: 'member', joined_at: joined },
    { room_id: OTHER_ROOM_ID, user_id: OWNER_ID, role: 'owner', joined_at: joined },
    { room_id: DELETED_ROOM_ID, user_id: me, role: 'owner', joined_at: joined },
  ];
  if (myRole === 'owner') world.members.push({ room_id: ROOM_ID, user_id: OWNER_ID, role: 'member', joined_at: joined });
  if (myRole && myRole !== 'owner') world.members.push({ room_id: ROOM_ID, user_id: me, role: myRole, joined_at: joined });
  world.profiles = [
    profile(me, world.mySteam, 'Me', MY_AVATAR),
    profile(OWNER_ID, OWNER_STEAM, 'Olivia', 'https://avatars.test/owner.jpg'),
    profile(ADMIN_ID, ADMIN_STEAM, 'Adam', null),
    profile(MEMBER_ID, MEMBER_STEAM, 'Mia', 'https://avatars.test/member.jpg'),
    profile(OUTSIDER_ID, OUTSIDER_STEAM, 'Otto', 'https://avatars.test/otto.jpg'),
  ];
  world.channels = [
    { id: GENERAL_ID, room_id: ROOM_ID, type: 'text', name: 'general', position: 0, created_at: ts(-30 * DAY), deleted_at: null },
    { id: VOICE_ID, room_id: ROOM_ID, type: 'voice', name: 'voice', position: 0, created_at: ts(-30 * DAY), deleted_at: null },
    { id: OTHER_GENERAL_ID, room_id: OTHER_ROOM_ID, type: 'text', name: 'general', position: 0, created_at: ts(-20 * DAY), deleted_at: null },
  ];
  world.invites = [];
}

function inviteRow(extra: Partial<InviteRow>): InviteRow {
  return {
    id: randomUUID(),
    room_id: ROOM_ID,
    created_by: OWNER_ID,
    kind: 'link',
    token_hash: null,
    invitee_steam_id: null,
    max_uses: null,
    uses: 0,
    expires_at: ts(HOUR),
    revoked_at: null,
    accepted_at: null,
    declined_at: null,
    created_at: seededCreatedAt(),
    ...extra,
  };
}

/** Seeds a link invite and returns it with its raw token. */
function seedLink(extra: Partial<InviteRow> = {}): { row: InviteRow; token: string } {
  const token = newRandomToken();
  const row = inviteRow({ kind: 'link', token_hash: sha256(token), ...extra });
  credentials.push(token, sha256(token));
  world.invites.push(row);
  return { row, token };
}

/** Seeds a direct invite to `steamId` (single use, expiring in 7 days). */
function seedDirect(steamId: string, extra: Partial<InviteRow> = {}): InviteRow {
  const row = inviteRow({ kind: 'direct', invitee_steam_id: steamId, max_uses: 1, expires_at: ts(7 * DAY), ...extra });
  world.invites.push(row);
  return row;
}

// ---------------------------------------------------------------------------
// Fake reads (PostgREST semantics for the filters the services send)
// ---------------------------------------------------------------------------

function hasCall(query: RecordedQuery, method: string, ...args: unknown[]): boolean {
  return query.calls.some(([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args));
}

/** Applies eq/is filters to columns the row has; embedded-table filters (dotted) are handled by callers. */
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

function single(rows: unknown[]): DbResult {
  if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
  return { data: rows[0] ?? null, error: null };
}

function isSingle(query: RecordedQuery): boolean {
  return query.calls.some(([m]) => m === 'maybeSingle' || m === 'single');
}

const ROOM_COLS = 'id, name, icon_emoji, icon_path, created_at';
const PROFILE_COLS = 'id, display_name, avatar_url';
const MEMBER_PROFILE_COLS = 'id, display_name, avatar_url, current_game';
const INVITE_COLS =
  'id, room_id, created_by, kind, invitee_steam_id, max_uses, uses, expires_at, revoked_at, accepted_at, declined_at, created_at';

/** The embedded room of a row, or null when it's missing or filtered out (only when the service sends the filter). */
function embeddedRoom(roomId: string, query: RecordedQuery): RoomRow | null {
  const room = world.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  if (room.deleted_at !== null && hasCall(query, 'is', 'rooms.deleted_at', null)) return null;
  return room;
}

function roomMembersSelect(query: RecordedQuery): DbResult {
  const columns = String(firstArg(query, 'select'));
  const rows = world.members.filter((m) => matches(m, query));
  if (/^role, rooms(!inner)?\(id\)$/.test(columns)) {
    // findMembership (requireRoomMember): maybeSingle.
    const row = rows[0];
    if (!row) return { data: null, error: null };
    const room = embeddedRoom(row.room_id, query);
    if (room) return { data: { role: row.role, rooms: { id: room.id } }, error: null };
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
  if (columns === 'user_id') {
    // The preview's member count: select('user_id', { count: 'exact', head: true }).
    const options = query.calls.find(([m]) => m === 'select')?.[1][1] as { count?: string; head?: boolean } | undefined;
    if (options?.count !== 'exact' || options.head !== true) throw new Error('fake db: expected a head count');
    return { data: null, count: rows.length, error: null } as DbResult;
  }
  throw new Error(`unexpected room_members select: ${columns}`);
}

function roomsSelect(query: RecordedQuery): DbResult {
  if (String(firstArg(query, 'select')) !== ROOM_COLS) throw new Error('unexpected rooms select');
  return single(world.rooms.filter((r) => matches(r, query)).map((r) => pick(r, ROOM_COLS)));
}

function channelsSelect(query: RecordedQuery): DbResult {
  const columns = String(firstArg(query, 'select'));
  if (columns !== 'id, room_id, type, name, position, created_at') throw new Error(`unexpected channels select: ${columns}`);
  return { data: world.channels.filter((c) => matches(c, query)).map((c) => pick(c, columns)), error: null };
}

function profilesSelect(query: RecordedQuery): DbResult {
  const columns = String(firstArg(query, 'select'));
  if (columns !== PROFILE_COLS && columns !== 'steam_id') throw new Error(`unexpected profiles select: ${columns}`);
  return single(world.profiles.filter((p) => matches(p, query)).map((p) => pick(p, columns)));
}

const EXPIRY_TREE = /^expires_at\.is\.null,expires_at\.gt\."([^"]+)"$/;
const CURSOR_TREE = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/;
const BOTH_TREES = /^and\(or\((.*)\),or\((.*)\)\)$/;

/** One `or` tree the services send, as a row predicate; anything else is a test failure. */
function treePredicate(tree: string): (row: InviteRow) => boolean {
  const expiry = EXPIRY_TREE.exec(tree);
  if (expiry) {
    const now = toMicros(expiry[1] ?? '');
    return (row) => row.expires_at === null || toMicros(row.expires_at) > now;
  }
  const cursor = CURSOR_TREE.exec(tree);
  if (cursor) {
    const [, lt, eq, id] = cursor as unknown as [string, string, string, string];
    if (lt !== eq) throw new Error('fake db: inconsistent keyset filter');
    const t = toMicros(lt);
    return (row) => toMicros(row.created_at) < t || (toMicros(row.created_at) === t && row.id < id);
  }
  throw new Error(`fake db: unexpected or tree ${tree}`);
}

function orPredicate(filter: string): (row: InviteRow) => boolean {
  const both = BOTH_TREES.exec(filter);
  if (both) {
    const a = treePredicate(both[1] ?? '');
    const b = treePredicate(both[2] ?? '');
    return (row) => a(row) && b(row);
  }
  return treePredicate(filter);
}

/** eq/is on the invite's own columns, `or`, order, and limit, exactly as sent. */
function filterInvites(query: RecordedQuery): InviteRow[] {
  let rows = world.invites.filter((i) => matches(i, query));
  for (const [method, args] of query.calls) {
    if (method === 'or') rows = rows.filter(orPredicate(String(args[0])));
    else if (!['select', 'eq', 'is', 'order', 'limit', 'maybeSingle', 'overrideTypes'].includes(method)) {
      throw new Error(`fake db: unexpected ${method} on invites`);
    }
  }
  const orders = query.calls.filter(([m]) => m === 'order').map(([, a]) => a as [string, { ascending?: boolean } | undefined]);
  rows = [...rows].sort((a, b) => {
    for (const [column, options] of orders) {
      let c: number;
      if (column === 'created_at') c = Math.sign(toMicros(a.created_at) - toMicros(b.created_at));
      else if (column === 'id') c = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      else throw new Error(`fake db: unexpected order column ${column}`);
      if (c !== 0) return options?.ascending === false ? -c : c;
    }
    return 0;
  });
  const limit = firstArg(query, 'limit');
  return typeof limit === 'number' ? rows.slice(0, limit) : rows;
}

/** requireInviteMember's lookup: rooms and room_members embeds, each dropped only when `!inner`. */
function inviteAccessSelect(query: RecordedQuery, columns: string): DbResult {
  const innerRooms = columns.includes('rooms!inner(');
  const innerMembers = columns.includes('room_members!inner(');
  const userFilter = query.calls.find(([m, a]) => m === 'eq' && a[0] === 'rooms.room_members.user_id')?.[1][1];
  const rows = world.invites
    .filter((i) => matches(i, query))
    .flatMap((i) => {
      const room = embeddedRoom(i.room_id, query);
      let embed: { room_members: { role: Role }[] } | null = null;
      if (room) {
        const roomMembers = world.members
          .filter((m) => m.room_id === room.id && (userFilter === undefined || m.user_id === userFilter))
          .map((m) => ({ role: m.role }));
        embed = roomMembers.length === 0 && innerMembers ? null : { room_members: roomMembers };
      }
      if (embed === null && innerRooms) return [];
      return [{ id: i.id, room_id: i.room_id, created_by: i.created_by, kind: i.kind, rooms: embed }];
    });
  return single(rows);
}

/** A row with its `rooms(...)` and `profiles(...)` (creator) embeds, or null if an `!inner` embed dropped it. */
function withEmbeds(i: InviteRow, query: RecordedQuery, columns: string, own: string): Record<string, unknown> | null {
  const room = embeddedRoom(i.room_id, query);
  const creator = world.profiles.find((p) => p.id === i.created_by);
  const out = pick(i, own);
  if (columns.includes('rooms(') || columns.includes('rooms!inner(')) {
    if (!room && columns.includes('rooms!inner(')) return null;
    out.rooms = room ? pick(room, ROOM_COLS) : null;
  }
  if (!creator && columns.includes('profiles!inner(')) return null;
  out.profiles = creator ? pick(creator, PROFILE_COLS) : null;
  return out;
}

function invitesSelect(query: RecordedQuery): DbResult {
  executedInviteSelects.push(query);
  const columns = String(firstArg(query, 'select'));
  const plain = columns.replaceAll('!inner', '');
  if (/^id, room_id, created_by, kind, rooms(!inner)?\(room_members(!inner)?\(role\)\)$/.test(columns)) {
    return inviteAccessSelect(query, columns);
  }
  if (plain === `${INVITE_COLS}, profiles(${PROFILE_COLS})`) {
    const rows = filterInvites(query).flatMap((i) => withEmbeds(i, query, columns, INVITE_COLS) ?? []);
    return { data: rows, error: null };
  }
  const previewOwn = 'room_id, max_uses, uses, expires_at, revoked_at';
  if (plain === `${previewOwn}, rooms(${ROOM_COLS}), profiles(${PROFILE_COLS})`) {
    return single(filterInvites(query).flatMap((i) => withEmbeds(i, query, columns, previewOwn) ?? []));
  }
  if (plain === `id, expires_at, rooms(${ROOM_COLS}), profiles(${PROFILE_COLS})`) {
    // The inbox: the limit applies after the inner joins drop rows, as in PostgREST.
    const limit = firstArg(query, 'limit');
    const unlimited: RecordedQuery = { ...query, calls: query.calls.filter(([m]) => m !== 'limit') };
    const rows = filterInvites(unlimited).flatMap((i) => withEmbeds(i, query, columns, 'id, expires_at') ?? []);
    return { data: typeof limit === 'number' ? rows.slice(0, limit) : rows, error: null };
  }
  if (columns === 'accepted_at, declined_at') {
    return single(filterInvites(query).map((i) => pick(i, columns)));
  }
  throw new Error(`unexpected invites select: ${columns}`);
}

function sessionsSelect(query: RecordedQuery): DbResult {
  const hash = query.calls.find(([m, a]) => m === 'eq' && a[0] === 'token_hash')?.[1][1];
  for (const [token, profileId] of sessions) {
    if (hashSessionToken(token) === hash) return { data: { id: randomUUID(), profile_id: profileId }, error: null };
  }
  return { data: null, error: null };
}

// ---------------------------------------------------------------------------
// Fake Postgres functions (semantics, check order, return shapes, SQLSTATEs of the migrations)
// ---------------------------------------------------------------------------

const DB_SECRET_MESSAGE = 'SECRET-DB-MESSAGE violates check';
const DB_DETAILS = 'Failing row contains (ROWVALUE-DETAILS)';

function rpcError(code: string): DbResult {
  return { data: null, error: { code, message: DB_SECRET_MESSAGE, details: DB_DETAILS, hint: 'HINTVALUE' } };
}

const liveRoom = (id: unknown) => world.rooms.find((r) => r.id === id && r.deleted_at === null);
const memberOf = (roomId: unknown, userId: unknown) => world.members.find((m) => m.room_id === roomId && m.user_id === userId);
const isPastTs = (value: string | null) => value !== null && toMicros(value) <= Date.now() * 1000;

/** Stores a timestamp argument the way Postgres returns it. */
const asPg = (value: unknown) => (typeof value === 'string' ? pgTs(toMicros(value)) : null);

function fakeCreateLinkInvite(args: Record<string, unknown>): DbResult {
  const { p_room, p_actor, p_token_hash, p_max_uses, p_expires_at } = args as {
    p_room?: string | null;
    p_actor?: string | null;
    p_token_hash?: string | null;
    p_max_uses?: number | null;
    p_expires_at?: string | null;
  };
  if (!p_room || !p_actor || !p_token_hash) return rpcError('22023');
  if (p_expires_at != null && isPastTs(p_expires_at)) return rpcError('22023');
  if (!liveRoom(p_room) || !memberOf(p_room, p_actor)) return rpcError('HX001');
  if (!/^[0-9a-f]{64}$/.test(p_token_hash)) return rpcError('23514');
  if (p_max_uses != null && p_max_uses < 1) return rpcError('23514');
  if (world.invites.some((i) => i.token_hash === p_token_hash)) return rpcError('23505');
  credentials.push(p_token_hash);
  const row = inviteRow({
    room_id: p_room,
    created_by: p_actor,
    kind: 'link',
    token_hash: p_token_hash,
    max_uses: p_max_uses ?? null,
    expires_at: asPg(p_expires_at),
    created_at: nowTs(),
  });
  world.invites.push(row);
  // RETURNS TABLE (the invite columns except token_hash): a one-row array.
  return { data: [withoutHash(row)], error: null };
}

/** The invite columns the functions return: everything but token_hash. */
function withoutHash(row: InviteRow): Record<string, unknown> {
  const { token_hash: _hash, ...rest } = row;
  return rest;
}

function withInviteeProfile(row: InviteRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const invitee = row.invitee_steam_id === null ? undefined : world.profiles.find((p) => p.steam_id === row.invitee_steam_id);
  return { ...withoutHash(row), ...extra, invitee_profile_id: invitee?.id ?? null };
}

function fakeCreateDirectInvite(args: Record<string, unknown>): DbResult {
  const { p_room, p_actor, p_steam_id, p_expires_at } = args as Record<string, string | null | undefined>;
  if (!p_room || !p_actor || !p_steam_id) return rpcError('22023');
  if (p_expires_at != null && isPastTs(p_expires_at)) return rpcError('22023');
  if (!liveRoom(p_room) || !memberOf(p_room, p_actor)) return rpcError('HX001');
  const invitee = world.profiles.find((p) => p.steam_id === p_steam_id);
  if (invitee && memberOf(p_room, invitee.id)) return rpcError('HX011');
  const pending = world.invites.find(
    (i) =>
      i.room_id === p_room &&
      i.kind === 'direct' &&
      i.invitee_steam_id === p_steam_id &&
      i.revoked_at === null &&
      i.accepted_at === null &&
      i.declined_at === null,
  );
  if (pending) {
    if (isPastTs(pending.expires_at)) pending.revoked_at = nowTs();
    else return rpcError('HX012');
  }
  if (!/^7656119[0-9]{10}$/.test(p_steam_id)) return rpcError('23514');
  const row = inviteRow({
    room_id: p_room,
    created_by: p_actor,
    kind: 'direct',
    invitee_steam_id: p_steam_id,
    max_uses: 1,
    expires_at: asPg(p_expires_at),
    created_at: nowTs(),
  });
  world.invites.push(row);
  // RETURNS TABLE: a one-row array (replaced_invite_id before invitee_profile_id).
  return { data: [withInviteeProfile(row, { replaced_invite_id: pending?.id ?? null })], error: null };
}

function fakeRevokeInvite(args: Record<string, unknown>): DbResult {
  const { p_invite, p_actor } = args as Record<string, string | null | undefined>;
  if (!p_invite || !p_actor) return rpcError('22023');
  const invite = world.invites.find((i) => i.id === p_invite);
  if (!invite || !liveRoom(invite.room_id)) return rpcError('HX001');
  const member = memberOf(invite.room_id, p_actor);
  if (!member) return rpcError('HX001');
  if (invite.created_by !== p_actor && member.role === 'member') return rpcError('HX002');
  if (invite.revoked_at === null) invite.revoked_at = nowTs();
  return { data: [withInviteeProfile(invite)], error: null };
}

function fakeRedeemInviteLink(args: Record<string, unknown>): DbResult {
  const { p_token_hash, p_user } = args as Record<string, string | null | undefined>;
  if (!p_token_hash || !p_user) return rpcError('22023');
  const row = (roomId: string | null, status: string): DbResult => ({ data: [{ room_id: roomId, status }], error: null });
  const invite = world.invites.find((i) => i.token_hash === p_token_hash);
  if (!invite || invite.kind !== 'link') return row(null, 'invalid');
  if (!liveRoom(invite.room_id)) return row(invite.room_id, 'room_deleted');
  if (memberOf(invite.room_id, p_user)) return row(invite.room_id, 'already_member');
  if (invite.revoked_at !== null) return row(invite.room_id, 'revoked');
  if (isPastTs(invite.expires_at)) return row(invite.room_id, 'expired');
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return row(invite.room_id, 'used_up');
  world.members.push({ room_id: invite.room_id, user_id: p_user, role: 'member', joined_at: nowTs() });
  invite.uses += 1;
  return row(invite.room_id, 'joined');
}

function fakeRespondToDirectInvite(args: Record<string, unknown>): DbResult {
  const { p_invite, p_user, p_accept } = args as { p_invite?: string | null; p_user?: string | null; p_accept?: boolean | null };
  if (!p_invite || !p_user || typeof p_accept !== 'boolean') return rpcError('22023');
  const row = (roomId: string | null, status: string): DbResult => ({ data: [{ room_id: roomId, status }], error: null });
  const steamId = world.profiles.find((p) => p.id === p_user)?.steam_id;
  const invite = world.invites.find((i) => i.id === p_invite);
  if (!invite || !steamId) return row(null, 'invalid');
  if (invite.kind !== 'direct' || invite.invitee_steam_id !== steamId) return row(null, 'invalid');
  if (!liveRoom(invite.room_id)) return row(invite.room_id, 'room_deleted');
  if (invite.accepted_at !== null || invite.declined_at !== null) return row(invite.room_id, 'already_responded');
  if (invite.revoked_at !== null) return row(invite.room_id, 'revoked');
  if (isPastTs(invite.expires_at)) return row(invite.room_id, 'expired');
  if (!p_accept) {
    invite.declined_at = nowTs();
    return row(invite.room_id, 'declined');
  }
  const already = memberOf(invite.room_id, p_user) !== undefined;
  if (!already) world.members.push({ room_id: invite.room_id, user_id: p_user, role: 'member', joined_at: nowTs() });
  invite.accepted_at = nowTs();
  invite.uses = 1;
  return row(invite.room_id, already ? 'already_member' : 'accepted');
}

function install(): void {
  results.selectByTable.sessions = sessionsSelect;
  results.selectByTable.room_members = roomMembersSelect;
  results.selectByTable.rooms = roomsSelect;
  results.selectByTable.channels = channelsSelect;
  results.selectByTable.profiles = profilesSelect;
  results.selectByTable.invites = invitesSelect;
  results.rpcByName.create_link_invite = fakeCreateLinkInvite;
  results.rpcByName.create_direct_invite = fakeCreateDirectInvite;
  results.rpcByName.revoke_invite = fakeRevokeInvite;
  results.rpcByName.redeem_invite_link = fakeRedeemInviteLink;
  results.rpcByName.respond_to_direct_invite = fakeRespondToDirectInvite;
}

/** Signs in as a brand-new user (fresh per-user rate-limit budgets) with `role` in ROOM_ID. */
function becomeNewUser(role: Role | null): void {
  world.me = randomUUID();
  world.mySteam = freshSteamId();
  world.token = newRandomToken();
  sessions.set(world.token, world.me);
  buildWorld(role);
}

/** Adds another signed-in user (with a profile) to the world; returns their session token. */
function addUser(id: string, steamId: string, name: string): string {
  const token = newRandomToken();
  sessions.set(token, id);
  world.profiles.push(profile(id, steamId, name, null));
  return token;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

type Method = 'get' | 'post' | 'delete';

interface CallOptions {
  body?: unknown;
  signedIn?: boolean;
  token?: string;
  origin?: string | null;
  contentType?: string | null;
}

/** A request as hideout-web sends it: session cookie, WEB_ORIGIN, and a JSON content type on writes. */
function call(method: Method, path: string, options: CallOptions = {}) {
  let req = request(app)[method](path);
  if (options.signedIn ?? true) req = req.set('Cookie', `${SESSION_COOKIE}=${options.token ?? world.token}`);
  const origin = options.origin === undefined ? WEB_ORIGIN : options.origin;
  const contentType = options.contentType === undefined ? (method === 'get' ? null : 'application/json') : options.contentType;
  if (origin !== null) req = req.set('Origin', origin);
  if (contentType !== null) req = req.set('Content-Type', contentType);
  return options.body === undefined ? req : req.send(JSON.stringify(options.body));
}

const roomInvitesPath = (roomId: string) => `/api/rooms/${roomId}/invites`;
const invitePath = (inviteId: string) => `/api/invites/${inviteId}`;
const redeemPath = (token: string) => `/api/invites/${token}/redeem`;
const previewPath = (token: string) => `/api/invites/${token}/preview`;
const acceptPath = (inviteId: string) => `/api/me/invites/${inviteId}/accept`;
const declinePath = (inviteId: string) => `/api/me/invites/${inviteId}/decline`;

/** Lets fire-and-forget work (the direct-invite broadcasts and their logging) finish before assertions. */
const flushPending = () => new Promise<void>((resolve) => setImmediate(resolve));

async function create(body: unknown, roomId = ROOM_ID, options: Omit<CallOptions, 'body'> = {}) {
  const res = await call('post', roomInvitesPath(roomId), { ...options, body });
  if (typeof res.body?.token === 'string') credentials.push(res.body.token as string);
  await flushPending();
  return res;
}
const listRoom = (query = '', roomId = ROOM_ID) => call('get', `${roomInvitesPath(roomId)}${query}`);
const revoke = (inviteId: string) => call('delete', invitePath(inviteId));
const redeem = (token: string, options: CallOptions = {}) => call('post', redeemPath(token), options);
const inbox = () => call('get', '/api/me/invites');
const accept = (inviteId: string) => call('post', acceptPath(inviteId));
const decline = (inviteId: string) => call('post', declinePath(inviteId));
const preview = (token: string, ip = freshIp()) => request(app).get(previewPath(token)).set('X-Forwarded-For', ip);

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

/** Asserts exactly one broadcast, on `<kind>:<id>`, whose payload passes the event schema unchanged; returns the payload. */
function expectOneBroadcast<K extends 'room' | 'user'>(kind: K, id: string, event: keyof (typeof serverEvents)[K]): unknown {
  const sent = sentBroadcasts();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.topic).toBe(`${kind}:${id}`);
  expect(sent[0]?.event).toBe(event);
  expect(sent[0]?.private).toBe(true);
  const schema = (serverEvents[kind] as Record<string, { parse: (v: unknown) => unknown }>)[event as string];
  expect(schema?.parse(sent[0]?.payload)).toStrictEqual(sent[0]?.payload);
  return sent[0]?.payload;
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

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

const mySummary = () => ({ id: world.me, displayName: 'Me', avatarUrl: MY_AVATAR });
const ownerSummary = { id: OWNER_ID, displayName: 'Olivia', avatarUrl: 'https://avatars.test/owner.jpg' };
const emojiIcon = { kind: 'emoji', emoji: '🎮' };
const signedIconUrl = `https://storage.test/sign/${ICON_PATH}?token=signed`;

function findInvite(id: string): InviteRow {
  const row = world.invites.find((i) => i.id === id);
  if (!row) throw new Error(`no invite ${id}`);
  return row;
}

beforeEach(() => {
  resetFakeDb();
  logLines.length = 0;
  credentials.length = 0;
  executedInviteSelects.length = 0;
  sessions.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 202 })));
  world = {
    me: '',
    mySteam: '',
    token: '',
    rooms: [],
    members: [],
    profiles: [],
    channels: [],
    invites: [],
    clock: Date.now() * 1000,
    seedClock: (NOW - DAY) * 1000,
  };
  // A fresh user per test also isolates the per-user rate limiters, whose state is module-level.
  becomeNewUser(null);
  install();
});

afterEach(() => {
  const logs = logLines.join('');
  for (const secret of [
    'test-service-role-key',
    'test-session-secret',
    'test-livekit-secret',
    'test-steam-api-key',
    'ROWVALUE',
    'HINTVALUE',
    ...sessions.keys(),
    ...credentials,
    ...world.invites.flatMap((i) => (i.token_hash ? [i.token_hash] : [])),
  ]) {
    expect(logs).not.toContain(secret);
  }
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('invites: authentication', () => {
  it.each<[string, Method, () => string, unknown]>([
    ['create', 'post', () => roomInvitesPath(ROOM_ID), { kind: 'link' }],
    ['list', 'get', () => roomInvitesPath(ROOM_ID), undefined],
    ['revoke', 'delete', () => invitePath(randomUUID()), undefined],
    ['redeem', 'post', () => redeemPath(newRandomToken()), undefined],
    ['inbox', 'get', () => '/api/me/invites', undefined],
    ['accept', 'post', () => acceptPath(randomUUID()), undefined],
    ['decline', 'post', () => declinePath(randomUUID()), undefined],
  ])('returns 401 for %s without a session and touches no data', async (_l, method, path, body) => {
    buildWorld('owner');
    expectError(await call(method, path(), { signedIn: false, body }), 401, 'UNAUTHENTICATED');
    expect(queries).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 401 for an unknown session cookie before any invite work', async () => {
    buildWorld('owner');
    const { token } = seedLink();
    expectError(await redeem(token, { token: newRandomToken() }), 401, 'UNAUTHENTICATED');
    expect(queries.map((q) => q.table)).toEqual(['sessions']);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it('serves the preview with no session at all', async () => {
    buildWorld('owner');
    const { token } = seedLink();
    const res = await preview(token);
    expect(res.status).toBe(200);
    expect(queriesOn('sessions')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Room-scoped access: create and list
// ---------------------------------------------------------------------------

const roomRoutes: [string, (roomId: string) => Promise<request.Response>][] = [
  ['create', async (roomId) => create({ kind: 'link' }, roomId)],
  ['list', async (roomId) => listRoom('', roomId)],
];

describe('invites: room-scoped access (create, list)', () => {
  it.each(roomRoutes)(
    '%s returns an identical 404 for a non-member, a deleted room, an unknown room, and a malformed roomId',
    async (_l, route) => {
      buildWorld(null);
      const nonMember = await route(ROOM_ID);
      expectError(nonMember, 404, 'NOT_FOUND');
      const others = [
        await route(OTHER_ROOM_ID),
        await route(DELETED_ROOM_ID), // I'm its owner, but it's deleted
        await route(randomUUID()),
        await route('not-a-uuid'),
        await route(encodeURIComponent(`${ROOM_ID},deleted_at.not.is.null`)),
      ];
      for (const res of others) {
        expect(res.status).toBe(404);
        expect(res.body).toStrictEqual(nonMember.body);
      }
      expect(executedInviteSelects).toHaveLength(0);
      expect(fakeDb.rpc).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(roomRoutes)('%s returns 404 without a membership lookup for a malformed roomId', async (_l, route) => {
    buildWorld('owner');
    for (const id of ['not-a-uuid', `${ROOM_ID}x`, '123']) expectError(await route(id), 404, 'NOT_FOUND');
    expect(queries.filter((q) => q.table !== 'sessions')).toHaveLength(0);
  });

  it.each<[Role]>([['owner'], ['admin'], ['member']])('lets an %s create link and direct invites and list', async (role) => {
    buildWorld(role);
    expect((await create({ kind: 'link' })).status).toBe(201);
    expect((await create({ kind: 'direct', steamId: OUTSIDER_STEAM })).status).toBe(201);
    expect((await listRoom()).status).toBe(200);
  });

  it('loses access immediately when removed: the next create and list are 404s', async () => {
    buildWorld('member');
    expect((await create({ kind: 'link' })).status).toBe(201);
    world.members = world.members.filter((m) => !(m.room_id === ROOM_ID && m.user_id === world.me));
    expectError(await create({ kind: 'link' }), 404, 'NOT_FOUND');
    expectError(await listRoom(), 404, 'NOT_FOUND');
    expect(rpcCalls('create_link_invite')).toHaveLength(1);
  });

  it('returns 404 and broadcasts nothing when the room is deleted between the membership check and the write', async () => {
    buildWorld('owner');
    const del = () => {
      const room = world.rooms.find((r) => r.id === ROOM_ID);
      if (room) room.deleted_at = ts(0);
    };
    results.rpcByName.create_direct_invite = (args) => {
      del();
      return fakeCreateDirectInvite(args);
    };
    expectError(await create({ kind: 'direct', steamId: OUTSIDER_STEAM }), 404, 'NOT_FOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Invite-scoped access: revoke (requireInviteMember)
// ---------------------------------------------------------------------------

describe('invites: revoke access', () => {
  it('returns 404 without any invite lookup for malformed inviteIds', async () => {
    buildWorld('owner');
    for (const id of ['not-a-uuid', `${randomUUID()}x`, `${randomUUID()},kind.eq.link`, '123']) {
      expectError(await revoke(encodeURIComponent(id)), 404, 'NOT_FOUND');
    }
    expect(queriesOn('invites')).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it('returns an identical 404 for an unknown invite, an invite in a deleted room, and one in a room I am not in', async () => {
    buildWorld('owner');
    const unknown = await revoke(randomUUID());
    expectError(unknown, 404, 'NOT_FOUND');
    const inDeleted = seedLink({ room_id: DELETED_ROOM_ID, created_by: world.me }).row;
    const elsewhere = seedLink({ room_id: OTHER_ROOM_ID }).row;
    for (const res of [await revoke(inDeleted.id), await revoke(elsewhere.id)]) {
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual(unknown.body);
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(inDeleted.revoked_at).toBeNull();
    expect(elsewhere.revoked_at).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 for the creator after they are removed from the room', async () => {
    buildWorld('member');
    const { row } = seedLink({ created_by: world.me });
    world.members = world.members.filter((m) => !(m.room_id === ROOM_ID && m.user_id === world.me));
    expectError(await revoke(row.id), 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it("returns 403 without calling revoke_invite when a plain member revokes someone else's invite", async () => {
    buildWorld('member');
    const { row } = seedLink({ created_by: ADMIN_ID });
    expectError(await revoke(row.id), 403, 'FORBIDDEN');
    // An invite whose creator's profile was deleted belongs to nobody.
    const orphan = seedLink({ created_by: null }).row;
    expectError(await revoke(orphan.id), 403, 'FORBIDDEN');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(row.revoked_at).toBeNull();
  });

  it('lets a plain member revoke their own invite', async () => {
    buildWorld('member');
    const { row } = seedLink({ created_by: world.me });
    const res = await revoke(row.id);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(rpcCalls('revoke_invite')).toEqual([{ p_invite: row.id, p_actor: world.me }]);
    expect(row.revoked_at).not.toBeNull();
  });

  it.each<[Role]>([['owner'], ['admin']])("lets an %s revoke anyone's invite", async (role) => {
    buildWorld(role);
    const { row } = seedLink({ created_by: MEMBER_ID });
    expect((await revoke(row.id)).status).toBe(204);
    expect(row.revoked_at).not.toBeNull();
  });

  it('is idempotent: a second revoke is 204 and keeps the first revoked_at', async () => {
    buildWorld('owner');
    const { row } = seedLink();
    expect((await revoke(row.id)).status).toBe(204);
    const first = row.revoked_at;
    expect((await revoke(row.id)).status).toBe(204);
    expect(row.revoked_at).toBe(first);
    expect(rpcCalls('revoke_invite')).toHaveLength(2);
  });

  it('lowercases an uppercase inviteId in the lookup and the rpc', async () => {
    buildWorld('owner');
    const { row } = seedLink();
    expect((await revoke(row.id.toUpperCase())).status).toBe(204);
    expect(queriesOn('invites')[0]?.calls).toContainEqual(['eq', ['id', row.id]]);
    expect(rpcCalls('revoke_invite')[0]?.p_invite).toBe(row.id);
  });

  it('filters the lookup by invite id, live room, and my membership, with inner joins', async () => {
    buildWorld('owner');
    const { row } = seedLink();
    expect((await revoke(row.id)).status).toBe(204);
    const [lookup] = queriesOn('invites');
    const select = String(firstArg(lookup as RecordedQuery, 'select'));
    expect(select).toContain('rooms!inner(');
    expect(select).toContain('room_members!inner(');
    expect(lookup?.calls).toContainEqual(['eq', ['id', row.id]]);
    expect(lookup?.calls).toContainEqual(['is', ['rooms.deleted_at', null]]);
    expect(lookup?.calls).toContainEqual(['eq', ['rooms.room_members.user_id', world.me]]);
  });

  it('(fake fidelity) leaks without the filters or without !inner, so the assertions above are meaningful', () => {
    buildWorld(null);
    const inner = 'id, room_id, created_by, kind, rooms!inner(room_members!inner(role))';
    const other = seedLink({ room_id: OTHER_ROOM_ID }).row;
    const deleted = seedLink({ room_id: DELETED_ROOM_ID }).row;
    const q = (select: string, ...calls: RecordedQuery['calls']): RecordedQuery => ({
      table: 'invites',
      calls: [['select', [select]], ...calls],
    });
    // Without the membership filter, a non-member sees the owner's role.
    const leaked = inviteAccessSelect(q(inner, ['eq', ['id', other.id]]), inner).data as {
      rooms: { room_members: { role: Role }[] };
    };
    expect(leaked.rooms.room_members[0]?.role).toBe('owner');
    // Without the deleted filter, a deleted room's invite comes back.
    expect(inviteAccessSelect(q(inner, ['eq', ['id', deleted.id]]), inner).data).not.toBeNull();
    // Fully filtered with !inner: nothing.
    const filters: RecordedQuery['calls'] = [
      ['eq', ['id', other.id]],
      ['is', ['rooms.deleted_at', null]],
      ['eq', ['rooms.room_members.user_id', world.me]],
    ];
    expect(inviteAccessSelect(q(inner, ...filters), inner).data).toBeNull();
    // Without !inner on the members embed, the row still comes back (with no members).
    const outer = 'id, room_id, created_by, kind, rooms!inner(room_members(role))';
    expect(inviteAccessSelect(q(outer, ...filters), outer).data).toMatchObject({ id: other.id, rooms: { room_members: [] } });
    // Without !inner on rooms, a deleted room's invite comes back with a null room.
    const outerRooms = 'id, room_id, created_by, kind, rooms(room_members!inner(role))';
    const deletedFilters: RecordedQuery['calls'] = [['eq', ['id', deleted.id]], ['is', ['rooms.deleted_at', null]]];
    expect(inviteAccessSelect(q(outerRooms, ...deletedFilters), outerRooms).data).toMatchObject({ id: deleted.id, rooms: null });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a null embedded room', { rooms: null }],
    ['an empty member list', { rooms: { room_members: [] } }],
  ])('returns 404 (not 500) and calls no rpc when the lookup row has %s', async (_l, embed) => {
    buildWorld('owner');
    const { row } = seedLink();
    results.selectByTable.invites = { data: { id: row.id, room_id: ROOM_ID, created_by: OWNER_ID, kind: 'link', ...embed }, error: null };
    expectError(await revoke(row.id), 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it.each<[string, number, string]>([
    ['HX001', 404, 'NOT_FOUND'],
    ['HX002', 403, 'FORBIDDEN'],
    ['XX000', 500, 'INTERNAL'],
  ])('maps %s from revoke_invite to %i %s without echoing the DB error or broadcasting', async (sqlstate, status, code) => {
    buildWorld('owner');
    const row = seedDirect(OUTSIDER_STEAM);
    results.rpcByName.revoke_invite = rpcError(sqlstate);
    const res = await revoke(row.id);
    expectError(res, status, code);
    for (const leak of ['SECRET-DB-MESSAGE', 'ROWVALUE', 'HINTVALUE']) expect(res.text).not.toContain(leak);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

const writes: [string, () => string, unknown][] = [
  ['create', () => roomInvitesPath(ROOM_ID), { kind: 'link' }],
  ['revoke', () => invitePath(randomUUID()), undefined],
  ['redeem', () => redeemPath(newRandomToken()), undefined],
  ['accept', () => acceptPath(randomUUID()), undefined],
  ['decline', () => declinePath(randomUUID()), undefined],
];
const methodOf = (label: string): Method => (label === 'revoke' ? 'delete' : 'post');

describe('invites: CSRF', () => {
  it.each(writes)('rejects %s from a foreign or missing Origin with 403 ORIGIN_NOT_ALLOWED', async (label, path, body) => {
    buildWorld('owner');
    for (const origin of ['https://evil.example', 'http://localhost:5173.evil.example', 'null', null]) {
      expectError(await call(methodOf(label), path(), { body, origin }), 403, 'ORIGIN_NOT_ALLOWED');
    }
    expect(queries).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(writes)('rejects %s without a JSON Content-Type with 403 UNSUPPORTED_CONTENT_TYPE', async (label, path, body) => {
    buildWorld('owner');
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) {
      expectError(await call(methodOf(label), path(), { body, contentType }), 403, 'UNSUPPORTED_CONTENT_TYPE');
    }
    expect(queries).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it.each(writes.filter(([label]) => label !== 'create'))(
    'rejects a bodiless %s with no Content-Type header at all',
    async (label, path) => {
      buildWorld('owner');
      const res = await request(app)[methodOf(label)](path())
        .set('Cookie', `${SESSION_COOKIE}=${world.token}`)
        .set('Origin', WEB_ORIGIN);
      expectError(res, 403, 'UNSUPPORTED_CONTENT_TYPE');
      expect(fakeDb.rpc).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// Create: link
// ---------------------------------------------------------------------------

describe('POST /api/rooms/:roomId/invites (link)', () => {
  it.each<[string, unknown, string[]]>([
    ['a missing kind', {}, ['body.kind']],
    ['an unknown kind', { kind: 'email' }, ['body.kind']],
    ['an expiresIn outside the enum', { kind: 'link', expiresIn: '2d' }, ['body.expiresIn']],
    ['an expiresIn in milliseconds', { kind: 'link', expiresIn: 3_600_000 }, ['body.expiresIn']],
    ['maxUses 2', { kind: 'link', maxUses: 2 }, ['body.maxUses']],
    ['maxUses 0', { kind: 'link', maxUses: 0 }, ['body.maxUses']],
    ['maxUses 1000', { kind: 'link', maxUses: 1000 }, ['body.maxUses']],
    ['maxUses as a string', { kind: 'link', maxUses: '5' }, ['body.maxUses']],
    ['an unknown key', { kind: 'link', roomId: OTHER_ROOM_ID }, ['body']],
    ['a steamId on a link', { kind: 'link', steamId: OUTSIDER_STEAM }, ['body']],
    ['maxUses on a direct invite', { kind: 'direct', steamId: OUTSIDER_STEAM, maxUses: 5 }, ['body']],
    ['a token hash', { kind: 'link', tokenHash: 'a'.repeat(64) }, ['body']],
    ['an array', [{ kind: 'link' }], ['body']],
  ])('returns 422 for %s without calling the database function', async (_l, body, paths) => {
    buildWorld('member');
    const res = await create(body);
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(paths);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('defaults to 7 days and unlimited uses, and returns the invite, the token (once), and the url', async () => {
    buildWorld('member');
    const before = Date.now();
    const res = await create({ kind: 'link' });
    const after = Date.now();
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = CreatedInvite.parse(res.body);
    expect(body).toStrictEqual(res.body);

    const [args] = rpcCalls('create_link_invite');
    expect(Object.keys(args ?? {}).sort()).toEqual(['p_actor', 'p_expires_at', 'p_max_uses', 'p_room', 'p_token_hash']);
    expect(args?.p_room).toBe(ROOM_ID);
    expect(args?.p_actor).toBe(world.me);
    expect(args?.p_max_uses).toBeNull();
    const expires = Date.parse(String(args?.p_expires_at));
    expect(expires).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(expires).toBeLessThanOrEqual(after + 7 * DAY);

    const token = String(body.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(args?.p_token_hash).toBe(sha256(token));
    expect(body.url).toBe(`${WEB_ORIGIN}/invite/${token}`);
    expect(body.invite).toStrictEqual({
      id: body.invite.id,
      roomId: ROOM_ID,
      kind: 'link',
      createdBy: mySummary(),
      inviteeSteamId: null,
      maxUses: null,
      uses: 0,
      expiresAt: findInvite(body.invite.id).expires_at,
      createdAt: findInvite(body.invite.id).created_at,
      status: 'active',
    });
    // The hash the database returns never reaches the client; no link invite is broadcast.
    expect(res.text).not.toContain(sha256(token));
    expect(res.text).not.toContain('token_hash');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never sends the raw token to the database, and each invite gets a new token', async () => {
    buildWorld('member');
    const a = await create({ kind: 'link' });
    const b = await create({ kind: 'link' });
    expect(a.body.token).not.toBe(b.body.token);
    const sentToDb = JSON.stringify([fakeDb.rpc.mock.calls, queries]);
    for (const token of [a.body.token as string, b.body.token as string]) expect(sentToDb).not.toContain(token);
    expect(world.invites.map((i) => i.token_hash)).toEqual([sha256(a.body.token as string), sha256(b.body.token as string)]);
  });

  it("sends p_expires_at null for 'never' and returns expiresAt null", async () => {
    buildWorld('member');
    const res = await create({ kind: 'link', expiresIn: 'never' });
    expect(res.status).toBe(201);
    expect(rpcCalls('create_link_invite')[0]?.p_expires_at).toBeNull();
    expect(res.body.invite.expiresAt).toBeNull();
    expect(res.body.invite.status).toBe('active');
  });

  it.each(Object.entries(INVITE_EXPIRY_MS).filter(([, ms]) => ms !== null) as [string, number][])(
    'maps expiresIn %s to now + %i ms',
    async (expiresIn, ms) => {
      buildWorld('member');
      const before = Date.now();
      expect((await create({ kind: 'link', expiresIn })).status).toBe(201);
      const after = Date.now();
      const expires = Date.parse(String(rpcCalls('create_link_invite')[0]?.p_expires_at));
      expect(expires).toBeGreaterThanOrEqual(before + ms);
      expect(expires).toBeLessThanOrEqual(after + ms);
    },
  );

  it('pins the expiry table to the documented durations', () => {
    expect(INVITE_EXPIRY_MS).toStrictEqual({
      '30m': 30 * 60_000,
      '1h': HOUR,
      '6h': 6 * HOUR,
      '12h': 12 * HOUR,
      '1d': DAY,
      '7d': 7 * DAY,
      never: null,
    });
  });

  it.each([1, 5, 10, 25, 50, 100, null])('passes maxUses %s through', async (maxUses) => {
    buildWorld('member');
    const res = await create({ kind: 'link', maxUses });
    expect(res.status).toBe(201);
    expect(rpcCalls('create_link_invite')[0]?.p_max_uses).toBe(maxUses);
    expect(res.body.invite.maxUses).toBe(maxUses);
  });

  it('shows the token only once: the list, preview, and revoke never return it or its hash', async () => {
    buildWorld('owner');
    const created = await create({ kind: 'link' });
    const token = created.body.token as string;
    const texts = [
      (await listRoom('?status=all')).text,
      (await listRoom()).text,
      (await preview(token)).text,
      (await revoke(created.body.invite.id as string)).text,
      (await listRoom('?status=all')).text,
    ];
    for (const text of texts) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(sha256(token));
      expect(text).not.toMatch(/token/i);
    }
  });

  it('returns createdBy null when the creator profile row is missing', async () => {
    buildWorld('member');
    world.profiles = world.profiles.filter((p) => p.id !== world.me);
    const res = await create({ kind: 'link' });
    expect(res.status).toBe(201);
    expect(res.body.invite.createdBy).toBeNull();
  });

  it.each<[string, number, string]>([
    ['HX001', 404, 'NOT_FOUND'],
    ['22023', 422, 'VALIDATION_FAILED'],
    ['23514', 422, 'VALIDATION_FAILED'],
    ['23505', 500, 'INTERNAL'],
    ['XX000', 500, 'INTERNAL'],
  ])('maps %s from create_link_invite to %i %s without echoing the DB error', async (sqlstate, status, code) => {
    buildWorld('member');
    results.rpcByName.create_link_invite = rpcError(sqlstate);
    const res = await create({ kind: 'link' });
    expectError(res, status, code);
    expect(res.body.token).toBeUndefined();
    for (const leak of ['SECRET-DB-MESSAGE', 'ROWVALUE', 'HINTVALUE']) expect(res.text).not.toContain(leak);
  });

  it('returns a generic 500 (and no token) when create_link_invite returns an unexpected row', async () => {
    buildWorld('member');
    results.rpcByName.create_link_invite = { data: [{ id: randomUUID() }], error: null };
    const res = await create({ kind: 'link' });
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toMatch(/token/i);
  });
});

// ---------------------------------------------------------------------------
// Create: direct
// ---------------------------------------------------------------------------

describe('POST /api/rooms/:roomId/invites (direct)', () => {
  it.each<[string, unknown]>([
    ['16 digits', '7656119800000000'],
    ['18 digits', '765611980000000001'],
    ['letters', '7656119800000000a'],
    ['a vanity name', 'gaben'],
    ['a number', 76561198000000000],
    ['an empty string', ''],
    ['a padded id', ' 76561198000000004'],
    ['17 digits without the SteamID64 prefix', '12345678901234567'],
    ['17 digits with a near-miss prefix', '76561208000000004'],
    ['a missing steamId', undefined],
  ])('returns 422 for a steamId that is %s', async (_l, steamId) => {
    buildWorld('member');
    const res = await create({ kind: 'direct', ...(steamId === undefined ? {} : { steamId }) });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['body.steamId']);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it('invites a signed-in player: 201, 7-day expiry, and invite:received on their user topic', async () => {
    buildWorld('member');
    const before = Date.now();
    const res = await create({ kind: 'direct', steamId: OUTSIDER_STEAM });
    const after = Date.now();
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(CreatedInvite.parse(res.body)).toStrictEqual(res.body);
    expect(res.body.token).toBeUndefined();
    expect(res.body.url).toBeUndefined();

    const [args] = rpcCalls('create_direct_invite');
    expect(Object.keys(args ?? {}).sort()).toEqual(['p_actor', 'p_expires_at', 'p_room', 'p_steam_id']);
    expect(args).toMatchObject({ p_room: ROOM_ID, p_actor: world.me, p_steam_id: OUTSIDER_STEAM });
    const expires = Date.parse(String(args?.p_expires_at));
    expect(expires).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(expires).toBeLessThanOrEqual(after + 7 * DAY);

    const row = findInvite(res.body.invite.id as string);
    expect(res.body.invite).toStrictEqual({
      id: row.id,
      roomId: ROOM_ID,
      kind: 'direct',
      createdBy: mySummary(),
      inviteeSteamId: OUTSIDER_STEAM,
      maxUses: 1,
      uses: 0,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      status: 'active',
    });
    expect(res.text).not.toContain('invitee_profile_id');
    expect(res.text).not.toContain(OUTSIDER_ID);

    expect(expectOneBroadcast('user', OUTSIDER_ID, 'invite:received')).toStrictEqual({
      inviteId: row.id,
      room: { id: ROOM_ID, name: 'Night Raid', icon: emojiIcon },
      invitedBy: mySummary(),
      expiresAt: row.expires_at,
    });
  });

  it('carries a signed image URL (never the storage path) in invite:received for an image-icon room', async () => {
    buildWorld('owner');
    world.members.push({ room_id: OTHER_ROOM_ID, user_id: world.me, role: 'member', joined_at: ts(-DAY) });
    expect((await create({ kind: 'direct', steamId: OUTSIDER_STEAM }, OTHER_ROOM_ID)).status).toBe(201);
    const payload = expectOneBroadcast('user', OUTSIDER_ID, 'invite:received') as { room: unknown };
    expect(payload.room).toStrictEqual({ id: OTHER_ROOM_ID, name: 'Elsewhere', icon: { kind: 'image', url: signedIconUrl } });
    expect(JSON.stringify(sentBroadcasts())).not.toContain('"icon_path"');
  });

  it('broadcasts nothing when the Steam account has never signed in (the invite waits in their inbox)', async () => {
    buildWorld('member');
    const res = await create({ kind: 'direct', steamId: NEW_STEAM });
    expect(res.status).toBe(201);
    expect(res.body.invite.inviteeSteamId).toBe(NEW_STEAM);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('broadcasts nothing when the creator profile is missing (invite:received must name who invited)', async () => {
    buildWorld('member');
    world.profiles = world.profiles.filter((p) => p.id !== world.me);
    const res = await create({ kind: 'direct', steamId: OUTSIDER_STEAM });
    expect(res.status).toBe(201);
    expect(res.body.invite.createdBy).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<[string, () => string]>([
    ['a member', () => MEMBER_STEAM],
    ['the owner', () => OWNER_STEAM],
    ['myself', () => world.mySteam],
  ])('returns 409 ALREADY_MEMBER when inviting %s, with no broadcast', async (_l, steamId) => {
    buildWorld('admin');
    const res = await create({ kind: 'direct', steamId: steamId() });
    expectError(res, 409, 'ALREADY_MEMBER');
    expect(res.body.error.details).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(world.invites).toHaveLength(0);
  });

  it('returns 409 INVITE_ALREADY_PENDING for a second pending invite, with no broadcast', async () => {
    buildWorld('member');
    expect((await create({ kind: 'direct', steamId: OUTSIDER_STEAM })).status).toBe(201);
    fetchMock.mockClear();
    expectError(await create({ kind: 'direct', steamId: OUTSIDER_STEAM }), 409, 'INVITE_ALREADY_PENDING');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(world.invites).toHaveLength(1);
  });

  it('replaces an expired pending invite: invite:revoked for the old one, then invite:received for the new one', async () => {
    buildWorld('member');
    const old = seedDirect(OUTSIDER_STEAM, { expires_at: ts(-HOUR) });
    const res = await create({ kind: 'direct', steamId: OUTSIDER_STEAM });
    expect(res.status).toBe(201);
    expect(res.body.invite.id).not.toBe(old.id);
    expect(old.revoked_at).not.toBeNull();
    expect(res.text).not.toContain('replaced_invite_id');
    expect(res.text).not.toContain(old.id);

    const sent = sentBroadcasts();
    expect(sent.map((b) => [b.topic, b.event, b.private])).toEqual([
      [`user:${OUTSIDER_ID}`, 'invite:revoked', true],
      [`user:${OUTSIDER_ID}`, 'invite:received', true],
    ]);
    expect(serverEvents.user['invite:revoked'].parse(sent[0]?.payload)).toStrictEqual({ inviteId: old.id });
    expect(sent[0]?.payload).toStrictEqual({ inviteId: old.id });
    expect((sent[1]?.payload as { inviteId: string }).inviteId).toBe(res.body.invite.id);
  });

  it('sends invite:revoked for a replaced invite even when invite:received is skipped (creator profile missing)', async () => {
    buildWorld('member');
    world.profiles = world.profiles.filter((p) => p.id !== world.me);
    const old = seedDirect(OUTSIDER_STEAM, { expires_at: ts(-HOUR) });
    expect((await create({ kind: 'direct', steamId: OUTSIDER_STEAM })).status).toBe(201);
    expect(expectOneBroadcast('user', OUTSIDER_ID, 'invite:revoked')).toStrictEqual({ inviteId: old.id });
  });

  it('broadcasts nothing when replacing an expired invite to someone who never signed in', async () => {
    buildWorld('member');
    const old = seedDirect(NEW_STEAM, { expires_at: ts(-HOUR) });
    expect((await create({ kind: 'direct', steamId: NEW_STEAM })).status).toBe(201);
    expect(old.revoked_at).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('responds without waiting for the invite:received broadcast (timing does not reveal a profile)', async () => {
    buildWorld('member');
    let release: (() => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(new Response(null, { status: 202 }));
          };
        }),
    );
    const res = await create({ kind: 'direct', steamId: OUTSIDER_STEAM });
    expect(res.status).toBe(201);
    // The broadcast was started but has not completed when the response arrived.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(release).toBeDefined();
    release?.();
    await flushPending();
    expectOneBroadcast('user', OUTSIDER_ID, 'invite:received');
  });

  it('allows a new invite after the previous one was declined or revoked', async () => {
    buildWorld('member');
    seedDirect(OUTSIDER_STEAM, { declined_at: ts(-HOUR) });
    seedDirect(NEW_STEAM, { revoked_at: ts(-HOUR) });
    expect((await create({ kind: 'direct', steamId: OUTSIDER_STEAM })).status).toBe(201);
    expect((await create({ kind: 'direct', steamId: NEW_STEAM })).status).toBe(201);
  });

  it('maps 23514 from create_direct_invite to 422 on body.steamId without echoing the DB error', async () => {
    buildWorld('member');
    results.rpcByName.create_direct_invite = rpcError('23514');
    const res = await create({ kind: 'direct', steamId: OUTSIDER_STEAM });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['body.steamId']);
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still returns 201 when the broadcast fails', async () => {
    buildWorld('member');
    fetchMock.mockImplementation(() => Promise.reject(new Error('network')));
    expect((await create({ kind: 'direct', steamId: OUTSIDER_STEAM })).status).toBe(201);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns a generic 500 and broadcasts nothing when create_direct_invite returns an unexpected row', async () => {
    buildWorld('member');
    results.rpcByName.create_direct_invite = { data: [], error: null };
    expectError(await create({ kind: 'direct', steamId: OUTSIDER_STEAM }), 500, 'INTERNAL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('GET /api/rooms/:roomId/invites', () => {
  function seedMixed(): Record<string, InviteRow> {
    return {
      mine: seedLink({ created_by: world.me }).row,
      owners: seedLink({ created_by: OWNER_ID }).row,
      admins: seedDirect(OUTSIDER_STEAM, { created_by: ADMIN_ID }),
      elsewhere: seedLink({ room_id: OTHER_ROOM_ID, created_by: world.me }).row,
    };
  }

  it('shows a plain member only the invites they created (filtered in the query)', async () => {
    buildWorld('member');
    const seeded = seedMixed();
    const res = await listRoom();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(InvitePage.parse(res.body)).toStrictEqual(res.body);
    expect((res.body.data as { id: string }[]).map((i) => i.id)).toEqual([seeded.mine?.id]);
    const [query] = executedInviteSelects;
    expect(query?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    expect(query?.calls).toContainEqual(['eq', ['created_by', world.me]]);
  });

  it.each<[Role]>([['owner'], ['admin']])("shows an %s every invite in the room (and no other room's)", async (role) => {
    buildWorld(role);
    const seeded = seedMixed();
    const res = await listRoom();
    expect(new Set((res.body.data as { id: string }[]).map((i) => i.id))).toEqual(
      new Set([seeded.mine?.id, seeded.owners?.id, seeded.admins?.id]),
    );
    expect(executedInviteSelects[0]?.calls.some(([m, a]) => m === 'eq' && a[0] === 'created_by')).toBe(false);
  });

  function seedStatuses(): Record<string, InviteRow> {
    const s: Record<string, InviteRow> = {};
    s.active = seedLink().row;
    s.neverExpires = seedLink({ expires_at: null, max_uses: 5, uses: 4 }).row;
    s.activeDirect = seedDirect(OUTSIDER_STEAM);
    s.revoked = seedLink({ revoked_at: ts(-HOUR) }).row;
    s.expired = seedLink({ expires_at: ts(-60_000) }).row;
    s.usedUp = seedLink({ max_uses: 5, uses: 5 }).row;
    s.accepted = seedDirect(NEW_STEAM, { accepted_at: ts(-HOUR), uses: 1 });
    s.declined = seedDirect(MEMBER_STEAM, { declined_at: ts(-HOUR) });
    // Precedence: answered beats revoked, revoked beats expired and used up, expired beats used up
    // (the order redeem_invite_link checks them in).
    s.acceptedThenRevoked = seedDirect(ADMIN_STEAM, { accepted_at: ts(-2 * HOUR), revoked_at: ts(-HOUR), uses: 1 });
    s.declinedThenRevoked = seedDirect(OWNER_STEAM, { declined_at: ts(-2 * HOUR), revoked_at: ts(-HOUR) });
    s.revokedAndExpired = seedLink({ revoked_at: ts(-2 * HOUR), expires_at: ts(-HOUR) }).row;
    s.revokedAndUsedUp = seedLink({ revoked_at: ts(-2 * HOUR), max_uses: 1, uses: 1 }).row;
    s.usedUpAndExpired = seedLink({ max_uses: 1, uses: 1, expires_at: ts(-HOUR) }).row;
    s.acceptedAndExpired = seedDirect(freshSteamId(), { accepted_at: ts(-2 * DAY), uses: 1, expires_at: ts(-DAY) });
    return s;
  }

  const expectedStatus: Record<string, string> = {
    active: 'active',
    neverExpires: 'active',
    activeDirect: 'active',
    revoked: 'revoked',
    expired: 'expired',
    usedUp: 'used_up',
    accepted: 'accepted',
    declined: 'declined',
    acceptedThenRevoked: 'accepted',
    declinedThenRevoked: 'declined',
    revokedAndExpired: 'revoked',
    revokedAndUsedUp: 'revoked',
    usedUpAndExpired: 'expired',
    acceptedAndExpired: 'accepted',
  };

  it('status=all returns every invite with its computed status', async () => {
    buildWorld('owner');
    const s = seedStatuses();
    const res = await listRoom('?status=all');
    expect(InvitePage.parse(res.body)).toStrictEqual(res.body);
    const byId = new Map((res.body.data as { id: string; status: string }[]).map((i) => [i.id, i.status]));
    expect(byId.size).toBe(Object.keys(s).length);
    for (const [name, row] of Object.entries(s)) expect([name, byId.get(row.id)]).toEqual([name, expectedStatus[name]]);
  });

  it('status=active (the default) returns only usable invites, filtering in the query and dropping used-up rows in Node', async () => {
    buildWorld('owner');
    const s = seedStatuses();
    for (const query of ['', '?status=active']) {
      const res = await listRoom(query);
      const ids = new Set((res.body.data as { id: string }[]).map((i) => i.id));
      expect(ids).toEqual(new Set([s.active?.id, s.neverExpires?.id, s.activeDirect?.id]));
      for (const item of res.body.data as { status: string }[]) expect(item.status).toBe('active');
    }
    const query = executedInviteSelects[0];
    expect(query?.calls).toContainEqual(['is', ['revoked_at', null]]);
    expect(query?.calls).toContainEqual(['is', ['accepted_at', null]]);
    expect(query?.calls).toContainEqual(['is', ['declined_at', null]]);
    expect(String(firstArg(query as RecordedQuery, 'or'))).toMatch(EXPIRY_TREE);
    // The unexpired used-up row came back from the query and was dropped in Node.
    const fromDb = filterInvites(query as RecordedQuery).map((r) => r.id);
    expect(fromDb).toContain(s.usedUp?.id);
    expect(fromDb).not.toContain(s.usedUpAndExpired?.id);
  });

  it('pages newest first with a stable keyset (ties broken by id), ending with nextCursor null', async () => {
    buildWorld('owner');
    const tie = ts(-HOUR);
    for (let i = 0; i < 4; i++) seedLink();
    seedLink({ created_at: tie, id: '00000000-0000-4000-8000-00000000000a' });
    seedLink({ created_at: tie, id: '00000000-0000-4000-8000-00000000000b' });
    seedLink({ created_at: tie, id: '00000000-0000-4000-8000-00000000000c' });
    const expected = [...world.invites]
      .sort((a, b) => toMicros(b.created_at) - toMicros(a.created_at) || (a.id < b.id ? 1 : -1))
      .map((i) => i.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await listRoom(`?status=all&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      const page = InvitePage.parse(res.body);
      expect(page.data.length).toBeLessThanOrEqual(2);
      seen.push(...page.data.map((i) => i.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual(expected);
    expect(pages).toBe(4);
  });

  it('keeps paging past short active pages (used-up rows dropped in Node) without skipping or repeating', async () => {
    buildWorld('owner');
    const a = seedLink().row;
    seedLink({ max_uses: 1, uses: 1 });
    seedLink({ max_uses: 1, uses: 1 });
    const b = seedLink().row;
    seedLink({ max_uses: 5, uses: 5 });
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await listRoom(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      const page = InvitePage.parse(res.body);
      seen.push(...page.data.map((i) => i.id));
      sizes.push(page.data.length);
      cursor = page.nextCursor;
    } while (cursor !== null && sizes.length < 10);
    expect(seen).toEqual([b.id, a.id]);
    expect(sizes).toContain(0);
  });

  it.each<[string, string]>([
    ['not base64url JSON', '!!!'],
    ['an object', encodeCursor({ createdAt: '2026-09-26T10:00:00Z' })],
    ['an impossible date', encodeCursor(['2026-13-45T00:00:00Z', randomUUID()])],
    ['year 0', encodeCursor(['0000-01-01T00:00:00Z', randomUUID()])],
    ['a filter injection', encodeCursor(['2026-09-26T10:00:00Z"),id.gt.(', randomUUID()])],
    ['a bad id', encodeCursor(['2026-09-26T10:00:00Z', 'not-a-uuid'])],
    ['an id injection', encodeCursor(['2026-09-26T10:00:00Z', `${randomUUID()}),or(id.gt.0`])],
    ['more than 256 characters', 'a'.repeat(257)],
  ])('returns 422 for a cursor that is %s, without running the list query', async (_l, cursor) => {
    buildWorld('owner');
    seedLink();
    const res = await listRoom(`?cursor=${encodeURIComponent(cursor)}`);
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['query.cursor']);
    expect(executedInviteSelects).toHaveLength(0);
  });

  it.each(['?status=revoked', '?limit=0', '?limit=101', '?limit=abc'])('returns 422 for %s', async (query) => {
    buildWorld('owner');
    expectError(await listRoom(query), 422, 'VALIDATION_FAILED');
    expect(executedInviteSelects).toHaveLength(0);
  });

  it('never returns tokens or hashes, and returns createdBy null for a deleted creator profile', async () => {
    buildWorld('owner');
    const { row } = seedLink({ created_by: GONE_ID });
    seedLink({ created_by: world.me });
    const res = await listRoom('?status=all');
    expect(res.text).not.toMatch(/token/i);
    for (const invite of world.invites) expect(res.text).not.toContain(String(invite.token_hash));
    const orphan = (res.body.data as { id: string; createdBy: unknown }[]).find((i) => i.id === row.id);
    expect(orphan?.createdBy).toBeNull();
    const mine = (res.body.data as { createdBy: { id: string } | null }[]).find((i) => i.createdBy?.id === world.me);
    expect(mine?.createdBy).toStrictEqual(mySummary());
  });
});

// ---------------------------------------------------------------------------
// Preview (public)
// ---------------------------------------------------------------------------

describe('GET /api/invites/:token/preview', () => {
  it('returns the room name and icon, member count, inviter, and expiry, with no-store', async () => {
    buildWorld('owner');
    const { row, token } = seedLink({ created_by: OWNER_ID });
    const res = await preview(token);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(InvitePreview.parse(res.body)).toStrictEqual(res.body);
    expect(res.body).toStrictEqual({
      room: { name: 'Night Raid', icon: emojiIcon },
      memberCount: world.members.filter((m) => m.room_id === ROOM_ID).length,
      invitedBy: { displayName: 'Olivia', avatarUrl: 'https://avatars.test/owner.jpg' },
      expiresAt: row.expires_at,
    });
    // Nothing identifying beyond the preview: no ids (not even the inviter's profile id), no hash.
    expect(res.text).not.toContain(OWNER_ID);
    expect(res.text).not.toContain(ROOM_ID);
    expect(res.text).not.toContain(row.id);
    expect(res.text).not.toContain(sha256(token));
  });

  it('looks the invite up by hash, kind link, and live room (inner join)', async () => {
    buildWorld('owner');
    const { token } = seedLink();
    expect((await preview(token)).status).toBe(200);
    const [query] = executedInviteSelects;
    expect(String(firstArg(query as RecordedQuery, 'select'))).toContain('rooms!inner(');
    expect(query?.calls).toContainEqual(['eq', ['token_hash', sha256(token)]]);
    expect(query?.calls).toContainEqual(['eq', ['kind', 'link']]);
    expect(query?.calls).toContainEqual(['is', ['rooms.deleted_at', null]]);
    expect(JSON.stringify(queries)).not.toContain(token);
    const count = queriesOn('room_members').at(-1);
    expect(count?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
  });

  it('serves an image icon as a signed URL, never the storage path', async () => {
    buildWorld('owner');
    const { token } = seedLink({ room_id: OTHER_ROOM_ID });
    const res = await preview(token);
    expect(res.body.room.icon).toStrictEqual({ kind: 'image', url: signedIconUrl });
    expect(storageCalls.map((c) => c.bucket)).toEqual(['room-icons']);
    expect(res.text).not.toContain(`"${ICON_PATH}"`);
  });

  it('returns invitedBy null for a deleted creator profile and expiresAt null for a never-expiring link', async () => {
    buildWorld('owner');
    const { token } = seedLink({ created_by: GONE_ID, expires_at: null, max_uses: 10, uses: 9 });
    const res = await preview(token);
    expect(res.status).toBe(200);
    expect(res.body.invitedBy).toBeNull();
    expect(res.body.expiresAt).toBeNull();
  });

  it('returns an identical no-store 404 for every unusable link', async () => {
    buildWorld('owner');
    const unknown = await preview(newRandomToken());
    expectError(unknown, 404, 'NOT_FOUND');
    expect(unknown.body.error.message).toBe('This invite is invalid or no longer usable.');
    const directToken = newRandomToken();
    credentials.push(directToken);
    // Not a state the DB allows (direct invites have no hash), but the kind filter must still hold.
    seedDirect(OUTSIDER_STEAM, { token_hash: sha256(directToken) });
    const cases = {
      revoked: seedLink({ revoked_at: ts(-HOUR) }).token,
      expired: seedLink({ expires_at: ts(-60_000) }).token,
      usedUp: seedLink({ max_uses: 5, uses: 5 }).token,
      deletedRoom: seedLink({ room_id: DELETED_ROOM_ID }).token,
      direct: directToken,
    };
    for (const [name, token] of Object.entries(cases)) {
      const res = await preview(token);
      expect([name, res.status]).toEqual([name, 404]);
      expect(res.body).toStrictEqual(unknown.body);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(unknown.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['42 characters', 'a'.repeat(42)],
    ['44 characters', 'a'.repeat(44)],
    ['standard base64 characters', `${'a'.repeat(41)}+/`],
    ['a filter injection', `${'a'.repeat(33)},kind.eq.x`],
    ['a dot', `${'a'.repeat(42)}.`],
  ])('returns the same 404 for a malformed token (%s) without any query', async (_l, token) => {
    buildWorld('owner');
    const unknown = await preview(newRandomToken());
    queries.length = 0;
    const res = await preview(encodeURIComponent(token));
    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(unknown.body);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(queries).toHaveLength(0);
  });

  it('rate limits per IP: the 61st request in a minute from one IP is 429, other IPs are unaffected', async () => {
    buildWorld('owner');
    const { token } = seedLink();
    const ip = freshIp();
    for (let i = 0; i < 60; i++) expect((await preview(i % 2 ? token : newRandomToken(), ip)).status).not.toBe(429);
    expectError(await preview(token, ip), 429, 'RATE_LIMITED');
    expect((await preview(token)).status).toBe(200);
  });

  it('works for a signed-in non-member too, and does not reveal membership', async () => {
    buildWorld(null);
    const { token } = seedLink();
    const res = await request(app)
      .get(previewPath(token))
      .set('X-Forwarded-For', freshIp())
      .set('Cookie', `${SESSION_COOKIE}=${world.token}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual(['expiresAt', 'invitedBy', 'memberCount', 'room']);
  });
});

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

describe('POST /api/invites/:token/redeem', () => {
  it('joins: 200 with the room, one use consumed, and exactly one member:joined on room:<id>', async () => {
    buildWorld(null);
    const { row, token } = seedLink({ max_uses: 5, uses: 2 });
    const res = await redeem(token);
    expect(res.status).toBe(200);
    expect(RedeemInviteResult.parse(res.body)).toStrictEqual(res.body);
    expect(res.body.status).toBe('joined');
    expect(res.body.room.room.id).toBe(ROOM_ID);
    expect(res.body.room.myRole).toBe('member');
    expect(res.body.room.defaultChannelId).toBe(GENERAL_ID);
    expect((res.body.room.members as { user: { id: string } }[]).map((m) => m.user.id)).toContain(world.me);
    expect(rpcCalls('redeem_invite_link')).toEqual([{ p_token_hash: sha256(token), p_user: world.me }]);
    expect(row.uses).toBe(3);

    const joinedAt = world.members.find((m) => m.room_id === ROOM_ID && m.user_id === world.me)?.joined_at;
    expect(expectOneBroadcast('room', ROOM_ID, 'member:joined')).toStrictEqual({
      member: { roomId: ROOM_ID, user: mySummary(), role: 'member', joinedAt, currentGame: null },
    });
    expect(JSON.stringify(sentBroadcasts())).not.toContain(world.mySteam);
  });

  it('is idempotent: redeeming again returns already_member, consumes no use, and broadcasts nothing', async () => {
    buildWorld(null);
    const { row, token } = seedLink({ max_uses: 1 });
    expect((await redeem(token)).body.status).toBe('joined');
    fetchMock.mockClear();
    const again = await redeem(token);
    expect(again.status).toBe(200);
    expect(RedeemInviteResult.parse(again.body).status).toBe('already_member');
    expect(row.uses).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns already_member (200, no broadcast) for an existing member, even on a revoked or used-up link', async () => {
    buildWorld('member');
    for (const extra of [{}, { revoked_at: ts(-HOUR) }, { max_uses: 1, uses: 1 }]) {
      const res = await redeem(seedLink(extra).token);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('already_member');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<InviteRow>, number, string]>([
    ['revoked', { revoked_at: ts(-HOUR) }, 410, 'INVITE_REVOKED'],
    ['expired', { expires_at: ts(-60_000) }, 410, 'INVITE_EXPIRED'],
    ['used up', { max_uses: 10, uses: 10 }, 410, 'INVITE_USED_UP'],
    ['in a deleted room', { room_id: DELETED_ROOM_ID }, 404, 'NOT_FOUND'],
  ])('returns %i %s for a link that is %s, without joining or broadcasting', async (_l, extra, status, code) => {
    buildWorld(null);
    const before = world.members.length;
    expectError(await redeem(seedLink(extra).token), status, code);
    expect(world.members).toHaveLength(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the preview 404 body for an unknown token and a deleted room', async () => {
    buildWorld(null);
    const unknownPreview = await preview(newRandomToken());
    const unknown = await redeem(newRandomToken());
    const deleted = await redeem(seedLink({ room_id: DELETED_ROOM_ID }).token);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toStrictEqual(unknownPreview.body);
    expect(deleted.body).toStrictEqual(unknown.body);
  });

  it('returns 404 for a direct invite (not a link) without joining', async () => {
    buildWorld(null);
    const token = newRandomToken();
    credentials.push(token);
    seedDirect(world.mySteam, { token_hash: sha256(token) });
    expectError(await redeem(token), 404, 'NOT_FOUND');
    expect(world.members.some((m) => m.room_id === ROOM_ID && m.user_id === world.me)).toBe(false);
  });

  it.each(['a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(41)}+/`, `${'a'.repeat(33)},kind.eq.x`])(
    'returns 404 for the malformed token %s without calling redeem_invite_link',
    async (token) => {
      buildWorld(null);
      expectError(await redeem(encodeURIComponent(token)), 404, 'NOT_FOUND');
      expect(fakeDb.rpc).not.toHaveBeenCalled();
    },
  );

  it('lets exactly one of two concurrent redemptions take the last use', async () => {
    buildWorld(null);
    const otherToken = addUser(randomUUID(), freshSteamId(), 'Second');
    const { row, token } = seedLink({ max_uses: 3, uses: 2 });
    const [a, b] = await Promise.all([redeem(token), redeem(token, { token: otherToken })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 410]);
    const loser = a.status === 410 ? a : b;
    expect(loser.body.error.code).toBe('INVITE_USED_UP');
    expect(row.uses).toBe(3);
    expect(sentBroadcasts().filter((m) => m.event === 'member:joined')).toHaveLength(1);
  });

  it('still returns 200 when the member:joined broadcast fails, or the joined member cannot be loaded', async () => {
    buildWorld(null);
    fetchMock.mockImplementation(() => Promise.reject(new Error('network')));
    expect((await redeem(seedLink().token)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();

    becomeNewUser(null);
    fetchMock.mockClear();
    const members = results.selectByTable.room_members;
    results.selectByTable.room_members = (query) => {
      const cols = String(firstArg(query, 'select'));
      if (cols.startsWith('user_id, role') && isSingle(query)) return rpcError('XX000');
      return typeof members === 'function' ? members(query) : { data: null, error: null };
    };
    const res = await redeem(seedLink().token);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('joined');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logLines.join('')).toContain('member:joined not sent');
  });

  it.each(['22023', 'XX000'])('maps %s from redeem_invite_link to a generic 500 without echoing the DB error', async (sqlstate) => {
    buildWorld(null);
    results.rpcByName.redeem_invite_link = rpcError(sqlstate);
    const res = await redeem(seedLink().token);
    expect(res.status).toBe(sqlstate === '22023' ? 422 : 500);
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a generic 500 for joined without a room_id or an unknown status', async () => {
    buildWorld(null);
    results.rpcByName.redeem_invite_link = { data: [{ room_id: null, status: 'joined' }], error: null };
    expectError(await redeem(seedLink().token), 500, 'INTERNAL');
    results.rpcByName.redeem_invite_link = { data: [{ room_id: ROOM_ID, status: 'teleported' }], error: null };
    expectError(await redeem(seedLink().token), 500, 'INTERNAL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

describe('GET /api/me/invites', () => {
  it('lists only pending, unexpired direct invites to my Steam account in live rooms, newest first', async () => {
    buildWorld(null);
    const older = seedDirect(world.mySteam, { created_by: OWNER_ID, expires_at: null });
    const newer = seedDirect(world.mySteam, { room_id: OTHER_ROOM_ID, created_by: OWNER_ID });
    seedDirect(OUTSIDER_STEAM);
    seedDirect(world.mySteam, { revoked_at: ts(-HOUR) });
    seedDirect(world.mySteam, { accepted_at: ts(-HOUR) });
    seedDirect(world.mySteam, { declined_at: ts(-HOUR) });
    seedDirect(world.mySteam, { expires_at: ts(-60_000) });
    seedDirect(world.mySteam, { room_id: DELETED_ROOM_ID });
    seedDirect(world.mySteam, { created_by: GONE_ID });
    seedLink();

    const res = await inbox();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(InboxPage.parse(res.body)).toStrictEqual(res.body);
    expect(res.body).toStrictEqual({
      data: [
        {
          inviteId: newer.id,
          room: { id: OTHER_ROOM_ID, name: 'Elsewhere', icon: { kind: 'image', url: signedIconUrl } },
          invitedBy: ownerSummary,
          expiresAt: newer.expires_at,
        },
        { inviteId: older.id, room: { id: ROOM_ID, name: 'Night Raid', icon: emojiIcon }, invitedBy: ownerSummary, expiresAt: null },
      ],
    });
    // Each item has the same shape as the invite:received payload.
    for (const item of res.body.data as unknown[]) {
      expect(serverEvents.user['invite:received'].parse(item)).toStrictEqual(item);
    }
  });

  it('filters in the query: kind, my steam id, pending, unexpired, live room, creator exists, limit 100', async () => {
    buildWorld(null);
    seedDirect(world.mySteam);
    expect((await inbox()).status).toBe(200);
    const [query] = executedInviteSelects;
    const select = String(firstArg(query as RecordedQuery, 'select'));
    expect(select).toContain('rooms!inner(');
    expect(select).toContain('profiles!inner(');
    for (const call of [
      ['eq', ['kind', 'direct']],
      ['eq', ['invitee_steam_id', world.mySteam]],
      ['is', ['revoked_at', null]],
      ['is', ['accepted_at', null]],
      ['is', ['declined_at', null]],
      ['is', ['rooms.deleted_at', null]],
      ['limit', [100]],
    ]) {
      expect(query?.calls).toContainEqual(call);
    }
    expect(String(firstArg(query as RecordedQuery, 'or'))).toMatch(EXPIRY_TREE);
    const lookup = queriesOn('profiles')[0];
    expect(lookup?.calls).toContainEqual(['eq', ['id', world.me]]);
  });

  it('returns at most 100 invites', async () => {
    buildWorld(null);
    for (let i = 0; i < 105; i++) {
      world.rooms.push({ id: randomUUID(), name: `Room ${String(i)}`, icon_emoji: '🎲', icon_path: null, created_at: ts(-DAY), deleted_at: null });
      seedDirect(world.mySteam, { room_id: world.rooms.at(-1)?.id ?? '' });
    }
    const res = await inbox();
    expect(res.body.data).toHaveLength(100);
  });

  it('is empty (not an error) when my profile row is gone', async () => {
    buildWorld(null);
    seedDirect(world.mySteam);
    world.profiles = world.profiles.filter((p) => p.id !== world.me);
    const res = await inbox();
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ data: [] });
    expect(executedInviteSelects).toHaveLength(0);
  });

  it('drops an invite from the inbox once it is revoked, accepted, or declined', async () => {
    buildWorld('owner');
    const direct = seedDirect(world.mySteam, { room_id: OTHER_ROOM_ID });
    expect((await inbox()).body.data).toHaveLength(1);
    direct.revoked_at = ts(0);
    expect((await inbox()).body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Accept / decline
// ---------------------------------------------------------------------------

describe('POST /api/me/invites/:inviteId/accept and /decline', () => {
  it('accepts: 200 with the room, the invite marked accepted, and exactly one member:joined', async () => {
    buildWorld(null);
    const invite = seedDirect(world.mySteam, { room_id: OTHER_ROOM_ID });
    const res = await accept(invite.id);
    expect(res.status).toBe(200);
    expect(AcceptInviteResult.parse(res.body)).toStrictEqual(res.body);
    expect(res.body.status).toBe('accepted');
    expect(res.body.room.room.id).toBe(OTHER_ROOM_ID);
    expect(res.body.room.myRole).toBe('member');
    expect(rpcCalls('respond_to_direct_invite')).toEqual([{ p_invite: invite.id, p_user: world.me, p_accept: true }]);
    expect(invite.accepted_at).not.toBeNull();
    const joinedAt = world.members.find((m) => m.room_id === OTHER_ROOM_ID && m.user_id === world.me)?.joined_at;
    expect(expectOneBroadcast('room', OTHER_ROOM_ID, 'member:joined')).toStrictEqual({
      member: { roomId: OTHER_ROOM_ID, user: mySummary(), role: 'member', joinedAt, currentGame: null },
    });
  });

  it('returns already_member (no broadcast) when I was already in the room', async () => {
    buildWorld('member');
    const invite = seedDirect(world.mySteam);
    const res = await accept(invite.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_member');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is idempotent: retrying a successful accept returns already_member with no second broadcast', async () => {
    buildWorld(null);
    const invite = seedDirect(world.mySteam);
    expect((await accept(invite.id)).body.status).toBe('accepted');
    const again = await accept(invite.id);
    expect(again.status).toBe(200);
    expect(AcceptInviteResult.parse(again.body).status).toBe('already_member');
    expect(sentBroadcasts()).toHaveLength(1);
  });

  it('returns 409 INVITE_ALREADY_RESPONDED for accepting after being removed from the room, or after declining', async () => {
    buildWorld(null);
    const accepted = seedDirect(world.mySteam);
    expect((await accept(accepted.id)).status).toBe(200);
    world.members = world.members.filter((m) => !(m.room_id === ROOM_ID && m.user_id === world.me));
    expectError(await accept(accepted.id), 409, 'INVITE_ALREADY_RESPONDED');
    expect(world.members.some((m) => m.room_id === ROOM_ID && m.user_id === world.me)).toBe(false);

    const declined = seedDirect(world.mySteam, { room_id: OTHER_ROOM_ID });
    expect((await decline(declined.id)).status).toBe(204);
    expectError(await accept(declined.id), 409, 'INVITE_ALREADY_RESPONDED');
    expect(sentBroadcasts()).toHaveLength(1);
  });

  it('declines: 204, the invite marked declined, no broadcast; declining again is 204', async () => {
    buildWorld(null);
    const invite = seedDirect(world.mySteam);
    const res = await decline(invite.id);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(rpcCalls('respond_to_direct_invite')).toEqual([{ p_invite: invite.id, p_user: world.me, p_accept: false }]);
    expect(invite.declined_at).not.toBeNull();
    expect((await decline(invite.id)).status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(world.members.some((m) => m.user_id === world.me && m.room_id === ROOM_ID)).toBe(false);
  });

  it('returns 409 INVITE_ALREADY_RESPONDED for declining an accepted invite, and stays a member', async () => {
    buildWorld(null);
    const invite = seedDirect(world.mySteam);
    expect((await accept(invite.id)).status).toBe(200);
    expectError(await decline(invite.id), 409, 'INVITE_ALREADY_RESPONDED');
    expect(invite.declined_at).toBeNull();
    expect(world.members.some((m) => m.user_id === world.me && m.room_id === ROOM_ID)).toBe(true);
  });

  const respondRoutes: [string, (id: string) => request.Test][] = [
    ['accept', accept],
    ['decline', decline],
  ];

  it.each(respondRoutes)('%s returns 410 INVITE_REVOKED / INVITE_EXPIRED without joining', async (_l, route) => {
    buildWorld(null);
    expectError(await route(seedDirect(world.mySteam, { revoked_at: ts(-HOUR) }).id), 410, 'INVITE_REVOKED');
    expectError(await route(seedDirect(world.mySteam, { expires_at: ts(-60_000) }).id), 410, 'INVITE_EXPIRED');
    expect(world.members.some((m) => m.user_id === world.me && m.room_id === ROOM_ID)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(respondRoutes)(
    "%s returns an identical 404 for an unknown id, someone else's invite, a link invite, and a deleted room",
    async (_l, route) => {
      buildWorld(null);
      const unknown = await route(randomUUID());
      expectError(unknown, 404, 'NOT_FOUND');
      const someoneElses = seedDirect(OUTSIDER_STEAM);
      const others = [
        await route(someoneElses.id),
        await route(seedLink().row.id),
        await route(seedDirect(world.mySteam, { room_id: DELETED_ROOM_ID }).id),
        await route('not-a-uuid'),
      ];
      for (const res of others) {
        expect(res.status).toBe(404);
        expect(res.body).toStrictEqual(unknown.body);
      }
      expect(someoneElses.accepted_at).toBeNull();
      expect(someoneElses.declined_at).toBeNull();
      expect(world.members.some((m) => m.user_id === world.me && m.room_id === ROOM_ID)).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(respondRoutes)('%s returns 404 without calling the database for malformed ids', async (_l, route) => {
    buildWorld(null);
    for (const id of ['not-a-uuid', `${randomUUID()}x`, '123', encodeURIComponent(`${randomUUID()},kind.eq.link`)]) {
      expectError(await route(id), 404, 'NOT_FOUND');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it.each(respondRoutes)('%s lowercases an uppercase inviteId', async (_l, route) => {
    buildWorld(null);
    const invite = seedDirect(world.mySteam);
    expect((await route(invite.id.toUpperCase())).status).toBeLessThan(300);
    expect(rpcCalls('respond_to_direct_invite')[0]?.p_invite).toBe(invite.id);
  });

  it('returns a generic 500 when respond_to_direct_invite fails, without echoing the DB error', async () => {
    buildWorld(null);
    results.rpcByName.respond_to_direct_invite = rpcError('XX000');
    const res = await accept(seedDirect(world.mySteam).id);
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
  });
});

// ---------------------------------------------------------------------------
// Revoke broadcasts
// ---------------------------------------------------------------------------

describe('DELETE /api/invites/:inviteId broadcasts', () => {
  it('tells a signed-in invitee of a pending direct invite with invite:revoked {inviteId} on user:<id>', async () => {
    buildWorld('member');
    const invite = seedDirect(OUTSIDER_STEAM, { created_by: world.me });
    expect((await revoke(invite.id)).status).toBe(204);
    expect(expectOneBroadcast('user', OUTSIDER_ID, 'invite:revoked')).toStrictEqual({ inviteId: invite.id });
  });

  it.each<[string, () => InviteRow]>([
    ['a link invite', () => seedLink().row],
    ['a direct invite to someone who never signed in', () => seedDirect(NEW_STEAM)],
    ['an accepted direct invite', () => seedDirect(OUTSIDER_STEAM, { accepted_at: ts(-HOUR), uses: 1 })],
    ['a declined direct invite', () => seedDirect(OUTSIDER_STEAM, { declined_at: ts(-HOUR) })],
  ])('broadcasts nothing when revoking %s', async (_l, seed) => {
    buildWorld('owner');
    const invite = seed();
    expect((await revoke(invite.id)).status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still returns 204 when the broadcast is rejected', async () => {
    buildWorld('owner');
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 })));
    expect((await revoke(seedDirect(OUTSIDER_STEAM).id)).status).toBe(204);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('makes a revoked link unusable right away: preview 404, redeem 410', async () => {
    buildWorld('owner');
    const { row, token } = seedLink();
    expect((await revoke(row.id)).status).toBe(204);
    expectError(await preview(token), 404, 'NOT_FOUND');
    becomeNewUser(null);
    world.invites.push(row);
    expectError(await redeem(token), 410, 'INVITE_REVOKED');
  });
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

describe('invites: rate limits', () => {
  it('limits invite creation to 20 per hour per user; other users are unaffected', async () => {
    buildWorld('member');
    for (let i = 0; i < 20; i++) expect((await create({ kind: 'link' })).status).toBe(201);
    expectError(await create({ kind: 'link' }), 429, 'RATE_LIMITED');
    expectError(await create({ kind: 'direct', steamId: OUTSIDER_STEAM }), 429, 'RATE_LIMITED');
    expect(fakeDb.rpc).toHaveBeenCalledTimes(20);
    becomeNewUser('member');
    expect((await create({ kind: 'link' })).status).toBe(201);
  });

  it('shares one 10-per-minute budget across redeem, accept, and decline', async () => {
    buildWorld(null);
    for (let i = 0; i < 4; i++) expect((await redeem(seedLink().token)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await accept(seedDirect(world.mySteam, { room_id: OTHER_ROOM_ID }).id)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await decline(seedDirect(world.mySteam, { room_id: OTHER_ROOM_ID }).id)).status).toBe(204);
    expectError(await redeem(seedLink().token), 429, 'RATE_LIMITED');
    expectError(await accept(seedDirect(world.mySteam).id), 429, 'RATE_LIMITED');
    expectError(await decline(seedDirect(world.mySteam).id), 429, 'RATE_LIMITED');
    expect(fakeDb.rpc).toHaveBeenCalledTimes(10);
  });

  it('charges redeem attempts with unknown or malformed tokens (token guessing is rate limited)', async () => {
    buildWorld(null);
    for (let i = 0; i < 5; i++) expectError(await redeem(newRandomToken()), 404, 'NOT_FOUND');
    for (let i = 0; i < 5; i++) expectError(await redeem('short'), 404, 'NOT_FOUND');
    expectError(await redeem(seedLink().token), 429, 'RATE_LIMITED');
  });

  it('shares one 60-per-minute read budget between the room list and the inbox', async () => {
    buildWorld('member');
    for (let i = 0; i < 30; i++) expect((await listRoom()).status).toBe(200);
    for (let i = 0; i < 30; i++) expect((await inbox()).status).toBe(200);
    expectError(await listRoom(), 429, 'RATE_LIMITED');
    expectError(await inbox(), 429, 'RATE_LIMITED');
    // Writes have their own budget.
    expect((await create({ kind: 'link' })).status).toBe(201);
  });

  it('limits revokes to 60 per hour per user', async () => {
    buildWorld('owner');
    const { row } = seedLink();
    for (let i = 0; i < 60; i++) expect((await revoke(row.id)).status).toBe(204);
    expectError(await revoke(row.id), 429, 'RATE_LIMITED');
    expect(rpcCalls('revoke_invite')).toHaveLength(60);
  });

  it('does not charge the create, list, or revoke budgets for 401, 404, or 403 responses', async () => {
    buildWorld('member');
    const others = seedLink({ created_by: ADMIN_ID }).row;
    for (let i = 0; i < 61; i++) {
      expectError(await create({ kind: 'link' }, ROOM_ID, { signedIn: false }), 401, 'UNAUTHENTICATED');
      expectError(await create({ kind: 'link' }, OTHER_ROOM_ID), 404, 'NOT_FOUND');
      expectError(await listRoom('', OTHER_ROOM_ID), 404, 'NOT_FOUND');
      expectError(await revoke(randomUUID()), 404, 'NOT_FOUND');
      expectError(await revoke(others.id), 403, 'FORBIDDEN');
    }
    for (let i = 0; i < 20; i++) expect((await create({ kind: 'link' })).status).toBe(201);
    expect((await listRoom()).status).toBe(200);
    expect((await revoke(seedLink({ created_by: world.me }).row.id)).status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Logs and secrets
// ---------------------------------------------------------------------------

describe('invites: logs and secrets', () => {
  it('never logs link tokens, token hashes, the session token, the service key, or DB details', async () => {
    buildWorld('owner');
    const texts: string[] = [];
    const created = await create({ kind: 'link' });
    texts.push(created.text);
    const token = created.body.token as string;
    texts.push((await preview(token)).text);
    texts.push((await preview(newRandomToken())).text);
    texts.push((await listRoom('?status=all')).text);
    texts.push((await create({ kind: 'direct', steamId: OUTSIDER_STEAM })).text);

    const saved = world.invites;
    becomeNewUser(null);
    world.invites.push(...saved);
    texts.push((await redeem(token)).text);
    texts.push((await inbox()).text);
    const direct = seedDirect(world.mySteam, { room_id: OTHER_ROOM_ID });
    texts.push((await accept(direct.id)).text);
    texts.push((await decline(seedDirect(world.mySteam).id)).text);
    results.rpcByName.redeem_invite_link = rpcError('XX000');
    texts.push((await redeem(seedLink().token)).text);
    results.selectByTable.invites = rpcError('XX000');
    texts.push((await preview(seedLink().token)).text);

    const logs = logLines.join('');
    expect(logs).toContain('redeem_invite_link failed');
    expect(logs).toContain('invite preview lookup failed');
    expect(logs).toContain('/api/invites/[redacted]');
    for (const secret of [...credentials, ...sessions.keys(), 'test-service-role-key', 'ROWVALUE', 'HINTVALUE']) {
      expect(logs).not.toContain(secret);
    }
    for (const text of [...texts, JSON.stringify(sentBroadcasts())]) {
      for (const secret of [...sessions.keys(), 'test-service-role-key', 'SECRET-DB-MESSAGE', 'ROWVALUE']) {
        expect(text).not.toContain(secret);
      }
      for (const hash of credentials.filter((c) => /^[0-9a-f]{64}$/.test(c))) expect(text).not.toContain(hash);
    }
  });

  it('does not log the token when the path is sent with different letter case', async () => {
    buildWorld('owner');
    const { token } = seedLink();
    const res = await request(app).get(`/API/Invites/${token}/preview`).set('X-Forwarded-For', freshIp());
    expect(res.status).toBe(200);
    expect(logLines.join('')).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------
// Referer from the invite page
// ---------------------------------------------------------------------------

describe('invites: Referer from the invite page', () => {
  it('never logs the link token the browser sends in Referer (preview and redeem)', async () => {
    buildWorld('owner');
    const { token } = seedLink();
    const referer = `${WEB_ORIGIN}/invite/${token}`;
    expect((await preview(token).set('Referer', referer)).status).toBe(200);
    becomeNewUser(null);
    const { token: other } = seedLink();
    expect((await redeem(other).set('Referer', `${WEB_ORIGIN}/invite/${other}`)).status).toBe(200);
    const logs = logLines.join('');
    expect(logs).toContain(`${WEB_ORIGIN}/invite/[redacted]`);
    // afterEach also checks that neither token (nor its hash) reached any log line.
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(other);
  });
});
