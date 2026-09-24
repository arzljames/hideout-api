import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalError } from '../src/errors.js';

vi.mock('../src/services/auth.js', () => ({ findSession: vi.fn() }));

const { findSession } = await import('../src/services/auth.js');
const { SESSION_COOKIE } = await import('../src/lib/session.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { requireAuth } = await import('../src/middleware/requireAuth.js');

const findSessionMock = vi.mocked(findSession);
const SESSION = { profileId: '5b0e7c1e-7f4a-4d2e-9a5b-3c1d2e4f6a7b', sessionId: '0d7f1c2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5' };
const TOKEN = 'a'.repeat(43);

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
  beforeEach(() => {
    findSessionMock.mockReset();
  });

  it('accepts a cookie with a live session', async () => {
    findSessionMock.mockResolvedValue(SESSION);
    const res = await withCookie(TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SESSION);
    expect(findSessionMock).toHaveBeenCalledWith(TOKEN);
  });

  it('rejects a missing cookie', async () => {
    findSessionMock.mockResolvedValue(null);
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an unknown or expired session', async () => {
    findSessionMock.mockResolvedValue(null);
    const res = await withCookie(TOKEN);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('turns a database failure into a generic 500', async () => {
    findSessionMock.mockRejectedValue(new InternalError(new Error('connection refused to db.internal')));
    const res = await withCookie(TOKEN);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });
});
