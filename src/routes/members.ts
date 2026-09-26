import { ChangeRoleBody, TransferOwnershipBody } from '../contracts/http/members.js';
import { memberWriteLimiter } from '../middleware/rateLimits.js';
import { authOf } from '../middleware/requireAuth.js';
import { memberTargetOf, requireMemberTarget } from '../middleware/requireMemberTarget.js';
import { requireRoomMember, roomOf } from '../middleware/requireRoomMember.js';
import { validate } from '../middleware/validate.js';
import { changeRole, leaveRoom, removeMember, transferOwnership } from '../services/members.js';
import { documentedRouter } from './documentedRouter.js';

// Mounted below the global requireAuth; requireSameOrigin (CSRF) covers every write under /api.
// The Postgres functions re-check every rule under the room lock; the role checks here are a fast path.

/** Membership routes of one room (`/api/rooms/:roomId/members...`), next to roomsRouter. */
export const roomMembersRouter = documentedRouter('/api/rooms')
  // Before `/members/:userId`, so `me` is never treated as a user id.
  .delete('/:roomId/members/me', requireRoomMember(), memberWriteLimiter, async (req, res) => {
    await leaveRoom(roomOf(req).roomId, authOf(req).profileId);
    res.status(204).end();
  })
  // Targeting yourself only needs membership (it's a leave); anyone else needs admin or above.
  .delete(
    '/:roomId/members/:userId',
    requireRoomMember(),
    requireMemberTarget('admin'),
    memberWriteLimiter,
    async (req, res) => {
      await removeMember(roomOf(req).roomId, authOf(req).profileId, memberTargetOf(req));
      res.status(204).end();
    },
  )
  .patch(
    '/:roomId/members/:userId',
    requireRoomMember('owner'),
    requireMemberTarget(),
    memberWriteLimiter,
    validate({ body: ChangeRoleBody }),
    async (req, res) => {
      const { roomId } = roomOf(req);
      const member = await changeRole(roomId, authOf(req).profileId, memberTargetOf(req), req.body as ChangeRoleBody);
      res.json(member);
    },
  )
  .post(
    '/:roomId/transfer-ownership',
    requireRoomMember('owner'),
    memberWriteLimiter,
    validate({ body: TransferOwnershipBody }),
    async (req, res) => {
      const { userId } = req.body as TransferOwnershipBody;
      const detail = await transferOwnership(roomOf(req).roomId, authOf(req).profileId, userId);
      res.json(detail);
    },
  );
