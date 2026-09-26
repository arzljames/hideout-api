import { z } from 'zod';
import { CursorQuery, Id, authedErrors, errorResponse, page } from './common.js';
import { SteamId } from './invites.js';
import { registry } from './registry.js';
import { ProfileSummary, RoomIdParams } from './rooms.js';

/*
 * Bans: the owner or an admin bans a member, which removes them and keeps their Steam account
 * out of the room (link redeem, direct invite accept, and new direct invites all refuse it)
 * until an owner or admin lifts the ban. Bans are keyed by SteamID64, so they survive a
 * profile delete. The Postgres functions (ban_member, unban) re-check every rule under the
 * room lock.
 */

const Timestamp = z.iso.datetime({ offset: true });

/** Controls (Unicode Cc), including line breaks: a reason is one line of plain text. */
const CONTROL_CHAR = /\p{Cc}/u;

export const BAN_REASON_MAX = 200;

export const BanBody = registry.register(
  'BanBody',
  z.strictObject({
    userId: Id.openapi({ description: 'Profile id of the member to ban.' }),
    reason: z
      .string()
      .trim()
      .min(1, 'Reason must not be blank; omit it instead.')
      .max(BAN_REASON_MAX, `Reason must be at most ${BAN_REASON_MAX} characters.`)
      .refine((value) => !CONTROL_CHAR.test(value), "Reason can't contain control characters or line breaks.")
      .optional()
      .openapi({
        description:
          `Optional note for the room's owner and admins, 1–${BAN_REASON_MAX} characters after trimming. ` +
          'Control characters (Unicode Cc, including line breaks) are rejected. Omit it rather than sending ' +
          'an empty string. Never shown to the banned person.',
      }),
  }),
);
export type BanBody = z.infer<typeof BanBody>;

// user/bannedBy: unions, not .nullable(), so the $ref renders as anyOf[$ref, null] (see messages.ts).
export const Ban = registry.register(
  'Ban',
  z
    .object({
      steamId: SteamId,
      user: z.union([ProfileSummary, z.null()]).openapi({
        description: 'The banned Steam account’s profile; null once it was deleted.',
      }),
      bannedBy: z.union([ProfileSummary, z.null()]).openapi({
        description: 'Who issued the ban; null once their profile was deleted.',
      }),
      reason: z.string().nullable(),
      createdAt: Timestamp,
    })
    .openapi({ description: 'A Steam account banned from a room. Permanent until an owner or admin lifts it.' }),
);
export type Ban = z.infer<typeof Ban>;

export const BanPage = registry.register('BanPage', page(Ban));
export type BanPage = z.infer<typeof BanPage>;

export const ListBansQuery = CursorQuery.extend({
  cursor: CursorQuery.shape.cursor.openapi({ description: 'Opaque `nextCursor` from the previous page.' }),
  limit: CursorQuery.shape.limit.openapi({ description: 'Page size, 1–100 (default 50).' }),
});
export type ListBansQuery = z.infer<typeof ListBansQuery>;

/** Path SteamIDs: the route answers 404 (not 422) for a malformed one, like an unknown ban. */
export const STEAM_ID_PATTERN = /^7656119\d{10}$/;

const BanParams = z.object({
  roomId: RoomIdParams.shape.roomId,
  steamId: z.string().regex(STEAM_ID_PATTERN).openapi({
    description: 'SteamID64 of the banned account. A malformed SteamID is a 404, like one that isn’t banned.',
    example: '76561197960287930',
  }),
});

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const csrf = 'Origin or Content-Type check failed (send `Content-Type: application/json` from WEB_ORIGIN).';
const writeNote =
  ' Writes need `Content-Type: application/json` (even with no body) and credentials; the CSRF check requires it.';
const writeLimitNote =
  ' Ban and unban share the membership-write rate limit (with leave, remove, change role, and transfer ' +
  'ownership): 30/hour per user.';
const roomNotFound = errorResponse('Room not found, deleted, or you are not a member (non-members always get 404).');
const notAdmin = 'Or the caller is a plain member (owner or admin required).';
const serverError = errorResponse('Unexpected server error.');

registry.registerPath({
  method: 'post',
  path: '/api/rooms/{roomId}/bans',
  tags: ['bans'],
  summary: 'Ban a member',
  description:
    'Owner or admin: removes a member and bans their Steam account from the room until the ban is lifted. The ' +
    'owner bans anyone except themself; an admin bans plain members only. Same effects as removing the member ' +
    '(`member:left` on `room:<roomId>`, disconnect from the room’s voice channels, their pending invites in the ' +
    'room revoked, as are pending direct invites addressed to them, with `invite:revoked` to each signed-in ' +
    'invitee), and `member:removed` on the banned member’s `user:<profileId>` carries `banned: true`. While ' +
    'banned, the account can’t join with a link (403 `BANNED`), accept a direct invite (403 `BANNED`), or be ' +
    'sent one (409 `USER_BANNED`). Not idempotent: the target must still be a member. Non-members get 404. ' +
    'If the server can’t read the stored ban back after writing it, it still answers 201, with `createdAt` ' +
    'from the API’s clock (approximate) and `bannedBy` possibly null; the ban list has the stored values.' +
    writeLimitNote +
    writeNote,
  request: { params: RoomIdParams, body: { required: true, content: json(BanBody) } },
  responses: {
    201: { description: 'The ban.', content: json(Ban) },
    ...authedErrors,
    403: errorResponse(`${csrf} ${notAdmin} Or an admin tried to ban an admin.`),
    404: errorResponse(
      'Room not found, deleted, or you are not a member (non-members always get 404); or `userId` is not a member.',
    ),
    409: errorResponse("`OWNER_PROTECTED`: the room owner can't be banned."),
    422: errorResponse('Invalid body (`userId` or `reason`), or `userId` is the caller’s own id (at `body.userId`).'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms/{roomId}/bans',
  tags: ['bans'],
  summary: 'List a room’s bans',
  description:
    'Owner or admin: every active ban in the room, newest first, cursor-paginated: pass `nextCursor` back as ' +
    '`cursor` until it is null. Non-members get 404. Sent with `Cache-Control: no-store`. Rate limited to ' +
    '60/minute per user.',
  request: { params: RoomIdParams, query: ListBansQuery },
  responses: {
    200: { description: 'A page of bans.', content: json(BanPage) },
    ...authedErrors,
    403: errorResponse(`The caller is a plain member (owner or admin required).`),
    404: roomNotFound,
    422: errorResponse('Invalid cursor or limit.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/rooms/{roomId}/bans/{steamId}',
  tags: ['bans'],
  summary: 'Lift a ban',
  description:
    'Owner or admin. The owner or any admin can lift any ban, whoever issued it (including a ban the owner ' +
    'issued, or one on an admin the owner banned); this is deliberate. The account can then be invited again; ' +
    'it does not rejoin automatically. No broadcast. Non-members get 404.' +
    writeLimitNote +
    writeNote,
  request: { params: BanParams },
  responses: {
    204: { description: 'Ban lifted.' },
    ...authedErrors,
    403: errorResponse(`${csrf} ${notAdmin}`),
    404: errorResponse(
      'Room not found, deleted, or you are not a member (non-members always get 404); or that SteamID is not ' +
        'banned (or is malformed).',
    ),
    500: serverError,
  },
});
