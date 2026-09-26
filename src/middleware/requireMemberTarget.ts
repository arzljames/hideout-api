import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { roleAtLeast } from '../services/rooms.js';
import { authOf } from './requireAuth.js';
import { roomOf } from './requireRoomMember.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Lowercased `:userId` from the path. Set by requireMemberTarget. */
    memberTarget?: string;
  }
}

const UserId = z.guid();

/**
 * Mount after requireRoomMember on routes with a `:userId` param. A malformed id is a 404 (like
 * an unknown member), not a 422. With `minRoleForOthers`, a caller below that role who targets
 * someone other than themself gets 403; targeting yourself only needs membership. This is a fast
 * path: the Postgres function re-checks the exact rules (e.g. admins can't remove admins).
 */
export function requireMemberTarget(minRoleForOthers?: 'admin' | 'owner'): RequestHandler {
  return (req, _res, next) => {
    const parsed = UserId.safeParse(req.params.userId);
    if (!parsed.success) {
      next(new NotFoundError());
      return;
    }
    const target = parsed.data.toLowerCase();
    const isSelf = target === authOf(req).profileId.toLowerCase();
    if (minRoleForOthers && !isSelf && !roleAtLeast(roomOf(req).role, minRoleForOthers)) {
      next(new ForbiddenError());
      return;
    }
    req.memberTarget = target;
    next();
  };
}

/** For handlers mounted after requireMemberTarget. */
export function memberTargetOf(req: { memberTarget?: string }): string {
  if (!req.memberTarget) throw new Error('route handler used without requireMemberTarget');
  return req.memberTarget;
}
