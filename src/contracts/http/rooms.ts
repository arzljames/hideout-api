import { z } from 'zod';
import {
  Channel as ChannelSchema,
  Member as MemberSchema,
  ProfileSummary as ProfileSummarySchema,
  Role as RoleSchema,
  Room as RoomSchema,
  RoomIcon as RoomIconSchema,
} from '../events.js';
import { CursorQuery, Id, authedErrors, errorResponse, page } from './common.js';
import { registry } from './registry.js';

/*
 * Rooms: create, list mine, read one, rename / change icon, delete.
 *
 * The shared shapes (Room, Channel, Member, ...) come from src/contracts/events.ts, so REST
 * responses and realtime payloads can't drift. They are registered here as OpenAPI
 * components from clones: events.ts may be evaluated before extendZodWithOpenApi runs (Zod 4
 * copies methods onto each schema when it is built, so those instances have no .openapi()),
 * and it must not depend on the REST tooling. Composite shapes are rebuilt from the originals'
 * shapes with the registered parts swapped in, so nested shared shapes become $refs; any
 * field added in events.ts flows through unchanged.
 */

export const ProfileSummary = registry.register('ProfileSummary', ProfileSummarySchema.clone());
export const Role = registry.register('Role', RoleSchema.clone());
export const RoomIcon = registry.register('RoomIcon', RoomIconSchema.clone());
export const Channel = registry.register('Channel', ChannelSchema.clone());
export const Room = registry.register('Room', z.object({ ...RoomSchema.shape, icon: RoomIcon }));
export const Member = registry.register(
  'Member',
  z.object({ ...MemberSchema.shape, user: ProfileSummary, role: Role }),
);

const Timestamp = z.iso.datetime({ offset: true });

// Built at runtime: the `v` flag needs an ES2024 regex literal and tsconfig targets ES2023.
const SINGLE_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');

// Invisible and direction-changing characters that let a name spoof another (or hide text):
// C0/C1 controls, zero-width space/non-joiner, LRM/RLM, bidi embeddings/overrides/isolates,
// word joiner and invisible operators, and the BOM. ZWJ (U+200D) stays: emoji sequences use it.
const SPOOFING_CHARS = /[\p{Cc}\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
const VISIBLE_CHAR = /[\p{L}\p{N}\p{S}\p{P}]/u;

// Refines, not .regex(): the Unicode property escapes need the `u` flag, which the OpenAPI
// `pattern` can't express portably.
export const RoomName = registry.register(
  'RoomName',
  z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(48, 'Name must be at most 48 characters.')
    .refine((value) => !SPOOFING_CHARS.test(value), "Name can't contain invisible or text-direction control characters.")
    .refine((value) => VISIBLE_CHAR.test(value), 'Name must contain a letter, number, symbol, or punctuation mark.')
    .openapi({
      description:
        'Room name: 1–48 UTF-16 code units after trimming surrounding whitespace. Must contain at least one ' +
        'letter, number, symbol, or punctuation mark, and no invisible or bidi control characters ' +
        '(control characters, U+200B, U+200C, U+200E, U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+2069, ' +
        'U+FEFF; U+200D zero-width joiner is allowed for emoji).',
      example: 'Friday Night Raids',
    }),
);

const EmojiIconInput = z.strictObject({
  kind: z.literal('emoji'),
  // A refine, not .regex(): the pattern needs the `v` flag, which JSON Schema validators don't support.
  emoji: z
    .string()
    .max(16, 'Emoji must be at most 16 characters.')
    .refine((value) => SINGLE_EMOJI.test(value), 'Must be a single emoji.')
    .openapi({ description: 'Exactly one emoji (RGI emoji sequence, at most 16 UTF-16 code units).', example: '🎮' }),
});

/** Icon chosen when creating or editing a room. Only emoji for now; an image variant is planned (additive). */
export const RoomIconInput = registry.register(
  'RoomIconInput',
  z.discriminatedUnion('kind', [EmojiIconInput]).openapi({
    description: 'The room icon to set. Only `emoji` is accepted today; more kinds may be added later.',
  }),
);

export const CreateRoomBody = registry.register(
  'CreateRoomBody',
  z.strictObject({ name: RoomName, icon: RoomIconInput }),
);
export type CreateRoomBody = z.infer<typeof CreateRoomBody>;

export const UpdateRoomBody = registry.register(
  'UpdateRoomBody',
  z
    .strictObject({ name: RoomName.optional(), icon: RoomIconInput.optional() })
    .refine((body) => body.name !== undefined || body.icon !== undefined, {
      message: 'Provide name, icon, or both.',
    })
    .openapi({ description: 'At least one of `name` or `icon` is required.', minProperties: 1 }),
);
export type UpdateRoomBody = z.infer<typeof UpdateRoomBody>;

export const RoomIdParams = z.object({ roomId: Id.openapi({ description: 'Room id.' }) });

/** One entry in the signed-in user's room list. */
export const MyRoom = registry.register(
  'MyRoom',
  z.object({ room: Room, myRole: Role, joinedAt: Timestamp }),
);
export type MyRoom = z.infer<typeof MyRoom>;

export const MyRoomPage = registry.register('MyRoomPage', page(MyRoom));

/** Everything the room view needs in one request. */
export const RoomDetail = registry.register(
  'RoomDetail',
  z.object({
    room: Room,
    myRole: Role,
    defaultChannelId: Id.nullable().openapi({
      description: 'Lowest-position text channel (where "You\'ll land in #general" points); null if there is none.',
    }),
    channels: z.array(Channel).openapi({ description: 'Live channels: text first, then voice, each by position.' }),
    members: z.array(Member).openapi({ description: 'All members: owner, then admins, then members, each by name.' }),
  }),
);
export type RoomDetail = z.infer<typeof RoomDetail>;

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const csrf = 'Origin or Content-Type check failed (send `Content-Type: application/json` from WEB_ORIGIN).';
const writeNote =
  ' Writes need `Content-Type: application/json` (even with no body) and credentials; the CSRF check requires it.';
const notFound = errorResponse('Room not found, deleted, or you are not a member (non-members always get 404).');

registry.registerPath({
  method: 'post',
  path: '/api/rooms',
  tags: ['rooms'],
  summary: 'Create a room',
  description:
    'Creates a room owned by the caller, with a `general` text channel and a `voice` voice channel. ' +
    'Not idempotent: disable the create button while the request is pending. Rate limited to 10/hour per user.' +
    writeNote,
  request: { body: { required: true, content: json(CreateRoomBody) } },
  responses: {
    201: { description: 'The new room.', content: json(RoomDetail) },
    ...authedErrors,
    403: errorResponse(csrf),
    422: errorResponse('Invalid name or icon.'),
    500: errorResponse('Unexpected server error.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms',
  tags: ['rooms'],
  summary: 'List my rooms',
  description:
    'Rooms the caller belongs to, oldest membership first. Cursor-paginated: pass `nextCursor` back as `cursor` ' +
    'until it is null. Sent with `Cache-Control: no-store`.',
  request: { query: CursorQuery },
  responses: {
    200: { description: 'A page of rooms.', content: json(MyRoomPage) },
    401: authedErrors[401],
    422: errorResponse('Invalid cursor or limit.'),
    500: errorResponse('Unexpected server error.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms/{roomId}',
  tags: ['rooms'],
  summary: 'Get a room',
  description:
    'The room, the caller’s role, its channels, default channel, and members. Non-members get 404, so room ' +
    'existence never leaks. Sent with `Cache-Control: no-store`.',
  request: { params: RoomIdParams },
  responses: {
    200: { description: 'The room.', content: json(RoomDetail) },
    401: authedErrors[401],
    404: notFound,
    500: errorResponse('Unexpected server error.'),
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/rooms/{roomId}',
  tags: ['rooms'],
  summary: 'Rename a room or change its icon',
  description:
    'Owner or admin only. Broadcasts `room:updated` on `room:<roomId>`. Non-members get 404. ' +
    'Rate limited to 30/hour per user.' +
    writeNote,
  request: { params: RoomIdParams, body: { required: true, content: json(UpdateRoomBody) } },
  responses: {
    200: { description: 'The updated room.', content: json(RoomDetail) },
    ...authedErrors,
    403: errorResponse(`${csrf} Or the caller is a plain member (owner or admin required).`),
    404: notFound,
    422: errorResponse('Invalid name or icon, or neither was given.'),
    500: errorResponse('Unexpected server error.'),
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/rooms/{roomId}',
  tags: ['rooms'],
  summary: 'Delete a room',
  description:
    'Owner only. Soft-deletes the room and its channels, ends its voice sessions, broadcasts `room:deleted` on ' +
    '`room:<roomId>` and `member:removed` on each member’s `user:<profileId>`. Non-members get 404.' +
    writeNote,
  request: { params: RoomIdParams },
  responses: {
    204: { description: 'Deleted.' },
    401: authedErrors[401],
    403: errorResponse(`${csrf} Or the caller is not the owner.`),
    404: notFound,
    500: errorResponse('Unexpected server error.'),
  },
});
