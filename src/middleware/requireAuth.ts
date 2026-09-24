import type { RequestHandler } from 'express';
import { UnauthenticatedError } from '../errors.js';
import { SESSION_COOKIE } from '../lib/session.js';
import { findSession, type AuthSession } from '../services/auth.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireAuth. */
    auth?: AuthSession;
  }
}

/** Looks up the server-side session for the cookie; 401 if there is none or it expired. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const session = await findSession((req.cookies as Record<string, string | undefined>)[SESSION_COOKIE]);
    if (!session) {
      next(new UnauthenticatedError());
      return;
    }
    req.auth = session;
    next();
  } catch (err) {
    next(err);
  }
};

/** For handlers mounted after requireAuth. */
export function authOf(req: { auth?: AuthSession }): AuthSession {
  if (!req.auth) throw new Error('route handler used without requireAuth');
  return req.auth;
}
