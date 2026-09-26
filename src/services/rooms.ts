import { z } from 'zod';
import type { Channel, Member, Role as RoleSchema, Room } from '../contracts/events.js';
import type { CursorQuery } from '../contracts/http/common.js';
import {
  MyRoom,
  ProfileSummary,
  RoomDetail,
  type CreateRoomBody,
  type UpdateRoomBody,
} from '../contracts/http/rooms.js';
import { db } from '../db/client.js';
import { dbFailure, rpcFailure } from '../db/errors.js';
import { InternalError, NotFoundError, ValidationError } from '../errors.js';
import { isLivekitNotFound, livekitRooms, voiceRoomName } from '../lib/livekit.js';
import { logger } from '../lib/logger.js';
import { signRoomIconUrls } from '../lib/storage.js';
import { broadcastToRoom, broadcastToUser } from '../realtime/broadcast.js';
import { broadcastRevokedInvites, parseRevokedInvites } from './revokedInvites.js';

export type Role = z.infer<typeof RoleSchema>;
type RoomShape = z.infer<typeof Room>;
type ChannelShape = z.infer<typeof Channel>;
export type MemberShape = z.infer<typeof Member>;

/** Shown when an uploaded icon can't be signed; a room always has exactly one icon. */
const FALLBACK_ICON_EMOJI = '💬';

/** Role privilege, higher is more. The one ranking used for access checks and member sorting. */
export const ROLE_RANK: Readonly<Record<Role, number>> = { member: 0, admin: 1, owner: 2 };

/** True when `role` is `minRole` or above (owner > admin > member). */
export function roleAtLeast(role: Role, minRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/** The room columns toRooms reads. */
export interface RoomRow {
  id: string;
  name: string;
  icon_emoji: string | null;
  icon_path: string | null;
  created_at: string;
}

/** The channel columns toChannel reads. */
export interface ChannelRow {
  id: string;
  room_id: string;
  type: 'text' | 'voice';
  name: string;
  position: number;
  created_at: string;
}

interface MemberRow {
  user_id: string;
  role: Role;
  joined_at: string;
  profiles: { id: string; display_name: string; avatar_url: string | null; current_game: string | null } | null;
}

export const ROOM_COLUMNS = 'id, name, icon_emoji, icon_path, created_at';

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/** Maps room rows to the Room shape; icon_path never leaves this function (only its signed URL). */
export async function toRooms(rows: RoomRow[]): Promise<RoomShape[]> {
  const signed = await signRoomIconUrls(rows.flatMap((row) => (row.icon_path ? [row.icon_path] : [])));
  return rows.map((row) => {
    const url = row.icon_path ? signed.get(row.icon_path) : undefined;
    const icon: RoomShape['icon'] = url
      ? { kind: 'image', url }
      : { kind: 'emoji', emoji: row.icon_emoji ?? FALLBACK_ICON_EMOJI };
    return { id: row.id, name: row.name, icon, createdAt: row.created_at };
  });
}

export function toChannel(row: ChannelRow): ChannelShape {
  return { id: row.id, roomId: row.room_id, type: row.type, name: row.name, position: row.position };
}

function toMember(roomId: string, row: MemberRow & { profiles: NonNullable<MemberRow['profiles']> }): MemberShape {
  // A stored avatar that isn't a valid https URL is dropped rather than failing the request.
  const avatar = ProfileSummary.shape.avatarUrl.safeParse(row.profiles.avatar_url);
  return {
    roomId,
    user: { id: row.profiles.id, displayName: row.profiles.display_name, avatarUrl: avatar.success ? avatar.data : null },
    role: row.role,
    joinedAt: row.joined_at,
    currentGame: row.profiles.current_game,
  };
}

function compareChannels(a: ChannelRow, b: ChannelRow): number {
  if (a.type !== b.type) return a.type === 'text' ? -1 : 1;
  return a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

function compareMembers(a: MemberShape, b: MemberShape): number {
  return (
    ROLE_RANK[b.role] - ROLE_RANK[a.role] ||
    a.user.displayName.localeCompare(b.user.displayName, 'en', { sensitivity: 'base' }) ||
    a.user.id.localeCompare(b.user.id)
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The caller's role in a live room, or null if the room is missing/deleted or they aren't a member. */
export async function findMembership(roomId: string, profileId: string): Promise<Role | null> {
  const { data, error } = await db
    .from('room_members')
    .select('role, rooms!inner(id)')
    .eq('room_id', roomId)
    .eq('user_id', profileId)
    .is('rooms.deleted_at', null)
    .maybeSingle<{ role: Role }>();

  if (error) throw dbFailure('membership lookup', error);
  return data?.role ?? null;
}

/**
 * One member of a room, as `member:joined` carries it, or null if they aren't a member (or
 * their profile is gone).
 */
export async function findMember(roomId: string, profileId: string): Promise<MemberShape | null> {
  const { data, error } = await db
    .from('room_members')
    .select('user_id, role, joined_at, profiles!inner(id, display_name, avatar_url, current_game)')
    .eq('room_id', roomId)
    .eq('user_id', profileId)
    .maybeSingle<MemberRow>();

  if (error) throw dbFailure('member lookup', error);
  if (!data?.profiles) return null;
  return toMember(roomId, { ...data, profiles: data.profiles });
}

/**
 * Everything the room view needs. Missing or deleted rooms and non-members are all
 * NotFoundError, so room existence never leaks.
 */
export async function getRoomDetail(roomId: string, profileId: string): Promise<RoomDetail> {
  const [roomResult, channelResult, memberResult] = await Promise.all([
    db.from('rooms').select(ROOM_COLUMNS).eq('id', roomId).is('deleted_at', null).maybeSingle<RoomRow>(),
    db
      .from('channels')
      .select('id, room_id, type, name, position, created_at')
      .eq('room_id', roomId)
      .is('deleted_at', null)
      .overrideTypes<ChannelRow[], { merge: false }>(),
    db
      .from('room_members')
      .select('user_id, role, joined_at, profiles!inner(id, display_name, avatar_url, current_game)')
      .eq('room_id', roomId)
      .overrideTypes<MemberRow[], { merge: false }>(),
  ]);

  if (roomResult.error) throw dbFailure('room lookup', roomResult.error);
  if (channelResult.error) throw dbFailure('channel list', channelResult.error);
  if (memberResult.error) throw dbFailure('member list', memberResult.error);

  const memberRows = memberResult.data;
  const myRow = memberRows.find((row) => row.user_id === profileId);
  if (!roomResult.data || !myRow) throw new NotFoundError();

  const channels = [...channelResult.data].sort(compareChannels);
  const members = memberRows
    .flatMap((row) => (row.profiles ? [toMember(roomId, { ...row, profiles: row.profiles })] : []))
    .sort(compareMembers);
  const [room] = await toRooms([roomResult.data]);

  const parsed = RoomDetail.safeParse({
    room,
    myRole: myRow.role,
    defaultChannelId: channels.find((channel) => channel.type === 'text')?.id ?? null,
    channels: channels.map(toChannel),
    members,
  });
  // A row that breaks the contract is a server bug; log only which fields failed, never values.
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new InternalError(new Error(`room detail does not match the RoomDetail schema: ${fields}`));
  }
  return parsed.data;
}

// Keyset cursor for "my rooms": (joined_at, room_id), opaque base64url JSON. joined_at is kept
// exactly as Postgres returned it (microseconds), so no row is skipped or repeated.
// A real ISO date-time (so impossible dates are a 422, not a Postgres error), in the narrow
// shape Postgres returns, which also keeps quotes, commas, and parens out of the filter string.
const CursorTimestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/.test(value))
  .refine((value) => !value.startsWith('0000'), 'Postgres has no year 0.');
const Cursor = z.tuple([CursorTimestamp, z.guid()]);

function encodeCursor(joinedAt: string, roomId: string): string {
  return Buffer.from(JSON.stringify([joinedAt, roomId])).toString('base64url');
}

function decodeCursor(cursor: string): [joinedAt: string, roomId: string] {
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.success) return [parsed.data[0], parsed.data[1].toLowerCase()];
  } catch {
    // fall through: not base64url JSON
  }
  throw new ValidationError([{ path: 'query.cursor', message: 'Invalid cursor.' }]);
}

interface MyRoomRow {
  role: Role;
  joined_at: string;
  room_id: string;
  rooms: RoomRow;
}

/** Live rooms the user belongs to, oldest membership first, keyset-paginated. */
export async function listMyRooms(
  profileId: string,
  { cursor, limit }: z.infer<typeof CursorQuery>,
): Promise<{ data: MyRoom[]; nextCursor: string | null }> {
  let query = db
    .from('room_members')
    .select(`role, joined_at, room_id, rooms!inner(${ROOM_COLUMNS})`)
    .eq('user_id', profileId)
    .is('rooms.deleted_at', null);
  if (cursor) {
    // Both values were validated by decodeCursor, so they can't break out of the filter.
    const [joinedAt, roomId] = decodeCursor(cursor);
    query = query.or(`joined_at.gt."${joinedAt}",and(joined_at.eq."${joinedAt}",room_id.gt.${roomId})`);
  }
  const { data, error } = await query
    .order('joined_at', { ascending: true })
    .order('room_id', { ascending: true })
    .limit(limit + 1)
    .overrideTypes<MyRoomRow[], { merge: false }>();

  if (error) throw dbFailure('room list', error);

  const pageRows = data.slice(0, limit);
  const rooms = await toRooms(pageRows.map((row) => row.rooms));
  const items = pageRows.map((row, i) => ({ room: rooms[i], myRole: row.role, joinedAt: row.joined_at }));
  const last = pageRows.at(-1);
  const nextCursor = data.length > limit && last ? encodeCursor(last.joined_at, last.room_id) : null;
  const parsed = z.array(MyRoom).safeParse(items);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new InternalError(new Error(`room list does not match the MyRoom schema: ${fields}`));
  }
  return { data: parsed.data, nextCursor };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Creates a room owned by the caller, with its default channels. No broadcast: nobody else is in it yet. */
export async function createRoom(profileId: string, { name, icon }: CreateRoomBody): Promise<RoomDetail> {
  const { data, error } = await db
    .rpc('create_room', { p_owner: profileId, p_name: name, p_icon_emoji: icon.emoji, p_icon_path: null })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('create_room', error);

  const roomId = z.guid().safeParse(data);
  if (!roomId.success) throw new InternalError(new Error('create_room returned no room id'));
  return getRoomDetail(roomId.data, profileId);
}

/** The public.rooms row update_room returns; only the columns toRooms needs are kept. */
const UpdatedRoomRow = z.object({
  id: z.guid(),
  name: z.string(),
  icon_emoji: z.string().nullable(),
  icon_path: z.string().nullable(),
  created_at: z.string(),
});

/**
 * Renames a room and/or changes its icon (owner or admin). room:updated is broadcast from the
 * row update_room returns, right after the commit, so a failing read afterwards can't swallow
 * it; the response is then read fresh (and a failure there is still a 500).
 */
export async function updateRoom(
  roomId: string,
  profileId: string,
  { name, icon }: UpdateRoomBody,
): Promise<RoomDetail> {
  const { data, error } = await db
    .rpc('update_room', { p_room: roomId, p_actor: profileId, p_name: name ?? null, p_icon_emoji: icon?.emoji ?? null })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('update_room', error);

  const row = UpdatedRoomRow.safeParse(data);
  if (!row.success) throw new InternalError(new Error('update_room did not return the room row'));
  const [room] = await toRooms([row.data]);
  if (room) await broadcastToRoom(roomId, 'room:updated', { room });

  return getRoomDetail(roomId, profileId);
}

/**
 * Soft-deletes a room (owner only), then tells everyone and ends its voice sessions. Each
 * signed-in invitee of a pending direct invite it revoked gets invite:revoked.
 * Voice channels are read before delete_room, because it soft-deletes them; a failure there
 * fails the request with nothing deleted. Members are read after it commits (their rows are
 * kept, and invite redemption locks the room, so nobody joins in between). Nothing after the
 * delete can fail the request: it has already committed.
 */
export async function deleteRoom(roomId: string, profileId: string): Promise<void> {
  const voiceChannelIds = await listVoiceChannelIds(roomId);

  const { data, error } = await db
    .rpc('delete_room', { p_room: roomId, p_actor: profileId })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('delete_room', error);

  await Promise.allSettled([
    broadcastToRoom(roomId, 'room:deleted', { id: roomId }),
    notifyRemovedMembers(roomId),
    ...voiceChannelIds.map((channelId) => endVoiceRoom(channelId)),
    ...broadcastRevokedInvites(parseRevokedInvites('delete_room', data)),
  ]);
}

/** Ids of the room's live voice channels. Read before a write that revokes voice access. */
export async function listVoiceChannelIds(roomId: string): Promise<string[]> {
  const { data, error } = await db
    .from('channels')
    .select('id')
    .eq('room_id', roomId)
    .eq('type', 'voice')
    .is('deleted_at', null)
    .overrideTypes<{ id: string }[], { merge: false }>();
  if (error) throw dbFailure('voice channel list', error);
  return data.map((channel) => channel.id.toLowerCase());
}

/** Sends member:removed to everyone in a just-deleted room. Never throws: the delete has committed. */
async function notifyRemovedMembers(roomId: string): Promise<void> {
  const { data, error } = await db
    .from('room_members')
    .select('user_id')
    .eq('room_id', roomId)
    .overrideTypes<{ user_id: string }[], { merge: false }>();
  if (error) {
    // Only the code: the message/details can carry row values.
    logger.warn({ roomId, dbCode: error.code }, 'could not list members of deleted room; member:removed not sent');
    return;
  }
  await Promise.allSettled(data.map((row) => broadcastToUser(row.user_id, 'member:removed', { roomId })));
}

/**
 * Removes everyone from a (deleted) voice channel's LiveKit room, then deletes the room. Each
 * participant is removed individually first, because removeParticipant (with LiveKit's default
 * revocation, see removeFromVoice) also revokes their earlier tokens, which deleteRoom doesn't.
 * A room that doesn't exist (nobody joined) is the common case. Never throws: the delete has
 * already committed.
 */
export async function endVoiceRoom(channelId: string): Promise<void> {
  const roomName = voiceRoomName(channelId);
  try {
    const participants = await livekitRooms.listParticipants(roomName);
    const identities = [...new Set(participants.map((p) => p.identity))];
    await Promise.allSettled(identities.map((identity) => removeWithRetry(roomName, identity, channelId)));
  } catch (err) {
    if (!isLivekitNotFound(err)) logger.warn({ err, channelId }, 'could not list LiveKit participants of deleted voice channel');
  }
  try {
    await livekitRooms.deleteRoom(roomName);
  } catch (err) {
    if (isLivekitNotFound(err)) logger.debug({ channelId }, 'no LiveKit room to end for deleted voice channel');
    else logger.warn({ err, channelId }, 'could not end LiveKit room for deleted voice channel');
  }
}

/**
 * Waits before the 2nd and 3rd removeParticipant attempt. Mutable only so tests can shorten it.
 */
export const voiceRemovalRetry = { delaysMs: [200, 800] as readonly number[] };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * removeParticipant with no options, so LiveKit applies its default revocation: tokens whose
 * `nbf` is before now + 1 minute (LiveKit's leeway) can't rejoin. Accepted consequence: someone
 * who leaves and is re-invited can't rejoin that voice channel for up to about a minute.
 * Retries other failures (3 attempts in total); not_found (not in the room, or no room) stops at
 * once. Never throws: callers run it after their write has committed.
 */
export async function removeWithRetry(roomName: string, identity: string, channelId: string): Promise<void> {
  const delays = voiceRemovalRetry.delaysMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await livekitRooms.removeParticipant(roomName, identity);
      return;
    } catch (err) {
      if (isLivekitNotFound(err)) {
        logger.debug({ channelId }, 'not in LiveKit room; nothing to remove');
        return;
      }
      const delay = delays[attempt];
      if (delay === undefined) {
        logger.warn({ err, channelId, attempts: attempt + 1 }, 'could not remove participant from LiveKit room');
        return;
      }
      await sleep(delay);
    }
  }
}

/**
 * Disconnects one person from each of the given voice channels' LiveKit rooms (rule 9: removal
 * and leaving revoke voice too), revoking their earlier voice tokens (see removeWithRetry). Not
 * being in a room, or the room not existing, is the common case. If LiveKit stays unreachable,
 * the webhook and every participant list read kick connected non-members as a backstop. Never
 * throws: the membership change has already committed.
 */
export async function removeFromVoice(channelIds: readonly string[], identity: string): Promise<void> {
  await Promise.allSettled(
    channelIds.map((channelId) => removeWithRetry(voiceRoomName(channelId), identity, channelId)),
  );
}
