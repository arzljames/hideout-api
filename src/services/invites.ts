import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  AcceptInviteResult,
  CreatedInvite,
  DIRECT_INVITE_TTL_DAYS,
  INBOX_LIMIT,
  INVITE_EXPIRY_MS,
  INVITE_TOKEN_PATTERN,
  InboxInvite,
  Invite,
  InvitePreview,
  type InvitePreviewInviter,
  RedeemInviteResult,
  type CreateInviteBody,
  type InboxPage,
  type InvitePage,
  type InviteStatus,
  type ListInvitesQuery,
} from '../contracts/http/invites.js';
import { ProfileSummary } from '../contracts/http/rooms.js';
import { Role as RoleSchema } from '../contracts/events.js';
import { db } from '../db/client.js';
import { dbFailure, rpcFailure } from '../db/errors.js';
import { ConflictError, GoneError, InternalError, NotFoundError, ValidationError } from '../errors.js';
import { logger } from '../lib/logger.js';
import { newRandomToken } from '../lib/session.js';
import { broadcastToRoom, broadcastToUser } from '../realtime/broadcast.js';
import { findMember, findMembership, getRoomDetail, roleAtLeast, ROOM_COLUMNS, toRooms, type Role } from './rooms.js';

/*
 * Link tokens and their hashes are credentials: never log them, never return a hash, and
 * return the raw token only once (in the create response).
 */

export interface InviteAccess {
  /** Lowercased invite id. */
  inviteId: string;
  /** Lowercased id of the invite's (live) room. */
  roomId: string;
  /** Lowercased creator profile id; null once the creator's profile was deleted. */
  createdBy: string | null;
  kind: 'link' | 'direct';
  /** The caller's role in the room. */
  role: Role;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const InviteKind = z.enum(['link', 'direct']);

/** The public.invites columns a response needs. token_hash is deliberately absent (and stripped by parsing). */
const InviteRow = z.object({
  id: z.guid(),
  room_id: z.guid(),
  created_by: z.guid().nullable(),
  kind: InviteKind,
  invitee_steam_id: z.string().nullable(),
  max_uses: z.number().int().nullable(),
  uses: z.number().int(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  accepted_at: z.string().nullable(),
  declined_at: z.string().nullable(),
  created_at: z.string(),
});
type InviteRow = z.infer<typeof InviteRow>;

/** revoke_invite: the invite columns (no token_hash) plus the invitee's profile id (if they signed in). */
const RpcInviteRow = InviteRow.extend({ invitee_profile_id: z.guid().nullable() });

/** create_direct_invite: also the id of the expired pending invite it revoked and replaced, if any. */
const DirectInviteRpcRow = RpcInviteRow.extend({ replaced_invite_id: z.guid().nullable() });

const INVITE_COLUMNS =
  'id, room_id, created_by, kind, invitee_steam_id, max_uses, uses, expires_at, revoked_at, accepted_at, declined_at, created_at';

const ProfileRow = z.object({ id: z.guid(), display_name: z.string(), avatar_url: z.string().nullable() });
type ProfileRow = z.infer<typeof ProfileRow>;
const PROFILE_COLUMNS = 'id, display_name, avatar_url';

const RoomRow = z.object({
  id: z.guid(),
  name: z.string(),
  icon_emoji: z.string().nullable(),
  icon_path: z.string().nullable(),
  created_at: z.string(),
});

function toProfileSummary(profile: ProfileRow): z.infer<typeof ProfileSummary> {
  // A stored avatar that isn't a valid https URL is dropped rather than failing the request.
  const avatar = ProfileSummary.shape.avatarUrl.safeParse(profile.avatar_url);
  return { id: profile.id.toLowerCase(), displayName: profile.display_name, avatarUrl: avatar.success ? avatar.data : null };
}

/** The public preview names the inviter without their profile id. */
function toInviter(profile: ProfileRow): z.infer<typeof InvitePreviewInviter> {
  const { displayName, avatarUrl } = toProfileSummary(profile);
  return { displayName, avatarUrl };
}

function isPast(timestamp: string | null, now: number): boolean {
  return timestamp !== null && Date.parse(timestamp) <= now;
}

/**
 * Answered states win over revoked (revoking an answered invite only stops further use).
 * Then revoked, expired, used up: the order redeem_invite_link checks them in.
 */
function inviteStatus(row: InviteRow, now: number): InviteStatus {
  if (row.accepted_at !== null) return 'accepted';
  if (row.declined_at !== null) return 'declined';
  if (row.revoked_at !== null) return 'revoked';
  if (isPast(row.expires_at, now)) return 'expired';
  if (row.max_uses !== null && row.uses >= row.max_uses) return 'used_up';
  return 'active';
}

/** Validates a response against its contract schema; a mismatch is a server bug (values never logged). */
function checked<T extends z.ZodType>(operation: string, schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new InternalError(new Error(`${operation}: response does not match the contract: ${fields}`));
  }
  return parsed.data;
}

function toInvite(operation: string, row: InviteRow, creator: ProfileRow | null, now = Date.now()): Invite {
  return checked(operation, Invite, {
    id: row.id.toLowerCase(),
    roomId: row.room_id.toLowerCase(),
    kind: row.kind,
    createdBy: creator ? toProfileSummary(creator) : null,
    inviteeSteamId: row.invitee_steam_id,
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    status: inviteStatus(row, now),
  });
}

/** Parses a single-row read (maybeSingle). */
function parseRow<T extends z.ZodType>(operation: string, schema: T, data: unknown): z.infer<T> {
  const row = schema.safeParse(data);
  if (!row.success) throw new InternalError(new Error(`${operation} returned an unexpected row`));
  return row.data;
}

/** Parses the one row a RETURNS TABLE function returned (PostgREST sends a one-element array). */
function parseRpcRow<T extends z.ZodType>(operation: string, schema: T, data: unknown): z.infer<T> {
  if (!Array.isArray(data) || data.length !== 1) {
    throw new InternalError(new Error(`${operation} returned an unexpected row`));
  }
  return parseRow(operation, schema, data[0]);
}

/** Lowercase hex SHA-256: the only form of a link token the database stores. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Identical for every unusable link, so the response reveals nothing about why. */
function invalidInvite(): NotFoundError {
  return new NotFoundError('This invite is invalid or no longer usable.');
}

function alreadyResponded(): ConflictError {
  return new ConflictError('You already responded to this invite.', 'INVITE_ALREADY_RESPONDED');
}

async function loadProfile(profileId: string): Promise<ProfileRow | null> {
  const { data, error } = await db.from('profiles').select(PROFILE_COLUMNS).eq('id', profileId).maybeSingle<unknown>();
  if (error) throw dbFailure('profile lookup', error);
  if (data === null) return null;
  return parseRow('profile lookup', ProfileRow, data);
}

// ---------------------------------------------------------------------------
// Access (for requireInviteMember)
// ---------------------------------------------------------------------------

const InviteAccessRow = z.object({
  id: z.guid(),
  room_id: z.guid(),
  created_by: z.guid().nullable(),
  kind: InviteKind,
  // `!inner` embeds should never be null; if one is, there is no live room to be a member of (404).
  rooms: z.object({ room_members: z.array(z.object({ role: RoleSchema })) }).nullish(),
});

/** The invite (in a live room) and the caller's role there, or null if either is missing or they aren't a member. */
export async function findInviteAccess(inviteId: string, profileId: string): Promise<InviteAccess | null> {
  const { data, error } = await db
    .from('invites')
    .select('id, room_id, created_by, kind, rooms!inner(room_members!inner(role))')
    .eq('id', inviteId)
    .is('rooms.deleted_at', null)
    .eq('rooms.room_members.user_id', profileId)
    .maybeSingle<unknown>();

  if (error) throw dbFailure('invite membership lookup', error);
  if (data === null) return null;

  const row = InviteAccessRow.safeParse(data);
  if (!row.success) throw new InternalError(new Error('invite membership lookup returned an unexpected shape'));
  const role = row.data.rooms?.room_members[0]?.role;
  if (!role) return null;
  return {
    inviteId: row.data.id.toLowerCase(),
    roomId: row.data.room_id.toLowerCase(),
    createdBy: row.data.created_by?.toLowerCase() ?? null,
    kind: row.data.kind,
    role,
  };
}

// ---------------------------------------------------------------------------
// Create / revoke (the Postgres functions re-check membership and role)
// ---------------------------------------------------------------------------

/**
 * Creates a link or direct invite. Everything the response and broadcast need is read before
 * the write, so nothing after the commit can fail except a malformed row (a bug).
 */
export async function createInvite(roomId: string, profileId: string, body: CreateInviteBody): Promise<CreatedInvite> {
  return body.kind === 'link'
    ? createLinkInvite(roomId, profileId, body)
    : createDirectInvite(roomId, profileId, body);
}

async function createLinkInvite(
  roomId: string,
  profileId: string,
  { expiresIn, maxUses }: Extract<CreateInviteBody, { kind: 'link' }>,
): Promise<CreatedInvite> {
  const creator = await loadProfile(profileId);
  const token = newRandomToken();
  const ttl = INVITE_EXPIRY_MS[expiresIn];
  const { data, error } = await db
    .rpc('create_link_invite', {
      p_room: roomId,
      p_actor: profileId,
      p_token_hash: hashInviteToken(token),
      p_max_uses: maxUses,
      p_expires_at: ttl === null ? null : new Date(Date.now() + ttl).toISOString(),
    })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('create_link_invite', error);

  const invite = toInvite('create_link_invite', parseRpcRow('create_link_invite', InviteRow, data), creator);
  return checked('create_link_invite', CreatedInvite, { invite, token, url: `${env.WEB_ORIGIN}/invite/${token}` });
}

async function createDirectInvite(
  roomId: string,
  profileId: string,
  { steamId }: Extract<CreateInviteBody, { kind: 'direct' }>,
): Promise<CreatedInvite> {
  const [creator, roomResult] = await Promise.all([
    loadProfile(profileId),
    db.from('rooms').select(ROOM_COLUMNS).eq('id', roomId).is('deleted_at', null).maybeSingle<unknown>(),
  ]);
  if (roomResult.error) throw dbFailure('room lookup', roomResult.error);
  // A missing room here is re-checked (HX001) by create_direct_invite under lock.
  const [room] = roomResult.data === null ? [] : await toRooms([parseRow('room lookup', RoomRow, roomResult.data)]);

  const expiresAt = new Date(Date.now() + DIRECT_INVITE_TTL_DAYS * 24 * 60 * 60_000).toISOString();
  const { data, error } = await db
    .rpc('create_direct_invite', { p_room: roomId, p_actor: profileId, p_steam_id: steamId, p_expires_at: expiresAt })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('create_direct_invite', error, { field: 'body.steamId' });

  const row = parseRpcRow('create_direct_invite', DirectInviteRpcRow, data);
  const invite = toInvite('create_direct_invite', row, creator);
  // Not awaited (broadcasts never throw), so response timing doesn't reveal whether the SteamID has a profile.
  if (row.invitee_profile_id) {
    if (row.replaced_invite_id) {
      void broadcastToUser(row.invitee_profile_id, 'invite:revoked', { inviteId: row.replaced_invite_id.toLowerCase() });
    }
    if (creator && room) {
      void broadcastToUser(row.invitee_profile_id, 'invite:received', {
        inviteId: invite.id,
        room: { id: room.id, name: room.name, icon: room.icon },
        invitedBy: toProfileSummary(creator),
        expiresAt: invite.expiresAt,
      });
    }
  }
  return { invite };
}

/**
 * Revokes an invite (creator, owner, or admin; idempotent). A pending direct invite's invitee
 * is told, so it leaves their inbox; a repeat revoke re-sends that, which is harmless.
 */
export async function revokeInvite({ inviteId }: Pick<InviteAccess, 'inviteId'>, profileId: string): Promise<void> {
  const { data, error } = await db
    .rpc('revoke_invite', { p_invite: inviteId, p_actor: profileId })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('revoke_invite', error);

  const row = parseRpcRow('revoke_invite', RpcInviteRow, data);
  if (row.kind === 'direct' && row.invitee_profile_id && row.accepted_at === null && row.declined_at === null) {
    await broadcastToUser(row.invitee_profile_id, 'invite:revoked', { inviteId: row.id.toLowerCase() });
  }
}

// ---------------------------------------------------------------------------
// Room invite list
// ---------------------------------------------------------------------------

// Keyset cursor: (created_at, id), newest first, opaque base64url JSON. Same timestamp rules as
// the rooms and messages cursors, which keep quotes, commas, and parens out of the filter string.
const CursorTimestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/.test(value))
  .refine((value) => !value.startsWith('0000'), 'Postgres has no year 0.');
const Cursor = z.tuple([CursorTimestamp, z.guid()]);

function encodeCursor(row: InviteRow): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id.toLowerCase()])).toString('base64url');
}

function decodeCursor(cursor: string): [createdAt: string, id: string] {
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.success) return [parsed.data[0], parsed.data[1].toLowerCase()];
  } catch {
    // fall through: not base64url JSON
  }
  throw new ValidationError([{ path: 'query.cursor', message: 'Invalid cursor.' }]);
}

const ListedInviteRow = InviteRow.extend({ profiles: ProfileRow.nullable() });

/**
 * A room's invites, newest first: owners and admins see all, members only their own.
 * `active` filters in the query except "used up" (a column comparison PostgREST can't express),
 * which is dropped here, so an active page can be shorter than `limit`.
 */
export async function listInvites(
  roomId: string,
  profileId: string,
  role: Role,
  { status, cursor, limit }: ListInvitesQuery,
): Promise<InvitePage> {
  const now = Date.now();
  let query = db.from('invites').select(`${INVITE_COLUMNS}, profiles(${PROFILE_COLUMNS})`).eq('room_id', roomId);
  if (!roleAtLeast(role, 'admin')) query = query.eq('created_by', profileId);

  // Every value in these filters is validated (cursor) or generated here (now), so none can
  // break out of the filter string. Top-level filters are ANDed; both ORs go in one tree.
  const trees: string[] = [];
  if (status === 'active') {
    query = query.is('revoked_at', null).is('accepted_at', null).is('declined_at', null);
    trees.push(`expires_at.is.null,expires_at.gt."${new Date(now).toISOString()}"`);
  }
  if (cursor) {
    const [createdAt, id] = decodeCursor(cursor);
    trees.push(`created_at.lt."${createdAt}",and(created_at.eq."${createdAt}",id.lt.${id})`);
  }
  if (trees.length === 1) query = query.or(trees[0] ?? '');
  else if (trees.length === 2) query = query.or(`and(${trees.map((tree) => `or(${tree})`).join(',')})`);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)
    .overrideTypes<unknown[], { merge: false }>();
  if (error) throw dbFailure('invite list', error);

  const rows = z.array(ListedInviteRow).safeParse(data);
  if (!rows.success) throw new InternalError(new Error('invite list returned an unexpected shape'));
  const pageRows = rows.data.slice(0, limit);
  const invites = pageRows
    .map((row) => toInvite('invite list', row, row.profiles, now))
    .filter((invite) => status === 'all' || invite.status === 'active');
  const last = pageRows.at(-1);
  return { data: invites, nextCursor: rows.data.length > limit && last ? encodeCursor(last) : null };
}

// ---------------------------------------------------------------------------
// Link invites: preview (public) and redeem
// ---------------------------------------------------------------------------

const PreviewRow = z.object({
  room_id: z.guid(),
  max_uses: z.number().int().nullable(),
  uses: z.number().int(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  rooms: RoomRow.nullish(),
  profiles: ProfileRow.nullable(),
});

/**
 * What the invite page shows before joining. Every unusable link (malformed or unknown token,
 * revoked, expired, used up, deleted room) is the same 404.
 */
export async function getInvitePreview(token: string): Promise<InvitePreview> {
  if (!INVITE_TOKEN_PATTERN.test(token)) throw invalidInvite();

  const { data, error } = await db
    .from('invites')
    .select(`room_id, max_uses, uses, expires_at, revoked_at, rooms!inner(${ROOM_COLUMNS}), profiles(${PROFILE_COLUMNS})`)
    .eq('token_hash', hashInviteToken(token))
    .eq('kind', 'link')
    .is('rooms.deleted_at', null)
    .maybeSingle<unknown>();
  if (error) throw dbFailure('invite preview lookup', error);
  if (data === null) throw invalidInvite();

  const row = parseRow('invite preview lookup', PreviewRow, data);
  const usable =
    row.rooms &&
    row.revoked_at === null &&
    !isPast(row.expires_at, Date.now()) &&
    (row.max_uses === null || row.uses < row.max_uses);
  if (!usable || !row.rooms) throw invalidInvite();

  const [[room], countResult] = await Promise.all([
    toRooms([row.rooms]),
    db.from('room_members').select('user_id', { count: 'exact', head: true }).eq('room_id', row.room_id),
  ]);
  if (countResult.error) throw dbFailure('member count', countResult.error);
  if (!room) throw new InternalError(new Error('invite preview: room mapping failed'));

  return checked('invite preview', InvitePreview, {
    room: { name: room.name, icon: room.icon },
    memberCount: countResult.count ?? 0,
    invitedBy: row.profiles ? toInviter(row.profiles) : null,
    expiresAt: row.expires_at,
  });
}

/** Tells the room someone joined. Never throws: the join has committed. */
async function announceJoin(roomId: string, profileId: string): Promise<void> {
  try {
    const member = await findMember(roomId, profileId);
    if (member) await broadcastToRoom(roomId, 'member:joined', { member });
    else logger.warn({ roomId }, 'joined member not found; member:joined not sent');
  } catch (err) {
    logger.warn({ err, roomId }, 'could not load joined member; member:joined not sent');
  }
}

const RedeemRow = z.object({
  room_id: z.guid().nullable(),
  status: z.enum(['invalid', 'room_deleted', 'already_member', 'revoked', 'expired', 'used_up', 'joined']),
});

/** Joins a room with a link token. Idempotent: a second redeem returns already_member without using up the link. */
export async function redeemInvite(token: string, profileId: string): Promise<RedeemInviteResult> {
  if (!INVITE_TOKEN_PATTERN.test(token)) throw invalidInvite();

  const { data, error } = await db
    .rpc('redeem_invite_link', { p_token_hash: hashInviteToken(token), p_user: profileId })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('redeem_invite_link', error);

  const { room_id: roomId, status } = parseRpcRow('redeem_invite_link', RedeemRow, data);
  switch (status) {
    case 'invalid':
    case 'room_deleted':
      throw invalidInvite();
    case 'revoked':
      throw new GoneError('This invite was revoked.', 'INVITE_REVOKED');
    case 'expired':
      throw new GoneError('This invite has expired.', 'INVITE_EXPIRED');
    case 'used_up':
      throw new GoneError('This invite has reached its maximum number of uses.', 'INVITE_USED_UP');
    case 'joined':
    case 'already_member': {
      if (roomId === null) throw new InternalError(new Error(`redeem_invite_link returned ${status} without a room`));
      const room = roomId.toLowerCase();
      if (status === 'joined') await announceJoin(room, profileId);
      return checked('redeem invite', RedeemInviteResult, { status, room: await getRoomDetail(room, profileId) });
    }
  }
}

// ---------------------------------------------------------------------------
// Direct invites: inbox, accept, decline
// ---------------------------------------------------------------------------

const InboxRow = z.object({
  id: z.guid(),
  expires_at: z.string().nullable(),
  rooms: RoomRow,
  profiles: ProfileRow,
});

/**
 * Pending, unexpired direct invites to the caller's Steam account in live rooms, newest first.
 * Invites whose creator's profile was deleted are left out: the inbox entry (like the
 * invite:received payload) always names who invited you.
 */
export async function listInbox(profileId: string): Promise<InboxPage> {
  const profile = await db.from('profiles').select('steam_id').eq('id', profileId).maybeSingle<{ steam_id: string }>();
  if (profile.error) throw dbFailure('profile lookup', profile.error);
  if (!profile.data) return { data: [] };

  const { data, error } = await db
    .from('invites')
    .select(`id, expires_at, rooms!inner(${ROOM_COLUMNS}), profiles!inner(${PROFILE_COLUMNS})`)
    .eq('kind', 'direct')
    .eq('invitee_steam_id', profile.data.steam_id)
    .is('revoked_at', null)
    .is('accepted_at', null)
    .is('declined_at', null)
    .is('rooms.deleted_at', null)
    // Generated here, so it can't break out of the filter string.
    .or(`expires_at.is.null,expires_at.gt."${new Date().toISOString()}"`)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(INBOX_LIMIT)
    .overrideTypes<unknown[], { merge: false }>();
  if (error) throw dbFailure('invite inbox', error);

  const rows = z.array(InboxRow).safeParse(data);
  if (!rows.success) throw new InternalError(new Error('invite inbox returned an unexpected shape'));
  const rooms = await toRooms(rows.data.map((row) => row.rooms));
  const items = rows.data.map((row, i) => ({
    inviteId: row.id.toLowerCase(),
    room: { id: row.rooms.id.toLowerCase(), name: rooms[i]?.name, icon: rooms[i]?.icon },
    invitedBy: toProfileSummary(row.profiles),
    expiresAt: row.expires_at,
  }));
  return { data: checked('invite inbox', z.array(InboxInvite), items) };
}

const RespondRow = z.object({
  room_id: z.guid().nullable(),
  status: z.enum([
    'invalid',
    'room_deleted',
    'already_responded',
    'revoked',
    'expired',
    'accepted',
    'already_member',
    'declined',
  ]),
});
type RespondStatus = 'already_responded' | 'accepted' | 'already_member' | 'declined';

/** Runs respond_to_direct_invite and turns its failure statuses into errors. */
async function respond(
  inviteId: string,
  profileId: string,
  accept: boolean,
): Promise<{ roomId: string; status: RespondStatus }> {
  const id = z.guid().safeParse(inviteId);
  if (!id.success) throw new NotFoundError();

  const { data, error } = await db
    .rpc('respond_to_direct_invite', { p_invite: id.data.toLowerCase(), p_user: profileId, p_accept: accept })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('respond_to_direct_invite', error);

  const { room_id: roomId, status } = parseRpcRow('respond_to_direct_invite', RespondRow, data);
  switch (status) {
    case 'invalid':
    case 'room_deleted':
      throw new NotFoundError();
    case 'revoked':
      throw new GoneError('This invite was revoked.', 'INVITE_REVOKED');
    case 'expired':
      throw new GoneError('This invite has expired.', 'INVITE_EXPIRED');
    default:
      if (roomId === null) throw new InternalError(new Error(`respond_to_direct_invite returned ${status} without a room`));
      return { roomId: roomId.toLowerCase(), status };
  }
}

/** How an already-answered invite was answered (it was verified as the caller's by respond_to_direct_invite). */
async function findAnswer(inviteId: string): Promise<'accepted' | 'declined' | null> {
  const { data, error } = await db
    .from('invites')
    .select('accepted_at, declined_at')
    .eq('id', inviteId.toLowerCase())
    .maybeSingle<{ accepted_at: string | null; declined_at: string | null }>();
  if (error) throw dbFailure('invite answer lookup', error);
  if (data?.accepted_at) return 'accepted';
  if (data?.declined_at) return 'declined';
  return null;
}

/**
 * Accepts a direct invite and joins the room. Idempotent: retrying an accept that succeeded
 * (while still a member) returns already_member.
 */
export async function acceptInvite(inviteId: string, profileId: string): Promise<AcceptInviteResult> {
  const { roomId, status } = await respond(inviteId, profileId, true);
  if (status === 'declined') throw new InternalError(new Error('respond_to_direct_invite declined an accept'));

  if (status === 'already_responded') {
    const [answer, role] = await Promise.all([findAnswer(inviteId), findMembership(roomId, profileId)]);
    if (answer !== 'accepted' || !role) throw alreadyResponded();
  }
  if (status === 'accepted') await announceJoin(roomId, profileId);

  const result = status === 'accepted' ? 'accepted' : 'already_member';
  return checked('accept invite', AcceptInviteResult, { status: result, room: await getRoomDetail(roomId, profileId) });
}

/** Declines a direct invite. Idempotent: declining a declined invite succeeds. No broadcast. */
export async function declineInvite(inviteId: string, profileId: string): Promise<void> {
  const { status } = await respond(inviteId, profileId, false);
  if (status === 'declined') return;
  if (status === 'already_responded' && (await findAnswer(inviteId)) === 'declined') return;
  if (status === 'already_responded') throw alreadyResponded();
  throw new InternalError(new Error(`respond_to_direct_invite returned ${status} for a decline`));
}
