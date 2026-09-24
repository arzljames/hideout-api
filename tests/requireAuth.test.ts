import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, signSession } from '../src/lib/session.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { requireAuth } from '../src/middleware/requireAuth.js';

const PROFILE_ID = '5b0e7c1e-7f4a-4d2e-9a5b-3c1d2e4f6a7b';
const SECRET = process.env.SESSION_SECRET ?? '';
const CLAIMS = { subject: PROFILE_ID, issuer: 'hideout-api', audience: 'hideout-session' };

const app = express()
  .use(cookieParser())
  .get('/me', requireAuth, (req, res) => {
    res.json(req.auth);
  })
  .use(errorHandler);

function withCookie(token: string) {
  return request(app).get('/me').set('Cookie', `${SESSION_COOKIE}=${token}`);
}

describe('requireAuth', () => {
  it('accepts a valid session cookie', async () => {
    const res = await withCookie(signSession(PROFILE_ID));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ profileId: PROFILE_ID });
  });

  it('rejects a missing cookie', async () => {
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a token signed with another secret', async () => {
    const res = await withCookie(jwt.sign({}, 'x'.repeat(40), { ...CLAIMS, expiresIn: 60 }));
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const res = await withCookie(jwt.sign({}, SECRET, { ...CLAIMS, expiresIn: -10 }));
    expect(res.status).toBe(401);
  });

  it('rejects alg "none"', async () => {
    const res = await withCookie(jwt.sign({}, '', { ...CLAIMS, algorithm: 'none' }));
    expect(res.status).toBe(401);
  });

  it('rejects a Realtime-style token signed with the session secret (wrong audience)', async () => {
    const res = await withCookie(jwt.sign({ sub: PROFILE_ID, aud: 'authenticated' }, SECRET));
    expect(res.status).toBe(401);
  });
});
