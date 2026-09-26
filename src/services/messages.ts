import { z } from 'zod';
import { Role } from '../contracts/events.js';
import {
  BACKFILL_OVERLAP_SECONDS,
  Message,
  type EditMessageBody,
  type ListMessagesQuery,
  type MessagePage,
  type SendMessageBody,
} from '../contracts/http/messages.js';
import { ProfileSummary } from '../contracts/http/rooms.js';
import { db } from '../db/client.js';
import { dbFailure, rpcFailure } from '../db/errors.js';
import { ConflictError, InternalError, ValidationError } from '../errors.js';
import { broadcastToChannel } from '../realtime/broadcast.js';
import type { ChannelAccess } from './channels.js';

type RoleShape = z.infer<typeof Role>;

export interface MessageAccess {
  /** Lowercased message id. */
  messageId: string;
  /** Lowercased id of the message's channel. */
  channelId: string;
  /** Lowercased id of the channel's room. */
  roomId: string;
  /** Lowercased author profile id; null once the author's profile was deleted. */
  authorId: string | null;
  /** The caller's role in the room. */
  role: RoleShape;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const ProfileRow = z.object({ id: z.guid(), display_name: z.string(), avatar_url: z.string().nullable() });
type ProfileRow = z.infer<typeof ProfileRow>;

/** The public.messages columns a message response needs (as the functions and selects return them). */
const MessageRow = z.object({
  id: z.guid(),
  channel_id: z.guid(),
  author_id: z.guid().nullable(),
  body: z.string(),
  created_at: z.string(),
  edited_at: z.string().nullable(),
});
type MessageRow = z.infer<typeof MessageRow>;

/** edit_message's row: the message columns plus the author's profile columns (null when author_id is null). */
const EditedMessageRow = MessageRow.extend({
  author_display_name: z.string().nullable(),
  author_avatar_url: z.string().nullable(),
});
type EditedMessageRow = z.infer<typeof EditedMessageRow>;

/** send_message's row: edit_message's columns plus whether it was an idempotent replay. */
const SentMessageRow = EditedMessageRow.extend({ replayed: z.boolean() });

/** A history/backfill row with its author embedded (null when author_id is null). */
const ListedMessageRow = MessageRow.extend({ profiles: ProfileRow.nullable() });

const MESSAGE_COLUMNS = 'id, channel_id, author_id, body, created_at, edited_at';

function toAuthor(profile: ProfileRow | null): z.infer<typeof ProfileSummary> | null {
  if (!profile) return null;
  // A stored avatar that isn't a valid https URL is dropped rather than failing the request.
  const avatar = ProfileSummary.shape.avatarUrl.safeParse(profile.avatar_url);
  return {
    id: profile.id.toLowerCase(),
    displayName: profile.display_name,
    avatarUrl: avatar.success ? avatar.data : null,
  };
}

/** Builds a contract Message; a result that breaks the contract is a server bug (values never logged). */
function toMessage(operation: string, row: MessageRow, author: ProfileRow | null): Message {
  const parsed = Message.safeParse({
    id: row.id.toLowerCase(),
    channelId: row.channel_id.toLowerCase(),
    author: toAuthor(author),
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new InternalError(new Error(`${operation}: message does not match the Message schema: ${fields}`));
  }
  return parsed.data;
}

/** The author embedded in a send/edit row; null when the message has no author (profile deleted). */
function rowAuthor(operation: string, row: EditedMessageRow): ProfileRow | null {
  if (row.author_id === null) return null;
  if (row.author_display_name === null) {
    throw new InternalError(new Error(`${operation} returned an author id without the author's profile`));
  }
  return { id: row.author_id, display_name: row.author_display_name, avatar_url: row.author_avatar_url };
}

/** Parses the single row a table function returned (PostgREST sends a one-row array; a bare object is accepted too). */
function parseRow<T extends z.ZodType>(operation: string, schema: T, data: unknown): z.infer<T> {
  const row = schema.safeParse(Array.isArray(data) && data.length === 1 ? data[0] : data);
  if (!row.success) throw new InternalError(new Error(`${operation} did not return a message row`));
  return row.data;
}

// ---------------------------------------------------------------------------
// Access (for requireMessageMember)
// ---------------------------------------------------------------------------

const MessageAccessRow = z.object({
  id: z.guid(),
  channel_id: z.guid(),
  author_id: z.guid().nullable(),
  // `!inner` embeds should never be null, but if one is (or the key is missing) there is no live
  // channel/room to be a member of: that's a 404, not a 500.
  channels: z
    .object({
      room_id: z.guid(),
      rooms: z.object({ room_members: z.array(z.object({ role: Role })) }).nullish(),
    })
    .nullish(),
});

/**
 * The live message (in a live channel of a live room) and the caller's role in that room, or
 * null if any of them is missing/deleted or the caller isn't a member.
 */
export async function findMessageAccess(messageId: string, profileId: string): Promise<MessageAccess | null> {
  const { data, error } = await db
    .from('messages')
    .select('id, channel_id, author_id, channels!inner(room_id, rooms!inner(room_members!inner(role)))')
    .eq('id', messageId)
    .is('deleted_at', null)
    .is('channels.deleted_at', null)
    .is('channels.rooms.deleted_at', null)
    .eq('channels.rooms.room_members.user_id', profileId)
    .maybeSingle<unknown>();

  if (error) throw dbFailure('message membership lookup', error);
  if (data === null) return null;

  const row = MessageAccessRow.safeParse(data);
  if (!row.success) throw new InternalError(new Error('message membership lookup returned an unexpected shape'));
  const role = row.data.channels?.rooms?.room_members[0]?.role;
  if (!row.data.channels || !role) return null;
  return {
    messageId: row.data.id.toLowerCase(),
    channelId: row.data.channel_id.toLowerCase(),
    roomId: row.data.channels.room_id.toLowerCase(),
    authorId: row.data.author_id?.toLowerCase() ?? null,
    role,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// Keyset cursor: [direction, created_at, id] as opaque base64url JSON. 'older' continues history
// (created_at desc, id desc); 'newer' continues a backfill (created_at asc, id asc). created_at
// is kept exactly as Postgres returned it (microseconds), so no row is skipped or repeated.
// A 'newer' cursor from an `after` backfill carries the anchor id as a 4th element, so later
// pages keep excluding the anchor (it can sort after the overlap window's first rows).
// A real ISO date-time in the narrow shape Postgres returns, which also keeps quotes, commas,
// and parens out of the filter string (same rules as the rooms cursor).
const CursorTimestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/.test(value))
  .refine((value) => !value.startsWith('0000'), 'Postgres has no year 0.');
const Cursor = z.union([
  z.tuple([z.enum(['older', 'newer']), CursorTimestamp, z.guid()]),
  z.tuple([z.literal('newer'), CursorTimestamp, z.guid(), z.guid()]),
]);
interface DecodedCursor {
  direction: 'older' | 'newer';
  createdAt: string;
  id: string;
  /** Lowercased `after` anchor to keep excluding (backfill cursors only). */
  anchor?: string;
}

function encodeCursor(direction: DecodedCursor['direction'], row: MessageRow, anchor?: string): string {
  const cursor: string[] = [direction, row.created_at, row.id.toLowerCase()];
  if (anchor !== undefined) cursor.push(anchor);
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(cursor: string): DecodedCursor {
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.success) {
      const [direction, createdAt, id, anchor] = parsed.data;
      return { direction, createdAt, id: id.toLowerCase(), ...(anchor ? { anchor: anchor.toLowerCase() } : {}) };
    }
  } catch {
    // fall through: not base64url JSON
  }
  throw new ValidationError([{ path: 'query.cursor', message: 'Invalid cursor.' }]);
}

/**
 * Where a page starts: newest history, older history, the first backfill page (inclusive from a
 * timestamp), or a later backfill page (after a keyset position). `anchor` is the `after`
 * message, excluded from every backfill page.
 */
type PageStart =
  | { direction: 'older'; before?: { createdAt: string; id: string } }
  | { direction: 'newer'; inclusiveFrom: string; anchor: string }
  | { direction: 'newer'; after: { createdAt: string; id: string }; anchor?: string };

/** The anchor of an `after` backfill: its created_at, from any message (even deleted) in this channel. */
async function backfillStart(channelId: string, afterId: string): Promise<PageStart> {
  const { data, error } = await db
    .from('messages')
    .select('id, created_at')
    .eq('id', afterId.toLowerCase())
    .eq('channel_id', channelId)
    .maybeSingle<unknown>();
  if (error) throw dbFailure('backfill anchor lookup', error);
  const anchor = z.object({ id: z.guid(), created_at: z.string() }).safeParse(data);
  if (data === null || !anchor.success) {
    throw new ValidationError([{ path: 'query.after', message: 'No such message in this channel.' }]);
  }
  const anchorMs = Date.parse(anchor.data.created_at);
  if (Number.isNaN(anchorMs)) throw new InternalError(new Error('backfill anchor has an unreadable created_at'));
  // Overlap the window: rows can commit slightly out of created_at order (see the
  // core_schema_fixes migration, section 11). Clients dedupe by id.
  const from = new Date(anchorMs - BACKFILL_OVERLAP_SECONDS * 1000).toISOString();
  return { direction: 'newer', inclusiveFrom: from, anchor: anchor.data.id.toLowerCase() };
}

/**
 * Live messages of a text channel. History (default): newest first. Backfill (`after`): oldest
 * first from a few seconds before the anchor, excluding it. `nextCursor` continues in the same
 * direction. Deleted messages are never returned.
 */
export async function listMessages(
  { channelId, type }: Pick<ChannelAccess, 'channelId' | 'type'>,
  { cursor, after, limit }: ListMessagesQuery,
): Promise<MessagePage> {
  if (type !== 'text') throw new ConflictError('Only text channels have messages.', 'CHANNEL_NOT_TEXT');

  let start: PageStart = { direction: 'older' };
  if (after) start = await backfillStart(channelId, after);
  else if (cursor) {
    const { direction, createdAt, id, anchor } = decodeCursor(cursor);
    start =
      direction === 'older'
        ? { direction, before: { createdAt, id } }
        : { direction, after: { createdAt, id }, ...(anchor ? { anchor } : {}) };
  }

  let query = db
    .from('messages')
    .select(`${MESSAGE_COLUMNS}, profiles(id, display_name, avatar_url)`)
    .eq('channel_id', channelId)
    .is('deleted_at', null);
  // Every value in these filters was validated (cursor/anchor timestamps and uuids), so none can
  // break out of the filter string.
  if (start.direction === 'older' && start.before) {
    const { createdAt, id } = start.before;
    query = query.or(`created_at.lt."${createdAt}",and(created_at.eq."${createdAt}",id.lt.${id})`);
  } else if (start.direction === 'newer' && 'inclusiveFrom' in start) {
    query = query.gte('created_at', start.inclusiveFrom);
  } else if (start.direction === 'newer') {
    const { createdAt, id } = start.after;
    query = query.or(`created_at.gt."${createdAt}",and(created_at.eq."${createdAt}",id.gt.${id})`);
  }
  if (start.direction === 'newer' && start.anchor) query = query.neq('id', start.anchor);
  const ascending = start.direction === 'newer';
  const { data, error } = await query
    .order('created_at', { ascending })
    .order('id', { ascending })
    .limit(limit + 1)
    .overrideTypes<unknown[], { merge: false }>();
  if (error) throw dbFailure('message list', error);

  const rows = z.array(ListedMessageRow).safeParse(data);
  if (!rows.success) throw new InternalError(new Error('message list returned an unexpected shape'));
  const pageRows = rows.data.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    data: pageRows.map((row) => toMessage('message list', row, row.profiles)),
    nextCursor:
      rows.data.length > limit && last
        ? encodeCursor(start.direction, last, start.direction === 'newer' ? start.anchor : undefined)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Writes (the Postgres functions re-check membership, channel type, and author/role)
// ---------------------------------------------------------------------------

/**
 * Sends a message and broadcasts it as message:created. A retry with the same Idempotency-Key
 * returns the original message (`replayed: true`) and broadcasts it again.
 */
export async function sendMessage(
  channelId: string,
  profileId: string,
  { body }: SendMessageBody,
  idempotencyKey?: string,
): Promise<{ message: Message; replayed: boolean }> {
  const { data, error } = await db
    .rpc('send_message', {
      p_channel: channelId,
      p_author: profileId,
      p_body: body,
      p_idempotency_key: idempotencyKey ?? null,
    })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('send_message', error, { field: 'body.body' });

  // The write has committed; a malformed row here is a 500 with no broadcast. A retry with the
  // same key then replays it (and broadcasts), and clients backfill.
  const row = parseRow('send_message', SentMessageRow, data);
  const message = toMessage('send_message', row, rowAuthor('send_message', row));
  // Replays broadcast too: a committed send whose first response (and possibly broadcast) was
  // lost must still reach online members via the retry. Clients dedupe message:created by id.
  await broadcastToChannel(message.channelId, 'message:created', { message });
  return { message, replayed: row.replayed };
}

/** Edits the caller's own message and tells the channel. */
export async function editMessage(messageId: string, profileId: string, { body }: EditMessageBody): Promise<Message> {
  const { data, error } = await db
    .rpc('edit_message', { p_message: messageId, p_actor: profileId, p_body: body })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('edit_message', error, { field: 'body.body' });

  const row = parseRow('edit_message', EditedMessageRow, data);
  const message = toMessage('edit_message', row, rowAuthor('edit_message', row));
  await broadcastToChannel(message.channelId, 'message:updated', { message });
  return message;
}

/**
 * Soft-deletes a message (author, owner, or admin) and tells the channel. Takes the ids
 * requireMessageMember resolved (a message's channel never changes), so nothing after the
 * delete depends on the returned row, which still holds the body and is never exposed.
 */
export async function deleteMessage(
  { messageId, channelId }: Pick<MessageAccess, 'messageId' | 'channelId'>,
  profileId: string,
): Promise<void> {
  const { error } = await db.rpc('delete_message', { p_message: messageId, p_actor: profileId });
  if (error) throw rpcFailure('delete_message', error);
  await broadcastToChannel(channelId, 'message:deleted', { id: messageId, channelId });
}
