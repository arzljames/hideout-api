import type { CookieOptions } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env.js';

const SECURE = new URL(env.API_URL).protocol === 'https:';

// __Host- stops sibling subdomains from setting (tossing) the cookie; browsers only allow it with Secure.
export const SESSION_COOKIE = SECURE ? '__Host-hideout_session' : 'hideout_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const ISSUER = 'hideout-api';
const AUDIENCE = 'hideout-session';

const SessionClaims = z.object({ sub: z.guid() });

export interface Session {
  profileId: string;
}

/** httpOnly, Secure, SameSite=Lax, host-only on the API domain (no `domain` set). */
export const sessionCookieOptions: CookieOptions = {
  httpOnly: true,
  // Always Secure over HTTPS; plain-http local dev (http://localhost) can't set Secure cookies in every browser.
  secure: SECURE,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL_SECONDS * 1000,
};

export function signSession(profileId: string): string {
  return jwt.sign({}, env.SESSION_SECRET, {
    algorithm: 'HS256',
    subject: profileId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: SESSION_TTL_SECONDS,
  });
}

/** Returns null for any missing, expired, tampered, or malformed token. */
export function verifySession(token: string | undefined): Session | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, env.SESSION_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const claims = SessionClaims.safeParse(decoded);
    return claims.success ? { profileId: claims.data.sub } : null;
  } catch {
    return null;
  }
}
