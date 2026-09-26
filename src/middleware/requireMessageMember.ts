import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { findMessageAccess, type MessageAccess } from '../services/messages.js';
import { roleAtLeast } from '../services/rooms.js';
import { authOf } from './requireAuth.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireMessageMember. */
    message?: MessageAccess;
  }
}

const MessageId = z.guid();

/**
 * Who may act on the message, checked up front so a clear 403 doesn't need a database write
 * (the Postgres functions re-check it under lock):
 * - `edit`: the author only.
 * - `delete`: the author, or an owner or admin of the room.
 */
export type MessagePermission = 'edit' | 'delete';

function allowed(access: MessageAccess, profileId: string, permission: MessagePermission): boolean {
  const isAuthor = access.authorId !== null && access.authorId === profileId.toLowerCase();
  return permission === 'edit' ? isAuthor : isAuthor || roleAtLeast(access.role, 'admin');
}

/**
 * Mount after requireAuth on routes with a `:messageId` param. A malformed id, a missing or
 * deleted message, a deleted channel or room, and a non-member all get 404, so existence never
 * leaks; a member who isn't allowed `permission` gets 403.
 */
export function requireMessageMember(permission: MessagePermission): RequestHandler {
  return async (req, _res, next) => {
    try {
      const parsed = MessageId.safeParse(req.params.messageId);
      if (!parsed.success) throw new NotFoundError();

      const { profileId } = authOf(req);
      const access = await findMessageAccess(parsed.data.toLowerCase(), profileId);
      if (!access) throw new NotFoundError();
      if (!allowed(access, profileId, permission)) throw new ForbiddenError();

      req.message = access;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** For handlers mounted after requireMessageMember. */
export function messageOf(req: { message?: MessageAccess }): MessageAccess {
  if (!req.message) throw new Error('route handler used without requireMessageMember');
  return req.message;
}
