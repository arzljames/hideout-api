import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import type { AuthRedirectErrorCode } from '../contracts/http/auth.js';
import { buildLoginUrl } from '../lib/steam.js';
import {
  clearLoginStateCookieOptions,
  clearSessionCookieOptions,
  LOGIN_STATE_COOKIE,
  loginStateCookieOptions,
  newRandomToken,
  safeEqual,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../lib/session.js';
import { MINUTE, navigationLimiter } from '../middleware/rateLimits.js';
import { authOf, requireAuth } from '../middleware/requireAuth.js';
import { completeSteamLogin, deleteAllSessions, deleteSession, endSessionByToken } from '../services/auth.js';
import { documentedRouter } from './documentedRouter.js';

function redirectWithError(res: Response, code: AuthRedirectErrorCode): void {
  res.redirect(302, `${env.WEB_ORIGIN}/?auth_error=${code}`);
}

/** The state query param, if it is present and matches the state cookie. */
function checkedState(req: Request): string | null {
  const fromQuery = req.query.state;
  const fromCookie = (req.cookies as Record<string, string | undefined>)[LOGIN_STATE_COOKIE];
  if (typeof fromQuery !== 'string' || !fromQuery || !fromCookie) return null;
  return safeEqual(fromQuery, fromCookie) ? fromQuery : null;
}

/*
 * Separate per-IP buckets (10/min each) so one sign-in costs one request from each.
 * These are browser navigations, so a limit redirects back to hideout-web instead of
 * returning JSON on the API origin.
 */
const startLimiter = navigationLimiter(MINUTE, 10, (_req, res) => {
  redirectWithError(res, 'RATE_LIMITED');
});
const callbackLimiter = navigationLimiter(MINUTE, 10, (_req, res) => {
  res.clearCookie(LOGIN_STATE_COOKIE, clearLoginStateCookieOptions);
  redirectWithError(res, 'RATE_LIMITED');
});

/** Ends the session this browser already had (e.g. signing in as a different account). Never fails sign-in. */
async function endPreviousSession(req: Request): Promise<void> {
  const previous = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
  await endSessionByToken(previous).catch((err: unknown) => {
    req.log.warn({ err: (err as Error).cause ?? err }, 'could not end previous session');
  });
}

// Public Steam routes are rate-limited per IP; logout routes require a session explicitly,
// because this router is mounted before the global requireAuth.
export const authRouter = documentedRouter('/api/auth')
  .get('/steam', startLimiter, (_req, res) => {
    const state = newRandomToken();
    res.cookie(LOGIN_STATE_COOKIE, state, loginStateCookieOptions);
    res.redirect(302, buildLoginUrl(state));
  })
  .get('/steam/callback', callbackLimiter, async (req, res) => {
    res.clearCookie(LOGIN_STATE_COOKIE, clearLoginStateCookieOptions);
    const state = checkedState(req);
    if (!state) {
      redirectWithError(res, 'LOGIN_STATE_MISMATCH');
      return;
    }
    const result = await completeSteamLogin(req.query, state).catch((err: unknown) => {
      // Never log the query string: it carries Steam's signed assertion.
      req.log.error({ err: (err as Error).cause ?? err }, 'steam login failed');
      return { ok: false, reason: 'LOGIN_FAILED' } as const;
    });
    if (!result.ok) {
      redirectWithError(res, result.reason);
      return;
    }
    await endPreviousSession(req);
    res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions);
    res.redirect(302, `${env.WEB_ORIGIN}/`);
  })
  .post('/logout', requireAuth, async (req, res) => {
    await deleteSession(authOf(req).sessionId);
    res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions);
    res.status(204).end();
  })
  .post('/logout-all', requireAuth, async (req, res) => {
    await deleteAllSessions(authOf(req).profileId);
    res.clearCookie(SESSION_COOKIE, clearSessionCookieOptions);
    res.status(204).end();
  });
