import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  AccessToken,
  ParticipantInfo,
  ParticipantInfo_State,
  ServerError,
} from 'livekit-server-sdk';
import type * as PinoModule from 'pino';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LivekitModule from '../src/lib/livekit.js';
import { fakeDb, firstArg, queries, resetFakeDb, results, type DbResult, type RecordedQuery } from './helpers/fakeDb.js';

/*
 * Voice (tokens, participant list, LiveKit webhook) through the real app, offline.
 * The database is faked at the supabase-js client with an in-memory world whose reads honour
 * only the filters the services actually pass (and PostgREST's `!inner` semantics), so a dropped
 * filter shows up as a leak. LiveKit is faked at livekitRooms (listParticipants,
 * removeParticipant); the webhook receiver is the real WebhookReceiver, and requests are signed
 * the way LiveKit signs them (an AccessToken carrying the body's base64 sha256). Broadcasts are
 * observed at the Realtime REST fetch boundary, so broadcast.ts's schema check runs. Every log
 * line (LOG_LEVEL=trace) is captured and checked for secrets.
 */

type RemoveOptions = { revokeTokenTs?: bigint };

const logLines = vi.hoisted<string[]>(() => []);
const livekit = vi.hoisted(() => ({
  listParticipants: vi.fn<(room: string) => Promise<ParticipantInfo[]>>(),
  removeParticipant: vi.fn<(room: string, identity: string, options?: RemoveOptions) => Promise<void>>(),
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
  livekitRooms: {
    listParticipants: livekit.listParticipants,
    removeParticipant: livekit.removeParticipant,
    deleteRoom: livekit.deleteRoom,
  },
}));

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

const savedEnv = { LOG_LEVEL: process.env.LOG_LEVEL };
process.env.LOG_LEVEL = 'trace';

const { createApp } = await import('../src/app.js');
const { newRandomToken, SESSION_COOKIE } = await import('../src/lib/session.js');
const { ErrorResponse } = await import('../src/contracts/http/common.js');
const { VoiceToken, VoiceParticipantList, VOICE_TOKEN_TTL_SECONDS } = await import('../src/contracts/http/voice.js');
const { serverEvents } = await import('../src/contracts/events.js');
const { removeFromVoice, voiceRemovalRetry } = await import('../src/services/rooms.js');

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
const LIVEKIT_URL = 'ws://localhost:7880';
const LIVEKIT_KEY = 'test-livekit-key';
const LIVEKIT_SECRET = 'test-livekit-secret';

const ROOM_ID = '1a2b3c4d-0000-4000-8000-00000000c001';
const OTHER_ROOM_ID = '1a2b3c4d-0000-4000-8000-00000000c002';
const OWNER_ID = '0f000000-0000-4000-8000-00000000c101';
const MEMBER_ID = '0f000000-0000-4000-8000-00000000c102';
const MEMBER2_ID = '0f000000-0000-4000-8000-00000000c103';
const OUTSIDER_ID = '0f000000-0000-4000-8000-00000000c104';
const GENERAL_ID = 'c0000000-0000-4000-8000-00000000c201';
const VOICE_ID = 'c0000000-0000-4000-8000-00000000c202';
const VOICE2_ID = 'c0000000-0000-4000-8000-00000000c203';
const DELETED_VOICE_ID = 'c0000000-0000-4000-8000-00000000c204';
const OTHER_VOICE_ID = 'c0000000-0000-4000-8000-00000000c205';
const T0 = '2026-09-01T10:00:00.123456+00:00';
const T1 = '2026-09-02T10:00:00.123456+00:00';

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
  position: number;
  created_at: string;
  deleted_at: string | null;
}

interface MemberRow {
  room_id: string;
  user_id: string;
  role: Role;
}

interface ProfileRow {
  id: string;
  steam_id: string;
  display_name: string;
  avatar_url: string | null;
}

interface World {
  me: string;
  /** profile_id the session row returns (normally `me`; uppercase to prove lowercasing). */
  sessionProfileId: string;
  token: string;
  rooms: RoomRow[];
  channels: ChannelRow[];
  members: MemberRow[];
  profiles: ProfileRow[];
  /** Participants LiveKit reports per room name; a missing room is LiveKit's not_found. */
  livekitRooms: Record<string, ParticipantInfo[]>;
  failChannelsRead?: boolean;
}

let world: World;

function channelRow(id: string, type: ChannelType, position: number, roomId = ROOM_ID): ChannelRow {
  return { id, room_id: roomId, type, position, created_at: T0, deleted_at: null };
}

function profile(id: string, name: string, avatar: string | null = null): ProfileRow {
  return { id, steam_id: `7656119${id.slice(-10).replace(/\D/g, '0')}`, display_name: name, avatar_url: avatar };
}

/**
 * ROOM_ID: a text channel, two live voice channels (stored out of position order so an unordered
 * read shows), and a deleted voice channel; the owner and two members, plus `me` as `myRole`
 * (null: not a member). OTHER_ROOM_ID has its own voice channel and OUTSIDER_ID, never `me`.
 */
function buildWorld(myRole: Role | null): void {
  const me = world.me;
  world.rooms = [
    { id: ROOM_ID, deleted_at: null },
    { id: OTHER_ROOM_ID, deleted_at: null },
  ];
  world.channels = [
    // Position order (VOICE2, VOICE) differs from id and insertion order, so any other ordering shows.
    channelRow(VOICE_ID, 'voice', 1),
    channelRow(GENERAL_ID, 'text', 0),
    { ...channelRow(DELETED_VOICE_ID, 'voice', 0), deleted_at: T0 },
    channelRow(VOICE2_ID, 'voice', 0),
    channelRow(OTHER_VOICE_ID, 'voice', 0, OTHER_ROOM_ID),
  ];
  world.members = [
    { room_id: ROOM_ID, user_id: OWNER_ID, role: 'owner' },
    { room_id: ROOM_ID, user_id: MEMBER_ID, role: 'member' },
    { room_id: ROOM_ID, user_id: MEMBER2_ID, role: 'member' },
    { room_id: OTHER_ROOM_ID, user_id: OUTSIDER_ID, role: 'owner' },
  ];
  if (myRole) world.members.push({ room_id: ROOM_ID, user_id: me, role: myRole });
  world.profiles = [
    profile(me, 'Me', 'https://avatars.steamstatic.com/me_full.jpg'),
    profile(OWNER_ID, 'Olivia'),
    // Not https: dropped to null rather than failing the read.
    profile(MEMBER_ID, 'Mallory', 'http://insecure.example/avatar.jpg'),
    profile(MEMBER2_ID, 'Max'),
    profile(OUTSIDER_ID, 'Oscar'),
  ];
}

// ---------------------------------------------------------------------------
// Fake reads (PostgREST semantics: only the filters the service sends apply)
// ---------------------------------------------------------------------------

const lower = (value: unknown): unknown => (typeof value === 'string' ? value.toLowerCase() : value);

function hasCall(query: RecordedQuery, method: string, ...args: unknown[]): boolean {
  return query.calls.some(([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args));
}

/** Applies eq/is/in filters to columns the row has (uuids compare case-insensitively, as in Postgres). */
function matches(row: object, query: RecordedQuery): boolean {
  const record = row as Record<string, unknown>;
  return query.calls.every(([method, args]) => {
    if (method !== 'eq' && method !== 'is' && method !== 'in') return true;
    const [column, value] = args as [string, unknown];
    if (!(column in record)) return true;
    if (method === 'in') return (value as unknown[]).map(lower).includes(lower(record[column]));
    return lower(record[column]) === lower(value);
  });
}

function isSingle(query: RecordedQuery): boolean {
  return query.calls.some(([m]) => m === 'maybeSingle' || m === 'single');
}

function single(rows: unknown[]): DbResult {
  if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
  return { data: rows[0] ?? null, error: null };
}

function roomOfRow(roomId: string, query: RecordedQuery): RoomRow | undefined {
  const room = world.rooms.find((r) => r.id === roomId);
  if (!room) return undefined;
  if (room.deleted_at !== null && hasCall(query, 'is', 'rooms.deleted_at', null)) return undefined;
  return room;
}

function ordered(rows: ChannelRow[], query: RecordedQuery): ChannelRow[] {
  const orders = query.calls.filter(([m]) => m === 'order').map(([, a]) => a as [keyof ChannelRow, { ascending?: boolean }?]);
  return [...rows].sort((a, b) => {
    for (const [column, opts] of orders) {
      const x = a[column] ?? '';
      const y = b[column] ?? '';
      if (x === y) continue;
      const sign = opts?.ascending === false ? -1 : 1;
      return (x < y ? -1 : 1) * sign;
    }
    return 0;
  });
}

function channelsSelect(query: RecordedQuery): DbResult {
  if (world.failChannelsRead) {
    return { data: null, error: { code: 'XX000', message: 'SECRET-DB-MESSAGE', details: 'ROWVALUE', hint: 'HINTVALUE' } };
  }
  const columns = String(firstArg(query, 'select'));
  const rows = world.channels.filter((c) => matches(c, query));
  if (columns === 'id, room_id, type, rooms!inner(room_members!inner(role))') {
    // findChannelAccess (requireChannelMember and the webhook's participant_joined).
    const userFilter = query.calls.find(([m, a]) => m === 'eq' && a[0] === 'rooms.room_members.user_id')?.[1][1];
    const joined = rows.flatMap((c) => {
      if (!roomOfRow(c.room_id, query)) return [];
      const members = world.members
        .filter((m) => m.room_id === c.room_id && (userFilter === undefined || lower(m.user_id) === lower(userFilter)))
        .map((m) => ({ role: m.role }));
      if (members.length === 0) return [];
      return [{ id: c.id, room_id: c.room_id, type: c.type, rooms: { room_members: members } }];
    });
    return single(joined);
  }
  if (columns === 'id') {
    // listRoomVoiceParticipants.
    return { data: ordered(rows, query).map((c) => ({ id: c.id })), error: null };
  }
  if (columns === 'room_id, rooms!inner(id)') {
    // findLiveVoiceChannelRoom (webhook).
    const joined = rows.flatMap((c) => (roomOfRow(c.room_id, query) ? [{ room_id: c.room_id, rooms: { id: c.room_id } }] : []));
    return isSingle(query) ? single(joined) : { data: joined, error: null };
  }
  throw new Error(`unexpected channels select: ${columns}`);
}

function roomMembersSelect(query: RecordedQuery): DbResult {
  const columns = String(firstArg(query, 'select'));
  const rows = world.members.filter((m) => matches(m, query));
  if (columns === 'role, rooms!inner(id)') {
    // findMembership (requireRoomMember).
    const live = rows.filter((m) => roomOfRow(m.room_id, query));
    return single(live.map((m) => ({ role: m.role, rooms: { id: m.room_id } })));
  }
  if (columns === 'user_id, profiles!inner(id, display_name, avatar_url)') {
    const joined = rows.flatMap((m) => {
      const p = world.profiles.find((x) => x.id === m.user_id);
      if (!p) return [];
      return [{ user_id: m.user_id, profiles: { id: p.id, display_name: p.display_name, avatar_url: p.avatar_url } }];
    });
    return { data: joined, error: null };
  }
  throw new Error(`unexpected room_members select: ${columns}`);
}

function profilesSelect(query: RecordedQuery): DbResult {
  if (String(firstArg(query, 'select')) !== 'id, steam_id, display_name, avatar_url') throw new Error('unexpected profiles select');
  return single(world.profiles.filter((p) => matches(p, query)));
}

function install(): void {
  results.selectByTable.sessions = () => ({ data: { id: randomUUID(), profile_id: world.sessionProfileId }, error: null });
  results.selectByTable.channels = channelsSelect;
  results.selectByTable.room_members = roomMembersSelect;
  results.selectByTable.profiles = profilesSelect;
}

function freshWorld(): World {
  const me = randomUUID();
  return {
    me,
    sessionProfileId: me,
    token: newRandomToken(),
    rooms: [],
    channels: [],
    members: [],
    profiles: [],
    livekitRooms: {},
  };
}

// ---------------------------------------------------------------------------
// LiveKit fakes
// ---------------------------------------------------------------------------

let nextSid = 0;

function participant(identity: string, joinedAtSec: number, extra: Partial<ParticipantInfo> = {}): ParticipantInfo {
  nextSid += 1;
  return new ParticipantInfo({
    sid: `PA_${nextSid}`,
    identity,
    state: ParticipantInfo_State.ACTIVE,
    joinedAt: BigInt(joinedAtSec),
    joinedAtMs: BigInt(joinedAtSec) * 1000n,
    ...extra,
  });
}

function notFound(): ServerError {
  return new ServerError('not_found', 'requested room does not exist', 404, 'not_found');
}

function listedRooms(): string[] {
  return livekit.listParticipants.mock.calls.map(([room]) => room).sort();
}

/**
 * Every removal passes no options, so LiveKit's default revocation applies (tokens with nbf before
 * now + 1 minute leeway can't rejoin); our own revokeTokenTs would be weaker.
 */
function expectNoRemoveOptions(): void {
  for (const call of livekit.removeParticipant.mock.calls) expect(call).toHaveLength(2);
}

/** The (room, identity) pairs removed from LiveKit, sorted, after checking none passed options. */
function kicked(): [string, string][] {
  expectNoRemoveOptions();
  return livekit.removeParticipant.mock.calls.map(([room, identity]) => [room, identity] as [string, string]).sort();
}

// ---------------------------------------------------------------------------
// Requests and observations
// ---------------------------------------------------------------------------

interface CallOptions {
  signedIn?: boolean;
  origin?: string | null;
  contentType?: string | null;
  body?: string;
}

const tokenPath = (channelId: string) => `/api/channels/${channelId}/voice/token`;
const participantsPath = (roomId: string) => `/api/rooms/${roomId}/voice/participants`;

/** POST a voice token request as hideout-web sends it: session cookie, WEB_ORIGIN, JSON content type. */
function postToken(channelId: string, options: CallOptions = {}) {
  let req = request(app).post(tokenPath(channelId));
  if (options.signedIn ?? true) req = req.set('Cookie', `${SESSION_COOKIE}=${world.token}`);
  const origin = options.origin === undefined ? WEB_ORIGIN : options.origin;
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (origin !== null) req = req.set('Origin', origin);
  if (contentType !== null) req = req.set('Content-Type', contentType);
  return options.body === undefined ? req : req.send(options.body);
}

function getParticipants(roomId: string, options: { signedIn?: boolean } = {}) {
  let req = request(app).get(participantsPath(roomId)).set('Origin', WEB_ORIGIN);
  if (options.signedIn ?? true) req = req.set('Cookie', `${SESSION_COOKIE}=${world.token}`);
  return req;
}

let lastWebhookAuth: string | undefined;

/** The Authorization value LiveKit sends: an HS256 JWT (iss = API key) whose `sha256` claim is the body's base64 sha256. */
async function signWebhook(body: string, key = LIVEKIT_KEY, secret = LIVEKIT_SECRET): Promise<string> {
  const at = new AccessToken(key, secret);
  at.sha256 = createHash('sha256').update(body).digest('base64');
  return at.toJwt();
}

interface WebhookOptions {
  /** Defaults to a valid signature of the sent body. `null` omits the header. */
  auth?: string | null;
  contentType?: string;
  /** Sent instead of JSON.stringify(event) (the signature still covers the event). */
  rawBody?: string;
}

async function postWebhook(event: object, options: WebhookOptions = {}) {
  const body = JSON.stringify(event);
  const auth = options.auth === undefined ? await signWebhook(body) : options.auth;
  lastWebhookAuth = auth ?? undefined;
  let req = request(app)
    .post('/api/livekit/webhook')
    .set('Content-Type', options.contentType ?? 'application/webhook+json');
  if (auth !== null) req = req.set('Authorization', auth);
  return req.send(options.rawBody ?? body);
}

let nextEvent = 0;

function webhookEvent(
  event: string,
  roomName: string,
  participantInfo?: { sid?: string; identity: string },
): Record<string, unknown> {
  nextEvent += 1;
  return {
    event,
    id: `EV_${nextEvent}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    room: { sid: `RM_${nextEvent}`, name: roomName },
    ...(participantInfo && {
      participant: { sid: participantInfo.sid ?? `PA_x${nextEvent}`, identity: participantInfo.identity, state: 'ACTIVE' },
    }),
  };
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

/** Exactly one broadcast was sent: voice:participants on room:<roomId>, private, schema-valid. */
function onlyVoiceBroadcast(roomId = ROOM_ID): { channelId: string; participants: unknown[] } {
  const sent = sentBroadcasts();
  expect(sent).toHaveLength(1);
  const [b] = sent as [SentBroadcast];
  expect(b.topic).toBe(`room:${roomId}`);
  expect(b.event).toBe('voice:participants');
  expect(b.private).toBe(true);
  expect(serverEvents.room['voice:participants'].parse(b.payload)).toStrictEqual(b.payload);
  return b.payload as { channelId: string; participants: unknown[] };
}

const summary = (id: string, displayName: string, avatarUrl: string | null = null) => ({ id, displayName, avatarUrl });

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

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
  expect(ErrorResponse.parse(res.body)).toStrictEqual(res.body);
}

function queriesOn(table: string): RecordedQuery[] {
  return queries.filter((q) => q.table === table);
}

function expectNoSideEffects(): void {
  // Voice never writes to the database.
  expect(fakeDb.rpc).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(livekit.removeParticipant).not.toHaveBeenCalled();
  expect(livekit.deleteRoom).not.toHaveBeenCalled();
}

let issuedTokens: string[] = [];

beforeEach(() => {
  resetFakeDb();
  logLines.length = 0;
  issuedTokens = [];
  lastWebhookAuth = undefined;
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 202 })));
  livekit.listParticipants.mockReset();
  livekit.listParticipants.mockImplementation((room) => {
    const list = world.livekitRooms[room];
    return list ? Promise.resolve(list) : Promise.reject(notFound());
  });
  livekit.removeParticipant.mockReset();
  livekit.removeParticipant.mockResolvedValue(undefined);
  livekit.deleteRoom.mockReset();
  livekit.deleteRoom.mockResolvedValue(undefined);
  // A fresh user per test also isolates the per-user rate limiters, whose state is module-level.
  world = freshWorld();
  install();
});

afterEach(() => {
  const logs = logLines.join('');
  for (const secret of [
    'test-service-role-key',
    'test-session-secret',
    LIVEKIT_SECRET,
    'test-steam-api-key',
    world.token,
    'ROWVALUE',
    'HINTVALUE',
    ...issuedTokens,
    ...(lastWebhookAuth ? [lastWebhookAuth] : []),
  ]) {
    expect(logs).not.toContain(secret);
  }
});

// ---------------------------------------------------------------------------
// POST /api/channels/:channelId/voice/token
// ---------------------------------------------------------------------------

interface VoiceClaims {
  iss: string;
  sub: string;
  name: string;
  nbf: number;
  exp: number;
  video: Record<string, unknown>;
  [key: string]: unknown;
}

function decodeVoiceToken(token: string): VoiceClaims {
  return jwt.verify(token, LIVEKIT_SECRET, { algorithms: ['HS256'], issuer: LIVEKIT_KEY }) as VoiceClaims;
}

describe('voice token: access control', () => {
  it('returns 401 without a session and touches no data', async () => {
    buildWorld('member');
    const res = await postToken(VOICE_ID, { signedIn: false });
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(queries).toHaveLength(0);
    expect(res.body.token).toBeUndefined();
  });

  it('returns 404 when a non-member requests a token for a voice channel in the room', async () => {
    buildWorld(null);
    const res = await postToken(VOICE_ID);
    expectError(res, 404, 'NOT_FOUND');
    expect(res.body.token).toBeUndefined();
    const [access] = queriesOn('channels');
    expect(access?.calls).toContainEqual(['eq', ['id', VOICE_ID]]);
    expect(access?.calls).toContainEqual(['eq', ['rooms.room_members.user_id', world.me]]);
    expect(access?.calls).toContainEqual(['is', ['deleted_at', null]]);
    expect(access?.calls).toContainEqual(['is', ['rooms.deleted_at', null]]);
    expect(queriesOn('profiles')).toHaveLength(0);
  });

  it('returns an identical 404 for a non-member, a member of another room, a missing channel, a deleted channel, a deleted room, and a malformed id', async () => {
    buildWorld(null);
    const nonMember = await postToken(VOICE_ID);
    const otherRoom = await postToken(OTHER_VOICE_ID);
    buildWorld('owner');
    const missing = await postToken(randomUUID());
    const deletedChannel = await postToken(DELETED_VOICE_ID);
    const malformed = await postToken('not-a-uuid');
    const injected = await postToken(encodeURIComponent(`${VOICE_ID},id.neq.0`));
    world.rooms[0] = { id: ROOM_ID, deleted_at: T1 };
    const deletedRoom = await postToken(VOICE_ID);

    expectError(nonMember, 404, 'NOT_FOUND');
    for (const res of [otherRoom, missing, deletedChannel, malformed, injected, deletedRoom]) {
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual(nonMember.body);
    }
    expect(queriesOn('profiles')).toHaveLength(0);
    expectNoSideEffects();
  });

  it('never looks up the channel for a malformed channelId', async () => {
    buildWorld('owner');
    for (const id of ['not-a-uuid', `${VOICE_ID}x`, '123']) {
      expectError(await postToken(id), 404, 'NOT_FOUND');
    }
    expect(queries.filter((q) => q.table !== 'sessions')).toHaveLength(0);
  });

  it('returns 404 immediately after the member is removed from the room', async () => {
    buildWorld('member');
    expect((await postToken(VOICE_ID)).status).toBe(200);
    world.members = world.members.filter((m) => m.user_id !== world.me);
    expectError(await postToken(VOICE_ID), 404, 'NOT_FOUND');
  });

  it('returns 409 CHANNEL_NOT_VOICE when a member asks for a token for a text channel', async () => {
    buildWorld('member');
    const res = await postToken(GENERAL_ID);
    expectError(res, 409, 'CHANNEL_NOT_VOICE');
    expect(res.body.token).toBeUndefined();
    expect(queriesOn('profiles')).toHaveLength(0);
  });

  it('returns 401 when the session is valid but the profile is gone', async () => {
    buildWorld('member');
    world.profiles = world.profiles.filter((p) => p.id !== world.me);
    const res = await postToken(VOICE_ID);
    expectError(res, 401, 'UNAUTHENTICATED');
    expect(res.body.token).toBeUndefined();
  });
});

describe('voice token: CSRF', () => {
  it.each<[string, CallOptions, string]>([
    ['no Origin', { origin: null }, 'ORIGIN_NOT_ALLOWED'],
    ['a foreign Origin', { origin: 'https://evil.example' }, 'ORIGIN_NOT_ALLOWED'],
    ['the API origin with a different port', { origin: 'http://localhost:3001' }, 'ORIGIN_NOT_ALLOWED'],
    ['a text/plain Content-Type', { contentType: 'text/plain' }, 'UNSUPPORTED_CONTENT_TYPE'],
    ['a form Content-Type', { contentType: 'application/x-www-form-urlencoded' }, 'UNSUPPORTED_CONTENT_TYPE'],
    ['no Content-Type', { contentType: null }, 'UNSUPPORTED_CONTENT_TYPE'],
  ])('returns 403 for %s without issuing a token or touching data', async (_label, options, code) => {
    buildWorld('member');
    const res = await postToken(VOICE_ID, options);
    expectError(res, 403, code);
    expect(res.body.token).toBeUndefined();
    expect(queries).toHaveLength(0);
  });

  it('accepts an empty body or {} and rejects a body that is not JSON', async () => {
    buildWorld('member');
    expect((await postToken(VOICE_ID)).status).toBe(200);
    expect((await postToken(VOICE_ID, { body: '{}' })).status).toBe(200);
    expect((await postToken(VOICE_ID, { body: '{"identity":"someone-else","room":"voice_x"}' })).status).toBe(200);
    expectError(await postToken(VOICE_ID, { body: '{' }), 400, 'INVALID_JSON');
  });
});

describe('voice token: the token', () => {
  it('issues a microphone-only join token for exactly this channel, as the caller, for 60 seconds', async () => {
    buildWorld('member');
    const before = Date.now();
    const res = await postToken(VOICE_ID);
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(VoiceToken.parse(res.body)).toStrictEqual(res.body);
    issuedTokens.push(res.body.token as string);
    expect(res.body.url).toBe(LIVEKIT_URL);
    expect(res.body.roomName).toBe(`voice_${VOICE_ID}`);

    const claims = decodeVoiceToken(res.body.token as string);
    expect(claims.sub).toBe(world.me);
    expect(claims.name).toBe('Me');
    expect(claims.iss).toBe(LIVEKIT_KEY);
    expect(claims.exp - claims.nbf).toBe(VOICE_TOKEN_TTL_SECONDS);
    expect(VOICE_TOKEN_TTL_SECONDS).toBe(60);
    expect(claims.nbf).toBeGreaterThanOrEqual(Math.floor(before / 1000));
    expect(claims.nbf).toBeLessThanOrEqual(Math.ceil(after / 1000));
    // Exactly these grants: no roomCreate/roomAdmin/roomList/roomRecord/hidden/agent, no camera or screen share.
    expect(claims.video).toStrictEqual({
      roomJoin: true,
      room: `voice_${VOICE_ID}`,
      roomCreate: false,
      canSubscribe: true,
      canPublish: true,
      canPublishSources: ['microphone'],
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iss', 'name', 'nbf', 'sub', 'video']);

    // expiresAt matches the token's exp.
    const expiresAt = Date.parse(res.body.expiresAt as string);
    expect(expiresAt).toBe(claims.exp * 1000);
    expect(expiresAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 60_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 60_000);
    expectNoSideEffects();
  });

  it('signs with the LiveKit API secret only (another secret does not verify)', async () => {
    buildWorld('member');
    const res = await postToken(VOICE_ID);
    issuedTokens.push(res.body.token as string);
    expect(() => jwt.verify(res.body.token as string, 'some-other-secret', { algorithms: ['HS256'] })).toThrow();
    expect((jwt.decode(res.body.token as string, { complete: true }) as { header: { alg: string } }).header.alg).toBe('HS256');
  });

  it('uses the lowercased profile id as identity and the lowercased channel id in the room name', async () => {
    buildWorld('member');
    world.sessionProfileId = world.me.toUpperCase();
    const res = await postToken(VOICE_ID.toUpperCase());
    expect(res.status).toBe(200);
    issuedTokens.push(res.body.token as string);
    const claims = decodeVoiceToken(res.body.token as string);
    expect(claims.sub).toBe(world.me);
    expect(claims.sub).toBe(claims.sub.toLowerCase());
    expect(claims.video.room).toBe(`voice_${VOICE_ID}`);
    expect(res.body.roomName).toBe(`voice_${VOICE_ID}`);
  });

  it('ignores identity or room fields in the body', async () => {
    buildWorld('member');
    const res = await postToken(VOICE_ID, {
      body: JSON.stringify({ identity: OWNER_ID, name: 'Olivia', room: `voice_${OTHER_VOICE_ID}`, roomAdmin: true }),
    });
    expect(res.status).toBe(200);
    issuedTokens.push(res.body.token as string);
    const claims = decodeVoiceToken(res.body.token as string);
    expect(claims.sub).toBe(world.me);
    expect(claims.name).toBe('Me');
    expect(claims.video.room).toBe(`voice_${VOICE_ID}`);
    expect(claims.video.roomAdmin).toBeUndefined();
  });

  it('returns 429 RATE_LIMITED on the 21st token in a minute for the same user', async () => {
    buildWorld('member');
    for (let i = 0; i < 20; i += 1) {
      const res = await postToken(VOICE_ID);
      expect(res.status).toBe(200);
      issuedTokens.push(res.body.token as string);
    }
    const limited = await postToken(VOICE_ID);
    expectError(limited, 429, 'RATE_LIMITED');
    expect(limited.body.token).toBeUndefined();

    // Another user is unaffected (the fakes read the current world).
    world = freshWorld();
    buildWorld('member');
    const res = await postToken(VOICE_ID);
    expect(res.status).toBe(200);
    issuedTokens.push(res.body.token as string);
  });

  it('counts non-member probes too: the limiter runs before the membership check, so a 429 reveals nothing', async () => {
    buildWorld(null);
    for (let i = 0; i < 20; i += 1) expectError(await postToken(i % 2 ? VOICE_ID : randomUUID()), 404, 'NOT_FOUND');
    const before = queries.length;
    const limitedReal = await postToken(VOICE_ID);
    const limitedMissing = await postToken(randomUUID());
    expectError(limitedReal, 429, 'RATE_LIMITED');
    expect(limitedMissing.body).toStrictEqual(limitedReal.body);
    expect(queries.slice(before).every((q) => q.table === 'sessions')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/rooms/:roomId/voice/participants
// ---------------------------------------------------------------------------

describe('voice participants: access control', () => {
  it('returns 401 without a session and asks LiveKit nothing', async () => {
    buildWorld('member');
    expectError(await getParticipants(ROOM_ID, { signedIn: false }), 401, 'UNAUTHENTICATED');
    expect(queries).toHaveLength(0);
    expect(livekit.listParticipants).not.toHaveBeenCalled();
  });

  it('returns an identical 404 for a non-member, a missing room, a deleted room, and a malformed id, without asking LiveKit', async () => {
    buildWorld(null);
    const nonMember = await getParticipants(ROOM_ID);
    const otherRoom = await getParticipants(OTHER_ROOM_ID);
    buildWorld('owner');
    const missing = await getParticipants(randomUUID());
    const malformed = await getParticipants('not-a-uuid');
    world.rooms[0] = { id: ROOM_ID, deleted_at: T1 };
    const deleted = await getParticipants(ROOM_ID);

    expectError(nonMember, 404, 'NOT_FOUND');
    for (const res of [otherRoom, missing, malformed, deleted]) {
      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual(nonMember.body);
    }
    expect(livekit.listParticipants).not.toHaveBeenCalled();
    expect(queriesOn('channels')).toHaveLength(0);
  });
});

describe('voice participants: the list', () => {
  it('lists every live voice channel by position with its members in join order', async () => {
    buildWorld('member');
    world.livekitRooms[`voice_${VOICE2_ID}`] = [
      participant(MEMBER2_ID, 300),
      participant(world.me.toUpperCase(), 100),
      participant(OUTSIDER_ID, 50), // not a member of this room
      participant('not-a-uuid', 60),
      participant(OWNER_ID, 70, { state: ParticipantInfo_State.DISCONNECTED }),
      participant(world.me, 400), // a second connection of the same person
      participant(MEMBER_ID, 200),
    ];
    // VOICE_ID's LiveKit room doesn't exist yet (nobody joined): not_found is an empty list.

    const res = await getParticipants(ROOM_ID);
    expect(res.status).toBe(200);
    expect(VoiceParticipantList.parse(res.body)).toStrictEqual(res.body);
    expect(res.body).toStrictEqual({
      data: [
        {
          channelId: VOICE2_ID,
          participants: [
            summary(world.me, 'Me', 'https://avatars.steamstatic.com/me_full.jpg'),
            summary(MEMBER_ID, 'Mallory'),
            summary(MEMBER2_ID, 'Max'),
          ],
        },
        { channelId: VOICE_ID, participants: [] },
      ],
    });
    // Only this room's live voice channels are read from LiveKit.
    expect(listedRooms()).toEqual([`voice_${VOICE_ID}`, `voice_${VOICE2_ID}`].sort());
    // Profiles are only looked up among this room's members.
    const profileRead = queriesOn('room_members').find((q) => String(firstArg(q, 'select')).startsWith('user_id'));
    expect(profileRead?.calls).toContainEqual(['eq', ['room_id', ROOM_ID]]);
    // Connected non-members (another room's member, a non-uuid identity) are kicked as a backstop;
    // the disconnected owner is not.
    expect(kicked()).toEqual([
      [`voice_${VOICE2_ID}`, OUTSIDER_ID],
      [`voice_${VOICE2_ID}`, 'not-a-uuid'],
    ]);
    expect(logsAt(40, 'non-member connected to a voice channel')).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it('still returns 200 when kicking a connected non-member fails', async () => {
    buildWorld('member');
    world.livekitRooms[`voice_${VOICE_ID}`] = [participant(OUTSIDER_ID, 10), participant(MEMBER_ID, 20)];
    livekit.removeParticipant.mockRejectedValue(new ServerError('internal', 'boom', 500, 'internal'));
    const res = await getParticipants(ROOM_ID);
    expect(res.status).toBe(200);
    expect(res.body.data[1]).toStrictEqual({ channelId: VOICE_ID, participants: [summary(MEMBER_ID, 'Mallory')] });
    expect(livekit.removeParticipant).toHaveBeenCalledOnce();
  });

  it('orders by joinedAtMs when present, falling back to joinedAt seconds', async () => {
    buildWorld('member');
    world.livekitRooms[`voice_${VOICE_ID}`] = [
      participant(MEMBER_ID, 10, { joinedAtMs: 10_900n }),
      participant(MEMBER2_ID, 10, { joinedAtMs: 10_100n }),
      participant(OWNER_ID, 10, { joinedAtMs: 0n }), // only seconds: 10_000 ms
    ];
    const res = await getParticipants(ROOM_ID);
    expect(res.body.data[1]).toStrictEqual({
      channelId: VOICE_ID,
      participants: [summary(OWNER_ID, 'Olivia'), summary(MEMBER2_ID, 'Max'), summary(MEMBER_ID, 'Mallory')],
    });
  });

  it('returns an empty list for a room with no voice channels, without asking LiveKit', async () => {
    buildWorld('member');
    world.channels = world.channels.filter((c) => c.type === 'text' || c.room_id !== ROOM_ID || c.deleted_at !== null);
    const res = await getParticipants(ROOM_ID);
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ data: [] });
    expect(livekit.listParticipants).not.toHaveBeenCalled();
  });

  it('shows a channel LiveKit fails to list (not a not_found) as empty, logs it, and still lists the others', async () => {
    buildWorld('member');
    world.livekitRooms[`voice_${VOICE_ID}`] = [participant(MEMBER_ID, 100)];
    livekit.listParticipants.mockImplementation((room) =>
      room === `voice_${VOICE2_ID}`
        ? Promise.reject(new ServerError('internal', 'LIVEKIT-INTERNAL-DETAIL', 500, 'internal'))
        : Promise.resolve(world.livekitRooms[room] ?? []),
    );
    const res = await getParticipants(ROOM_ID);
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      data: [
        { channelId: VOICE2_ID, participants: [] },
        { channelId: VOICE_ID, participants: [summary(MEMBER_ID, 'Mallory')] },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain('LIVEKIT-INTERNAL-DETAIL');
    const warned = logsAt(40, 'could not list LiveKit participants');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.channelId).toBe(VOICE2_ID);
  });

  it('shows every channel empty (200) when LiveKit is down', async () => {
    buildWorld('member');
    livekit.listParticipants.mockRejectedValue(new Error('fetch failed'));
    const res = await getParticipants(ROOM_ID);
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      data: [
        { channelId: VOICE2_ID, participants: [] },
        { channelId: VOICE_ID, participants: [] },
      ],
    });
  });

  it('returns 429 RATE_LIMITED on the 61st read in a minute for the same user', async () => {
    buildWorld('member');
    for (let i = 0; i < 60; i += 1) expect((await getParticipants(ROOM_ID)).status).toBe(200);
    expectError(await getParticipants(ROOM_ID), 429, 'RATE_LIMITED');
  });

  it('counts non-member probes too: the limiter runs before the membership check, so a 429 reveals nothing', async () => {
    buildWorld(null);
    for (let i = 0; i < 60; i += 1) expect((await getParticipants(i % 2 ? ROOM_ID : randomUUID())).status).toBe(404);
    const before = queries.length;
    const limitedReal = await getParticipants(ROOM_ID);
    const limitedMissing = await getParticipants(randomUUID());
    expectError(limitedReal, 429, 'RATE_LIMITED');
    expect(limitedMissing.body).toStrictEqual(limitedReal.body);
    // Only the session lookups ran: no membership check once limited.
    expect(queries.slice(before).every((q) => q.table === 'sessions')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/livekit/webhook: signature
// ---------------------------------------------------------------------------

function expectUntouched(): void {
  expect(queries).toHaveLength(0);
  expect(livekit.listParticipants).not.toHaveBeenCalled();
  expectNoSideEffects();
}

describe('livekit webhook: signature', () => {
  const joined = () => webhookEvent('participant_joined', `voice_${VOICE_ID}`, { identity: OUTSIDER_ID });

  it('returns 401 INVALID_SIGNATURE without an Authorization header and does nothing', async () => {
    buildWorld('member');
    expectError(await postWebhook(joined(), { auth: null }), 401, 'INVALID_SIGNATURE');
    expectUntouched();
  });

  it('returns 401 when the body was changed after signing', async () => {
    buildWorld('member');
    const signed = webhookEvent('room_finished', `voice_${VOICE_ID}`);
    const auth = await signWebhook(JSON.stringify(signed));
    const tampered = JSON.stringify(joined());
    expectError(await postWebhook(signed, { auth, rawBody: tampered }), 401, 'INVALID_SIGNATURE');
    // Whitespace counts too: the signature covers the exact bytes.
    expectError(await postWebhook(signed, { auth, rawBody: `${JSON.stringify(signed)} ` }), 401, 'INVALID_SIGNATURE');
    expectUntouched();
  });

  it('returns 401 for a signature made with another secret or another API key', async () => {
    buildWorld('member');
    const event = joined();
    const body = JSON.stringify(event);
    expectError(await postWebhook(event, { auth: await signWebhook(body, LIVEKIT_KEY, 'wrong-secret') }), 401, 'INVALID_SIGNATURE');
    expectError(await postWebhook(event, { auth: await signWebhook(body, 'other-key') }), 401, 'INVALID_SIGNATURE');
    expectUntouched();
  });

  it('returns 401 for an expired signature, one without exp, and a non-HS256 one', async () => {
    buildWorld('member');
    const event = joined();
    const body = JSON.stringify(event);
    const sha256 = createHash('sha256').update(body).digest('base64');
    const now = Math.floor(Date.now() / 1000);
    const expired = jwt.sign({ sha256, iss: LIVEKIT_KEY, exp: now - 3600, nbf: now - 7200 }, LIVEKIT_SECRET, { noTimestamp: true });
    const noExp = jwt.sign({ sha256, iss: LIVEKIT_KEY }, LIVEKIT_SECRET, { noTimestamp: true });
    const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({ sha256, iss: LIVEKIT_KEY, exp: now + 600 }),
    ).toString('base64url')}.`;
    for (const auth of [expired, noExp, unsigned, 'garbage', `Bearer ${await signWebhook(body)}`]) {
      expectError(await postWebhook(event, { auth }), 401, 'INVALID_SIGNATURE');
    }
    expectUntouched();
  });

  it('returns 401 for a correctly signed body sent as application/json', async () => {
    buildWorld('member');
    expectError(await postWebhook(joined(), { contentType: 'application/json' }), 401, 'INVALID_SIGNATURE');
    expectError(await postWebhook(joined(), { contentType: 'text/plain' }), 401, 'INVALID_SIGNATURE');
    expectUntouched();
  });

  it('returns 401 for a signed body that is not JSON', async () => {
    buildWorld('member');
    const body = 'not json';
    expectError(await postWebhook({}, { rawBody: body, auth: await signWebhook(body) }), 401, 'INVALID_SIGNATURE');
    expectUntouched();
  });

  it('returns 413 for a body over 100 kB and does nothing', async () => {
    buildWorld('member');
    const event = { ...joined(), padding: 'x'.repeat(110_000) };
    expectError(await postWebhook(event), 413, 'PAYLOAD_TOO_LARGE');
    expectUntouched();
  });

  it('accepts a signed request with no cookie and no Origin (server to server)', async () => {
    buildWorld('member');
    const res = await postWebhook(webhookEvent('room_started', `voice_${VOICE_ID}`));
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('never logs the Authorization header', async () => {
    buildWorld('member');
    expect((await postWebhook(webhookEvent('room_started', `voice_${VOICE_ID}`))).status).toBe(200);
    expectError(await postWebhook(joined(), { auth: 'garbage-auth-header-value' }), 401, 'INVALID_SIGNATURE');
    // afterEach checks the last valid header; the invalid one is checked here.
    expect(logLines.join('')).not.toContain('garbage-auth-header-value');
  });
});

// ---------------------------------------------------------------------------
// POST /api/livekit/webhook: events
// ---------------------------------------------------------------------------

describe('livekit webhook: rooms and events Hideout does not use', () => {
  it.each([
    ['a non-voice room', 'lobby'],
    ['a prefixed voice room', `xvoice_${VOICE_ID}`],
    ['an empty room name', ''],
  ])('acknowledges %s with 200 and does nothing', async (_label, name) => {
    buildWorld('member');
    const res = await postWebhook(webhookEvent('participant_joined', name, { identity: OUTSIDER_ID }));
    expect(res.status).toBe(200);
    expectUntouched();
  });

  it.each([
    ['a voice_ room without a uuid', 'voice_not-a-uuid'],
    ['a voice_ room with a suffix', `voice_${VOICE_ID}_x`],
    ['an uppercase voice_ room', `voice_${VOICE_ID.toUpperCase()}`],
  ])('kicks whoever joins %s (not canonical) and broadcasts nothing, without reading the database', async (_label, name) => {
    buildWorld('member');
    const res = await postWebhook(webhookEvent('participant_joined', name, { identity: world.me }));
    expect(res.status).toBe(200);
    expect(kicked()).toEqual([[name, world.me]]);
    expect(queries.filter((q) => q.table !== 'sessions')).toHaveLength(0);
    expect(livekit.listParticipants).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['participant_left', 'participant_connection_aborted', 'room_finished'])(
    'ignores %s in a non-canonical voice_ room',
    async (event) => {
      buildWorld('member');
      const res = await postWebhook(webhookEvent(event, `voice_${VOICE_ID.toUpperCase()}`, { identity: world.me }));
      expect(res.status).toBe(200);
      expectUntouched();
    },
  );

  it.each(['room_started', 'track_published', 'track_unpublished', 'egress_started', 'unknown_future_event'])(
    'acknowledges %s with 200 and does nothing',
    async (event) => {
      buildWorld('member');
      const res = await postWebhook(webhookEvent(event, `voice_${VOICE_ID}`, { identity: OUTSIDER_ID }));
      expect(res.status).toBe(200);
      expectUntouched();
    },
  );
});

describe('livekit webhook: participant_joined', () => {
  it('broadcasts the full participant list to room:<roomId> when a member joins', async () => {
    buildWorld('member');
    world.livekitRooms[`voice_${VOICE_ID}`] = [
      participant(MEMBER_ID, 100),
      participant(OUTSIDER_ID, 150), // being kicked by its own webhook; never broadcast
      participant(world.me, 200),
    ];
    const res = await postWebhook(webhookEvent('participant_joined', `voice_${VOICE_ID}`, { identity: world.me }));
    expect(res.status).toBe(200);
    expect(onlyVoiceBroadcast()).toStrictEqual({
      channelId: VOICE_ID,
      participants: [summary(MEMBER_ID, 'Mallory'), summary(world.me, 'Me', 'https://avatars.steamstatic.com/me_full.jpg')],
    });
    expect(listedRooms()).toEqual([`voice_${VOICE_ID}`]);
    // The connected outsider is kicked by this list read too (a backstop if its own webhook failed).
    expect(kicked()).toEqual([[`voice_${VOICE_ID}`, OUTSIDER_ID]]);
  });

  it('accepts an uppercase identity and broadcasts lowercased ids', async () => {
    buildWorld('member');
    world.livekitRooms[`voice_${VOICE_ID}`] = [participant(world.me.toUpperCase(), 100)];
    const res = await postWebhook(
      webhookEvent('participant_joined', `voice_${VOICE_ID}`, { identity: world.me.toUpperCase() }),
    );
    expect(res.status).toBe(200);
    expect(onlyVoiceBroadcast()).toStrictEqual({
      channelId: VOICE_ID,
      participants: [summary(world.me, 'Me', 'https://avatars.steamstatic.com/me_full.jpg')],
    });
  });

  it.each<[string, () => { roomName: string; identity: string }]>([
    ['a member of another room', () => ({ roomName: `voice_${VOICE_ID}`, identity: OUTSIDER_ID })],
    ['someone with no profile at all', () => ({ roomName: `voice_${VOICE_ID}`, identity: randomUUID() })],
    ['a non-uuid identity', () => ({ roomName: `voice_${VOICE_ID}`, identity: 'hacker' })],
    ['a member, into a text channel', () => ({ roomName: `voice_${GENERAL_ID}`, identity: MEMBER_ID })],
    ['a member, into a deleted voice channel', () => ({ roomName: `voice_${DELETED_VOICE_ID}`, identity: MEMBER_ID })],
    ['a member, into a channel that never existed', () => ({ roomName: `voice_${randomUUID()}`, identity: MEMBER_ID })],
  ])('kicks %s (no options, so LiveKit applies its default revocation) and broadcasts nothing', async (_label, setup) => {
    buildWorld('member');
    const { roomName, identity } = setup();
    world.livekitRooms[roomName] = [participant(MEMBER_ID, 100), participant(identity, 200)];
    const res = await postWebhook(webhookEvent('participant_joined', roomName, { identity }));

    expect(res.status).toBe(200);
    expect(kicked()).toEqual([[roomName, identity]]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(livekit.listParticipants).not.toHaveBeenCalled();
    expect(logsAt(40, 'non-member joined a voice channel')).toHaveLength(1);
  });

  it('kicks a member of a deleted room', async () => {
    buildWorld('member');
    world.rooms[0] = { id: ROOM_ID, deleted_at: T1 };
    const res = await postWebhook(webhookEvent('participant_joined', `voice_${VOICE_ID}`, { identity: world.me }));
    expect(res.status).toBe(200);
    expect(livekit.removeParticipant.mock.calls.map(([r, i]) => [r, i])).toEqual([[`voice_${VOICE_ID}`, world.me]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not look up a non-uuid identity in the database', async () => {
    buildWorld('member');
    await postWebhook(webhookEvent('participant_joined', `voice_${VOICE_ID}`, { identity: `${MEMBER_ID}' or '1'='1` }));
    expect(queriesOn('channels')).toHaveLength(0);
    expect(livekit.removeParticipant).toHaveBeenCalledOnce();
  });

  it('does nothing for a participant_joined without an identity', async () => {
    buildWorld('member');
    const event = webhookEvent('participant_joined', `voice_${VOICE_ID}`);
    const res = await postWebhook(event);
    expect(res.status).toBe(200);
    expectUntouched();
  });

  it.each([
    ['LiveKit says the participant already left', () => notFound(), 20],
    ['LiveKit fails', () => new ServerError('internal', 'boom', 500, 'internal'), 40],
    ['LiveKit is unreachable', () => new Error('fetch failed'), 40],
  ])('still returns 200 when kicking fails because %s', async (_label, makeError, level) => {
    buildWorld('member');
    livekit.removeParticipant.mockRejectedValue(makeError());
    const res = await postWebhook(webhookEvent('participant_joined', `voice_${VOICE_ID}`, { identity: OUTSIDER_ID }));
    expect(res.status).toBe(200);
    expect(livekit.removeParticipant).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logEntries().some((e) => e.level === level && /non-member|remove non-member/.test(e.msg))).toBe(true);
  });
});

describe('livekit webhook: leaving and room_finished', () => {
  it.each(['participant_left', 'participant_connection_aborted'])(
    '%s broadcasts the list without the participant who left, even if LiveKit still lists them',
    async (event) => {
      buildWorld('member');
      const leaving = participant(MEMBER_ID, 100);
      world.livekitRooms[`voice_${VOICE_ID}`] = [leaving, participant(world.me, 200), participant(MEMBER2_ID, 300)];
      const res = await postWebhook(webhookEvent(event, `voice_${VOICE_ID}`, { sid: leaving.sid, identity: MEMBER_ID }));
      expect(res.status).toBe(200);
      expect(onlyVoiceBroadcast()).toStrictEqual({
        channelId: VOICE_ID,
        participants: [summary(world.me, 'Me', 'https://avatars.steamstatic.com/me_full.jpg'), summary(MEMBER2_ID, 'Max')],
      });
      expect(livekit.removeParticipant).not.toHaveBeenCalled();
    },
  );

  it.each(['participant_left', 'participant_connection_aborted'])(
    '%s kicks connected non-members (not the one leaving) and leaves them out of the broadcast',
    async (event) => {
      buildWorld('member');
      const stranger = randomUUID();
      const leaving = participant(OUTSIDER_ID, 50);
      world.livekitRooms[`voice_${VOICE_ID}`] = [
        leaving,
        participant(MEMBER_ID, 100),
        participant('intruder', 150),
        participant(stranger, 200),
      ];
      const res = await postWebhook(webhookEvent(event, `voice_${VOICE_ID}`, { sid: leaving.sid, identity: OUTSIDER_ID }));
      expect(res.status).toBe(200);
      expect(onlyVoiceBroadcast().participants).toStrictEqual([summary(MEMBER_ID, 'Mallory')]);
      expect(kicked()).toEqual(
        (
          [
            [`voice_${VOICE_ID}`, 'intruder'],
            [`voice_${VOICE_ID}`, stranger],
          ] as [string, string][]
        ).sort(),
      );
    },
  );

  it('keeps the same person when only another of their connections left', async () => {
    buildWorld('member');
    const oldConnection = participant(MEMBER_ID, 100);
    world.livekitRooms[`voice_${VOICE_ID}`] = [oldConnection, participant(MEMBER_ID, 200)];
    await postWebhook(webhookEvent('participant_left', `voice_${VOICE_ID}`, { sid: oldConnection.sid, identity: MEMBER_ID }));
    expect(onlyVoiceBroadcast().participants).toStrictEqual([summary(MEMBER_ID, 'Mallory')]);
  });

  it('broadcasts an empty list when the last participant leaves and the LiveKit room is gone', async () => {
    buildWorld('member');
    // No entry: listParticipants rejects with not_found.
    const res = await postWebhook(webhookEvent('participant_left', `voice_${VOICE_ID}`, { identity: MEMBER_ID }));
    expect(res.status).toBe(200);
    expect(onlyVoiceBroadcast()).toStrictEqual({ channelId: VOICE_ID, participants: [] });
  });

  it('room_finished broadcasts an empty list without asking LiveKit', async () => {
    buildWorld('member');
    world.livekitRooms[`voice_${VOICE_ID}`] = [participant(MEMBER_ID, 100)];
    const res = await postWebhook(webhookEvent('room_finished', `voice_${VOICE_ID}`));
    expect(res.status).toBe(200);
    expect(onlyVoiceBroadcast()).toStrictEqual({ channelId: VOICE_ID, participants: [] });
    expect(livekit.listParticipants).not.toHaveBeenCalled();
  });

  it.each(['participant_left', 'participant_connection_aborted', 'room_finished'])(
    '%s broadcasts nothing for a deleted channel, a deleted room, a text channel, or an unknown channel',
    async (event) => {
      buildWorld('member');
      await postWebhook(webhookEvent(event, `voice_${DELETED_VOICE_ID}`, { identity: MEMBER_ID }));
      await postWebhook(webhookEvent(event, `voice_${GENERAL_ID}`, { identity: MEMBER_ID }));
      await postWebhook(webhookEvent(event, `voice_${randomUUID()}`, { identity: MEMBER_ID }));
      world.rooms[0] = { id: ROOM_ID, deleted_at: T1 };
      const res = await postWebhook(webhookEvent(event, `voice_${VOICE_ID}`, { identity: MEMBER_ID }));
      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(livekit.listParticipants).not.toHaveBeenCalled();
      expect(livekit.removeParticipant).not.toHaveBeenCalled();
      for (const q of queriesOn('channels')) {
        expect(q.calls).toContainEqual(['is', ['deleted_at', null]]);
        expect(q.calls).toContainEqual(['is', ['rooms.deleted_at', null]]);
        expect(q.calls).toContainEqual(['eq', ['type', 'voice']]);
      }
    },
  );

  it('broadcasts to the channel’s own room, not a room named in the event', async () => {
    buildWorld('member');
    world.livekitRooms[`voice_${OTHER_VOICE_ID}`] = [participant(OUTSIDER_ID, 100)];
    await postWebhook(webhookEvent('participant_left', `voice_${OTHER_VOICE_ID}`, { identity: MEMBER_ID }));
    expect(onlyVoiceBroadcast(OTHER_ROOM_ID)).toStrictEqual({
      channelId: OTHER_VOICE_ID,
      participants: [summary(OUTSIDER_ID, 'Oscar')],
    });
  });
});

describe('livekit webhook: failures are acknowledged', () => {
  it('returns 200 and broadcasts nothing when LiveKit listParticipants fails (not a not_found)', async () => {
    buildWorld('member');
    livekit.listParticipants.mockRejectedValue(new ServerError('internal', 'boom', 500, 'internal'));
    const res = await postWebhook(webhookEvent('participant_joined', `voice_${VOICE_ID}`, { identity: world.me }));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logsAt(40, 'LiveKit webhook handling failed')).toHaveLength(1);
  });

  it('fails closed with 503 when a participant_joined membership check fails, so LiveKit retries', async () => {
    buildWorld('member');
    world.failChannelsRead = true;
    const res = await postWebhook(webhookEvent('participant_joined', `voice_${VOICE_ID}`, { identity: world.me }));
    expectError(res, 503, 'SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('SECRET-DB-MESSAGE');
    expectNoSideEffects();
    expect(logsAt(40, 'LiveKit webhook handling failed')).toHaveLength(0);
  });

  it('returns 200 and does nothing when the database read fails on other events', async () => {
    buildWorld('member');
    world.failChannelsRead = true;
    for (const event of ['participant_left', 'participant_connection_aborted', 'room_finished']) {
      const res = await postWebhook(webhookEvent(event, `voice_${VOICE_ID}`, { identity: world.me }));
      expect(res.status).toBe(200);
    }
    expectNoSideEffects();
    expect(logsAt(40, 'LiveKit webhook handling failed')).toHaveLength(3);
  });

  it('returns 200 when the broadcast is rejected', async () => {
    buildWorld('member');
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 500 })));
    const res = await postWebhook(webhookEvent('room_finished', `voice_${VOICE_ID}`));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// removeFromVoice (leave, remove, ban): retries with backoff
// ---------------------------------------------------------------------------

describe('removeFromVoice retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a failure after 200 ms and 800 ms (3 attempts), passing no options, then gives up with one warning', async () => {
    expect(voiceRemovalRetry.delaysMs).toEqual([200, 800]);
    vi.useFakeTimers();
    livekit.removeParticipant.mockRejectedValue(new ServerError('internal', 'boom', 500, 'internal'));
    const done = removeFromVoice([VOICE_ID], MEMBER_ID);

    await vi.advanceTimersByTimeAsync(0);
    expect(livekit.removeParticipant).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(livekit.removeParticipant).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(livekit.removeParticipant).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(799);
    expect(livekit.removeParticipant).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBeUndefined();

    expect(kicked()).toEqual(Array.from({ length: 3 }, () => [`voice_${VOICE_ID}`, MEMBER_ID]));
    expect(logsAt(40, 'could not remove participant from LiveKit room')).toHaveLength(1);
  });

  it('stops retrying once an attempt succeeds', async () => {
    vi.useFakeTimers();
    livekit.removeParticipant.mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue(undefined);
    const done = removeFromVoice([VOICE_ID], MEMBER_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBeUndefined();
    expect(livekit.removeParticipant).toHaveBeenCalledTimes(2);
    expect(logsAt(40, 'could not remove participant')).toHaveLength(0);
  });

  it('does not retry not_found (not connected, or no room)', async () => {
    livekit.removeParticipant.mockRejectedValue(notFound());
    await removeFromVoice([VOICE_ID, VOICE2_ID], MEMBER_ID);
    expect(livekit.removeParticipant).toHaveBeenCalledTimes(2);
    expect(logsAt(20, 'not in LiveKit room')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe('voice contract', () => {
  it('documents the three voice endpoints in the committed openapi.json', async () => {
    const { default: openapi } = await import('../contract/openapi.json', { with: { type: 'json' } });
    const paths = openapi.paths as Record<string, Record<string, { security?: unknown[]; tags?: string[] }>>;
    expect(paths['/api/channels/{channelId}/voice/token']?.post?.tags).toEqual(['voice']);
    expect(paths['/api/rooms/{roomId}/voice/participants']?.get?.tags).toEqual(['voice']);
    const webhook = paths['/api/livekit/webhook']?.post;
    expect(webhook?.tags).toEqual(['voice']);
    // Public (signature-authenticated), unlike the other two which inherit the session scheme.
    expect(webhook?.security).toEqual([]);
    expect(paths['/api/channels/{channelId}/voice/token']?.post?.security).toBeUndefined();
    expect(Object.keys((webhook as { responses?: object } | undefined)?.responses ?? {})).toContain('503');
  });
});
