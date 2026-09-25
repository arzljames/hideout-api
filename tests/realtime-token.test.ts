import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import type * as PinoModule from 'pino';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TokenModule from '../src/realtime/token.js';
import { fakeDb, resetFakeDb, results, type RecordedQuery } from './helpers/fakeDb.js';
import { TEST_JWT_KID, TEST_JWT_PRIVATE_JWK } from './helpers/jwtKey.js';

/*
 * GET /api/auth/realtime-token through the real app (createApp), offline: the database is
 * faked at the supabase-js client, and mintRealtimeToken is wrapped in a spy (real
 * implementation) so tests can assert when no token was minted. Every log line
 * (LOG_LEVEL=trace) is captured and checked for secrets.
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
vi.mock('../src/realtime/token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TokenModule>();
  return { ...actual, mintRealtimeToken: vi.fn(actual.mintRealtimeToken) };
});

const savedEnv = { LOG_LEVEL: process.env.LOG_LEVEL };
process.env.LOG_LEVEL = 'trace';

const { createApp } = await import('../src/app.js');
const { hashSessionToken, newRandomToken, SESSION_COOKIE } = await import('../src/lib/session.js');
const { RealtimeToken } = await import('../src/contracts/http/auth.js');
const { mintRealtimeToken } = await import('../src/realtime/token.js');
const mintSpy = vi.mocked(mintRealtimeToken);

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

const app = createApp();
const PATH = '/api/auth/realtime-token';
const WEB_ORIGIN = 'http://localhost:5173';
const SERVICE_ROLE_KEY = 'test-service-role-key';

// What Supabase holds after the import: only the public half of the signing key.
const privateJwk = JSON.parse(TEST_JWT_PRIVATE_JWK) as Record<string, string>;
const { d: JWK_D, ...publicJwk } = privateJwk;
const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' });

const UNAUTHENTICATED = { error: { code: 'UNAUTHENTICATED', message: 'You need to sign in.' } };
const RATE_LIMITED = { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' } };
const INTERNAL = { error: { code: 'INTERNAL', message: 'Something went wrong.' } };

/** token_hash -> session row; the fake sessions table answers only for live sessions in here. */
const liveSessions = new Map<string, { id: string; profile_id: string }>();

function sessionLookup(query: RecordedQuery) {
  const eq = query.calls.find(([m, args]) => m === 'eq' && args[0] === 'token_hash');
  const row = eq ? liveSessions.get(eq[1][1] as string) : undefined;
  return { data: row ?? null, error: null };
}

/** A new signed-in user with a fresh profile id (so rate-limit buckets never collide across tests). */
function newUser(): { profileId: string; cookieToken: string } {
  const profileId = randomUUID();
  const cookieToken = newRandomToken();
  liveSessions.set(hashSessionToken(cookieToken), { id: randomUUID(), profile_id: profileId });
  return { profileId, cookieToken };
}

function getToken(cookieToken: string | null) {
  const req = request(app).get(PATH);
  return cookieToken === null ? req : req.set('Cookie', `${SESSION_COOKIE}=${cookieToken}`);
}

function verifyWithPublicKey(token: string, options: Omit<jwt.VerifyOptions, 'complete' | 'algorithms'> = {}): jwt.Jwt {
  return jwt.verify(token, publicKey, { ...options, algorithms: ['ES256'], complete: true });
}

/** Tokens returned in this test, checked against the logs in afterEach. */
const mintedTokens: string[] = [];

beforeEach(() => {
  resetFakeDb();
  liveSessions.clear();
  results.selectByTable.sessions = sessionLookup;
  logLines.length = 0;
  mintedTokens.length = 0;
  mintSpy.mockClear();
});

afterEach(() => {
  const logs = logLines.join('');
  expect(logs).not.toContain(SERVICE_ROLE_KEY);
  expect(logs).not.toContain('test-session-secret');
  expect(logs).not.toContain(JWK_D);
  for (const token of mintedTokens) {
    expect(logs).not.toContain(token);
    // The signature alone is enough to reuse a token; make sure no fragment leaks either.
    expect(logs).not.toContain(token.split('.')[2]);
  }
});

describe('GET /api/auth/realtime-token: access control', () => {
  it('returns 401 without a session cookie, queries nothing, and mints no token', async () => {
    const res = await getToken(null);
    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(UNAUTHENTICATED);
    expect(fakeDb.from).not.toHaveBeenCalled();
    expect(mintSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', 'abc'],
    ['44 characters', 'A'.repeat(44)],
    ['non-base64url characters', `${'A'.repeat(42)}!`],
  ])('returns 401 for a malformed cookie (%s) and mints no token', async (_name, token) => {
    const res = await getToken(token);
    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(UNAUTHENTICATED);
    expect(fakeDb.from).not.toHaveBeenCalled();
    expect(mintSpy).not.toHaveBeenCalled();
  });

  it('returns 401 for an unknown or expired session (lookup finds nothing) and mints no token', async () => {
    newUser(); // someone else is signed in; this cookie is not theirs
    const cookieToken = newRandomToken();
    const res = await getToken(cookieToken);
    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(UNAUTHENTICATED);
    expect(res.text).not.toMatch(/eyJ/); // no JWT anywhere in the body
    expect(mintSpy).not.toHaveBeenCalled();
  });

  it('only accepts sessions that have not expired (the lookup filters on expires_at)', async () => {
    let captured: RecordedQuery | undefined;
    results.selectByTable.sessions = (query) => {
      captured = query;
      return sessionLookup(query);
    };
    const { cookieToken } = newUser();
    const res = await getToken(cookieToken);
    expect(res.status).toBe(200);
    expect(captured?.calls).toContainEqual(['eq', ['token_hash', hashSessionToken(cookieToken)]]);
    const gt = captured?.calls.find(([m]) => m === 'gt');
    expect(gt?.[1][0]).toBe('expires_at');
    expect(Math.abs(new Date(gt?.[1][1] as string).getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('returns a generic 500 and mints no token when the session lookup fails', async () => {
    results.selectByTable.sessions = { data: null, error: { code: 'XX000', message: 'db down', details: 'ROWVALUE' } };
    const res = await getToken(newRandomToken());
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(INTERNAL);
    expect(mintSpy).not.toHaveBeenCalled();
    expect(logLines.join('')).not.toContain('ROWVALUE');
  });
});

describe('GET /api/auth/realtime-token: success', () => {
  it('returns exactly { token, expiresAt }, matching RealtimeToken, with Cache-Control: no-store', async () => {
    const { cookieToken } = newUser();
    const res = await getToken(cookieToken);
    mintedTokens.push(res.body.token as string);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body as object).sort()).toEqual(['expiresAt', 'token']);
    expect(RealtimeToken.strict().parse(res.body)).toStrictEqual(res.body);
    expect(mintSpy).toHaveBeenCalledTimes(1);
    // The session cookie never comes back in the body.
    expect(res.text).not.toContain(cookieToken);
  });

  it('signs an ES256 JWT with the configured kid and exactly the expected claims for the session profile', async () => {
    const { profileId, cookieToken } = newUser();
    const before = Math.floor(Date.now() / 1000);
    const res = await getToken(cookieToken);
    const after = Math.floor(Date.now() / 1000);
    const body = RealtimeToken.parse(res.body);
    mintedTokens.push(body.token);

    const decoded = verifyWithPublicKey(body.token, { audience: 'authenticated', issuer: 'hideout-api' });
    expect(decoded.header).toStrictEqual({ alg: 'ES256', kid: TEST_JWT_KID, typ: 'JWT' });
    const claims = decoded.payload as jwt.JwtPayload;
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'role', 'sub']);
    expect(claims).toMatchObject({ iss: 'hideout-api', sub: profileId, role: 'authenticated', aud: 'authenticated' });
    const iat = claims.iat ?? 0;
    const exp = claims.exp ?? 0;
    expect(iat).toBeGreaterThanOrEqual(before);
    expect(iat).toBeLessThanOrEqual(after);
    expect(exp - iat).toBe(900);
    expect(body.expiresAt).toBe(new Date(exp * 1000).toISOString());
  });

  it('mints a token that fails verification with a different P-256 key', async () => {
    const { cookieToken } = newUser();
    const { token } = RealtimeToken.parse((await getToken(cookieToken)).body);
    mintedTokens.push(token);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey;
    expect(() => jwt.verify(token, other, { algorithms: ['ES256'] })).toThrow(/invalid signature/);
  });

  it('mints a token that is rejected when the verifier allows only HS256 or none', async () => {
    const { cookieToken } = newUser();
    const { token } = RealtimeToken.parse((await getToken(cookieToken)).body);
    mintedTokens.push(token);
    const publicPem = publicKey.export({ format: 'pem', type: 'spki' });
    // Classic key confusion: the public key used as an HMAC secret.
    expect(() => jwt.verify(token, publicPem, { algorithms: ['HS256'] })).toThrow();
    expect(() => jwt.verify(token, 'any-shared-secret', { algorithms: ['HS256'] })).toThrow();
    expect(() => jwt.verify(token, '', { algorithms: ['none'] })).toThrow();
    // Stripping the signature and claiming alg none must not verify with the real key either.
    const [, payload] = token.split('.');
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`;
    expect(() => verifyWithPublicKey(unsigned)).toThrow();
  });

  it('mints a token that is rejected after it expires', async () => {
    const { cookieToken } = newUser();
    const { token } = RealtimeToken.parse((await getToken(cookieToken)).body);
    mintedTokens.push(token);
    const { exp } = jwt.decode(token) as jwt.JwtPayload;
    expect(() => verifyWithPublicKey(token, { clockTimestamp: (exp ?? 0) - 1 })).not.toThrow();
    expect(() => verifyWithPublicKey(token, { clockTimestamp: exp ?? 0 })).toThrow(/expired/);
  });

  it('gives each user a token for their own profile id', async () => {
    const alice = newUser();
    const bob = newUser();
    const a = RealtimeToken.parse((await getToken(alice.cookieToken)).body);
    const b = RealtimeToken.parse((await getToken(bob.cookieToken)).body);
    mintedTokens.push(a.token, b.token);
    expect((verifyWithPublicKey(a.token).payload as jwt.JwtPayload).sub).toBe(alice.profileId);
    expect((verifyWithPublicKey(b.token).payload as jwt.JwtPayload).sub).toBe(bob.profileId);
  });
});

describe('GET /api/auth/realtime-token: sub comes only from the session', () => {
  it.each([
    ['?sub=', (victim: string) => `${PATH}?sub=${victim}`],
    ['?profileId=', (victim: string) => `${PATH}?profileId=${victim}`],
    ['?sub[]= and ?user_id=', (victim: string) => `${PATH}?sub[]=${victim}&user_id=${victim}&role=service_role`],
  ])('ignores %s query params', async (_name, url) => {
    const { profileId, cookieToken } = newUser();
    const victim = randomUUID();
    const res = await request(app).get(url(victim)).set('Cookie', `${SESSION_COOKIE}=${cookieToken}`);
    const { token } = RealtimeToken.parse(res.body);
    mintedTokens.push(token);
    const claims = verifyWithPublicKey(token).payload as jwt.JwtPayload;
    expect(claims.sub).toBe(profileId);
    expect(claims.role).toBe('authenticated');
    expect(token).not.toContain(Buffer.from(victim).toString('base64url'));
  });

  it('ignores identity-looking headers and a JSON body', async () => {
    const { profileId, cookieToken } = newUser();
    const victim = randomUUID();
    const res = await request(app)
      .get(PATH)
      .set('Cookie', `${SESSION_COOKIE}=${cookieToken}`)
      .set('X-Profile-Id', victim)
      .set('X-User-Id', victim)
      .set('Authorization', `Bearer ${jwt.sign({ sub: victim }, 'x')}`)
      .set('Content-Type', 'application/json')
      .send({ sub: victim, profileId: victim, role: 'service_role', iss: 'evil', exp: 9_999_999_999 });
    expect(res.status).toBe(200);
    const { token } = RealtimeToken.parse(res.body);
    mintedTokens.push(token);
    const claims = verifyWithPublicKey(token, { issuer: 'hideout-api' }).payload as jwt.JwtPayload;
    expect(claims.sub).toBe(profileId);
    expect(claims.role).toBe('authenticated');
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(900);
    expect(mintSpy).toHaveBeenCalledWith(profileId);
  });
});

describe('GET /api/auth/realtime-token: rate limit (30/hour/user)', () => {
  it('returns 429 RATE_LIMITED on the 31st request in the hour, and mints no token for it', async () => {
    const { cookieToken } = newUser();
    for (let i = 0; i < 30; i += 1) {
      const res = await getToken(cookieToken);
      expect(res.status).toBe(200);
      mintedTokens.push(res.body.token as string);
    }
    mintSpy.mockClear();
    const res = await getToken(cookieToken);
    expect(res.status).toBe(429);
    expect(res.body).toStrictEqual(RATE_LIMITED);
    expect(mintSpy).not.toHaveBeenCalled();
    expect(res.text).not.toMatch(/eyJ/);
  });

  it('keys the limit by user, so a second session of the same user shares the bucket', async () => {
    const { profileId, cookieToken } = newUser();
    const secondCookie = newRandomToken();
    liveSessions.set(hashSessionToken(secondCookie), { id: randomUUID(), profile_id: profileId });
    for (let i = 0; i < 30; i += 1) {
      const res = await getToken(i % 2 === 0 ? cookieToken : secondCookie);
      expect(res.status).toBe(200);
      mintedTokens.push(res.body.token as string);
    }
    expect((await getToken(secondCookie)).status).toBe(429);
  });

  it('does not limit another user when one user is limited', async () => {
    const limited = newUser();
    for (let i = 0; i < 30; i += 1) mintedTokens.push((await getToken(limited.cookieToken)).body.token as string);
    expect((await getToken(limited.cookieToken)).status).toBe(429);

    const other = newUser();
    const res = await getToken(other.cookieToken);
    expect(res.status).toBe(200);
    const { token } = RealtimeToken.parse(res.body);
    mintedTokens.push(token);
    expect((verifyWithPublicKey(token).payload as jwt.JwtPayload).sub).toBe(other.profileId);
  });

  it('does not count 401 requests against anyone (the limiter runs after requireAuth)', async () => {
    for (let i = 0; i < 40; i += 1) {
      const res = await getToken(i % 2 === 0 ? null : newRandomToken());
      expect(res.status).toBe(401);
    }
    const { cookieToken } = newUser();
    for (let i = 0; i < 30; i += 1) {
      const res = await getToken(cookieToken);
      expect(res.status).toBe(200);
      mintedTokens.push(res.body.token as string);
    }
  });
});

describe('GET /api/auth/realtime-token: CORS', () => {
  it('does not grant a foreign Origin access to the response', async () => {
    const { cookieToken } = newUser();
    const res = await getToken(cookieToken).set('Origin', 'https://evil.example');
    mintedTokens.push(res.body.token as string);
    // cors pins Allow-Origin to WEB_ORIGIN, so a browser on the foreign origin can't read the token.
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('does not answer a foreign-origin preflight with that origin', async () => {
    const res = await request(app)
      .options(PATH)
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('allows WEB_ORIGIN with credentials', async () => {
    const { cookieToken } = newUser();
    const res = await getToken(cookieToken).set('Origin', WEB_ORIGIN);
    mintedTokens.push(res.body.token as string);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('GET /api/auth/realtime-token: secrets', () => {
  it('never logs the minted token, the signing key, the session cookie, or the service role key', async () => {
    const { cookieToken } = newUser();
    const res = await getToken(cookieToken).set('Origin', WEB_ORIGIN);
    expect(res.status).toBe(200);
    mintedTokens.push(res.body.token as string);
    const logs = logLines.join('');
    expect(logs).toContain('/api/auth/realtime-token'); // the request was logged at all
    expect(logs).not.toContain(cookieToken);
    expect(logs).not.toContain(hashSessionToken(cookieToken));
    expect(logs).not.toContain(JWK_D);
    expect(logs).not.toContain(SERVICE_ROLE_KEY);
    // afterEach also checks the token itself.
  });

  it('returns a generic 500 when signing throws, without the error details in the body', async () => {
    const { cookieToken } = newUser();
    mintSpy.mockImplementationOnce(() => {
      throw new Error('SIGNER-INTERNAL-DETAIL');
    });
    const res = await getToken(cookieToken);
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(INTERNAL);
    expect(res.text).not.toContain('SIGNER-INTERNAL-DETAIL');
  });
});

describe('GET /api/auth/realtime-token: contract', () => {
  it('is in contract/openapi.json with 200, 401, 429, and 500 responses', () => {
    const spec = JSON.parse(readFileSync(new URL('../contract/openapi.json', import.meta.url), 'utf8')) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown>; security?: unknown[] }>>;
    };
    const op = spec.paths[PATH]?.get;
    expect(op).toBeDefined();
    expect(Object.keys(op?.responses ?? {}).sort()).toEqual(['200', '401', '429', '500']);
    // Not public: it inherits the session cookie scheme.
    expect(op?.security).toBeUndefined();
  });
});
