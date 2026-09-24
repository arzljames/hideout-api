import type { RequestHandler } from 'express';
import { UnauthenticatedError } from '../errors.js';
import { SESSION_COOKIE, verifySession, type Session } from '../lib/session.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireAuth. */
    auth?: Session;
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const session = verifySession((req.cookies as Record<string, string | undefined>)[SESSION_COOKIE]);
  if (!session) {
    next(new UnauthenticatedError());
    return;
  }
  req.auth = session;
  next();
};
