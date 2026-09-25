import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { findMembership, roleAtLeast, type Role } from '../services/rooms.js';
import { authOf } from './requireAuth.js';

export interface RoomAccess {
  /** Lowercased room id from the path. */
  roomId: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireRoomMember. */
    room?: RoomAccess;
  }
}

const RoomId = z.guid();

/**
 * Mount after requireAuth on routes with a `:roomId` param. A malformed id, a missing or
 * deleted room, and a non-member all get 404, so room existence never leaks; a member
 * below `minRole` (owner > admin > member) gets 403.
 */
export function requireRoomMember(minRole?: 'admin' | 'owner'): RequestHandler {
  return async (req, _res, next) => {
    try {
      const parsed = RoomId.safeParse(req.params.roomId);
      if (!parsed.success) throw new NotFoundError();
      const roomId = parsed.data.toLowerCase();

      const role = await findMembership(roomId, authOf(req).profileId);
      if (!role) throw new NotFoundError();
      if (minRole && !roleAtLeast(role, minRole)) throw new ForbiddenError();

      req.room = { roomId, role };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** For handlers mounted after requireRoomMember. */
export function roomOf(req: { room?: RoomAccess }): RoomAccess {
  if (!req.room) throw new Error('route handler used without requireRoomMember');
  return req.room;
}
