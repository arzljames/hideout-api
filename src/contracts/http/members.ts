import { z } from 'zod';
import { Id, authedErrors, errorResponse } from './common.js';
import { registry } from './registry.js';
import { Member, RoomDetail, RoomIdParams } from './rooms.js';

/*
 * Membership: leave a room, remove a member, change a member's role, transfer ownership.
 *
 * Rules (the Postgres functions re-check them under the room lock):
 *   - Anyone but the owner can leave. The owner transfers ownership or deletes the room first.
 *   - The owner removes anyone except themself; an admin removes plain members only.
 *   - Only the owner changes roles (admin <-> member) or transfers ownership.
 */

export const MemberParams = z.object({
  roomId: RoomIdParams.shape.roomId,
  userId: Id.openapi({ description: 'Profile id of the member. A malformed id is a 404, like an unknown one.' }),
});

export const ChangeRoleBody = registry.register(
  'ChangeRoleBody',
  z.strictObject({
    role: z.enum(['admin', 'member']).openapi({
      description: 'The new role. Ownership only moves via `POST /api/rooms/{roomId}/transfer-ownership`.',
    }),
  }),
);
export type ChangeRoleBody = z.infer<typeof ChangeRoleBody>;

export const TransferOwnershipBody = registry.register(
  'TransferOwnershipBody',
  z.strictObject({
    userId: Id.openapi({ description: 'Profile id of the member who becomes the owner.' }),
  }),
);
export type TransferOwnershipBody = z.infer<typeof TransferOwnershipBody>;

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const csrf = 'Origin or Content-Type check failed (send `Content-Type: application/json` from WEB_ORIGIN).';
const writeNote =
  ' Writes need `Content-Type: application/json` (even with no body) and credentials; the CSRF check requires it.';
const limitNote = ' Leave, remove, change role, and transfer ownership share one rate limit: 30/hour per user.';
const roomNotFound = errorResponse('Room not found, deleted, or you are not a member (non-members always get 404).');
const memberNotFound = errorResponse(
  'Room not found, deleted, or you are not a member (non-members always get 404); or the target is not a member ' +
    '(or the userId is malformed).',
);
const ownerProtected = errorResponse(
  "`OWNER_PROTECTED`: the room owner can't leave or be removed; transfer ownership or delete the room first.",
);
const serverError = errorResponse('Unexpected server error.');

const leaveEffects =
  'Broadcasts `member:left` on `room:<roomId>` and disconnects the member from the room’s voice channels. ' +
  'Their pending invites in this room are revoked, as are pending direct invites addressed to them; each ' +
  'signed-in invitee of a revoked direct invite gets `invite:revoked` on their `user:<profileId>`.';
const retryNote = ' If the response is a 5xx, the change may have been applied; refetch the room before retrying.';

registry.registerPath({
  method: 'delete',
  path: '/api/rooms/{roomId}/members/me',
  tags: ['members'],
  summary: 'Leave a room',
  description:
    `Any member except the owner. ${leaveEffects} The owner gets 409 \`OWNER_PROTECTED\`: transfer ownership or ` +
    'delete the room first. Non-members get 404.' +
    limitNote +
    writeNote,
  request: { params: RoomIdParams },
  responses: {
    204: { description: 'Left the room.' },
    ...authedErrors,
    403: errorResponse(csrf),
    404: roomNotFound,
    409: ownerProtected,
    500: serverError,
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/rooms/{roomId}/members/{userId}',
  tags: ['members'],
  summary: 'Remove a member',
  description:
    'The owner removes anyone except themself; an admin removes plain members only. ' +
    `${leaveEffects} Also broadcasts \`member:removed\` on the removed member’s \`user:<profileId>\`, so their ` +
    'client leaves the room. If `userId` is the caller’s own id, this behaves exactly like leaving ' +
    '(`DELETE /api/rooms/{roomId}/members/me`: same rules, no `member:removed`). Removing the owner is 409 ' +
    '`OWNER_PROTECTED`. Non-members get 404.' +
    limitNote +
    writeNote,
  request: { params: MemberParams },
  responses: {
    204: { description: 'Removed.' },
    ...authedErrors,
    403: errorResponse(`${csrf} Or the caller’s role can’t remove this member (plain members; admins removing an admin).`),
    404: memberNotFound,
    409: ownerProtected,
    500: serverError,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/rooms/{roomId}/members/{userId}',
  tags: ['members'],
  summary: 'Change a member’s role',
  description:
    'Owner only: makes a member an admin or an admin a plain member. Broadcasts `member:role_changed` on ' +
    '`room:<roomId>`. The owner can’t change their own role (422); ownership moves only via transfer. ' +
    'Non-members get 404.' +
    retryNote +
    limitNote +
    writeNote,
  request: { params: MemberParams, body: { required: true, content: json(ChangeRoleBody) } },
  responses: {
    200: { description: 'The member with their new role.', content: json(Member) },
    ...authedErrors,
    403: errorResponse(`${csrf} Or the caller is not the owner.`),
    404: memberNotFound,
    422: errorResponse('Invalid role, or the owner targeted themself.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/rooms/{roomId}/transfer-ownership',
  tags: ['members'],
  summary: 'Transfer room ownership',
  description:
    'Owner only: makes another member the owner; the caller becomes an admin. Broadcasts two ' +
    '`member:role_changed` events on `room:<roomId>` (the caller → `admin`, the new owner → `owner`). Returns the ' +
    'room as the caller now sees it. Non-members get 404.' +
    retryNote +
    limitNote +
    writeNote,
  request: { params: RoomIdParams, body: { required: true, content: json(TransferOwnershipBody) } },
  responses: {
    200: { description: 'The room, with the caller now an admin.', content: json(RoomDetail) },
    ...authedErrors,
    403: errorResponse(`${csrf} Or the caller is not the owner.`),
    404: errorResponse(
      'Room not found, deleted, or you are not a member (non-members always get 404); or the new owner is not a member.',
    ),
    422: errorResponse('Invalid body, or `userId` is the caller’s own id.'),
    500: serverError,
  },
});
