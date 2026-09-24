import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions } from 'express';
import { env } from '../config/env.js';

/*
 * Sessions are server-side: the cookie holds a random opaque token, and the database
 * stores only HMAC-SHA256(SESSION_SECRET, token). A leaked sessions table can't be
 * replayed, and deleting a row revokes the session immediately.
 */

const SECURE = new URL(env.API_URL).protocol === 'https:';

// __Host- stops sibling subdomains from setting (tossing) the cookie; browsers only allow it with Secure.
export const SESSION_COOKIE = SECURE ? '__Host-hideout_session' : 'hideout_session';
/** Absolute lifetime; sessions are not extended on use. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Holds the OpenID `state` between GET /api/auth/steam and the callback. */
export const LOGIN_STATE_COOKIE = SECURE ? '__Host-hideout_login_state' : 'hideout_login_state';
export const LOGIN_STATE_TTL_SECONDS = 10 * 60;

/** 32 random bytes, base64url without padding. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  // Always Secure over HTTPS; plain-http local dev (http://localhost) can't set Secure cookies in every browser.
  secure: SECURE,
  sameSite: 'lax',
  path: '/',
};

/** httpOnly, Secure, SameSite=Lax, host-only on the API domain (no `domain` set). */
export const sessionCookieOptions: CookieOptions = { ...baseCookieOptions, maxAge: SESSION_TTL_SECONDS * 1000 };

/** Same attributes minus maxAge, for res.clearCookie. */
export const clearSessionCookieOptions: CookieOptions = baseCookieOptions;

export const loginStateCookieOptions: CookieOptions = { ...baseCookieOptions, maxAge: LOGIN_STATE_TTL_SECONDS * 1000 };

export const clearLoginStateCookieOptions: CookieOptions = baseCookieOptions;

/** A new random token: 32 bytes, base64url (43 chars). Used for session tokens and login state. */
export function newRandomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newSessionToken(): string {
  return newRandomToken();
}

/** HMAC-SHA256(SESSION_SECRET, token) as 64 lowercase hex chars; the only form stored in the database. */
export function hashSessionToken(token: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(token).digest('hex');
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
