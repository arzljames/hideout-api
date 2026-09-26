import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { findInviteAccess, type InviteAccess } from '../services/invites.js';
import { roleAtLeast } from '../services/rooms.js';
import { authOf } from './requireAuth.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireInviteMember. */
    invite?: InviteAccess;
  }
}

const InviteId = z.guid();

/**
 * Mount after requireAuth on routes with an `:inviteId` param that act on an invite from its
 * room's side (revoke). A malformed id, a missing invite, a deleted room, and a non-member all
 * get 404, so existence never leaks. A plain member who didn't create the invite gets 403 here,
 * without a database write (revoke_invite re-checks it under lock).
 *
 * Despite the name (kept parallel to requireRoomMember), membership alone isn't enough: the
 * caller must also be the invite's creator or an owner/admin of its room.
 */
export function requireInviteMember(): RequestHandler {
  return async (req, _res, next) => {
    try {
      const parsed = InviteId.safeParse(req.params.inviteId);
      if (!parsed.success) throw new NotFoundError();

      const profileId = authOf(req).profileId.toLowerCase();
      const access = await findInviteAccess(parsed.data.toLowerCase(), profileId);
      if (!access) throw new NotFoundError();
      if (access.createdBy !== profileId && !roleAtLeast(access.role, 'admin')) throw new ForbiddenError();

      req.invite = access;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** For handlers mounted after requireInviteMember. */
export function inviteOf(req: { invite?: InviteAccess }): InviteAccess {
  if (!req.invite) throw new Error('route handler used without requireInviteMember');
  return req.invite;
}
