import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { RealtimeToken } from '../contracts/http/auth.js';

export const REALTIME_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Marks tokens minted by Node. realtime.messages policies must require
 * auth.jwt() ->> 'iss' = 'hideout-api' so other authenticated JWTs can't join.
 */
export const REALTIME_TOKEN_ISSUER = 'hideout-api';

/*
 * Mints the short-lived JWT the browser uses to join private Realtime channels.
 * `sub` is the profile id that realtime.messages RLS policies check membership against.
 *
 * Signed with ES256 using our own P-256 private key (SUPABASE_JWT_PRIVATE_JWK, from
 * `npm run jwt:keygen`), imported into the project as a JWT signing key. Supabase picks
 * the verification key by the `kid` header, which must equal the imported key's kid.
 * Not the legacy HS256 JWT secret, which Supabase no longer recommends.
 * Verified 2026-09-25 against https://supabase.com/docs/guides/auth/signing-keys
 */
export function mintRealtimeToken(profileId: string, now = new Date()): RealtimeToken {
  const { kid, privateKey } = env.SUPABASE_JWT_SIGNING_KEY;
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + REALTIME_TOKEN_TTL_SECONDS;
  const token = jwt.sign(
    { iss: REALTIME_TOKEN_ISSUER, sub: profileId, role: 'authenticated', aud: 'authenticated', iat, exp },
    privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid, typ: 'JWT' } },
  );
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}
