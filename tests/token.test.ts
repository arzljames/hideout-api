import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { mintRealtimeToken, REALTIME_TOKEN_TTL_SECONDS } from '../src/realtime/token.js';

describe('mintRealtimeToken', () => {
  it('mints an authenticated Supabase JWT for the profile with a 15 minute TTL', () => {
    const now = new Date('2026-09-25T10:00:00Z');
    const { token, expiresAt } = mintRealtimeToken('5b0e7c1e-7f4a-4d2e-9a5b-3c1d2e4f6a7b', now);
    const claims = jwt.verify(token, process.env.SUPABASE_JWT_SECRET ?? '', {
      algorithms: ['HS256'],
      clockTimestamp: now.getTime() / 1000,
    }) as jwt.JwtPayload;
    expect(claims).toMatchObject({
      sub: '5b0e7c1e-7f4a-4d2e-9a5b-3c1d2e4f6a7b',
      role: 'authenticated',
      aud: 'authenticated',
      iss: 'hideout-api',
    });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(REALTIME_TOKEN_TTL_SECONDS);
    expect(expiresAt).toBe('2026-09-25T10:15:00.000Z');
  });
});
