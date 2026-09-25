import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { mintRealtimeToken, REALTIME_TOKEN_TTL_SECONDS } from '../src/realtime/token.js';
import { TEST_JWT_KID, TEST_JWT_PRIVATE_JWK } from './helpers/jwtKey.js';

// What Supabase holds after the import: the public half of the signing key.
const { d: _d, ...publicJwk } = JSON.parse(TEST_JWT_PRIVATE_JWK) as Record<string, string>;
const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' });

const PROFILE_ID = '5b0e7c1e-7f4a-4d2e-9a5b-3c1d2e4f6a7b';

describe('mintRealtimeToken', () => {
  it('mints an ES256 Supabase JWT for the profile with a 15 minute TTL', () => {
    const now = new Date('2026-09-25T10:00:00Z');
    const { token, expiresAt } = mintRealtimeToken(PROFILE_ID, now);
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['ES256'],
      audience: 'authenticated',
      issuer: 'hideout-api',
      clockTimestamp: now.getTime() / 1000,
      complete: true,
    });
    expect(decoded.header).toEqual({ alg: 'ES256', kid: TEST_JWT_KID, typ: 'JWT' });
    const claims = decoded.payload as jwt.JwtPayload;
    expect(claims).toEqual({
      sub: PROFILE_ID,
      role: 'authenticated',
      aud: 'authenticated',
      iss: 'hideout-api',
      iat: now.getTime() / 1000,
      exp: now.getTime() / 1000 + REALTIME_TOKEN_TTL_SECONDS,
    });
    expect(REALTIME_TOKEN_TTL_SECONDS).toBe(900);
    expect(expiresAt).toBe('2026-09-25T10:15:00.000Z');
  });

  it('is rejected once expired and never verifies as HS256', () => {
    const now = new Date('2026-09-25T10:00:00Z');
    const { token } = mintRealtimeToken(PROFILE_ID, now);
    expect(() =>
      jwt.verify(token, publicKey, { algorithms: ['ES256'], clockTimestamp: now.getTime() / 1000 + 901 }),
    ).toThrow(/expired/);
    expect(() => jwt.verify(token, 'any-shared-secret', { algorithms: ['HS256'] })).toThrow();
  });
});
