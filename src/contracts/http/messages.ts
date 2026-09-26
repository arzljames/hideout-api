import { z } from 'zod';
import { Message as MessageSchema } from '../events.js';
import { ChannelIdParams } from './channels.js';
import { CursorQuery, Id, authedErrors, errorResponse, page } from './common.js';
import { registry } from './registry.js';
import { ProfileSummary } from './rooms.js';

/*
 * Messages in text channels: members read and send; only the author edits (no time limit);
 * the author, an admin, or the owner deletes. Deleted messages are never returned.
 */

export const MESSAGE_MAX_LENGTH = 2000;

/** Seconds the `after` backfill window reaches back before the anchor message (see ListMessagesQuery). */
export const BACKFILL_OVERLAP_SECONDS = 5;

// Composite rebuilt from the events.ts shape (see rooms.ts) so `author` is a $ref to ProfileSummary.
// A union, not .nullable(): zod-to-openapi renders a nullable $ref as allOf[$ref, {type: [object, null]}],
// which null can't satisfy; the union renders as anyOf[$ref, {type: null}].
export const Message = registry.register(
  'Message',
  z.object({ ...MessageSchema.shape, author: z.union([ProfileSummary, z.null()]) }).openapi({
    description:
      '`author` is null only when the author’s profile was deleted; former members keep their author. ' +
      '`editedAt` is null until the first edit.',
  }),
);
export type Message = z.infer<typeof Message>;

export const MessagePage = registry.register('MessagePage', page(Message));
export type MessagePage = z.infer<typeof MessagePage>;

// Controls (Unicode Cc) other than tab and line feed. A lone CR is rejected; CRLF becomes LF first.
// Built with RegExp: the `v` flag needs an ES2024 regex literal and tsconfig targets ES2023.
const FORBIDDEN_CONTROL = new RegExp(String.raw`[\p{Cc}--[\t\n]]`, 'v');

/**
 * A character that renders visibly: not whitespace, a format character (zero-width, bidi
 * controls, ...), a nonspacing or enclosing combining mark on its own, the braille blank, or a
 * Hangul filler. Bidi controls are still allowed alongside visible text (RTL users need them).
 */
const VISIBLE_CHAR = new RegExp(
  String.raw`[^\p{White_Space}\p{Cf}\p{Mn}\p{Me}\u2800\u3164\uFFA0\u115F\u1160]`,
  'v',
);

/** Length in Unicode code points, as Postgres char_length counts it. */
const codePoints = (value: string): number => Array.from(value).length;

export const MessageBody = registry.register(
  'MessageBody',
  z
    .string()
    // Not trimmed: leading/trailing whitespace and blank lines are part of the message.
    .overwrite((value) => value.replace(/\r\n/g, '\n'))
    .refine((value) => codePoints(value) >= 1, 'Message is required.')
    .refine(
      (value) => codePoints(value) <= MESSAGE_MAX_LENGTH,
      `Message must be at most ${MESSAGE_MAX_LENGTH} characters.`,
    )
    .refine((value) => value.isWellFormed(), 'Message must be valid Unicode (no lone surrogates).')
    .refine((value) => VISIBLE_CHAR.test(value), 'Message must contain a visible character.')
    .refine(
      (value) => !FORBIDDEN_CONTROL.test(value),
      "Message can't contain control characters other than tab and line breaks.",
    )
    .openapi({
      description:
        `Message text: 1–${MESSAGE_MAX_LENGTH} Unicode code points (counted after CRLF → LF), not trimmed. ` +
        'Must be well-formed UTF-16 (no lone surrogates) and contain at least one visible character: not ' +
        'whitespace, a format character (Unicode Cf, e.g. zero-width or bidi controls), a combining mark on ' +
        'its own (Mn, Me), U+2800, or the Hangul fillers U+115F, U+1160, U+3164, U+FFA0. Format characters, ' +
        'including bidi controls, are allowed alongside visible text, so render bodies bidi-isolated (e.g. ' +
        '`<bdi>` or `dir="auto"` with `unicode-bidi: isolate`). Control characters (Unicode Cc) are rejected ' +
        'except tab and line feed; CRLF is stored as LF and a lone CR is rejected.',
      minLength: 1,
      maxLength: MESSAGE_MAX_LENGTH,
      example: 'gg, one more?',
    }),
);

export const SendMessageBody = registry.register('SendMessageBody', z.strictObject({ body: MessageBody }));
export type SendMessageBody = z.infer<typeof SendMessageBody>;

export const EditMessageBody = registry.register('EditMessageBody', z.strictObject({ body: MessageBody }));
export type EditMessageBody = z.infer<typeof EditMessageBody>;

export const IdempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'Idempotency-Key must be 1–128 characters of A–Z, a–z, 0–9, _ or -.');

/** Validates the (lowercased) Node header; other headers pass through untouched. */
export const SendMessageHeaders = z.object({ 'idempotency-key': IdempotencyKey.optional() });

const IdempotencyKeyDoc = z.object({
  'Idempotency-Key': IdempotencyKey.optional().openapi({
    description:
      'Recommended: a fresh random key (e.g. a UUID) per message, reused on every retry of that message. A retry ' +
      'with the same key returns the original message (200, `Idempotent-Replayed: true`) instead of posting it ' +
      'twice. Reusing a key for a different message (another body or channel), or after that message was ' +
      'deleted or edited to a different body, is 409 `IDEMPOTENCY_KEY_REUSED`.',
    example: '5f0c2a8e-1b7d-4c55-9a53-0e6d1b2c3d4e',
  }),
});

export const ListMessagesQuery = CursorQuery.extend({
  cursor: CursorQuery.shape.cursor.openapi({
    description: 'Opaque `nextCursor` from the previous page; continues in the same direction. Not with `after`.',
  }),
  after: Id.optional().openapi({
    description:
      'Backfill after reconnecting: the id of the last message you have. Returns messages oldest first, starting ' +
      `${BACKFILL_OVERLAP_SECONDS} seconds before that message (so some may repeat: dedupe by id), excluding it. ` +
      'Not with `cursor`.',
  }),
  limit: CursorQuery.shape.limit.openapi({ description: 'Page size, 1–100 (default 50).' }),
}).refine((query) => query.cursor === undefined || query.after === undefined, {
  message: 'Use either cursor or after, not both.',
  path: ['after'],
});
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;

export const MessageIdParams = z.object({ messageId: Id.openapi({ description: 'Message id.' }) });

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const writeNote =
  ' Writes need `Content-Type: application/json` (even with no body) and credentials; the CSRF check requires it.';
const writeLimitNote = ' Sending, editing, and deleting share one rate limit: 10 per 10 seconds per user.';
const csrf = 'Origin or Content-Type check failed (send `Content-Type: application/json` from WEB_ORIGIN).';
const channelNotFound = errorResponse(
  'Channel not found or deleted, its room is deleted, or you are not a member of its room (non-members always get 404).',
);
const messageNotFound = errorResponse(
  'Message not found or deleted, its channel or room is deleted, or you are not a member of its room ' +
    '(non-members always get 404).',
);
const notText = '`CHANNEL_NOT_TEXT`: the channel is a voice channel.';
const serverError = errorResponse('Unexpected server error.');

registry.registerPath({
  method: 'post',
  path: '/api/channels/{channelId}/messages',
  tags: ['messages'],
  summary: 'Send a message',
  description:
    'Any member of the channel’s room can send in a text channel. Broadcasts `message:created` on ' +
    '`channel:<channelId>`, also for idempotent replays, so `message:created` may be delivered more than once: ' +
    'dedupe by id. Non-members get 404. Send an `Idempotency-Key` so retries are safe.' +
    writeLimitNote +
    writeNote,
  request: {
    params: ChannelIdParams,
    headers: IdempotencyKeyDoc,
    body: { required: true, content: json(SendMessageBody) },
  },
  responses: {
    201: { description: 'The new message.', content: json(Message) },
    200: {
      description: 'A retry with an Idempotency-Key already used for this message: the original message, not posted again.',
      headers: {
        'Idempotent-Replayed': { description: 'Always `true` on this response.', schema: { type: 'string', enum: ['true'] } },
      },
      content: json(Message),
    },
    ...authedErrors,
    403: errorResponse(csrf),
    404: channelNotFound,
    409: errorResponse(
      `${notText} \`IDEMPOTENCY_KEY_REUSED\`: the key was used for a different message (another body or ` +
        'channel), or that message was deleted or edited to a different body since.',
    ),
    422: errorResponse('Invalid body or Idempotency-Key.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/channels/{channelId}/messages',
  tags: ['messages'],
  summary: 'List messages in a text channel',
  description:
    'Any member of the channel’s room. Without `after`: history, newest first; pass `nextCursor` back as `cursor` ' +
    'for older messages until it is null. With `after=<messageId>` (after reconnecting): messages oldest first, ' +
    `starting ${BACKFILL_OVERLAP_SECONDS} seconds before that message, so some may repeat: dedupe by id. Pass ` +
    '`nextCursor` back as `cursor` (alone) for newer messages until it is null. Delivery and backfill are ' +
    'best-effort. Backfill returns only live messages created after the window start; edits and deletes of ' +
    'older messages that happened while you were disconnected are not recovered (reload history for that). ' +
    'Deleted messages are never returned. Non-members get 404. Sent with `Cache-Control: no-store`. ' +
    'Rate limited to 120/minute per user.',
  request: { params: ChannelIdParams, query: ListMessagesQuery },
  responses: {
    200: { description: 'A page of messages.', content: json(MessagePage) },
    ...authedErrors,
    404: channelNotFound,
    409: errorResponse(notText),
    422: errorResponse(
      'Invalid cursor or limit, both `cursor` and `after`, or `after` is not a message in this channel.',
    ),
    500: serverError,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/messages/{messageId}',
  tags: ['messages'],
  summary: 'Edit a message',
  description:
    'Author only (no time limit). Sets `editedAt`. Broadcasts `message:updated` on `channel:<channelId>`. ' +
    'Non-members get 404.' +
    writeLimitNote +
    writeNote,
  request: { params: MessageIdParams, body: { required: true, content: json(EditMessageBody) } },
  responses: {
    200: { description: 'The edited message.', content: json(Message) },
    ...authedErrors,
    403: errorResponse(`${csrf} Or the caller is not the author.`),
    404: messageNotFound,
    422: errorResponse('Invalid body.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/messages/{messageId}',
  tags: ['messages'],
  summary: 'Delete a message',
  description:
    'The author, or an owner or admin of the room. Soft-deletes the message; it is no longer returned. ' +
    'Broadcasts `message:deleted` on `channel:<channelId>`. Non-members get 404. Not idempotent: a retried ' +
    'DELETE of a message that was already deleted returns 404; treat that as done.' +
    writeLimitNote +
    writeNote,
  request: { params: MessageIdParams },
  responses: {
    204: { description: 'Deleted.' },
    ...authedErrors,
    403: errorResponse(`${csrf} Or the caller is a plain member who isn’t the author.`),
    404: messageNotFound,
    500: serverError,
  },
});
