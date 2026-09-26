import { createHash, randomUUID } from 'node:crypto';
import type * as PinoModule from 'pino';
import type * as LivekitModule from '../src/lib/livekit.js';
import { ServerError } from 'livekit-server-sdk';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, firstArg, queries, resetFakeDb, results, type DbResult, type RecordedQuery } from './helpers/fakeDb.js';

/*
 * Room bans through the real app, offline:
 *   POST /api/rooms/:roomId/bans, GET /api/rooms/:roomId/bans, DELETE /api/rooms/:roomId/bans/:steamId,
 * plus the places a ban is enforced (link redeem, direct invite accept/decline/create) and the
 * invite:revoked broadcasts of DELETE /api/rooms/:roomId.
 * The database is faked at the supabase-js client with an in-memory world whose reads honour only
 * the filters the services send (eq/is/in, PostgREST's `!inner` embeds, the keyset `or` tree,
 * order, and limit), so a dropped filter shows up as a leak. ban_member, unban,
 * redeem_invite_link, respond_to_direct_invite, create_direct_invite, and delete_room mirror
 * supabase/migrations/20260926130308_bans.sql (check order, statuses, return shapes, SQLSTATEs);
 * remove_member mirrors 20260926054446_membership.sql. Broadcasts are observed at the Realtime
 * REST fetch boundary (so broadcast.ts's schema check runs), LiveKit at livekitRooms. Every log
 * line (LOG_LEVEL=trace) is captured and checked for secrets.
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
const { hashSessionToken, newRandomToken, SESSION_COOKIE } = await import('../src/lib/session.js');
const { Ban, BanPage } = await import('../src/contracts/http/bans.js');
const { AcceptInviteResult, CreatedInvite, RedeemInviteResult } = await import('../src/contracts/http/invites.js');
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

const ROOM_ID = '3c000000-0000-4000-8000-00000000c001';
const OTHER_ROOM_ID = '3c000000-0000-4000-8000-00000000c002';
const GENERAL_ID = 'c3000000-0000-4000-8000-00000000c201';
const VOICE_ID = 'c3000000-0000-4000-8000-00000000c202';
const VOICE2_ID = 'c3000000-0000-4000-8000-00000000c203';
const DELETED_VOICE_ID = 'c3000000-0000-4000-8000-00000000c204';
const OTHER_VOICE_ID = 'c3000000-0000-4000-8000-00000000c205';
const T0 = '2026-09-01T10:00:00.123456+00:00';
/** A Steam account that never signed in (no profile). */
const UNSIGNED_STEAM = '76561197999999999';

const DB_SECRET_MESSAGE = 'SECRET-DB-MESSAGE violates check';
const DB_DETAILS = 'Failing row contains (ROWVALUE-DETAILS)';

// ---------------------------------------------------------------------------
// Timestamps (PostgREST renders timestamptz with microseconds and +00:00)
// ---------------------------------------------------------------------------

function pgTs(micros: number): string {
  const seconds = Math.floor(micros / 1_000_000);
  const frac = String(micros - seconds * 1_000_000).padStart(6, '0');
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${frac}+00:00`;
}

function toMicros(ts: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(ts);
  if (!m) throw new Error(`fake db: unparseable timestamp ${ts}`);
  return Date.parse(`${m[1] ?? ''}${m[3] ?? ''}`) * 1000 + Number((m[2] ?? '').padEnd(6, '0'));
}

let clock = toMicros('2026-09-26T12:00:00.000000+00:00');
/** A strictly increasing timestamp for rows the fake functions write. */
function nextTs(): string {
  clock += 1_000_000;
  return pgTs(clock);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

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
}
interface ProfileRow {
  id: string;
  steam_id: string;
  display_name: string;
  avatar_url: string | null;
  current_game: string | null;
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
interface BanRow {
  room_id: string;
  steam_id: string;
  banned_by: string | null;
  reason: string | null;
  created_at: string;
}

interface World {
  rooms: RoomRow[];
  channels: ChannelRow[];
  members: MemberRow[];
  profiles: ProfileRow[];
  invites: InviteRow[];
  bans: BanRow[];
  /** session token hash -> profile id */
  sessions: Map<string, string>;
  /** profile id -> raw session token */
  tokens: Map<string, string>;
  fail: { channels?: boolean; profiles?: boolean; bans?: boolean };
}

interface Ids {
  owner: string;
  admin: string;
  admin2: string;
  member: string;
  member2: string;
  /** A member of OTHER_ROOM_ID only. */
  outsider: string;
}

let world: World;
let ids: Ids;
let steamSeq = 0;

function newSteamId(): string {
  steamSeq += 1;
  return `76561198${String(100_000_000 + steamSeq).slice(-9)}`;
}

function steamOf(profileId: string): string {
  const p = world.profiles.find((x) => x.id === profileId);
  if (!p) throw new Error('no such profile');
  return p.steam_id;
}

function addProfile(id: string, name: string, steamId = newSteamId()): ProfileRow {
  const row = { id, steam_id: steamId, display_name: name, avatar_url: null, current_game: null };
  world.profiles.push(row);
  return row;
}

function addMember(role: Role, roomId = ROOM_ID, name = `user-${String(steamSeq)}`): string {
  const id = randomUUID();
  addProfile(id, name);
  world.members.push({ room_id: roomId, user_id: id, role, joined_at: T0 });
  return id;
}

function channelRow(id: string, type: 'text' | 'voice', name: string, position: number, roomId = ROOM_ID): ChannelRow {
  return { id, room_id: roomId, type, name, position, created_at: T0, deleted_at: null };
}

/**
 * ROOM_ID ("Raid Night"): a text channel, two live voice channels, one deleted voice channel; an
 * owner, two admins, and two plain members. OTHER_ROOM_ID: its own owner (ids.owner too) and
 * ids.outsider, with its own voice channel. Everyone gets fresh ids per test, which also
 * isolates the per-user rate limiters (module-level state).
 */
function freshWorld(): void {
  world = {
    rooms: [
      { id: ROOM_ID, name: 'Raid Night', icon_emoji: '🎮', icon_path: null, created_at: T0, deleted_at: null },
      { id: OTHER_ROOM_ID, name: 'Elsewhere', icon_emoji: '🎲', icon_path: null, created_at: T0, deleted_at: null },
    ],
    channels: [
      channelRow(GENERAL_ID, 'text', 'general', 0),
      channelRow(VOICE_ID, 'voice', 'lounge', 0),
      channelRow(VOICE2_ID, 'voice', 'raid', 1),
      { ...channelRow(DELETED_VOICE_ID, 'voice', 'old', 2), deleted_at: T0 },
      channelRow(OTHER_VOICE_ID, 'voice', 'elsewhere', 0, OTHER_ROOM_ID),
    ],
    members: [],
    profiles: [],
    invites: [],
    bans: [],
    sessions: new Map(),
    tokens: new Map(),
    fail: {},
  };
  ids = {
    owner: addMember('owner', ROOM_ID, 'Olivia'),
    admin: addMember('admin', ROOM_ID, 'Alice'),
    admin2: addMember('admin', ROOM_ID, 'Aaron'),
    member: addMember('member', ROOM_ID, 'Mallory'),
    member2: addMember('member', ROOM_ID, 'Max'),
    outsider: addMember('owner', OTHER_ROOM_ID, 'Oscar'),
  };
}

function roleOf(userId: string, roomId = ROOM_ID): Role | undefined {
  return world.members.find((m) => m.room_id === roomId && m.user_id === userId)?.role;
}

function setRole(userId: string, role: Role): void {
  const row = world.members.find((m) => m.room_id === ROOM_ID && m.user_id === userId);
  if (!row) throw new Error('no such member');
  row.role = role;
}

function seedBan(steamId: string, bannedBy: string | null, createdAt: string, reason: string | null = null, roomId = ROOM_ID): BanRow {
  const row = { room_id: roomId, steam_id: steamId, banned_by: bannedBy, reason, created_at: createdAt };
  world.bans.push(row);
  return row;
}

function isBanned(steamId: string, roomId = ROOM_ID): boolean {
  return world.bans.some((b) => b.room_id === roomId && b.steam_id === steamId);
}

function seedInvite(partial: Partial<InviteRow> & Pick<InviteRow, 'kind'>): InviteRow {
  const row: InviteRow = {
    id: randomUUID(),
    room_id: ROOM_ID,
    created_by: ids.owner,
    token_hash: null,
    invitee_steam_id: null,
    max_uses: partial.kind === 'direct' ? 1 : null,
    uses: 0,
    expires_at: null,
    revoked_at: null,
    accepted_at: null,
    declined_at: null,
    created_at: T0,
    ...partial,
  };
  world.invites.push(row);
  return row;
}

// ---------------------------------------------------------------------------
// Fake reads (PostgREST semantics: only the filters the service sends apply)
// ---------------------------------------------------------------------------

function dbReadError(): DbResult {
  return { data: null, error: { code: 'XX000', message: DB_SECRET_MESSAGE, details: DB_DETAILS, hint: 'HINTVALUE' } };
}

function hasCall(query: RecordedQuery, method: string, ...args: unknown[]): boolean {
  return query.calls.some(([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args));
}

/** Applies eq/is/in filters to columns the row has; nested filters (rooms.*) are handled by callers. */
function matches(row: object, query: RecordedQuery): boolean {
  const record = row as Record<string, unknown>;
  return query.calls.every(([method, args]) => {
    if (method === 'in') {
      const [column, values] = args as [string, unknown[]];
      return !(column in record) || values.includes(record[column]);
    }
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
const PROFILE_COLS = 'id, display_name, avatar_url';
const BAN_COLS = `steam_id, reason, created_at, profiles!room_bans_banned_by_fkey(${PROFILE_COLS})`;

function sessionsSelect(query: RecordedQuery): DbResult {
  const hash = query.calls.find(([m, a]) => m === 'eq' && a[0] === 'token_hash')?.[1][1];
  const profileId = typeof hash === 'string' ? world.sessions.get(hash) : undefined;
  return single(profileId ? [{ id: `sess-${profileId}`, profile_id: profileId }] : []);
}

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
  if (columns === 'user_id') {
    // notifyRemovedMembers (room delete).
    return { data: rows.map((m) => ({ user_id: m.user_id })), error: null };
  }
  throw new Error(`unexpected room_members select: ${columns}`);
}

function roomsSelect(query: RecordedQuery): DbResult {
  if (String(firstArg(query, 'select')) !== ROOM_COLS) throw new Error('unexpected rooms select');
  return single(world.rooms.filter((r) => matches(r, query)).map((r) => pick(r, ROOM_COLS)));
}

function channelsSelect(query: RecordedQuery): DbResult {
  if (world.fail.channels) return dbReadError();
  const columns = String(firstArg(query, 'select'));
  if (columns !== 'id' && columns !== CHANNEL_COLS) throw new Error(`unexpected channels select: ${columns}`);
  return { data: world.channels.filter((c) => matches(c, query)).map((c) => pick(c, columns)), error: null };
}

function profilesSelect(query: RecordedQuery): DbResult {
  if (world.fail.profiles) return dbReadError();
  const columns = String(firstArg(query, 'select'));
  if (columns !== PROFILE_COLS && columns !== `${PROFILE_COLS}, steam_id`) {
    throw new Error(`unexpected profiles select: ${columns}`);
  }
  for (const [method] of query.calls) {
    if (!['select', 'eq', 'in', 'maybeSingle', 'overrideTypes'].includes(method)) {
      throw new Error(`unexpected profiles call: ${method}`);
    }
  }
  const rows = world.profiles.filter((p) => matches(p, query)).map((p) => pick(p, columns));
  return isSingle(query) ? single(rows) : { data: rows, error: null };
}

const KEYSET = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",steam_id\.lt\.(\d{17})\)$/;

function roomBansSelect(query: RecordedQuery): DbResult {
  if (world.fail.bans) return dbReadError();
  const columns = String(firstArg(query, 'select'));
  if (columns !== BAN_COLS) throw new Error(`unexpected room_bans select: ${columns}`);
  let rows = world.bans.filter((b) => matches(b, query));

  const or = firstArg(query, 'or');
  if (or !== undefined) {
    if (typeof or !== 'string') throw new Error('fake db: non-string room_bans or filter');
    const m = KEYSET.exec(or);
    if (!m?.[1] || m[1] !== m[2] || !m[3]) throw new Error(`fake db: unexpected room_bans or filter ${or}`);
    const at = toMicros(m[1]);
    const steam = m[3];
    rows = rows.filter((b) => toMicros(b.created_at) < at || (toMicros(b.created_at) === at && b.steam_id < steam));
  }

  const orders = query.calls
    .filter(([method]) => method === 'order')
    .map(([, args]) => args as [keyof BanRow, { ascending: boolean }]);
  rows = [...rows].sort((a, b) => {
    for (const [column, { ascending }] of orders) {
      const av = column === 'created_at' ? toMicros(a.created_at) : String(a[column]);
      const bv = column === 'created_at' ? toMicros(b.created_at) : String(b[column]);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return ascending ? cmp : -cmp;
    }
    return 0;
  });
  const limit = firstArg(query, 'limit');
  if (typeof limit === 'number') rows = rows.slice(0, limit);

  const out = rows.map((b) => {
    // room_bans.banned_by -> profiles (a plain, nullable embed).
    const issuer = b.banned_by ? world.profiles.find((p) => p.id === b.banned_by) : undefined;
    return { steam_id: b.steam_id, reason: b.reason, created_at: b.created_at, profiles: issuer ? pick(issuer, PROFILE_COLS) : null };
  });
  return isSingle(query) ? single(out) : { data: out, error: null };
}

// ---------------------------------------------------------------------------
// Fake Postgres functions (same checks, order, return shapes, and SQLSTATEs as the migrations)
// ---------------------------------------------------------------------------

function rpcError(code: string): DbResult {
  return { data: null, error: { code, message: DB_SECRET_MESSAGE, details: DB_DETAILS, hint: 'HINTVALUE' } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** uuid arguments as Postgres reads them: null stays null, bad text is 22P02, case is ignored. */
function uuidArgs(...values: unknown[]): (string | null)[] | DbResult {
  const out: (string | null)[] = [];
  for (const value of values) {
    if (value === null || value === undefined) out.push(null);
    else if (typeof value !== 'string' || !UUID.test(value)) return rpcError('22P02');
    else out.push(value.toLowerCase());
  }
  return out;
}

function liveRoom(roomId: string): boolean {
  return world.rooms.some((r) => r.id === roomId && r.deleted_at === null);
}

function profileBySteam(steamId: string | null): ProfileRow | undefined {
  return steamId === null ? undefined : world.profiles.find((p) => p.steam_id === steamId);
}

function isPending(i: InviteRow): boolean {
  return i.revoked_at === null && i.accepted_at === null && i.declined_at === null;
}

function isExpired(i: InviteRow): boolean {
  return i.expires_at !== null && toMicros(i.expires_at) <= Date.now() * 1000;
}

type RevokedRow = { invite_id: string; invitee_profile_id: string | null };

/** Steps 1 and 2 of remove_member / ban_member: the target's pending invites, then direct invites addressed to them. */
function revokeInvitesOf(room: string, target: string, targetSteam: string): RevokedRow[] {
  const out: RevokedRow[] = [];
  const now = nextTs();
  for (const i of world.invites) {
    if (i.room_id !== room || i.created_by !== target || !isPending(i)) continue;
    i.revoked_at = now;
    if (i.kind === 'direct') out.push({ invite_id: i.id, invitee_profile_id: profileBySteam(i.invitee_steam_id)?.id ?? null });
  }
  for (const i of world.invites) {
    if (i.room_id !== room || i.kind !== 'direct' || i.invitee_steam_id !== targetSteam || !isPending(i)) continue;
    i.revoked_at = now;
    out.push({ invite_id: i.id, invitee_profile_id: target });
  }
  return out;
}

/** ban_member: 22023, HX004, HX001, HX003, HX005, HX002, 23514, in that order. */
function fakeBanMember(args: Record<string, unknown>): DbResult {
  if (!('p_reason' in args)) throw new Error('ban_member called without p_reason (PostgREST would not find the function)');
  const parsed = uuidArgs(args.p_room, args.p_actor, args.p_target);
  if (!Array.isArray(parsed)) return parsed;
  const [room, actor, target] = parsed;
  if (!room || !actor || !target) return rpcError('22023');
  if (actor === target) return rpcError('HX004');
  if (!liveRoom(room)) return rpcError('HX001');
  const actorRole = roleOf(actor, room);
  if (!actorRole) return rpcError('HX001');
  const targetRole = roleOf(target, room);
  if (!targetRole) return rpcError('HX003');
  if (targetRole === 'owner') return rpcError('HX005');
  if (!(actorRole === 'owner' || (actorRole === 'admin' && targetRole === 'member'))) return rpcError('HX002');
  const reason = args.p_reason;
  if (reason !== null && (typeof reason !== 'string' || Array.from(reason).length < 1 || Array.from(reason).length > 200)) {
    return rpcError('23514');
  }

  const steam = steamOf(target);
  const existing = world.bans.find((b) => b.room_id === room && b.steam_id === steam);
  if (existing) {
    existing.banned_by = actor;
    existing.reason = reason;
  } else {
    world.bans.push({ room_id: room, steam_id: steam, banned_by: actor, reason, created_at: nextTs() });
  }
  world.members = world.members.filter((m) => !(m.room_id === room && m.user_id === target));
  return { data: revokeInvitesOf(room, target, steam), error: null };
}

/** unban: 22023, HX001, HX002, HX003 (not banned). */
function fakeUnban(args: Record<string, unknown>): DbResult {
  const parsed = uuidArgs(args.p_room, args.p_actor);
  if (!Array.isArray(parsed)) return parsed;
  const [room, actor] = parsed;
  const steam = args.p_steam_id;
  if (!room || !actor || typeof steam !== 'string') return rpcError('22023');
  if (!liveRoom(room)) return rpcError('HX001');
  const role = roleOf(actor, room);
  if (!role) return rpcError('HX001');
  if (role === 'member') return rpcError('HX002');
  const before = world.bans.length;
  world.bans = world.bans.filter((b) => !(b.room_id === room && b.steam_id === steam));
  if (world.bans.length === before) return rpcError('HX003');
  return { data: null, error: null };
}

/** remove_member (membership migration), for comparing a plain removal with a ban. */
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
  return { data: revokeInvitesOf(room, target, steamOf(target)), error: null };
}

/** redeem_invite_link: invalid, room_deleted, banned, already_member, revoked, expired, used_up, joined. */
function fakeRedeem(args: Record<string, unknown>): DbResult {
  const hash = args.p_token_hash;
  const parsed = uuidArgs(args.p_user);
  if (!Array.isArray(parsed)) return parsed;
  const [user] = parsed;
  if (typeof hash !== 'string' || !user) return rpcError('22023');
  const row = (room_id: string | null, status: string): DbResult => ({ data: [{ room_id, status }], error: null });

  const invite = world.invites.find((i) => i.token_hash === hash);
  if (!invite || invite.kind !== 'link') return row(null, 'invalid');
  const room = world.rooms.find((r) => r.id === invite.room_id);
  if (room?.deleted_at) return row(invite.room_id, 'room_deleted');
  const steam = world.profiles.find((p) => p.id === user)?.steam_id;
  if (steam !== undefined && isBanned(steam, invite.room_id)) return row(invite.room_id, 'banned');
  if (roleOf(user, invite.room_id)) return row(invite.room_id, 'already_member');
  if (invite.revoked_at !== null) return row(invite.room_id, 'revoked');
  if (isExpired(invite)) return row(invite.room_id, 'expired');
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return row(invite.room_id, 'used_up');
  if (steam === undefined) return rpcError('23503');
  world.members.push({ room_id: invite.room_id, user_id: user, role: 'member', joined_at: nextTs() });
  invite.uses += 1;
  return row(invite.room_id, 'joined');
}

/** respond_to_direct_invite: invalid, room_deleted, already_responded, banned (accept), revoked, expired, then the answer. */
function fakeRespond(args: Record<string, unknown>): DbResult {
  const parsed = uuidArgs(args.p_invite, args.p_user);
  if (!Array.isArray(parsed)) return parsed;
  const [inviteId, user] = parsed;
  const accept = args.p_accept;
  if (!inviteId || !user || typeof accept !== 'boolean') return rpcError('22023');
  const row = (room_id: string | null, status: string): DbResult => ({ data: [{ room_id, status }], error: null });

  const steam = world.profiles.find((p) => p.id === user)?.steam_id;
  const invite = world.invites.find((i) => i.id === inviteId);
  if (!invite || steam === undefined) return row(null, 'invalid');
  if (invite.kind !== 'direct' || invite.invitee_steam_id !== steam) return row(null, 'invalid');
  if (world.rooms.find((r) => r.id === invite.room_id)?.deleted_at) return row(invite.room_id, 'room_deleted');
  if (invite.accepted_at !== null || invite.declined_at !== null) return row(invite.room_id, 'already_responded');
  if (accept && isBanned(steam, invite.room_id)) return row(invite.room_id, 'banned');
  if (invite.revoked_at !== null) return row(invite.room_id, 'revoked');
  if (isExpired(invite)) return row(invite.room_id, 'expired');
  if (!accept) {
    invite.declined_at = nextTs();
    return row(invite.room_id, 'declined');
  }
  const wasMember = roleOf(user, invite.room_id) !== undefined;
  if (!wasMember) world.members.push({ room_id: invite.room_id, user_id: user, role: 'member', joined_at: nextTs() });
  invite.accepted_at = nextTs();
  invite.uses = 1;
  return row(invite.room_id, wasMember ? 'already_member' : 'accepted');
}

/** create_direct_invite: 22023, 22023 (expiry), HX001, HX001, HX013, HX011, HX012, 23514. */
function fakeCreateDirectInvite(args: Record<string, unknown>): DbResult {
  const parsed = uuidArgs(args.p_room, args.p_actor);
  if (!Array.isArray(parsed)) return parsed;
  const [room, actor] = parsed;
  const steam = args.p_steam_id;
  const expiresAt = args.p_expires_at;
  if (!room || !actor || typeof steam !== 'string') return rpcError('22023');
  if (typeof expiresAt === 'string' && Date.parse(expiresAt) <= Date.now()) return rpcError('22023');
  if (!liveRoom(room)) return rpcError('HX001');
  if (!roleOf(actor, room)) return rpcError('HX001');
  if (isBanned(steam, room)) return rpcError('HX013');
  const invitee = profileBySteam(steam);
  if (invitee && roleOf(invitee.id, room)) return rpcError('HX011');
  let replaced: string | null = null;
  const pending = world.invites.find((i) => i.room_id === room && i.kind === 'direct' && i.invitee_steam_id === steam && isPending(i));
  if (pending) {
    if (!isExpired(pending)) return rpcError('HX012');
    pending.revoked_at = nextTs();
    replaced = pending.id;
  }
  if (!/^7656119\d{10}$/.test(steam)) return rpcError('23514');
  const invite = seedInvite({
    kind: 'direct',
    room_id: room,
    created_by: actor,
    invitee_steam_id: steam,
    expires_at: typeof expiresAt === 'string' ? expiresAt : null,
    created_at: nextTs(),
  });
  const { token_hash: _hidden, ...columns } = invite;
  return { data: [{ ...columns, replaced_invite_id: replaced, invitee_profile_id: invitee?.id ?? null }], error: null };
}

/** delete_room: 22023, HX001, HX001, HX002; returns the pending direct invites it revoked. */
function fakeDeleteRoom(args: Record<string, unknown>): DbResult {
  const parsed = uuidArgs(args.p_room, args.p_actor);
  if (!Array.isArray(parsed)) return parsed;
  const [roomId, actor] = parsed;
  if (!roomId || !actor) return rpcError('22023');
  const room = world.rooms.find((r) => r.id === roomId && r.deleted_at === null);
  if (!room) return rpcError('HX001');
  const role = roleOf(actor, roomId);
  if (!role) return rpcError('HX001');
  if (role !== 'owner') return rpcError('HX002');
  const now = nextTs();
  room.deleted_at = now;
  for (const c of world.channels) if (c.room_id === roomId && c.deleted_at === null) c.deleted_at = now;
  const out: RevokedRow[] = [];
  for (const i of world.invites) {
    if (i.room_id !== roomId || !isPending(i)) continue;
    i.revoked_at = now;
    if (i.kind === 'direct') out.push({ invite_id: i.id, invitee_profile_id: profileBySteam(i.invitee_steam_id)?.id ?? null });
  }
  return { data: out, error: null };
}

function install(): void {
  results.selectByTable.sessions = sessionsSelect;
  results.selectByTable.room_members = roomMembersSelect;
  results.selectByTable.rooms = roomsSelect;
  results.selectByTable.channels = channelsSelect;
  results.selectByTable.profiles = profilesSelect;
  results.selectByTable.room_bans = roomBansSelect;
  results.rpcByName.ban_member = fakeBanMember;
  results.rpcByName.unban = fakeUnban;
  results.rpcByName.remove_member = fakeRemoveMember;
  results.rpcByName.redeem_invite_link = fakeRedeem;
  results.rpcByName.respond_to_direct_invite = fakeRespond;
  results.rpcByName.create_direct_invite = fakeCreateDirectInvite;
  results.rpcByName.delete_room = fakeDeleteRoom;
}

// ---------------------------------------------------------------------------
// Requests and observations
// ---------------------------------------------------------------------------

type Method = 'get' | 'post' | 'delete';

interface CallOptions {
  body?: unknown;
  /** The caller's profile id (default: ids.owner). */
  as?: string;
  signedIn?: boolean;
  origin?: string | null;
  contentType?: string | null;
}

function tokenFor(profileId: string): string {
  let token = world.tokens.get(profileId);
  if (!token) {
    token = newRandomToken();
    world.tokens.set(profileId, token);
    world.sessions.set(hashSessionToken(token), profileId);
  }
  return token;
}

/** A request as hideout-web sends it: session cookie, WEB_ORIGIN, JSON content type on writes. */
function call(method: Method, path: string, options: CallOptions = {}) {
  let req = request(app)[method](path);
  if (options.signedIn ?? true) req = req.set('Cookie', `${SESSION_COOKIE}=${tokenFor(options.as ?? ids.owner)}`);
  const origin = options.origin === undefined ? WEB_ORIGIN : options.origin;
  const defaultType = method === 'get' ? null : 'application/json';
  const contentType = options.contentType === undefined ? defaultType : options.contentType;
  if (origin !== null) req = req.set('Origin', origin);
  if (contentType !== null) req = req.set('Content-Type', contentType);
  return options.body === undefined ? req : req.send(JSON.stringify(options.body));
}

const bansPath = (roomId = ROOM_ID) => `/api/rooms/${roomId}/bans`;
const banPath = (steamId: string, roomId = ROOM_ID) => `/api/rooms/${roomId}/bans/${steamId}`;

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

/** Every broadcast is private and its payload passes the event schema for its topic kind unchanged. */
function expectValidBroadcasts(sent: SentBroadcast[]): void {
  for (const b of sent) {
    expect(b.private).toBe(true);
    const kind = b.topic.split(':')[0] as 'room' | 'user' | 'channel';
    const schema = (serverEvents[kind] as Record<string, { parse: (v: unknown) => unknown }>)[b.event];
    expect(schema, `${b.topic} ${b.event}`).toBeDefined();
    expect(schema?.parse(b.payload)).toStrictEqual(b.payload);
  }
}

function sortedByTopic(entries: [string, unknown][]): [string, unknown][] {
  return [...entries].sort((a, b) => a[0].localeCompare(b[0]) || JSON.stringify(a[1]).localeCompare(JSON.stringify(b[1])));
}

function inviteRevokedBroadcasts(): [string, unknown][] {
  return sortedByTopic(
    sentBroadcasts()
      .filter((b) => b.event === 'invite:revoked')
      .map((b): [string, unknown] => [b.topic, b.payload]),
  );
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

function voiceRemovalsFor(userId: string): [string, string][] {
  return (
    [
      [`voice_${VOICE_ID}`, userId],
      [`voice_${VOICE2_ID}`, userId],
    ] as [string, string][]
  ).sort();
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
  expect(res.status, res.text).toBe(status);
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

function clearObservations(): void {
  fetchMock.mockClear();
  livekit.removeParticipant.mockClear();
  livekit.deleteRoom.mockClear();
  fakeDb.rpc.mockClear();
  queries.length = 0;
}

function summary(id: string): { id: string; displayName: string; avatarUrl: null } {
  const p = world.profiles.find((x) => x.id === id);
  if (!p) throw new Error('no such profile');
  return { id, displayName: p.display_name, avatarUrl: null };
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
  freshWorld();
  install();
});

afterEach(() => {
  const logs = logLines.join('');
  for (const secret of [
    'test-service-role-key',
    'test-session-secret',
    'test-livekit-secret',
    'test-steam-api-key',
    ...world.tokens.values(),
    'ROWVALUE',
    'HINTVALUE',
  ]) {
    expect(logs).not.toContain(secret);
  }
});

/** The three ban routes, as ROOM_ID's owner would send them; `roomId` is swappable. */
const allRoutes: [string, Method, (roomId: string) => string, () => object | undefined][] = [
  ['ban', 'post', (roomId) => bansPath(roomId), () => ({ userId: ids.member })],
  ['list', 'get', (roomId) => bansPath(roomId), () => undefined],
  ['unban', 'delete', (roomId) => banPath(UNSIGNED_STEAM, roomId), () => undefined],
];

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe('bans: authentication', () => {
  it.each(allRoutes)('returns 401 for %s without a session and touches no data', async (_l, method, path, body) => {
    const res = await call(method, path(ROOM_ID), { signedIn: false, body: body() });
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(queries).toHaveLength(0);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it.each(allRoutes)('returns 401 for %s with an unknown session token', async (_l, method, path, body) => {
    const res = await request(app)[method](path(ROOM_ID))
      .set('Cookie', `${SESSION_COOKIE}=${newRandomToken()}`)
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body() ?? {}));
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(queriesOn('room_members')).toHaveLength(0);
  });
});

describe('bans: room access', () => {
  it.each(allRoutes)(
    '%s returns an identical 404 for a non-member, a missing room, a deleted room, and a malformed roomId',
    async (_l, method, path, body) => {
      seedBan(UNSIGNED_STEAM, ids.owner, T0);
      // ids.outsider belongs to OTHER_ROOM_ID only.
      const nonMember = await call(method, path(ROOM_ID), { as: ids.outsider, body: body() });
      const missing = await call(method, path(randomUUID()), { body: body() });
      const malformed = await call(method, path('not-a-uuid'), { body: body() });
      const injected = await call(method, path(encodeURIComponent(`${ROOM_ID},user_id.neq.0`)), { body: body() });
      const room = world.rooms.find((r) => r.id === ROOM_ID);
      if (room) room.deleted_at = T0;
      const deleted = await call(method, path(ROOM_ID), { body: body() });

      expectError(nonMember, 404, 'NOT_FOUND');
      for (const res of [missing, malformed, injected, deleted]) {
        expect(res.status).toBe(404);
        expect(res.body).toStrictEqual(nonMember.body);
      }
      expect(fakeDb.rpc).not.toHaveBeenCalled();
      expect(queriesOn('room_bans')).toHaveLength(0);
      expect(queriesOn('profiles')).toHaveLength(0);
      expect(queriesOn('channels')).toHaveLength(0);
      expect(roleOf(ids.member)).toBe('member');
      expect(isBanned(UNSIGNED_STEAM)).toBe(true);
      expectNoSideEffects();
    },
  );

  it.each(allRoutes)('%s checks membership with the room id and the caller id', async (_l, method, path, body) => {
    await call(method, path(ROOM_ID), { as: ids.outsider, body: body() });
    const [membership] = queriesOn('room_members');
    expect(membership?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    expect(membership?.calls).toContainEqual(['eq', ['user_id', ids.outsider]]);
    expect(membership?.calls).toContainEqual(['is', ['rooms.deleted_at', null]]);
  });

  it.each(allRoutes)('%s returns 403 for a plain member, with no rpc and no ban, profile, or channel read', async (_l, method, path) => {
    seedBan(UNSIGNED_STEAM, ids.owner, T0);
    // Even aimed at another plain member (the easiest target).
    const res = await call(method, path(ROOM_ID), { as: ids.member, body: method === 'post' ? { userId: ids.member2 } : undefined });
    expectError(res, 403, 'FORBIDDEN');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(queriesOn('room_bans')).toHaveLength(0);
    expect(queriesOn('profiles')).toHaveLength(0);
    expect(queriesOn('channels')).toHaveLength(0);
    expect(roleOf(ids.member2)).toBe('member');
    expect(isBanned(UNSIGNED_STEAM)).toBe(true);
    expectNoSideEffects();
  });

  it('a banned member loses access immediately: every ban route and the room itself answer 404', async () => {
    expect((await call('post', bansPath(), { body: { userId: ids.admin } })).status).toBe(201);
    clearObservations();
    for (const [, method, path, body] of allRoutes) {
      expectError(await call(method, path(ROOM_ID), { as: ids.admin, body: body() }), 404, 'NOT_FOUND');
    }
    expectError(await call('get', `/api/rooms/${ROOM_ID}`, { as: ids.admin }), 404, 'NOT_FOUND');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Ban: POST /api/rooms/:roomId/bans
// ---------------------------------------------------------------------------

describe('POST /api/rooms/:roomId/bans', () => {
  it.each([
    ['an admin', 'admin'],
    ['a plain member', 'member'],
  ] as const)('lets the owner ban %s: 201 Ban, membership gone, ban recorded by SteamID', async (_l, key) => {
    const target = ids[key];
    const res = await call('post', bansPath(), { body: { userId: target } });
    expect(res.status, res.text).toBe(201);
    expect(Ban.parse(res.body)).toStrictEqual(res.body);
    expect(res.body).toStrictEqual({
      steamId: steamOf(target),
      user: summary(target),
      bannedBy: summary(ids.owner),
      reason: null,
      createdAt: world.bans[0]?.created_at,
    });
    expect(rpcCalls('ban_member')).toEqual([{ p_room: ROOM_ID, p_actor: ids.owner, p_target: target, p_reason: null }]);
    expect(roleOf(target)).toBeUndefined();
    expect(world.bans).toEqual([
      { room_id: ROOM_ID, steam_id: steamOf(target), banned_by: ids.owner, reason: null, created_at: res.body.createdAt },
    ]);
  });

  it('lets an admin ban a plain member', async () => {
    const res = await call('post', bansPath(), { as: ids.admin, body: { userId: ids.member } });
    expect(res.status).toBe(201);
    expect(Ban.parse(res.body)).toStrictEqual(res.body);
    expect(res.body.bannedBy).toStrictEqual(summary(ids.admin));
    expect(res.body.user).toStrictEqual(summary(ids.member));
    expect(roleOf(ids.member)).toBeUndefined();
  });

  it('stores and returns a trimmed reason', async () => {
    const res = await call('post', bansPath(), { body: { userId: ids.member, reason: '   spamming invite links  ' } });
    expect(res.status).toBe(201);
    expect(res.body.reason).toBe('spamming invite links');
    expect(rpcCalls('ban_member')[0]?.p_reason).toBe('spamming invite links');
  });

  it('accepts a reason of exactly 200 characters (after trimming)', async () => {
    const reason = 'x'.repeat(200);
    const res = await call('post', bansPath(), { body: { userId: ids.member, reason: `  ${reason}  ` } });
    expect(res.status).toBe(201);
    expect(res.body.reason).toBe(reason);
  });

  it('returns 403 when an admin bans another admin (the database refuses; the fast path lets it through)', async () => {
    const res = await call('post', bansPath(), { as: ids.admin, body: { userId: ids.admin2 } });
    expectError(res, 403, 'FORBIDDEN');
    expect(rpcCalls('ban_member')).toHaveLength(1);
    expect(roleOf(ids.admin2)).toBe('admin');
    expect(world.bans).toEqual([]);
    expect(queriesOn('room_bans')).toHaveLength(0);
    expectNoSideEffects();
  });

  it('returns 409 OWNER_PROTECTED with a ban-specific message when an admin bans the owner', async () => {
    const res = await call('post', bansPath(), { as: ids.admin, body: { userId: ids.owner } });
    expectError(res, 409, 'OWNER_PROTECTED');
    expect(res.body.error.message).toBe("The room owner can't be banned.");
    expect(rpcCalls('ban_member')).toHaveLength(1);
    expect(roleOf(ids.owner)).toBe('owner');
    expect(world.bans).toEqual([]);
    expectNoSideEffects();
  });

  it.each([
    ['the owner', 'owner'],
    ['an admin', 'admin'],
  ] as const)('returns 422 at body.userId when %s bans themself (any case), with no read or rpc', async (_l, key) => {
    for (const userId of [ids[key], ids[key].toUpperCase()]) {
      const res = await call('post', bansPath(), { as: ids[key], body: { userId } });
      expectError(res, 422, 'VALIDATION_FAILED');
      expect(res.body.error.details).toEqual([{ path: 'body.userId', message: "You can't ban yourself." }]);
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(queriesOn('profiles')).toHaveLength(0);
    expect(roleOf(ids[key])).toBe(key);
    expectNoSideEffects();
  });

  it('returns the same 404 for a target in another room (rpc HX003) and a target with no profile (no rpc)', async () => {
    const outsider = await call('post', bansPath(), { body: { userId: ids.outsider } });
    expectError(outsider, 404, 'NOT_FOUND');
    expect(rpcCalls('ban_member')).toHaveLength(1);

    const unknown = await call('post', bansPath(), { body: { userId: randomUUID() } });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toStrictEqual(outsider.body);
    expect(rpcCalls('ban_member')).toHaveLength(1);

    expect(roleOf(ids.outsider, OTHER_ROOM_ID)).toBe('owner');
    expect(world.bans).toEqual([]);
    expectNoSideEffects();
  });

  it('looks up the target profile by id only (no other filter can widen it)', async () => {
    expect((await call('post', bansPath(), { body: { userId: ids.member } })).status).toBe(201);
    const [lookup] = queriesOn('profiles');
    expect(lookup?.calls).toEqual([
      ['select', [`${PROFILE_COLS}, steam_id`]],
      ['eq', ['id', ids.member]],
      ['maybeSingle', []],
    ]);
  });

  it('reads the new ban back by room and SteamID', async () => {
    expect((await call('post', bansPath(), { body: { userId: ids.member } })).status).toBe(201);
    const [read] = queriesOn('room_bans');
    expect(read?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    expect(read?.calls).toContainEqual(['eq', ['steam_id', steamOf(ids.member)]]);
  });

  it('lowercases an uppercase body userId in the rpc, the topics, and the LiveKit identity', async () => {
    const res = await call('post', bansPath(), { body: { userId: ids.member.toUpperCase() } });
    expect(res.status).toBe(201);
    expect(rpcCalls('ban_member')[0]?.p_target).toBe(ids.member);
    expect(sentBroadcasts().map((b) => b.topic).sort()).toEqual([`room:${ROOM_ID}`, `user:${ids.member}`]);
    expect(removedFromVoice()).toEqual(voiceRemovalsFor(ids.member));
  });

  it.each<[string, unknown, string[]]>([
    ['a malformed userId', { userId: 'not-a-uuid' }, ['body.userId']],
    ['a filter injection in userId', { userId: `${randomUUID()},role.eq.owner` }, ['body.userId']],
    ['a missing userId', {}, ['body.userId']],
    ['a non-string userId', { userId: 42 }, ['body.userId']],
    ['an unknown key', { userId: randomUUID(), steamId: '76561198000000001' }, ['body']],
    ['a 201-character reason', { userId: randomUUID(), reason: 'x'.repeat(201) }, ['body.reason']],
    ['an empty reason', { userId: randomUUID(), reason: '' }, ['body.reason']],
    ['a whitespace-only reason', { userId: randomUUID(), reason: '   ' }, ['body.reason']],
    ['a reason with a newline inside', { userId: randomUUID(), reason: 'line one\nline two' }, ['body.reason']],
    ['a reason with a carriage return inside', { userId: randomUUID(), reason: 'a\rb' }, ['body.reason']],
    ['a reason with a tab inside', { userId: randomUUID(), reason: 'a\tb' }, ['body.reason']],
    ['a reason with a control character', { userId: randomUUID(), reason: 'bell\u0007' }, ['body.reason']],
    ['a reason with a C1 control character', { userId: randomUUID(), reason: 'x\u0085y' }, ['body.reason']],
    ['a null reason', { userId: randomUUID(), reason: null }, ['body.reason']],
    ['a non-string reason', { userId: randomUUID(), reason: 7 }, ['body.reason']],
    ['a JSON array body', [], ['body']],
  ])('returns 422 for %s without any read or rpc', async (_l, body, paths) => {
    const res = await call('post', bansPath(), { body });
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(paths);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(queriesOn('profiles')).toHaveLength(0);
    expectNoSideEffects();
  });

  it('returns 500 with no rpc or side effects when the voice-channel read fails', async () => {
    world.fail.channels = true;
    const res = await call('post', bansPath(), { body: { userId: ids.member } });
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(roleOf(ids.member)).toBe('member');
    expectNoSideEffects();
  });

  it('returns 500 with no rpc or side effects when the target-profile read fails', async () => {
    world.fail.profiles = true;
    expectError(await call('post', bansPath(), { body: { userId: ids.member } }), 500, 'INTERNAL');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(roleOf(ids.member)).toBe('member');
    expect(world.bans).toEqual([]);
    expectNoSideEffects();
  });
});

// ---------------------------------------------------------------------------
// Ban side effects (after commit, best-effort)
// ---------------------------------------------------------------------------

describe('bans: side effects of a ban', () => {
  it('sends member:left on the room and member:removed {roomId, banned: true} to the target, and removes them from every live voice channel', async () => {
    expect((await call('post', bansPath(), { body: { userId: ids.member, reason: 'REASON-MARKER-7f3a' } })).status).toBe(201);
    const sent = sentBroadcasts();
    expectValidBroadcasts(sent);
    expect(sortedByTopic(sent.map((b) => [b.topic, { event: b.event, payload: b.payload }]))).toEqual([
      [`room:${ROOM_ID}`, { event: 'member:left', payload: { roomId: ROOM_ID, userId: ids.member } }],
      [`user:${ids.member}`, { event: 'member:removed', payload: { roomId: ROOM_ID, banned: true } }],
    ]);
    // Not the text channel, not the deleted voice channel, not another room's voice channel.
    expect(removedFromVoice()).toEqual(voiceRemovalsFor(ids.member));
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
  });

  it('never puts the reason in any broadcast or log line', async () => {
    const reason = 'REASON-MARKER-7f3a';
    const res = await call('post', bansPath(), { body: { userId: ids.member, reason } });
    expect(res.body.reason).toBe(reason);
    expect(JSON.stringify(sentBroadcasts())).not.toContain(reason);
    expect(logLines.join('')).not.toContain(reason);
  });

  it('a plain removal (DELETE /members/:userId) sends member:removed without `banned`', async () => {
    expect((await call('delete', `/api/rooms/${ROOM_ID}/members/${ids.member}`)).status).toBe(204);
    const removed = sentBroadcasts().find((b) => b.event === 'member:removed');
    expect(removed?.payload).toStrictEqual({ roomId: ROOM_ID });
    expect(removed?.payload).not.toHaveProperty('banned');
    expect(world.bans).toEqual([]);
  });

  it("revokes the target's pending invites and those addressed to them, with invite:revoked to each signed-in invitee", async () => {
    const target = ids.member;
    const toOutsider = seedInvite({ kind: 'direct', created_by: target, invitee_steam_id: steamOf(ids.outsider) });
    const toUnsigned = seedInvite({ kind: 'direct', created_by: target, invitee_steam_id: UNSIGNED_STEAM });
    const link = seedInvite({ kind: 'link', created_by: target, token_hash: sha256('x'), max_uses: null });
    const toTarget = seedInvite({ kind: 'direct', created_by: ids.admin, invitee_steam_id: steamOf(target) });
    const answered = seedInvite({ kind: 'direct', created_by: target, invitee_steam_id: steamOf(ids.member2), accepted_at: T0 });
    const otherRoom = seedInvite({ kind: 'direct', room_id: OTHER_ROOM_ID, created_by: target, invitee_steam_id: steamOf(ids.member2) });
    const byOthers = seedInvite({ kind: 'direct', created_by: ids.admin, invitee_steam_id: steamOf(ids.member2) });

    expect((await call('post', bansPath(), { body: { userId: target } })).status).toBe(201);

    const revoked = world.invites.filter((i) => i.revoked_at !== null).map((i) => i.id).sort();
    expect(revoked).toEqual([toOutsider.id, toUnsigned.id, link.id, toTarget.id].sort());
    for (const untouched of [answered, otherRoom, byOthers]) expect(untouched.revoked_at).toBeNull();

    const sent = sentBroadcasts();
    expectValidBroadcasts(sent);
    expect(sent.map((b) => b.event).sort()).toEqual(['invite:revoked', 'invite:revoked', 'member:left', 'member:removed']);
    expect(inviteRevokedBroadcasts()).toEqual(
      sortedByTopic([
        [`user:${ids.outsider}`, { inviteId: toOutsider.id }],
        [`user:${target}`, { inviteId: toTarget.id }],
      ]),
    );
    expect(removedFromVoice()).toEqual(voiceRemovalsFor(target));
  });

  it('sends no invite:revoked for a row whose invitee has no profile', async () => {
    seedInvite({ kind: 'direct', created_by: ids.member, invitee_steam_id: UNSIGNED_STEAM });
    expect((await call('post', bansPath(), { body: { userId: ids.member } })).status).toBe(201);
    expect(inviteRevokedBroadcasts()).toEqual([]);
    expect(sentBroadcasts().map((b) => b.event).sort()).toEqual(['member:left', 'member:removed']);
  });

  it.each<[string, unknown]>([
    ['an object instead of an array', { invite_id: 'e0000000-0000-4000-8000-000000000001', invitee_profile_id: null }],
    ['a malformed invite id', [{ invite_id: 'ROWVALUE-not-a-uuid', invitee_profile_id: null }]],
    ['a missing field', [{ invite_id: 'e0000000-0000-4000-8000-000000000001' }]],
  ])('treats %s from ban_member as no rows: still 201 with the usual effects, logged without the values', async (_l, data) => {
    results.rpcByName.ban_member = (args) => {
      const out = fakeBanMember(args);
      return out.error ? out : { data, error: null };
    };
    const res = await call('post', bansPath(), { body: { userId: ids.member } });
    expect(res.status).toBe(201);
    expect(Ban.parse(res.body)).toStrictEqual(res.body);
    expect(sentBroadcasts().map((b) => b.event).sort()).toEqual(['member:left', 'member:removed']);
    expect(removedFromVoice()).toEqual(voiceRemovalsFor(ids.member));
    const entries = logsAt(50, 'ban_member returned unexpected rows');
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).not.toContain('e0000000-0000-4000-8000-000000000001');
  });

  it.each([
    ['rejected with a 500', () => Promise.resolve(new Response('{}', { status: 500 }))],
    ['a thrown fetch', () => Promise.reject(new Error('network'))],
  ])('still returns 201 and removes from LiveKit when the broadcasts fail (%s)', async (_l, impl) => {
    seedInvite({ kind: 'direct', created_by: ids.admin, invitee_steam_id: steamOf(ids.member) });
    fetchMock.mockImplementation(impl);
    const res = await call('post', bansPath(), { body: { userId: ids.member } });
    expect(res.status).toBe(201);
    expect(Ban.parse(res.body)).toStrictEqual(res.body);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(removedFromVoice()).toEqual(voiceRemovalsFor(ids.member));
    expect(isBanned(steamOf(ids.member))).toBe(true);
  });

  it.each([
    // Failures are retried (3 attempts per voice channel); not_found stops at once.
    ['a LiveKit server error', () => new ServerError('internal', 'boom', 500, 'internal'), 6],
    ['LiveKit being unreachable', () => new Error('fetch failed'), 6],
    ['the participant not being there', () => new ServerError('not_found', 'participant not found', 404, 'not_found'), 2],
  ])('still returns 201 and broadcasts on %s', async (_l, makeError, calls) => {
    livekit.removeParticipant.mockRejectedValue(makeError());
    const res = await call('post', bansPath(), { body: { userId: ids.member } });
    expect(res.status).toBe(201);
    expect(livekit.removeParticipant).toHaveBeenCalledTimes(calls);
    expect(sentBroadcasts().map((b) => b.event).sort()).toEqual(['member:left', 'member:removed']);
  });

  it('returns 201 from known values when reading the committed ban back fails; every effect has run', async () => {
    world.fail.bans = true;
    const before = Date.now();
    const res = await call('post', bansPath(), { body: { userId: ids.member, reason: '  REASON-MARKER-7f3a  ' } });
    expect(res.status, res.text).toBe(201);
    expect(Ban.parse(res.body)).toStrictEqual(res.body);
    expect(res.body).toStrictEqual({
      steamId: steamOf(ids.member),
      user: summary(ids.member),
      bannedBy: summary(ids.owner),
      reason: 'REASON-MARKER-7f3a',
      createdAt: expect.any(String),
    });
    const createdAt = Date.parse(Ban.parse(res.body).createdAt);
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(Date.now());
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
    expect(isBanned(steamOf(ids.member))).toBe(true);
    expect(roleOf(ids.member)).toBeUndefined();
    expect(sentBroadcasts().map((b) => b.event).sort()).toEqual(['member:left', 'member:removed']);
    expect(removedFromVoice()).toEqual(voiceRemovalsFor(ids.member));

    // A warning without values: no DB message, SteamID, or reason.
    const logs = logLines.join('');
    expect(logs).toContain('could not read the new ban back');
    for (const leak of ['SECRET-DB-MESSAGE', 'REASON-MARKER', steamOf(ids.member)]) expect(logs).not.toContain(leak);
  });

  it('returns bannedBy null in the fallback when the issuer profile cannot be read either', async () => {
    // The target profile is read before the rpc, so both reads start failing only after it commits.
    results.rpcByName.ban_member = (args) => {
      const out = fakeBanMember(args);
      world.fail.bans = true;
      world.fail.profiles = true;
      return out;
    };
    const res = await call('post', bansPath(), { body: { userId: ids.member, reason: 'spam' } });
    expect(res.status, res.text).toBe(201);
    expect(Ban.parse(res.body)).toStrictEqual(res.body);
    expect(res.body).toMatchObject({ steamId: steamOf(ids.member), user: summary(ids.member), bannedBy: null, reason: 'spam' });
    expect(isBanned(steamOf(ids.member))).toBe(true);
    expect(sentBroadcasts().map((b) => b.event).sort()).toEqual(['member:left', 'member:removed']);
  });

  it('returns 201 from known values (not 404 or 500) when the ban was lifted between the write and the read', async () => {
    results.rpcByName.ban_member = (args) => {
      const out = fakeBanMember(args);
      world.bans = [];
      return out;
    };
    const res = await call('post', bansPath(), { as: ids.admin, body: { userId: ids.member } });
    expect(res.status, res.text).toBe(201);
    expect(Ban.parse(res.body)).toStrictEqual(res.body);
    expect(res.body).toMatchObject({
      steamId: steamOf(ids.member),
      user: summary(ids.member),
      bannedBy: summary(ids.admin),
      reason: null,
    });
    expect(roleOf(ids.member)).toBeUndefined();
    expect(sentBroadcasts().map((b) => b.event).sort()).toEqual(['member:left', 'member:removed']);
    expect(removedFromVoice()).toEqual(voiceRemovalsFor(ids.member));
    const logs = logLines.join('');
    expect(logs).toContain('new ban missing or malformed on read-back');
    expect(logs).not.toContain(steamOf(ids.member));
  });
});

// ---------------------------------------------------------------------------
// RPC error mapping: nothing broadcast on any failed write
// ---------------------------------------------------------------------------

describe('bans: rpc error mapping', () => {
  const invalid = 'The request is invalid.';
  // [label, method, rpc, sqlstate, status, code, 422 detail [path, message]]
  const cases: [string, Method, string, string, number, string, [string, string] | null][] = [
    ['ban', 'post', 'ban_member', 'HX001', 404, 'NOT_FOUND', null],
    ['ban', 'post', 'ban_member', 'HX002', 403, 'FORBIDDEN', null],
    ['ban', 'post', 'ban_member', 'HX003', 404, 'NOT_FOUND', null],
    ['ban', 'post', 'ban_member', 'HX004', 422, 'VALIDATION_FAILED', ['body.userId', "You can't ban yourself."]],
    ['ban', 'post', 'ban_member', 'HX005', 409, 'OWNER_PROTECTED', null],
    ['ban', 'post', 'ban_member', '23514', 422, 'VALIDATION_FAILED', ['body.reason', invalid]],
    ['ban', 'post', 'ban_member', 'XX000', 500, 'INTERNAL', null],
    ['unban', 'delete', 'unban', 'HX001', 404, 'NOT_FOUND', null],
    ['unban', 'delete', 'unban', 'HX002', 403, 'FORBIDDEN', null],
    ['unban', 'delete', 'unban', 'HX003', 404, 'NOT_FOUND', null],
    ['unban', 'delete', 'unban', 'XX000', 500, 'INTERNAL', null],
  ];

  it.each(cases)(
    '%s: maps %s/%s %s to %i %s, never echoing the DB error, broadcasting, or calling LiveKit',
    async (label, method, rpc, sqlstate, status, code, detail) => {
      seedBan(UNSIGNED_STEAM, ids.owner, T0);
      results.rpcByName[rpc] = rpcError(sqlstate);
      const path = label === 'ban' ? bansPath() : banPath(UNSIGNED_STEAM);
      const res = await call(method, path, { body: label === 'ban' ? { userId: ids.member } : undefined });
      expectError(res, status, code);
      expect(rpcCalls(rpc)).toHaveLength(1);
      if (detail) expect(res.body.error.details).toEqual([{ path: detail[0], message: detail[1] }]);
      else expect(res.body.error.details).toBeUndefined();
      for (const leak of ['SECRET-DB-MESSAGE', 'ROWVALUE', 'HINTVALUE', sqlstate]) expect(res.text).not.toContain(leak);
      if (status < 500) expect(logLines.join('')).not.toContain('SECRET-DB-MESSAGE');
      expect(queriesOn('room_bans')).toHaveLength(0);
      expectNoSideEffects();
    },
  );
});

// ---------------------------------------------------------------------------
// List: GET /api/rooms/:roomId/bans
// ---------------------------------------------------------------------------

describe('GET /api/rooms/:roomId/bans', () => {
  const tie = '2026-09-10T08:00:00.500000+00:00';

  /** Five bans in ROOM_ID (three sharing a timestamp) and one in OTHER_ROOM_ID; returns the expected order. */
  function seedList(): string[] {
    const old = seedBan(newSteamId(), ids.admin, '2026-09-01T00:00:00.000001+00:00', 'old one');
    const [s1, s2, s3] = [newSteamId(), newSteamId(), newSteamId()].sort();
    const t1 = seedBan(s1 ?? '', ids.owner, tie);
    const t3 = seedBan(s3 ?? '', ids.owner, tie);
    const t2 = seedBan(s2 ?? '', ids.owner, tie);
    const newest = seedBan(newSteamId(), ids.owner, '2026-09-20T00:00:00.000000+00:00', 'spamming links');
    seedBan(newSteamId(), ids.outsider, '2026-09-25T00:00:00.000000+00:00', 'other room', OTHER_ROOM_ID);
    return [newest, t3, t2, t1, old].map((b) => b.steam_id);
  }

  it.each([
    ['the owner', 'owner'],
    ['an admin', 'admin'],
  ] as const)('returns every ban of the room to %s, newest first, with Cache-Control: no-store', async (_l, key) => {
    const expected = seedList();
    const res = await call('get', bansPath(), { as: ids[key] });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(BanPage.parse(res.body)).toStrictEqual(res.body);
    expect(BanPage.parse(res.body).data.map((b) => b.steamId)).toEqual(expected);
    expect(res.body.nextCursor).toBeNull();
    const [read] = queriesOn('room_bans');
    expect(read?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
  });

  it('pages with a keyset cursor over (created_at, steam_id), splitting a timestamp tie without skipping or repeating', async () => {
    const expected = seedList();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path: string = cursor ? `${bansPath()}?limit=2&cursor=${encodeURIComponent(cursor)}` : `${bansPath()}?limit=2`;
      const res = await call('get', path);
      expect(res.status).toBe(200);
      expect(BanPage.parse(res.body)).toStrictEqual(res.body);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...BanPage.parse(res.body).data.map((b) => b.steamId));
      cursor = res.body.nextCursor as string | null;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
  });

  it('returns nextCursor null when the last page is exactly full', async () => {
    seedList();
    const res = await call('get', `${bansPath()}?limit=5`);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.nextCursor).toBeNull();
  });

  it('returns an empty page when the room has no bans', async () => {
    const res = await call('get', bansPath());
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ data: [], nextCursor: null });
    expect(queriesOn('profiles')).toHaveLength(0);
  });

  it('shows the banned profile when there is one, null user for a SteamID without a profile, and null bannedBy once the issuer is gone', async () => {
    seedBan(steamOf(ids.outsider), ids.owner, '2026-09-03T00:00:00.000000+00:00', 'spamming links');
    seedBan(UNSIGNED_STEAM, null, '2026-09-02T00:00:00.000000+00:00');
    const res = await call('get', bansPath(), { as: ids.admin });
    expect(res.status).toBe(200);
    expect(res.body.data).toStrictEqual([
      {
        steamId: steamOf(ids.outsider),
        user: summary(ids.outsider),
        bannedBy: summary(ids.owner),
        reason: 'spamming links',
        createdAt: '2026-09-03T00:00:00.000000+00:00',
      },
      { steamId: UNSIGNED_STEAM, user: null, bannedBy: null, reason: null, createdAt: '2026-09-02T00:00:00.000000+00:00' },
    ]);
    const [lookup] = queriesOn('profiles');
    expect(lookup?.calls).toContainEqual(['in', ['steam_id', [steamOf(ids.outsider), UNSIGNED_STEAM]]]);
  });

  it.each<[string, string]>([
    ['not base64url JSON', 'garbage!!'],
    ['JSON that is not a tuple', Buffer.from('{"a":1}').toString('base64url')],
    ['a bad timestamp', Buffer.from(JSON.stringify(['not-a-date', '76561198000000001'])).toString('base64url')],
    ['a non-SteamID', Buffer.from(JSON.stringify(['2026-09-10T08:00:00.5+00:00', 'abc'])).toString('base64url')],
    [
      'a filter injection in the SteamID',
      Buffer.from(JSON.stringify(['2026-09-10T08:00:00.5+00:00', '76561198000000001),steam_id.gt.(0'])).toString('base64url'),
    ],
    [
      'a quote in the timestamp',
      Buffer.from(JSON.stringify(['2026-09-10T08:00:00"),or(x', '76561198000000001'])).toString('base64url'),
    ],
    ['year 0', Buffer.from(JSON.stringify(['0000-01-01T00:00:00Z', '76561198000000001'])).toString('base64url')],
    ['an over-long cursor', 'a'.repeat(257)],
  ])('returns 422 at query.cursor for %s, with no filter sent', async (_l, cursor) => {
    const res = await call('get', `${bansPath()}?cursor=${encodeURIComponent(cursor)}`);
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['query.cursor']);
    for (const q of queriesOn('room_bans')) expect(q.calls.some(([m]) => m === 'or')).toBe(false);
  });

  it.each(['0', '101', 'abc', '1.5'])('returns 422 at query.limit for limit=%s', async (limit) => {
    const res = await call('get', `${bansPath()}?limit=${limit}`);
    expectError(res, 422, 'VALIDATION_FAILED');
    expect(detailPaths(res)).toEqual(['query.limit']);
  });

  it('returns 500 without DB details when the list read fails', async () => {
    seedList();
    world.fail.bans = true;
    const res = await call('get', bansPath());
    expectError(res, 500, 'INTERNAL');
    expect(res.text).not.toContain('SECRET-DB-MESSAGE');
  });
});

// ---------------------------------------------------------------------------
// Unban: DELETE /api/rooms/:roomId/bans/:steamId
// ---------------------------------------------------------------------------

describe('DELETE /api/rooms/:roomId/bans/:steamId', () => {
  it.each([
    ['the owner', 'owner'],
    ['an admin', 'admin'],
  ] as const)('lets %s lift a ban (even one the owner issued): 204, no broadcast, member not re-added', async (_l, key) => {
    const steam = steamOf(ids.outsider);
    seedBan(steam, ids.owner, T0, 'spam');
    const res = await call('delete', banPath(steam), { as: ids[key] });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(rpcCalls('unban')).toEqual([{ p_room: ROOM_ID, p_actor: ids[key], p_steam_id: steam }]);
    expect(world.bans).toEqual([]);
    expect(roleOf(ids.outsider)).toBeUndefined();
    expectNoSideEffects();
  });

  it("logs 'ban lifted' with the room, actor, and SteamID (never the reason) after a successful unban only", async () => {
    const steam = steamOf(ids.outsider);
    seedBan(steam, ids.owner, T0, 'REASON-MARKER-9c1d');
    expect((await call('delete', banPath(steam), { as: ids.admin })).status).toBe(204);
    const lifted = logLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.msg === 'ban lifted');
    expect(lifted).toHaveLength(1);
    expect(lifted[0]).toMatchObject({ level: 30, roomId: ROOM_ID, actorId: ids.admin, steamId: steam });
    expect(logLines.join('')).not.toContain('REASON-MARKER');

    logLines.length = 0;
    expectError(await call('delete', banPath(steam), { as: ids.admin }), 404, 'NOT_FOUND');
    expect(logLines.join('')).not.toContain('ban lifted');
  });

  it('only lifts the ban in this room', async () => {
    seedBan(UNSIGNED_STEAM, ids.owner, T0);
    seedBan(UNSIGNED_STEAM, ids.outsider, T0, null, OTHER_ROOM_ID);
    expect((await call('delete', banPath(UNSIGNED_STEAM))).status).toBe(204);
    expect(isBanned(UNSIGNED_STEAM)).toBe(false);
    expect(isBanned(UNSIGNED_STEAM, OTHER_ROOM_ID)).toBe(true);
  });

  it('returns 404 for a SteamID that is not banned (HX003), with no broadcast', async () => {
    const res = await call('delete', banPath(UNSIGNED_STEAM));
    expectError(res, 404, 'NOT_FOUND');
    expect(rpcCalls('unban')).toHaveLength(1);
    expectNoSideEffects();
  });

  it('a second unban of the same SteamID is 404', async () => {
    seedBan(UNSIGNED_STEAM, ids.owner, T0);
    expect((await call('delete', banPath(UNSIGNED_STEAM))).status).toBe(204);
    expectError(await call('delete', banPath(UNSIGNED_STEAM)), 404, 'NOT_FOUND');
  });

  it.each([
    'abc',
    '1234',
    '7656119800000000', // 16 digits
    '765611980000000001', // 18 digits
    '12345678901234567', // 17 digits, wrong prefix
    encodeURIComponent('76561198000000001,steam_id.neq.0'),
  ])('returns the same 404 as an unknown ban for a malformed steamId (%s), with no rpc', async (steamId) => {
    const unknown = await call('delete', banPath(UNSIGNED_STEAM));
    fakeDb.rpc.mockClear();
    const res = await call('delete', banPath(steamId));
    expectError(res, 404, 'NOT_FOUND');
    expect(res.body).toStrictEqual(unknown.body);
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Enforcement: link redeem, direct invite accept/decline/create
// ---------------------------------------------------------------------------

describe('bans: enforcement through the invite routes', () => {
  function seedLink(): { token: string; invite: InviteRow } {
    const token = newRandomToken();
    return { token, invite: seedInvite({ kind: 'link', token_hash: sha256(token), max_uses: 5 }) };
  }

  it('a banned member redeeming a link gets 403 BANNED with no use consumed and no member:joined; after unban they join', async () => {
    const { token, invite } = seedLink();
    expect((await call('post', bansPath(), { body: { userId: ids.member } })).status).toBe(201);
    clearObservations();

    const refused = await call('post', `/api/invites/${token}/redeem`, { as: ids.member });
    expectError(refused, 403, 'BANNED');
    expect(rpcCalls('redeem_invite_link')).toEqual([{ p_token_hash: sha256(token), p_user: ids.member }]);
    expect(invite.uses).toBe(0);
    expect(roleOf(ids.member)).toBeUndefined();
    expectNoSideEffects();

    expect((await call('delete', banPath(steamOf(ids.member)), { as: ids.admin })).status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();

    const joined = await call('post', `/api/invites/${token}/redeem`, { as: ids.member });
    expect(joined.status, joined.text).toBe(200);
    expect(RedeemInviteResult.parse(joined.body)).toStrictEqual(joined.body);
    expect(joined.body.status).toBe('joined');
    expect(joined.body.room.room.id).toBe(ROOM_ID);
    expect(roleOf(ids.member)).toBe('member');
    expect(invite.uses).toBe(1);
    const sent = sentBroadcasts();
    expectValidBroadcasts(sent);
    expect(sent.map((b) => [b.topic, b.event])).toEqual([[`room:${ROOM_ID}`, 'member:joined']]);
  });

  it('BANNED wins over a revoked, expired, or used-up link (the ban is the real reason)', async () => {
    seedBan(steamOf(ids.outsider), ids.owner, T0);
    for (const state of [{ revoked_at: T0 }, { expires_at: T0 }, { max_uses: 1, uses: 1 }]) {
      const token = newRandomToken();
      seedInvite({ kind: 'link', token_hash: sha256(token), ...state });
      expectError(await call('post', `/api/invites/${token}/redeem`, { as: ids.outsider }), 403, 'BANNED');
    }
    expect(roleOf(ids.outsider)).toBeUndefined();
    expectNoSideEffects();
  });

  it('accepting a direct invite while banned is 403 BANNED even after the ban revoked it; once unbanned it is 410 INVITE_REVOKED', async () => {
    const invite = seedInvite({ kind: 'direct', created_by: ids.admin, invitee_steam_id: steamOf(ids.member) });
    expect((await call('post', bansPath(), { body: { userId: ids.member } })).status).toBe(201);
    expect(invite.revoked_at).not.toBeNull();
    clearObservations();

    expectError(await call('post', `/api/me/invites/${invite.id}/accept`, { as: ids.member }), 403, 'BANNED');
    expect(rpcCalls('respond_to_direct_invite')).toEqual([{ p_invite: invite.id, p_user: ids.member, p_accept: true }]);
    expect(roleOf(ids.member)).toBeUndefined();
    expect(invite.accepted_at).toBeNull();
    expectNoSideEffects();

    expect((await call('delete', banPath(steamOf(ids.member)))).status).toBe(204);
    expectError(await call('post', `/api/me/invites/${invite.id}/accept`, { as: ids.member }), 410, 'INVITE_REVOKED');
    expect(roleOf(ids.member)).toBeUndefined();
  });

  it('a banned user can still decline a pending direct invite (204), and accept stays refused without touching it', async () => {
    seedBan(steamOf(ids.outsider), ids.owner, T0);
    const invite = seedInvite({ kind: 'direct', created_by: ids.admin, invitee_steam_id: steamOf(ids.outsider) });

    expectError(await call('post', `/api/me/invites/${invite.id}/accept`, { as: ids.outsider }), 403, 'BANNED');
    expect(invite).toMatchObject({ accepted_at: null, declined_at: null, revoked_at: null, uses: 0 });

    const declined = await call('post', `/api/me/invites/${invite.id}/decline`, { as: ids.outsider });
    expect(declined.status).toBe(204);
    expect(invite.declined_at).not.toBeNull();
    expect(roleOf(ids.outsider)).toBeUndefined();
    expectNoSideEffects();
  });

  it('accepting a pending direct invite works once the ban is lifted', async () => {
    seedBan(steamOf(ids.outsider), ids.owner, T0);
    const invite = seedInvite({ kind: 'direct', created_by: ids.admin, invitee_steam_id: steamOf(ids.outsider) });
    expectError(await call('post', `/api/me/invites/${invite.id}/accept`, { as: ids.outsider }), 403, 'BANNED');
    expect((await call('delete', banPath(steamOf(ids.outsider)))).status).toBe(204);
    const res = await call('post', `/api/me/invites/${invite.id}/accept`, { as: ids.outsider });
    expect(res.status, res.text).toBe(200);
    expect(AcceptInviteResult.parse(res.body)).toStrictEqual(res.body);
    expect(res.body.status).toBe('accepted');
    expect(roleOf(ids.outsider)).toBe('member');
  });

  it.each([
    ['a banned member (has a profile)', () => steamOf(ids.outsider)],
    ['a banned Steam account that never signed in', () => UNSIGNED_STEAM],
  ])('refuses a direct invite to %s with 409 USER_BANNED, for any member, with nothing written or sent', async (_l, steam) => {
    const steamId = steam();
    seedBan(steamId, ids.owner, T0);
    for (const caller of [ids.owner, ids.admin, ids.member]) {
      const res = await call('post', `/api/rooms/${ROOM_ID}/invites`, { as: caller, body: { kind: 'direct', steamId } });
      expectError(res, 409, 'USER_BANNED');
      expect(res.text).not.toContain('SECRET-DB-MESSAGE');
    }
    expect(rpcCalls('create_direct_invite')).toHaveLength(3);
    expect(world.invites).toEqual([]);
    expectNoSideEffects();
  });

  it('creates the direct invite once the ban is lifted, and the invitee is told', async () => {
    const steamId = steamOf(ids.outsider);
    seedBan(steamId, ids.owner, T0);
    expectError(await call('post', `/api/rooms/${ROOM_ID}/invites`, { body: { kind: 'direct', steamId } }), 409, 'USER_BANNED');
    expect((await call('delete', banPath(steamId))).status).toBe(204);
    const res = await call('post', `/api/rooms/${ROOM_ID}/invites`, { body: { kind: 'direct', steamId } });
    expect(res.status, res.text).toBe(201);
    expect(CreatedInvite.parse(res.body)).toStrictEqual(res.body);
    await vi.waitFor(() => {
      expect(sentBroadcasts().map((b) => [b.topic, b.event])).toEqual([[`user:${ids.outsider}`, 'invite:received']]);
    });
    expectValidBroadcasts(sentBroadcasts());
  });

  it('a ban in another room does not stop a redeem, accept, or direct invite here', async () => {
    seedBan(steamOf(ids.outsider), ids.owner, T0, null, OTHER_ROOM_ID);
    const { token } = seedLink();
    const res = await call('post', `/api/invites/${token}/redeem`, { as: ids.outsider });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('joined');
  });
});

// ---------------------------------------------------------------------------
// Room delete: invite:revoked for the direct invites delete_room revoked
// ---------------------------------------------------------------------------

describe('DELETE /api/rooms/:roomId: invite:revoked for revoked direct invites', () => {
  it('sends invite:revoked to each signed-in invitee, alongside room:deleted and member:removed (without `banned`)', async () => {
    const toOutsider = seedInvite({ kind: 'direct', created_by: ids.admin, invitee_steam_id: steamOf(ids.outsider) });
    const toUnsigned = seedInvite({ kind: 'direct', created_by: ids.admin, invitee_steam_id: UNSIGNED_STEAM });
    const link = seedInvite({ kind: 'link', token_hash: sha256('y') });
    const answered = seedInvite({ kind: 'direct', invitee_steam_id: steamOf(ids.member2), declined_at: T0 });
    const otherRoom = seedInvite({ kind: 'direct', room_id: OTHER_ROOM_ID, invitee_steam_id: steamOf(ids.member2) });

    const res = await call('delete', `/api/rooms/${ROOM_ID}`);
    expect(res.status).toBe(204);
    for (const revoked of [toOutsider, toUnsigned, link]) expect(revoked.revoked_at).not.toBeNull();
    for (const untouched of [answered, otherRoom]) expect(untouched.revoked_at).toBeNull();

    const sent = sentBroadcasts();
    expectValidBroadcasts(sent);
    expect(inviteRevokedBroadcasts()).toEqual([[`user:${ids.outsider}`, { inviteId: toOutsider.id }]]);
    expect(sent.filter((b) => b.event === 'room:deleted').map((b) => b.topic)).toEqual([`room:${ROOM_ID}`]);
    const removed = sent.filter((b) => b.event === 'member:removed');
    expect(removed.map((b) => b.topic).sort()).toEqual(
      [ids.owner, ids.admin, ids.admin2, ids.member, ids.member2].map((id) => `user:${id}`).sort(),
    );
    for (const b of removed) expect(b.payload).toStrictEqual({ roomId: ROOM_ID });
    expect(livekit.deleteRoom.mock.calls.map(([name]) => name).sort()).toEqual([`voice_${VOICE_ID}`, `voice_${VOICE2_ID}`].sort());
  });

  it('sends no invite:revoked when only invitees without a profile (or links) were revoked', async () => {
    seedInvite({ kind: 'direct', invitee_steam_id: UNSIGNED_STEAM });
    seedInvite({ kind: 'link', token_hash: sha256('z') });
    expect((await call('delete', `/api/rooms/${ROOM_ID}`)).status).toBe(204);
    expect(inviteRevokedBroadcasts()).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['null (the pre-bans return shape)', null],
    ['an object instead of an array', { invite_id: 'e0000000-0000-4000-8000-000000000002', invitee_profile_id: 'e0000000-0000-4000-8000-000000000003' }],
    ['a malformed invite id', [{ invite_id: 'ROWVALUE-not-a-uuid', invitee_profile_id: 'e0000000-0000-4000-8000-000000000003' }]],
    ['a non-string profile id', [{ invite_id: 'e0000000-0000-4000-8000-000000000002', invitee_profile_id: 42 }]],
  ])('treats %s as no rows: still 204 with the other effects', async (label, data) => {
    results.rpcByName.delete_room = (args) => {
      const out = fakeDeleteRoom(args);
      return out.error ? out : { data, error: null };
    };
    expect((await call('delete', `/api/rooms/${ROOM_ID}`)).status).toBe(204);
    expect(inviteRevokedBroadcasts()).toEqual([]);
    expect(sentBroadcasts().some((b) => b.event === 'room:deleted')).toBe(true);
    const entries = logsAt(50, 'delete_room returned unexpected rows');
    if (data === null) {
      // parseRevokedInvites treats null as an empty list.
      expect(entries).toHaveLength(0);
    } else {
      expect(entries, label).toHaveLength(1);
      const logged = JSON.stringify(entries[0]);
      for (const value of ['e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000003']) {
        expect(logged).not.toContain(value);
      }
    }
  });

  it('still returns 204 when the invite:revoked broadcast fails', async () => {
    seedInvite({ kind: 'direct', invitee_steam_id: steamOf(ids.outsider) });
    fetchMock.mockImplementation(() => Promise.reject(new Error('network')));
    expect((await call('delete', `/api/rooms/${ROOM_ID}`)).status).toBe(204);
    expect(inviteRevokedBroadcasts()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe('bans: CSRF', () => {
  const writes: [string, Method, () => string, () => object | undefined][] = [
    ['ban', 'post', () => bansPath(), () => ({ userId: ids.member })],
    ['unban', 'delete', () => banPath(UNSIGNED_STEAM), () => undefined],
  ];

  it.each(writes)('rejects %s from a foreign or missing Origin with 403 and no rpc', async (_l, method, path, body) => {
    seedBan(UNSIGNED_STEAM, ids.owner, T0);
    for (const origin of ['https://evil.example', 'http://localhost:5173.evil.example', 'null', null]) {
      expectError(await call(method, path(), { body: body(), origin }), 403, 'ORIGIN_NOT_ALLOWED');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(roleOf(ids.member)).toBe('member');
    expect(isBanned(UNSIGNED_STEAM)).toBe(true);
    expectNoSideEffects();
  });

  it.each(writes)('rejects %s without a JSON Content-Type with 403 and no rpc', async (_l, method, path, body) => {
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) {
      expectError(await call(method, path(), { body: body(), contentType }), 403, 'UNSUPPORTED_CONTENT_TYPE');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('serves the list (a GET) to a foreign Origin without granting it CORS access (never reflects the Origin)', async () => {
    const res = await call('get', bansPath(), { origin: 'https://evil.example' });
    expect(res.status).toBe(200);
    // The browser drops the response: the allowed origin isn't the requester's.
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
  });
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

describe('bans: rate limits', () => {
  it('ban and unban share the 30/hour membership-write budget with the member routes; errors past the limiter count', async () => {
    const targets = Array.from({ length: 10 }, () => addMember('member'));
    const extra = targets.slice(5);

    // 5 bans (201) and 5 unbans (204): 10.
    for (const t of targets.slice(0, 5)) expect((await call('post', bansPath(), { body: { userId: t } })).status).toBe(201);
    for (const t of targets.slice(0, 5)) expect((await call('delete', banPath(steamOf(t)))).status).toBe(204);
    // Self-ban and invalid bodies are 422 from validate()/the service, after the limiter: 16.
    for (let i = 0; i < 3; i++) expectError(await call('post', bansPath(), { body: { userId: ids.owner } }), 422, 'VALIDATION_FAILED');
    for (let i = 0; i < 3; i++) {
      expectError(await call('post', bansPath(), { body: { userId: ids.member, reason: '' } }), 422, 'VALIDATION_FAILED');
    }
    // Malformed and unknown SteamIDs (404 from the service) and targets with no profile: 25.
    for (let i = 0; i < 3; i++) expectError(await call('delete', banPath('abc')), 404, 'NOT_FOUND');
    for (let i = 0; i < 3; i++) expectError(await call('delete', banPath(UNSIGNED_STEAM)), 404, 'NOT_FOUND');
    for (let i = 0; i < 3; i++) expectError(await call('post', bansPath(), { body: { userId: randomUUID() } }), 404, 'NOT_FOUND');
    // Member routes draw on the same budget: 4 removals and an owner leave (409): 30.
    for (const t of extra.slice(0, 4)) expect((await call('delete', `/api/rooms/${ROOM_ID}/members/${t}`)).status).toBe(204);
    expectError(await call('delete', `/api/rooms/${ROOM_ID}/members/me`), 409, 'OWNER_PROTECTED');

    // The 31st of each kind is limited and never reaches the database.
    const last = extra[4] ?? '';
    clearObservations();
    expectError(await call('post', bansPath(), { body: { userId: last } }), 429, 'RATE_LIMITED');
    expectError(await call('delete', banPath(steamOf(last))), 429, 'RATE_LIMITED');
    expectError(await call('delete', `/api/rooms/${ROOM_ID}/members/${last}`), 429, 'RATE_LIMITED');
    expect(fakeDb.rpc).not.toHaveBeenCalled();
    expect(queriesOn('profiles')).toHaveLength(0);
    expect(roleOf(last)).toBe('member');
    expectNoSideEffects();

    // The list has its own budget, and another admin has their own write budget.
    expect((await call('get', bansPath())).status).toBe(200);
    expect((await call('post', bansPath(), { as: ids.admin, body: { userId: last } })).status).toBe(201);
  });

  it('does not charge 401s, room 404s, or plain-member 403s (all rejected before the limiter)', async () => {
    const caller = ids.member;
    for (let i = 0; i < 5; i++) {
      expectError(await call('post', bansPath(), { signedIn: false, body: { userId: ids.member2 } }), 401, 'UNAUTHENTICATED');
    }
    for (let i = 0; i < 10; i++) {
      expectError(await call('post', bansPath(OTHER_ROOM_ID), { as: caller, body: { userId: ids.member2 } }), 404, 'NOT_FOUND');
      expectError(await call('delete', banPath(UNSIGNED_STEAM, 'not-a-uuid'), { as: caller }), 404, 'NOT_FOUND');
      expectError(await call('post', bansPath(), { as: caller, body: { userId: ids.member2 } }), 403, 'FORBIDDEN');
      expectError(await call('delete', banPath(UNSIGNED_STEAM), { as: caller }), 403, 'FORBIDDEN');
      // Even an invalid body is a 403 first: the role check runs before the limiter and validate().
      expectError(await call('post', bansPath(), { as: caller, body: { nope: true } }), 403, 'FORBIDDEN');
    }
    for (let i = 0; i < 70; i++) {
      expectError(await call('get', bansPath(), { as: caller }), 403, 'FORBIDDEN');
    }
    expect(fakeDb.rpc).not.toHaveBeenCalled();

    // Promoted to owner in the database: both full budgets are still there.
    setRole(ids.owner, 'admin');
    setRole(caller, 'owner');
    for (let i = 0; i < 30; i++) seedBan(newSteamId(), ids.owner, T0);
    const steams = world.bans.map((b) => b.steam_id);
    for (const steam of steams) expect((await call('delete', banPath(steam), { as: caller })).status).toBe(204);
    expectError(await call('delete', banPath(UNSIGNED_STEAM), { as: caller }), 429, 'RATE_LIMITED');
    expect(rpcCalls('unban')).toHaveLength(30);

    for (let i = 0; i < 60; i++) expect((await call('get', bansPath(), { as: caller })).status).toBe(200);
    expectError(await call('get', bansPath(), { as: caller }), 429, 'RATE_LIMITED');
  });

  it('lists at most 60 times a minute per user; 422s past the limiter count, and the write budget is untouched', async () => {
    for (let i = 0; i < 30; i++) expect((await call('get', bansPath())).status).toBe(200);
    for (let i = 0; i < 30; i++) expectError(await call('get', `${bansPath()}?cursor=bad`), 422, 'VALIDATION_FAILED');
    const before = queriesOn('room_bans').length;
    expectError(await call('get', bansPath()), 429, 'RATE_LIMITED');
    expect(queriesOn('room_bans')).toHaveLength(before);
    expect((await call('post', bansPath(), { body: { userId: ids.member } })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe('bans: secrets', () => {
  it('never logs, returns, or broadcasts the session token, service key, reason, or DB details across every route', async () => {
    const reason = 'REASON-MARKER-7f3a';
    livekit.removeParticipant.mockRejectedValue(new ServerError('internal', 'boom', 500, 'internal'));
    seedInvite({ kind: 'direct', created_by: ids.member, invitee_steam_id: steamOf(ids.outsider) });
    const texts: string[] = [];
    texts.push((await call('post', bansPath(), { body: { userId: ids.member, reason } })).text);
    texts.push((await call('get', bansPath(), { as: ids.admin })).text);
    texts.push((await call('delete', banPath(steamOf(ids.member)), { as: ids.admin })).text);
    results.rpcByName.ban_member = rpcError('XX000');
    texts.push((await call('post', bansPath(), { body: { userId: ids.member2, reason } })).text);
    world.fail.bans = true;
    texts.push((await call('get', bansPath())).text);

    const logs = logLines.join('');
    expect(logs).toContain('ban_member failed');
    expect(logsAt(40, 'could not remove participant')).toHaveLength(2);
    const broadcasts = JSON.stringify(sentBroadcasts());
    for (const text of [...texts, logs, broadcasts]) {
      for (const token of world.tokens.values()) expect(text).not.toContain(token);
      expect(text).not.toContain('test-service-role-key');
      expect(text).not.toContain('test-livekit-secret');
      expect(text).not.toContain('ROWVALUE-DETAILS');
      expect(text).not.toContain('HINTVALUE');
    }
    for (const text of texts) expect(text).not.toContain('SECRET-DB-MESSAGE');
    expect(logs).not.toContain(reason);
    expect(broadcasts).not.toContain(reason);
  });
});
