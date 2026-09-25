import type * as PinoModule from 'pino';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, queries, resetFakeDb, results } from './helpers/fakeDb.js';

/*
 * GET /api/auth/me through the real app (createApp), offline: the database is faked at
 * the supabase-js client. Every log line (LOG_LEVEL=trace) is captured and checked.
 */

const logLines = vi.hoisted<string[]>(() => []);

vi.mock('pino', async (importOriginal) => {
  const actual = await importOriginal<typeof PinoModule>();
  const capture = { write: (line: string) => void logLines.push(line) };
  const pino = Object.assign(
    (options: PinoModule.LoggerOptions) => actual.pino(options, capture),
    actual.pino,
  );
  return { ...actual, pino, default: pino };
});
vi.mock('../src/db/client.js', async () => ({ db: (await import('./helpers/fakeDb.js')).fakeDb }));

const savedEnv = { LOG_LEVEL: process.env.LOG_LEVEL };
process.env.LOG_LEVEL = 'trace';

const { createApp } = await import('../src/app.js');
const { hashSessionToken, newRandomToken, SESSION_COOKIE } = await import('../src/lib/session.js');
const { Me } = await import('../src/contracts/http/auth.js');

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

const app = createApp();
const PROFILE_ID = '5b0e7c1e-7f4a-4d2e-9a5b-3c1d2e4f6a7b';
const SESSION_ID = '0d7f1c2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5';
const STEAM_ID = '76561197960287930';
const AVATAR = 'https://avatars.steamstatic.com/abc_full.jpg';

interface ProfileRow {
  id: string;
  steam_id: string;
  display_name: string;
  avatar_url: string | null;
  created_at?: string;
  updated_at?: string;
}

function profileRow(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return { id: PROFILE_ID, steam_id: STEAM_ID, display_name: 'Gordon', avatar_url: AVATAR, ...overrides };
}

/** A live session for PROFILE_ID, and the given profile lookup result. */
function signedIn(profile: { data?: unknown; error: { code?: string; message?: string; details?: string; hint?: string } | null }) {
  results.selectByTable.sessions = { data: { id: SESSION_ID, profile_id: PROFILE_ID }, error: null };
  results.selectByTable.profiles = profile;
}

function getMe(token: string | null = newRandomToken()) {
  const req = request(app).get('/api/auth/me');
  return token === null ? req : req.set('Cookie', `${SESSION_COOKIE}=${token}`);
}

function profileQueries() {
  return queries.filter((q) => q.table === 'profiles');
}

const UNAUTHENTICATED = { error: { code: 'UNAUTHENTICATED', message: 'You need to sign in.' } };
const INTERNAL = { error: { code: 'INTERNAL', message: 'Something went wrong.' } };

beforeEach(() => {
  resetFakeDb();
  logLines.length = 0;
});

afterEach(() => {
  const logs = logLines.join('');
  expect(logs).not.toContain('test-service-role-key');
  expect(logs).not.toContain('test-session-secret');
});

describe('GET /api/auth/me: access control', () => {
  it('returns 401 without a session cookie and queries nothing', async () => {
    const res = await getMe(null);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHENTICATED);
    expect(fakeDb.from).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', 'abc'],
    ['44 characters', 'A'.repeat(44)],
    ['non-base64url characters', `${'A'.repeat(42)}!`],
  ])('returns 401 for a malformed cookie (%s) without querying the database', async (_name, token) => {
    const res = await getMe(token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHENTICATED);
    expect(fakeDb.from).not.toHaveBeenCalled();
  });

  it('returns 401 for an unknown or expired session and never looks up a profile', async () => {
    const token = newRandomToken();
    results.selectByTable.sessions = { data: null, error: null };
    results.selectByTable.profiles = { data: profileRow(), error: null };
    const res = await getMe(token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHENTICATED);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.table).toBe('sessions');
    expect(queries[0]?.calls).toContainEqual(['eq', ['token_hash', hashSessionToken(token)]]);
    expect(queries[0]?.calls.some(([m, args]) => m === 'gt' && args[0] === 'expires_at')).toBe(true);
  });

  it('returns 401 when the session is valid but the profile row is missing', async () => {
    signedIn({ data: null, error: null });
    const res = await getMe();
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNAUTHENTICATED);
    expect(profileQueries()).toHaveLength(1);
  });
});

describe('GET /api/auth/me: success', () => {
  it('returns exactly { id, steamId, displayName, avatarUrl } with Cache-Control: no-store', async () => {
    signedIn({
      data: profileRow({ created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }),
      error: null,
    });
    const token = newRandomToken();
    const res = await getMe(token);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toStrictEqual({ id: PROFILE_ID, steamId: STEAM_ID, displayName: 'Gordon', avatarUrl: AVATAR });
    expect(Me.parse(res.body)).toStrictEqual(res.body);

    // No row metadata, session data, or the cookie token leak into the body.
    expect(res.text).not.toContain('created_at');
    expect(res.text).not.toContain('2026-01-01');
    expect(res.text).not.toContain(SESSION_ID);
    expect(res.text).not.toContain(token);
    expect(res.text).not.toContain(hashSessionToken(token));
    expect(logLines.join('')).not.toContain(token);
  });

  it('scopes the profile query to the session profile id and selects only the needed columns', async () => {
    signedIn({ data: profileRow(), error: null });
    await getMe();
    const [profile] = profileQueries();
    expect(profileQueries()).toHaveLength(1);
    expect(profile?.calls).toContainEqual(['eq', ['id', PROFILE_ID]]);
    expect(profile?.calls.filter(([m]) => m === 'eq')).toEqual([['eq', ['id', PROFILE_ID]]]);
    expect(profile?.calls).toContainEqual(['select', ['id, steam_id, display_name, avatar_url']]);
  });

  it('returns avatarUrl null when the profile has no avatar', async () => {
    signedIn({ data: profileRow({ avatar_url: null }), error: null });
    const res = await getMe();
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBeNull();
    expect(Me.parse(res.body)).toStrictEqual(res.body);
  });

  it.each([
    ['an http URL', 'http://avatars.steamstatic.com/abc_full.jpg'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['garbage', 'not a url'],
    ['an empty string', ''],
  ])('returns 200 with avatarUrl null when the stored avatar is %s', async (_name, avatar) => {
    signedIn({ data: profileRow({ avatar_url: avatar }), error: null });
    const res = await getMe();
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ id: PROFILE_ID, steamId: STEAM_ID, displayName: 'Gordon', avatarUrl: null });
    expect(Me.parse(res.body)).toStrictEqual(res.body);
  });

  it('needs no Origin or Content-Type (GET is exempt from the CSRF check)', async () => {
    signedIn({ data: profileRow(), error: null });
    const res = await getMe();
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PROFILE_ID);
  });

  it('still answers 200 with a foreign Origin, without granting that origin CORS credentials', async () => {
    signedIn({ data: profileRow(), error: null });
    const res = await getMe().set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    // cors pins Allow-Origin to WEB_ORIGIN; a browser on another origin can't read the body.
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });
});

describe('GET /api/auth/me: server errors', () => {
  it('returns a generic 500 when the profile lookup fails, logging no row values or details', async () => {
    signedIn({
      data: null,
      error: {
        code: 'XX000',
        message: 'db down',
        details: 'Failing row contains (ROWVALUE-DETAILS)',
        hint: 'HINTVALUE',
      },
    });
    const res = await getMe();
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(INTERNAL);
    const logs = logLines.join('');
    expect(logs).toContain('profile lookup failed: db down');
    expect(logs).not.toContain('ROWVALUE-DETAILS');
    expect(logs).not.toContain('HINTVALUE');
    expect(res.text).not.toContain('db down');
  });

  it('returns a generic 500 when the session lookup fails', async () => {
    results.selectByTable.sessions = { data: null, error: { code: 'XX000', message: 'db down', details: 'ROWVALUE' } };
    const res = await getMe();
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(INTERNAL);
    expect(profileQueries()).toHaveLength(0);
    expect(logLines.join('')).not.toContain('ROWVALUE');
  });

  it.each([
    ['16 digits', '7656119796028793'],
    ['18 digits', '765611979602879300'],
    ['non-digits', '7656119796028793x'],
  ])('returns a generic 500 when the stored steam_id is %s, and logs no row values', async (_name, steamId) => {
    signedIn({ data: profileRow({ steam_id: steamId, display_name: 'ROWNAME' }), error: null });
    const res = await getMe();
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(INTERNAL);
    expect(res.text).not.toContain(steamId);
    const logs = logLines.join('');
    expect(logs).toContain('profile row does not match the Me schema');
    expect(logs).not.toContain(steamId);
    expect(logs).not.toContain('ROWNAME');
  });

  it('returns a generic 500 when the stored id is not a uuid', async () => {
    signedIn({ data: profileRow({ id: 'not-a-uuid' }), error: null });
    const res = await getMe();
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(INTERNAL);
  });
});
