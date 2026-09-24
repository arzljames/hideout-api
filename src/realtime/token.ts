import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const REALTIME_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Marks tokens minted by Node. realtime.messages policies must require
 * auth.jwt() ->> 'iss' = 'hideout-api' so other authenticated JWTs can't join.
 */
export const REALTIME_TOKEN_ISSUER = 'hideout-api';

export interface RealtimeToken {
  token: string;
  expiresAt: string;
}

/*
 * Mints the short-lived JWT the browser uses to join private Realtime channels.
 * `sub` is the profile id that realtime.messages RLS policies check membership against.
 * Assumes the project signs with the legacy HS256 JWT secret. Verify against the
 * current Supabase docs for the project's JWT signing configuration before changing.
 */
export function mintRealtimeToken(profileId: string, now = new Date()): RealtimeToken {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + REALTIME_TOKEN_TTL_SECONDS;
  const token = jwt.sign(
    { iss: REALTIME_TOKEN_ISSUER, sub: profileId, role: 'authenticated', aud: 'authenticated', iat, exp },
    env.SUPABASE_JWT_SECRET,
    { algorithm: 'HS256' },
  );
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}
