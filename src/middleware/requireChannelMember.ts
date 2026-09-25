import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { findChannelAccess, type ChannelAccess } from '../services/channels.js';
import { roleAtLeast } from '../services/rooms.js';
import { authOf } from './requireAuth.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireChannelMember. */
    channel?: ChannelAccess;
  }
}

const ChannelId = z.guid();

/**
 * Mount after requireAuth on routes with a `:channelId` param. A malformed id, a missing or
 * deleted channel, a deleted room, and a non-member all get 404, so existence never leaks;
 * a member below `minRole` (owner > admin > member) gets 403.
 */
export function requireChannelMember(minRole?: 'admin' | 'owner'): RequestHandler {
  return async (req, _res, next) => {
    try {
      const parsed = ChannelId.safeParse(req.params.channelId);
      if (!parsed.success) throw new NotFoundError();

      const access = await findChannelAccess(parsed.data.toLowerCase(), authOf(req).profileId);
      if (!access) throw new NotFoundError();
      if (minRole && !roleAtLeast(access.role, minRole)) throw new ForbiddenError();

      req.channel = access;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** For handlers mounted after requireChannelMember. */
export function channelOf(req: { channel?: ChannelAccess }): ChannelAccess {
  if (!req.channel) throw new Error('route handler used without requireChannelMember');
  return req.channel;
}
