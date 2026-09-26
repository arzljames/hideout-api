import express from 'express';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CursorQuery } from '../src/contracts/http/common.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { authLimiter } from '../src/middleware/rateLimits.js';
import { validate } from '../src/middleware/validate.js';
import { createContractRouter } from '../src/routes/contract.js';

describe('validate', () => {
  const app = express()
    .use(express.json({ limit: '1kb' }))
    .post(
      '/items/:id',
      validate({ params: z.object({ id: z.guid() }), query: CursorQuery, body: z.object({ name: z.string().min(1) }) }),
      (req, res) => {
        res.json({ params: req.params, query: req.query, body: req.body as unknown });
      },
    )
    .use(errorHandler);

  const ID = '11111111-1111-4111-8111-111111111111';

  it('replaces params, query, and body with parsed values (coercion and defaults applied)', async () => {
    const res = await request(app).post(`/items/${ID}?limit=5`).send({ name: 'a', extra: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ params: { id: ID }, query: { limit: 5 }, body: { name: 'a' } });

    const defaults = await request(app).post(`/items/${ID}`).send({ name: 'a' });
    expect(defaults.body.query).toEqual({ limit: 50 });
  });

  it('returns 422 with field details from every location', async () => {
    const res = await request(app).post('/items/nope?limit=0').send({ name: '' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = (res.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(['params.id', 'query.limit', 'body.name']);
  });

  it('returns 413 PAYLOAD_TOO_LARGE for oversized bodies', async () => {
    const res = await request(app).post(`/items/${ID}`).send({ name: 'x'.repeat(2_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('validate: headers', () => {
  const Headers = z.object({ 'x-key': z.string().regex(/^[a-z]{1,4}$/).optional() });
  const app = express()
    .use(express.json())
    .post('/h', validate({ headers: Headers, body: z.strictObject({ name: z.string().min(1) }) }), (req, res) => {
      res.json({ key: req.get('x-key') ?? null, other: req.get('x-other') ?? null, body: req.body as unknown });
    })
    .use(errorHandler);

  it('passes valid and absent headers through without replacing req.headers', async () => {
    const res = await request(app).post('/h').set('X-Key', 'abc').set('X-Other', 'Kept As Is').send({ name: 'a' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: 'abc', other: 'Kept As Is', body: { name: 'a' } });

    const absent = await request(app).post('/h').send({ name: 'a' });
    expect(absent.status).toBe(200);
    expect(absent.body.key).toBeNull();
  });

  it('matches header names case-insensitively (Node lowercases them)', async () => {
    const res = await request(app).post('/h').set('X-KEY', 'TOOLONG').send({ name: 'a' });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([{ path: 'headers.x-key', message: expect.any(String) as string }]);
  });

  it('reports header issues first, together with body issues, and never echoes the header value', async () => {
    const res = await request(app).post('/h').set('X-Key', 'SECRETVALUE').send({ name: '' });
    expect(res.status).toBe(422);
    expect((res.body.error.details as { path: string }[]).map((d) => d.path)).toEqual(['headers.x-key', 'body.name']);
    expect(res.text).not.toContain('SECRETVALUE');
  });
});

describe('rate limits', () => {
  it('returns 429 RATE_LIMITED in the standard error shape', async () => {
    const app = express()
      .get('/login', authLimiter, (_req, res) => {
        res.json({});
      })
      .use(errorHandler);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await request(app).get('/login')).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);

    const res = await request(app).get('/login');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' } });
  });
});

describe('contract route', () => {
  it('returns 404 NOT_FOUND (not 500) when the contract has not been generated', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'hideout-contract-'));
    const app = express().use('/contract', createContractRouter(empty).router).use(errorHandler);
    const res = await request(app).get('/contract/openapi.json');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'Contract not generated.' });
  });
});
