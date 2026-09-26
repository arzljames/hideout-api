import { z } from 'zod';
import { CursorQuery, Id, authedErrors, errorResponse, page } from './common.js';
import { registry } from './registry.js';
import { ProfileSummary, RoomDetail, RoomIcon, RoomIdParams } from './rooms.js';

/*
 * Invites: the owner and admins create link invites; any member creates direct invites. The
 * creator, an admin, or the owner revokes them. Link invites are redeemed by token (the raw
 * token is shown once, at creation; only its SHA-256 is stored). Direct invites go to a SteamID
 * and appear in that person's inbox (GET /api/me/invites) once they sign in; they accept or
 * decline.
 */

const Timestamp = z.iso.datetime({ offset: true });

/** Direct invites expire this long after creation. */
export const DIRECT_INVITE_TTL_DAYS = 7;

export const INVITE_EXPIRY_OPTIONS = ['30m', '1h', '6h', '12h', '1d', '7d', 'never'] as const;

/** Milliseconds for each expiry option; `never` is null (the invite doesn't expire). */
export const INVITE_EXPIRY_MS: Readonly<Record<(typeof INVITE_EXPIRY_OPTIONS)[number], number | null>> = {
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  never: null,
};

export const InviteExpiresIn = registry.register(
  'InviteExpiresIn',
  z.enum(INVITE_EXPIRY_OPTIONS).openapi({ description: 'How long a link invite stays valid. `never` = no expiry.' }),
);

export const InviteMaxUses = registry.register(
  'InviteMaxUses',
  z
    .union([z.literal(1), z.literal(5), z.literal(10), z.literal(25), z.literal(50), z.literal(100)])
    .openapi({ description: 'How many people can join with a link invite.' }),
);

const CreateLinkInviteBody = z.strictObject({
  kind: z.literal('link'),
  expiresIn: InviteExpiresIn.default('7d').openapi({ description: 'Default `7d`.' }),
  maxUses: z
    .union([InviteMaxUses, z.null()])
    .default(null)
    .openapi({ description: 'Null or omitted = unlimited uses.' }),
});

export const SteamId = z
  .string()
  .regex(/^7656119[0-9]{10}$/, 'Must be a SteamID64 (17 digits starting with 7656119).')
  .openapi({ description: 'SteamID64: 17 digits starting with `7656119`.', example: '76561197960287930' });

const CreateDirectInviteBody = z.strictObject({ kind: z.literal('direct'), steamId: SteamId });

export const CreateInviteBody = registry.register(
  'CreateInviteBody',
  z.discriminatedUnion('kind', [CreateLinkInviteBody, CreateDirectInviteBody]).openapi({
    description:
      '`link`: a shareable link (optional expiry and max uses). `direct`: an invite to one Steam account, ' +
      `single use, expiring after ${DIRECT_INVITE_TTL_DAYS} days.`,
  }),
);
export type CreateInviteBody = z.infer<typeof CreateInviteBody>;

export const InviteStatus = registry.register(
  'InviteStatus',
  z.enum(['active', 'expired', 'used_up', 'revoked', 'accepted', 'declined']).openapi({
    description:
      'Computed when read. `accepted`/`declined` only apply to direct invites; an accepted or declined invite ' +
      'that was later revoked stays `accepted`/`declined`. More values may be added.',
  }),
);
export type InviteStatus = z.infer<typeof InviteStatus>;

export const InviteKind = registry.register('InviteKind', z.enum(['link', 'direct']));

// createdBy: a union, not .nullable(), so the $ref renders as anyOf[$ref, null] (see messages.ts).
export const Invite = registry.register(
  'Invite',
  z
    .object({
      id: Id,
      roomId: Id,
      kind: InviteKind,
      createdBy: z.union([ProfileSummary, z.null()]),
      inviteeSteamId: SteamId.nullable().openapi({ description: 'Set for direct invites, null for links.' }),
      maxUses: z.number().int().nullable().openapi({ description: 'Null = unlimited (links only).' }),
      uses: z.number().int(),
      expiresAt: Timestamp.nullable(),
      createdAt: Timestamp,
      status: InviteStatus,
    })
    .openapi({
      description:
        'An invite as its room sees it. Never includes the link token: it is shown once, when the link is created. ' +
        '`createdBy` is null once the creator’s profile was deleted.',
    }),
);
export type Invite = z.infer<typeof Invite>;

export const CreatedInvite = registry.register(
  'CreatedInvite',
  z.object({
    invite: Invite,
    token: z.string().optional().openapi({
      description: 'Link invites only: the raw token. Shown only in this response; it can’t be retrieved later.',
    }),
    url: z.url().optional().openapi({ description: 'Link invites only: `WEB_ORIGIN/invite/<token>`, ready to share.' }),
  }),
);
export type CreatedInvite = z.infer<typeof CreatedInvite>;

export const InvitePage = registry.register('InvitePage', page(Invite));
export type InvitePage = z.infer<typeof InvitePage>;

export const ListInvitesQuery = CursorQuery.extend({
  status: z
    .enum(['active', 'all'])
    .default('active')
    .openapi({ description: '`active` (default): only invites that can still be used. `all`: every invite.' }),
  cursor: CursorQuery.shape.cursor.openapi({ description: 'Opaque `nextCursor` from the previous page.' }),
  limit: CursorQuery.shape.limit.openapi({ description: 'Page size, 1–100 (default 50).' }),
});
export type ListInvitesQuery = z.infer<typeof ListInvitesQuery>;

export const InvitePreviewInviter = registry.register(
  'InvitePreviewInviter',
  ProfileSummary.pick({ displayName: true, avatarUrl: true })
    .openapi({ description: 'Who created a link invite, as the public preview shows them (no profile id).' }),
);

// invitedBy: a union, not .nullable(), so the $ref renders as anyOf[$ref, null] (see messages.ts).
export const InvitePreview = registry.register(
  'InvitePreview',
  z.object({
    room: z.object({ name: z.string(), icon: RoomIcon }),
    memberCount: z.number().int().openapi({ description: 'Current number of members.' }),
    invitedBy: z.union([InvitePreviewInviter, z.null()]).openapi({
      description: 'Null once the creator’s profile was deleted.',
    }),
    expiresAt: Timestamp.nullable(),
  }),
);
export type InvitePreview = z.infer<typeof InvitePreview>;

export const RedeemInviteResult = registry.register(
  'RedeemInviteResult',
  z.object({
    status: z.enum(['joined', 'already_member']).openapi({
      description: '`already_member`: you were already in the room (e.g. a retry); no use was consumed.',
    }),
    room: RoomDetail,
  }),
);
export type RedeemInviteResult = z.infer<typeof RedeemInviteResult>;

export const AcceptInviteResult = registry.register(
  'AcceptInviteResult',
  z.object({
    status: z.enum(['accepted', 'already_member']).openapi({
      description: '`already_member`: you were already in the room, or this is a retry of an accept that succeeded.',
    }),
    room: RoomDetail,
  }),
);
export type AcceptInviteResult = z.infer<typeof AcceptInviteResult>;

/** Same shape as the `invite:received` event payload on `user:<profileId>`. */
export const InboxInvite = registry.register(
  'InboxInvite',
  z
    .object({
      inviteId: Id,
      room: z.object({ id: Id, name: z.string(), icon: RoomIcon }),
      invitedBy: ProfileSummary,
      expiresAt: Timestamp.nullable(),
    })
    .openapi({ description: 'A pending direct invite; the same shape as the `invite:received` event payload.' }),
);
export type InboxInvite = z.infer<typeof InboxInvite>;

export const INBOX_LIMIT = 100;

export const InboxPage = registry.register(
  'InboxPage',
  z.object({ data: z.array(InboxInvite).openapi({ description: `Newest first, at most ${INBOX_LIMIT}.` }) }),
);
export type InboxPage = z.infer<typeof InboxPage>;

/** 32 random bytes, base64url without padding. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const InviteTokenParams = z.object({
  token: z.string().regex(INVITE_TOKEN_PATTERN).openapi({
    description: 'The link invite token (43 base64url characters). A malformed token is a 404, like an unknown one.',
  }),
});

export const InviteIdParams = z.object({ inviteId: Id.openapi({ description: 'Invite id.' }) });

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const writeNote =
  ' Writes need `Content-Type: application/json` (even with no body) and credentials; the CSRF check requires it.';
const csrf = 'Origin or Content-Type check failed (send `Content-Type: application/json` from WEB_ORIGIN).';
const roomNotFound = errorResponse('Room not found, deleted, or you are not a member (non-members always get 404).');
const serverError = errorResponse('Unexpected server error.');
const respondLimitNote = ' Redeem, accept, and decline share one rate limit: 10/minute per user.';

registry.registerPath({
  method: 'post',
  path: '/api/rooms/{roomId}/invites',
  tags: ['invites'],
  summary: 'Create an invite',
  description:
    '`link` (owner or admin only; a plain member gets 403 `FORBIDDEN`): returns the invite plus `token` and ' +
    '`url`; the token is shown only in this response, so share it now. `direct` (any member): invites one Steam account (single use, expires after ' +
    `${DIRECT_INVITE_TTL_DAYS} days); if that person has signed in, \`invite:received\` is broadcast on their ` +
    '`user:<profileId>`, otherwise it appears in their inbox when they sign in. An expired pending direct invite ' +
    'is replaced automatically. Not idempotent. Non-members get 404. Rate limited to 20/hour per user.' +
    writeNote,
  request: { params: RoomIdParams, body: { required: true, content: json(CreateInviteBody) } },
  responses: {
    201: { description: 'The new invite (with `token` and `url` for links).', content: json(CreatedInvite) },
    ...authedErrors,
    403: errorResponse(`${csrf} Or a plain member tried to create a \`link\` invite (owner or admin required).`),
    404: roomNotFound,
    409: errorResponse(
      '`ALREADY_MEMBER`: that Steam account is already in the room. `INVITE_ALREADY_PENDING`: an unexpired ' +
        'direct invite to that Steam account is pending; revoke it first. `USER_BANNED`: that Steam account is ' +
        'banned from the room; lift the ban first.',
    ),
    422: errorResponse('Invalid body (kind, expiresIn, maxUses, or steamId).'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms/{roomId}/invites',
  tags: ['invites'],
  summary: 'List a room’s invites',
  description:
    'Owners and admins see every invite in the room; members see only the invites they created. Newest first, ' +
    'cursor-paginated: pass `nextCursor` back as `cursor` until it is null. With `status=active` a page can hold ' +
    'fewer than `limit` items (even none) while `nextCursor` is not null; keep going until it is null. ' +
    'Non-members get 404. Sent with `Cache-Control: no-store`. Rate limited to 60/minute per user.',
  request: { params: RoomIdParams, query: ListInvitesQuery },
  responses: {
    200: { description: 'A page of invites.', content: json(InvitePage) },
    ...authedErrors,
    404: roomNotFound,
    422: errorResponse('Invalid status, cursor, or limit.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/invites/{inviteId}',
  tags: ['invites'],
  summary: 'Revoke an invite',
  description:
    'The invite’s creator, or an owner or admin of its room. Idempotent: revoking a revoked invite is 204. ' +
    'Revoking an accepted invite never removes the member. For a pending direct invite to someone who has ' +
    'signed in, broadcasts `invite:revoked` on their `user:<profileId>`. Non-members of the invite’s room get ' +
    '404. Rate limited to 60/hour per user.' +
    writeNote,
  request: { params: InviteIdParams },
  responses: {
    204: { description: 'Revoked.' },
    ...authedErrors,
    403: errorResponse(`${csrf} Or the caller is a plain member who didn’t create the invite.`),
    404: errorResponse('Invite not found, its room is deleted, or you are not a member of its room.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/invites/{token}/preview',
  tags: ['invites'],
  summary: 'Preview a link invite',
  description:
    'Public (no session needed): what the invite page shows before joining. Returns 404 with the same body for ' +
    'every unusable invite (malformed or unknown token, revoked, expired, used up, deleted room), so it reveals ' +
    'nothing about invalid links. Sent with `Cache-Control: no-store`. Rate limited to 60/minute per IP.',
  security: [],
  request: { params: InviteTokenParams },
  responses: {
    200: { description: 'The invite preview.', content: json(InvitePreview) },
    404: errorResponse('This invite is invalid or no longer usable.'),
    429: authedErrors[429],
    500: serverError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/invites/{token}/redeem',
  tags: ['invites'],
  summary: 'Join a room with a link invite',
  description:
    'Joins the invite’s room as a member and returns the room. Idempotent by design: redeeming again (or a ' +
    'retry) returns `already_member` without using up the invite. On join, broadcasts `member:joined` on ' +
    '`room:<roomId>`. 410 codes: `INVITE_REVOKED`, `INVITE_EXPIRED`, `INVITE_USED_UP`. A caller banned from the ' +
    'room gets 403 `BANNED`.' +
    respondLimitNote +
    writeNote,
  request: { params: InviteTokenParams },
  responses: {
    200: { description: 'Joined (or already a member).', content: json(RedeemInviteResult) },
    ...authedErrors,
    403: errorResponse(`${csrf} Or \`BANNED\`: you are banned from this room.`),
    404: errorResponse('Malformed or unknown token, or the room was deleted.'),
    410: errorResponse('`INVITE_REVOKED`, `INVITE_EXPIRED`, or `INVITE_USED_UP`.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/me/invites',
  tags: ['invites'],
  summary: 'My pending direct invites',
  description:
    `Pending, unexpired direct invites to the caller’s Steam account in live rooms, newest first (at most ${INBOX_LIMIT}). ` +
    'Keep it current with `invite:received` and `invite:revoked` on `user:<profileId>`. Sent with ' +
    '`Cache-Control: no-store`. Rate limited to 60/minute per user.',
  responses: {
    200: { description: 'The inbox.', content: json(InboxPage) },
    ...authedErrors,
    500: serverError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/me/invites/{inviteId}/accept',
  tags: ['invites'],
  summary: 'Accept a direct invite',
  description:
    'Joins the room and returns it. Idempotent: retrying an accept that succeeded returns `already_member`. On ' +
    'join, broadcasts `member:joined` on `room:<roomId>`. Invites addressed to someone else are 404. A caller ' +
    'banned from the room gets 403 `BANNED`; declining still works.' +
    respondLimitNote +
    writeNote,
  request: { params: InviteIdParams },
  responses: {
    200: { description: 'Accepted (or already a member).', content: json(AcceptInviteResult) },
    ...authedErrors,
    403: errorResponse(`${csrf} Or \`BANNED\`: you are banned from this room.`),
    404: errorResponse('Invite not found, not addressed to you, or its room was deleted.'),
    409: errorResponse('`INVITE_ALREADY_RESPONDED`: the invite was already declined, or accepted and you are no longer a member.'),
    410: errorResponse('`INVITE_REVOKED` or `INVITE_EXPIRED`.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/me/invites/{inviteId}/decline',
  tags: ['invites'],
  summary: 'Decline a direct invite',
  description:
    'Declines the invite; nobody is notified. Idempotent: declining a declined invite is 204. Invites addressed ' +
    'to someone else are 404.' +
    respondLimitNote +
    writeNote,
  request: { params: InviteIdParams },
  responses: {
    204: { description: 'Declined.' },
    ...authedErrors,
    403: errorResponse(csrf),
    404: errorResponse('Invite not found, not addressed to you, or its room was deleted.'),
    409: errorResponse('`INVITE_ALREADY_RESPONDED`: the invite was already accepted.'),
    410: errorResponse('`INVITE_REVOKED` or `INVITE_EXPIRED`.'),
    500: serverError,
  },
});
