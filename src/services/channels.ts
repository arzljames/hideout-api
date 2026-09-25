import { z } from 'zod';
import { ChannelType, Role, type Channel } from '../contracts/events.js';
import type { ChannelList, CreateChannelBody, RenameChannelBody, ReorderChannelsBody } from '../contracts/http/channels.js';
import { db } from '../db/client.js';
import { dbFailure, rpcFailure } from '../db/errors.js';
import { ConflictError, InternalError } from '../errors.js';
import { broadcastToRoom } from '../realtime/broadcast.js';
import { endVoiceRoom, toChannel, type ChannelRow } from './rooms.js';

type ChannelShape = z.infer<typeof Channel>;

export interface ChannelAccess {
  /** Lowercased channel id. */
  channelId: string;
  /** Lowercased id of the channel's room. */
  roomId: string;
  type: z.infer<typeof ChannelType>;
  /** The caller's role in the room. */
  role: z.infer<typeof Role>;
}

/** A public.channels row as the channel Postgres functions return it (via PostgREST). */
const ChannelRowSchema = z.object({
  id: z.guid(),
  room_id: z.guid(),
  type: ChannelType,
  name: z.string(),
  position: z.number().int(),
  created_at: z.string(),
});

function channelNameTaken(): ConflictError {
  return new ConflictError('A channel with this name already exists in this room.', 'CHANNEL_NAME_TAKEN');
}

/** Parses the row(s) a channel function returned. A malformed row is a server bug; its values are never logged. */
function parseRow(operation: string, data: unknown): ChannelRow {
  const row = ChannelRowSchema.safeParse(data);
  if (!row.success) throw new InternalError(new Error(`${operation} did not return a channel row`));
  return { ...row.data, id: row.data.id.toLowerCase(), room_id: row.data.room_id.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const ChannelAccessRow = z.object({
  id: z.guid(),
  room_id: z.guid(),
  type: ChannelType,
  // `rooms!inner` should never embed null, but if it does (or the key is missing) there is no
  // live room to be a member of: that's a 404, not a 500.
  rooms: z.object({ room_members: z.array(z.object({ role: Role })) }).nullish(),
});

/**
 * The live channel (in a live room) and the caller's role in its room, or null if the channel
 * or room is missing/deleted or the caller isn't a member.
 */
export async function findChannelAccess(channelId: string, profileId: string): Promise<ChannelAccess | null> {
  const { data, error } = await db
    .from('channels')
    .select('id, room_id, type, rooms!inner(room_members!inner(role))')
    .eq('id', channelId)
    .is('deleted_at', null)
    .is('rooms.deleted_at', null)
    .eq('rooms.room_members.user_id', profileId)
    .maybeSingle<unknown>();

  if (error) throw dbFailure('channel membership lookup', error);
  if (data === null) return null;

  const row = ChannelAccessRow.safeParse(data);
  if (!row.success) throw new InternalError(new Error('channel membership lookup returned an unexpected shape'));
  const role = row.data.rooms?.room_members[0]?.role;
  if (!role) return null;
  return {
    channelId: row.data.id.toLowerCase(),
    roomId: row.data.room_id.toLowerCase(),
    type: row.data.type,
    role,
  };
}

// ---------------------------------------------------------------------------
// Writes (owner or admin; the Postgres functions re-check the role)
// ---------------------------------------------------------------------------

/** Creates a channel at the end of its type and tells the room. */
export async function createChannel(
  roomId: string,
  profileId: string,
  { type, name }: CreateChannelBody,
): Promise<ChannelShape> {
  const { data, error } = await db
    .rpc('create_channel', { p_room: roomId, p_actor: profileId, p_type: type, p_name: name })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('create_channel', error, { field: 'body.name', uniqueViolation: channelNameTaken() });

  // The write has committed; a malformed row here is a server bug and yields a 500 with no
  // broadcast (unlike deleteChannel, which only uses data requireChannelMember resolved).
  const channel = toChannel(parseRow('create_channel', data));
  await broadcastToRoom(channel.roomId, 'channel:created', { channel });
  return channel;
}

/** Renames a channel and tells the room. */
export async function renameChannel(
  channelId: string,
  profileId: string,
  { name }: RenameChannelBody,
): Promise<ChannelShape> {
  const { data, error } = await db
    .rpc('rename_channel', { p_channel: channelId, p_actor: profileId, p_name: name })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('rename_channel', error, { field: 'body.name', uniqueViolation: channelNameTaken() });

  // As in createChannel: a malformed row after the committed rename is a 500 with no broadcast.
  const channel = toChannel(parseRow('rename_channel', data));
  await broadcastToRoom(channel.roomId, 'channel:updated', { channel });
  return channel;
}

/**
 * Sets the order of every live channel of one type. The function rejects a stale list (HX007 →
 * 409 CHANNEL_ORDER_STALE), so the broadcast always carries the complete new order.
 */
export async function reorderChannels(
  roomId: string,
  profileId: string,
  { type, channelIds }: ReorderChannelsBody,
): Promise<ChannelList> {
  const { data, error } = await db
    .rpc('reorder_channels', {
      p_room: roomId,
      p_actor: profileId,
      p_type: type,
      p_channel_ids: channelIds.map((id) => id.toLowerCase()),
    })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('reorder_channels', error, { field: 'body.channelIds' });
  if (!Array.isArray(data)) throw new InternalError(new Error('reorder_channels did not return a channel list'));

  const channels = data
    .map((row) => toChannel(parseRow('reorder_channels', row)))
    .sort((a, b) => a.position - b.position);
  await broadcastToRoom(roomId, 'channel:reordered', { roomId, type, channelIds: channels.map((c) => c.id) });
  return { data: channels };
}

/**
 * Soft-deletes a channel (its messages stay, unreachable), tells the room, and for a voice
 * channel disconnects everyone in it. Takes the channel as requireChannelMember resolved it
 * (a channel's room and type never change), so nothing after the delete depends on parsing the
 * returned row and nothing can fail the request once it has committed.
 */
export async function deleteChannel(
  { channelId, roomId, type }: Pick<ChannelAccess, 'channelId' | 'roomId' | 'type'>,
  profileId: string,
): Promise<void> {
  const { error } = await db.rpc('delete_channel', { p_channel: channelId, p_actor: profileId });
  if (error) throw rpcFailure('delete_channel', error);

  await Promise.allSettled([
    broadcastToRoom(roomId, 'channel:deleted', { id: channelId, roomId }),
    ...(type === 'voice' ? [endVoiceRoom(channelId)] : []),
  ]);
}
