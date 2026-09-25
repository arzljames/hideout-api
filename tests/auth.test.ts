import type * as PinoModule from 'pino';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callsOf, fakeDb, queries, resetFakeDb, results } from './helpers/fakeDb.js';
import {
  assertionParams,
  AVATAR,
  fetchCallsTo,
  resetFakeSteam,
  steam,
  STEAM_ID,
  STEAM_OP_ENDPOINT,
  steamFetch,
  SUMMARIES_PREFIX,
  summariesResponse,
  urlOf,
} from './helpers/fakeSteam.js';

/*
 * Steam sign-in and logout through the real app (createApp), offline:
 * Steam is faked at fetch, the database at the supabase-js client. Every log line
 * the app writes (LOG_LEVEL=trace) is captured and checked for secrets after each test.
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

// Overrides for this file only: see every log line, and key rate limits by X-Forwarded-For
// so each test gets a fresh limiter bucket.
const savedEnv = { LOG_LEVEL: process.env.LOG_LEVEL, TRUST_PROXY: process.env.TRUST_PROXY };
process.env.LOG_LEVEL = 'trace';
process.env.TRUST_PROXY = '1';

// Realtime broadcasts go to their own mock (the real schema check in broadcast.ts still runs); everything else is Steam.
const BROADCAST_URL = 'http://127.0.0.1:54321/realtime/v1/api/broadcast';
const broadcastFetch = vi.fn<typeof fetch>();
const routedFetch: typeof fetch = (input, init) =>
  urlOf(input) === BROADCAST_URL ? broadcastFetch(input, init) : steamFetch(input, init);
vi.stubGlobal('fetch', routedFetch);

const { createApp } = await import('../src/app.js');
const { hashSessionToken, LOGIN_STATE_COOKIE, newRandomToken, SESSION_COOKIE } = await import(
  '../src/lib/session.js'
);

afterAll(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

const app = createApp();
const API_URL = 'http://localhost:5173';
const WEB_ORIGIN = 'http://localhost:5173';
const STEAM_API_KEY = 'test-steam-api-key';
const PROFILE_ID = '5b0e7c1e-7f4a-4d2e-9a5b-3c1d2e4f6a7b';
const SESSION_ID = '0d7f1c2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5';

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.1.${String(ipCounter >> 8)}.${String(ipCounter & 255)}`;
}

function setCookies(res: request.Response): string[] {
  const header = res.headers['set-cookie'] as string[] | string | undefined;
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

function cookieNamed(res: request.Response, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

function returnToFor(state: string): string {
  return `${API_URL}/api/auth/steam/callback?state=${state}`;
}

interface CallbackOptions {
  /** openid.* params; defaults to a valid assertion for `state`. */
  params?: Record<string, string>;
  /** Raw extra query string appended after the params (for repeated keys). */
  extraQuery?: string;
  /** The state query param; null to omit it. */
  state?: string | null;
  /** The state cookie; null to omit it. */
  cookieState?: string | null;
}

function callback(options: CallbackOptions = {}) {
  const state = options.state === undefined ? newRandomToken() : options.state;
  const cookieState = options.cookieState === undefined ? state : options.cookieState;
  const query = new URLSearchParams();
  if (state !== null) query.set('state', state);
  const params = options.params ?? assertionParams(returnToFor(state ?? ''));
  for (const [key, value] of Object.entries(params)) query.append(key, value);
  const qs = query.toString() + (options.extraQuery ? `&${options.extraQuery}` : '');
  const req = request(app).get(`/api/auth/steam/callback?${qs}`).set('X-Forwarded-For', freshIp());
  return cookieState === null ? req : req.set('Cookie', `${LOGIN_STATE_COOKIE}=${cookieState}`);
}

/** Valid assertion for `state` with some fields replaced. */
function tampered(state: string, overrides: Record<string, string>): CallbackOptions {
  return { state, params: { ...assertionParams(returnToFor(state)), ...overrides } };
}

function expectFailedLogin(res: request.Response, code: string): void {
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=${code}`);
  expect(cookieNamed(res, SESSION_COOKIE)).toBeUndefined();
  const cleared = cookieNamed(res, LOGIN_STATE_COOKIE);
  expect(cleared).toMatch(new RegExp(`^${LOGIN_STATE_COOKIE}=;`));
  expect(cleared).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  expect(cleared).toContain('Path=/');
  expect(fakeDb.rpc).not.toHaveBeenCalled();
}

function rpcArgs(): Record<string, unknown> {
  const call = fakeDb.rpc.mock.calls[0];
  if (!call) throw new Error('create_login_session was not called');
  expect(call[0]).toBe('create_login_session');
  return call[1];
}

function sessionTokenFrom(res: request.Response): string {
  const cookie = cookieNamed(res, SESSION_COOKIE);
  const token = cookie?.slice(SESSION_COOKIE.length + 1).split(';')[0];
  if (!token) throw new Error('no session cookie');
  return token;
}

beforeEach(() => {
  resetFakeDb();
  resetFakeSteam();
  broadcastFetch.mockReset();
  broadcastFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 202 })));
  logLines.length = 0;
});

/** Broadcasts sent to the Realtime REST endpoint, as { topic, event, payload, private }. */
function sentBroadcasts(): unknown[] {
  return broadcastFetch.mock.calls.flatMap(([, init]) => {
    const body = JSON.parse(init?.body as string) as { messages: unknown[] };
    return body.messages;
  });
}

afterEach(() => {
  // Secrets must never reach the logs, whatever the test did.
  const logs = logLines.join('');
  expect(logs).not.toContain(STEAM_API_KEY);
  expect(logs).not.toContain('SIGNATURE-VALUE');
  expect(logs).not.toContain('test-service-role-key');
  expect(logs).not.toContain('test-session-secret');
});

describe('GET /api/auth/steam', () => {
  it('redirects to Steam OpenID with checkid_setup, realm = API_URL and return_to carrying the state', async () => {
    const res = await request(app).get('/api/auth/steam').set('X-Forwarded-For', freshIp());
    expect(res.status).toBe(302);

    const location = new URL(String(res.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(STEAM_OP_ENDPOINT);
    const q = location.searchParams;
    expect(q.get('openid.ns')).toBe('http://specs.openid.net/auth/2.0');
    expect(q.get('openid.mode')).toBe('checkid_setup');
    expect(q.get('openid.realm')).toBe(API_URL);
    expect(q.get('openid.identity')).toBe('http://specs.openid.net/auth/2.0/identifier_select');
    expect(q.get('openid.claimed_id')).toBe('http://specs.openid.net/auth/2.0/identifier_select');

    const returnTo = new URL(String(q.get('openid.return_to')));
    expect(`${returnTo.origin}${returnTo.pathname}`).toBe(`${API_URL}/api/auth/steam/callback`);
    expect([...returnTo.searchParams.keys()]).toEqual(['state']);
    const state = returnTo.searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cookie = cookieNamed(res, LOGIN_STATE_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.split(';')[0]).toBe(`${LOGIN_STATE_COOKIE}=${String(state)}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookieNamed(res, SESSION_COOKIE)).toBeUndefined();
  });

  it('issues a different state on every request', async () => {
    const ip = freshIp();
    const a = await request(app).get('/api/auth/steam').set('X-Forwarded-For', ip);
    const b = await request(app).get('/api/auth/steam').set('X-Forwarded-For', ip);
    expect(cookieNamed(a, LOGIN_STATE_COOKIE)).not.toBe(cookieNamed(b, LOGIN_STATE_COOKIE));
  });

  it('redirects to WEB_ORIGIN/?auth_error=RATE_LIMITED after 10 requests per minute from one IP', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      const ok = await request(app).get('/api/auth/steam').set('X-Forwarded-For', ip);
      expect(ok.status).toBe(302);
    }
    const limited = await request(app).get('/api/auth/steam').set('X-Forwarded-For', ip);
    expect(limited.status).toBe(302);
    expect(limited.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=RATE_LIMITED`);
    expect(cookieNamed(limited, LOGIN_STATE_COOKIE)).toBeUndefined();

    // Other IPs are unaffected.
    const other = await request(app).get('/api/auth/steam').set('X-Forwarded-For', freshIp());
    expect(other.status).toBe(302);
  });

  it('limits the callback in its own bucket, redirecting and clearing the state cookie', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      await request(app).get('/api/auth/steam').set('X-Forwarded-For', ip);
    }
    // Starting sign-in doesn't use up the callback's budget.
    const first = await request(app).get('/api/auth/steam/callback?state=x').set('X-Forwarded-For', ip);
    expect(first.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=LOGIN_STATE_MISMATCH`);
    for (let i = 0; i < 9; i += 1) {
      await request(app).get('/api/auth/steam/callback?state=x').set('X-Forwarded-For', ip);
    }
    const limited = await request(app).get('/api/auth/steam/callback?state=x').set('X-Forwarded-For', ip);
    expect(limited.status).toBe(302);
    expect(limited.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=RATE_LIMITED`);
    expect(String(limited.headers['set-cookie'])).toContain(`${LOGIN_STATE_COOKIE}=;`);
    expect(steamFetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/auth/steam/callback: state binding', () => {
  it('rejects with LOGIN_STATE_MISMATCH when the state query param is missing', async () => {
    const state = newRandomToken();
    const res = await callback({ state: null, cookieState: state, params: assertionParams(returnToFor(state)) });
    expectFailedLogin(res, 'LOGIN_STATE_MISMATCH');
    expect(steamFetch).not.toHaveBeenCalled();
  });

  it('rejects with LOGIN_STATE_MISMATCH when the state cookie is missing (login CSRF)', async () => {
    const res = await callback({ cookieState: null });
    expectFailedLogin(res, 'LOGIN_STATE_MISMATCH');
    expect(steamFetch).not.toHaveBeenCalled();
  });

  it('rejects with LOGIN_STATE_MISMATCH when the state cookie differs from the query', async () => {
    const res = await callback({ cookieState: newRandomToken() });
    expectFailedLogin(res, 'LOGIN_STATE_MISMATCH');
    expect(steamFetch).not.toHaveBeenCalled();
  });

  it('rejects with LOGIN_STATE_MISMATCH when state is repeated in the query', async () => {
    const state = newRandomToken();
    const res = await callback({ state, extraQuery: `state=${state}` });
    expectFailedLogin(res, 'LOGIN_STATE_MISMATCH');
  });
});

describe('GET /api/auth/steam/callback: tampered assertions', () => {
  const state = newRandomToken();
  const cases: [string, CallbackOptions][] = [
    ['openid.mode is not id_res', tampered(state, { 'openid.mode': 'cancel' })],
    ['openid.mode is missing', { state, params: withoutKey(assertionParams(returnToFor(state)), 'openid.mode') }],
    ['return_to carries a different state', tampered(state, { 'openid.return_to': returnToFor(newRandomToken()) })],
    ['return_to has an extra param', tampered(state, { 'openid.return_to': `${returnToFor(state)}&next=/admin` })],
    [
      'return_to points at another host',
      tampered(state, { 'openid.return_to': `https://evil.example/api/auth/steam/callback?state=${state}` }),
    ],
    ['return_to uses another path', tampered(state, { 'openid.return_to': `${API_URL}/api/auth/other?state=${state}` })],
    ['op_endpoint is not Steam', tampered(state, { 'openid.op_endpoint': 'https://evil.example/openid/login' })],
    [
      'op_endpoint is Steam over http',
      tampered(state, { 'openid.op_endpoint': 'http://steamcommunity.com/openid/login' }),
    ],
    [
      'claimed_id has 16 digits',
      tampered(state, {
        'openid.claimed_id': 'https://steamcommunity.com/openid/id/7656119796028793',
        'openid.identity': 'https://steamcommunity.com/openid/id/7656119796028793',
      }),
    ],
    [
      'claimed_id has a trailing path',
      tampered(state, {
        'openid.claimed_id': `https://steamcommunity.com/openid/id/${STEAM_ID}/x`,
        'openid.identity': `https://steamcommunity.com/openid/id/${STEAM_ID}/x`,
      }),
    ],
    [
      'claimed_id is on another host',
      tampered(state, {
        'openid.claimed_id': `https://evil.example/openid/id/${STEAM_ID}`,
        'openid.identity': `https://evil.example/openid/id/${STEAM_ID}`,
      }),
    ],
    [
      'identity differs from claimed_id',
      tampered(state, { 'openid.identity': 'https://steamcommunity.com/openid/id/76561197960287931' }),
    ],
    ['an openid param is repeated', { state, extraQuery: 'openid.claimed_id=x' }],
  ];

  it.each(cases)('rejects with STEAM_LOGIN_FAILED when %s, without asking Steam', async (_name, options) => {
    const res = await callback(options);
    expectFailedLogin(res, 'STEAM_LOGIN_FAILED');
    expect(steamFetch).not.toHaveBeenCalled();
  });

  it('rejects with STEAM_LOGIN_FAILED when check_authentication says is_valid:false', async () => {
    steam.checkAuth = () => Promise.resolve(new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:false\n'));
    const res = await callback();
    expectFailedLogin(res, 'STEAM_LOGIN_FAILED');
    expect(fetchCallsTo(STEAM_OP_ENDPOINT)).toHaveLength(1);
    expect(fetchCallsTo(SUMMARIES_PREFIX)).toHaveLength(0);
  });

  it('rejects with STEAM_LOGIN_FAILED when check_authentication has no is_valid line', async () => {
    steam.checkAuth = () => Promise.resolve(new Response('<html>is_valid:true</html>'));
    const res = await callback();
    expectFailedLogin(res, 'STEAM_LOGIN_FAILED');
  });
});

describe('GET /api/auth/steam/callback: Steam or database unavailable', () => {
  it('redirects with STEAM_UNAVAILABLE when check_authentication returns non-2xx', async () => {
    steam.checkAuth = () => Promise.resolve(new Response('busy', { status: 503 }));
    expectFailedLogin(await callback(), 'STEAM_UNAVAILABLE');
  });

  it('redirects with STEAM_UNAVAILABLE on a network error', async () => {
    steam.checkAuth = () => Promise.reject(new TypeError('fetch failed'));
    expectFailedLogin(await callback(), 'STEAM_UNAVAILABLE');
  });

  it('redirects with STEAM_UNAVAILABLE when check_authentication times out (and sets a timeout signal)', async () => {
    let signal: AbortSignal | null | undefined;
    steam.checkAuth = (init) => {
      signal = init?.signal;
      return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    };
    expectFailedLogin(await callback(), 'STEAM_UNAVAILABLE');
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('redirects with LOGIN_FAILED (not a Steam error) and logs only code/message when create_login_session fails', async () => {
    results.rpc = { data: null, error: { code: '23505', message: 'boom', details: 'Key (steam_id)=(ROWVALUE)' } };
    const res = await callback();
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=LOGIN_FAILED`);
    expect(cookieNamed(res, SESSION_COOKIE)).toBeUndefined();
    expect(fakeDb.rpc).toHaveBeenCalledOnce();
    const logs = logLines.join('');
    expect(logs).toContain('create_login_session failed: boom');
    expect(logs).not.toContain('ROWVALUE');
  });
});

describe('GET /api/auth/steam/callback: success', () => {
  it('verifies with Steam, creates a session and redirects to WEB_ORIGIN/', async () => {
    const state = newRandomToken();
    const params = assertionParams(returnToFor(state));
    const before = Date.now();
    const res = await callback({ state, params });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/`);

    // check_authentication: POSTed to the op_endpoint with every openid.* param, mode swapped.
    const checks = fetchCallsTo(STEAM_OP_ENDPOINT);
    expect(checks).toHaveLength(1);
    const init = checks[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const sent = Object.fromEntries(new URLSearchParams(init?.body as URLSearchParams));
    expect(sent).toEqual({ ...params, 'openid.mode': 'check_authentication' });
    expect(sent).not.toHaveProperty('state');

    // GetPlayerSummaries for the verified id.
    const summaries = fetchCallsTo(SUMMARIES_PREFIX);
    expect(summaries).toHaveLength(1);
    expect(new URL(summaries[0]?.[0] ?? '').searchParams.get('steamids')).toBe(STEAM_ID);

    // Session cookie: httpOnly, Lax, Path=/, 7 days, host-only.
    const cookie = cookieNamed(res, SESSION_COOKIE);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=604800');
    expect(cookie).not.toMatch(/Domain=/i);
    const token = sessionTokenFrom(res);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // State cookie is cleared on success too.
    expect(cookieNamed(res, LOGIN_STATE_COOKIE)).toMatch(new RegExp(`^${LOGIN_STATE_COOKIE}=;`));

    // Database: only the HMAC of the token is stored.
    expect(fakeDb.rpc).toHaveBeenCalledOnce();
    const args = rpcArgs();
    expect(args).toMatchObject({
      p_steam_id: STEAM_ID,
      p_display_name: 'Gordon',
      p_avatar_url: AVATAR,
      p_keep_existing_profile: false,
    });
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_token_hash).toBe(hashSessionToken(token));
    expect(JSON.stringify(args)).not.toContain(token);
    const expiresAt = Date.parse(String(args.p_expires_at));
    expect(expiresAt).toBeGreaterThanOrEqual(before + 604_800_000 - 1_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 604_800_000 + 1_000);
  });

  it('accepts a CRLF check_authentication response', async () => {
    steam.checkAuth = () => Promise.resolve(new Response('ns:http://specs.openid.net/auth/2.0\r\nis_valid:true\r\n'));
    const res = await callback();
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/`);
    expect(cookieNamed(res, SESSION_COOKIE)).toBeDefined();
  });

  it('never puts the Steam API key or the session token in the response', async () => {
    const res = await callback();
    const token = sessionTokenFrom(res);
    const visible = JSON.stringify({ location: res.headers.location, body: res.text });
    expect(visible).not.toContain(STEAM_API_KEY);
    expect(visible).not.toContain(token);
    // Token must not be logged either (set-cookie is redacted).
    expect(logLines.join('')).not.toContain(token);
    // The key is only ever sent to the Steam Web API.
    expect(fetchCallsTo(SUMMARIES_PREFIX)[0]?.[0]).toContain(`key=${STEAM_API_KEY}`);
    expect(JSON.stringify(fetchCallsTo(STEAM_OP_ENDPOINT))).not.toContain(STEAM_API_KEY);
  });
});

describe('GET /api/auth/steam/callback: Steam profile fallbacks', () => {
  const fallback = { p_display_name: 'Steam user 7930', p_avatar_url: null, p_keep_existing_profile: true };

  it.each<[string, () => Promise<Response>]>([
    ['returns non-2xx', () => Promise.resolve(new Response('nope', { status: 500 }))],
    ['returns invalid JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['returns JSON of the wrong shape', () => Promise.resolve(Response.json({ players: [] }))],
    ['returns no players', () => Promise.resolve(summariesResponse([]))],
    ['returns only another player', () => Promise.resolve(summariesResponse([{ steamid: '76561197960287931' }]))],
    ['fails with a network error that echoes the URL', () =>
      Promise.reject(new TypeError(`fetch failed: ${SUMMARIES_PREFIX}?key=${STEAM_API_KEY}`))],
  ])('still signs in with a fallback name and keeps the stored profile when GetPlayerSummaries %s', async (_n, fn) => {
    steam.summaries = fn;
    const res = await callback();
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/`);
    expect(cookieNamed(res, SESSION_COOKIE)).toBeDefined();
    expect(rpcArgs()).toMatchObject({ p_steam_id: STEAM_ID, ...fallback });
    expect(JSON.stringify(res.headers)).not.toContain(STEAM_API_KEY);
  });

  it('stores a null avatar when Steam sends a non-https avatar URL', async () => {
    steam.summaries = () =>
      Promise.resolve(summariesResponse([{ steamid: STEAM_ID, personaname: 'G', avatarfull: 'http://x/a.jpg' }]));
    await callback();
    expect(rpcArgs()).toMatchObject({ p_display_name: 'G', p_avatar_url: null, p_keep_existing_profile: false });
  });

  it('stores a null avatar for javascript: URLs', async () => {
    steam.summaries = () =>
      Promise.resolve(summariesResponse([{ steamid: STEAM_ID, personaname: 'G', avatarfull: 'javascript:alert(1)' }]));
    await callback();
    expect(rpcArgs()).toMatchObject({ p_avatar_url: null });
  });

  it('strips control characters (e.g. NUL) from Steam names', async () => {
    steam.summaries = () =>
      Promise.resolve(summariesResponse([{ steamid: STEAM_ID, personaname: 'Gor\u0000don\u0007' }]));
    await callback();
    expect(rpcArgs()).toMatchObject({ p_display_name: 'Gordon' });
  });

  it('ends the session this browser already had when signing in again', async () => {
    const oldToken = newRandomToken();
    results.rpc = { data: PROFILE_ID, error: null };
    results.lookup = { data: { id: SESSION_ID, profile_id: PROFILE_ID }, error: null };
    const state = newRandomToken();
    const res = await callback({ state, cookieState: null }).set('Cookie', [
      `${LOGIN_STATE_COOKIE}=${state}`,
      `${SESSION_COOKIE}=${oldToken}`,
    ]);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/`);
    const deletes = queries.filter((q) => q.calls[0]?.[0] === 'delete');
    expect(deletes).toEqual([{ table: 'sessions', calls: [['delete', []], ['eq', ['id', SESSION_ID]]] }]);
  });

  it('still signs in (and logs a warning) when ending the previous session fails', async () => {
    results.rpc = { data: PROFILE_ID, error: null };
    results.lookup = { data: null, error: { code: 'XX000', message: 'db down' } };
    const state = newRandomToken();
    const res = await callback({ state, cookieState: null }).set('Cookie', [
      `${LOGIN_STATE_COOKIE}=${state}`,
      `${SESSION_COOKIE}=${newRandomToken()}`,
    ]);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/`);
    expect(cookieNamed(res, SESSION_COOKIE)).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(logLines.join('')).toContain('could not end previous session');
  });

  it('truncates long names to 64 characters (code points, not UTF-16 units)', async () => {
    const name = '\u{1F600}'.repeat(70);
    steam.summaries = () => Promise.resolve(summariesResponse([{ steamid: STEAM_ID, personaname: name }]));
    await callback();
    const stored = String(rpcArgs().p_display_name);
    expect(Array.from(stored)).toHaveLength(64);
    expect(stored).toBe('\u{1F600}'.repeat(64));
    expect(rpcArgs()).toMatchObject({ p_avatar_url: null, p_keep_existing_profile: false });
  });

  it('uses the fallback name (but a fresh profile) when the Steam name is blank', async () => {
    steam.summaries = () =>
      Promise.resolve(summariesResponse([{ steamid: STEAM_ID, personaname: '   ', avatarfull: AVATAR }]));
    await callback();
    expect(rpcArgs()).toMatchObject({ p_display_name: 'Steam user 7930', p_avatar_url: AVATAR });
  });
});

describe('POST /api/auth/logout and /logout-all', () => {
  const TOKEN = newRandomToken();

  function post(path: string, headers: Record<string, string> = {}) {
    const req = request(app).post(path);
    for (const [key, value] of Object.entries(headers)) req.set(key, value);
    return req;
  }

  const good = {
    Origin: WEB_ORIGIN,
    'Content-Type': 'application/json',
    Cookie: `${SESSION_COOKIE}=${TOKEN}`,
  };

  function liveSession(): void {
    results.lookup = { data: { id: SESSION_ID, profile_id: PROFILE_ID }, error: null };
  }

  function deletes() {
    return queries.filter((q) => q.calls[0]?.[0] === 'delete');
  }

  for (const path of ['/api/auth/logout', '/api/auth/logout-all']) {
    describe(path, () => {
      it('returns 401 without a session cookie', async () => {
        const { Cookie: _omit, ...noCookie } = good;
        const res = await post(path, noCookie);
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: expect.any(String) } });
        expect(deletes()).toHaveLength(0);
      });

      it('returns 401 for an unknown or expired session', async () => {
        results.lookup = { data: null, error: null };
        const res = await post(path, good);
        expect(res.status).toBe(401);
        expect(deletes()).toHaveLength(0);
      });

      it('returns 403 ORIGIN_NOT_ALLOWED with a live session but a foreign Origin', async () => {
        liveSession();
        const res = await post(path, { ...good, Origin: 'https://evil.example' });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
        expect(fakeDb.from).not.toHaveBeenCalled();
      });

      it('returns 403 ORIGIN_NOT_ALLOWED with a live session but no Origin', async () => {
        liveSession();
        const { Origin: _omit, ...noOrigin } = good;
        const res = await post(path, noOrigin);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
        expect(fakeDb.from).not.toHaveBeenCalled();
      });

      it('returns 403 UNSUPPORTED_CONTENT_TYPE with a live session but a form content type', async () => {
        liveSession();
        const res = await post(path, { ...good, 'Content-Type': 'application/x-www-form-urlencoded' });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('UNSUPPORTED_CONTENT_TYPE');
        expect(fakeDb.from).not.toHaveBeenCalled();
      });

      it('returns 403 UNSUPPORTED_CONTENT_TYPE with a live session but no content type', async () => {
        liveSession();
        const { 'Content-Type': _omit, ...noType } = good;
        const res = await post(path, noType);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('UNSUPPORTED_CONTENT_TYPE');
      });

      it('returns 500 without details when the session delete fails', async () => {
        liveSession();
        results.delete = { error: { code: 'XX000', message: 'db down', details: 'ROWVALUE' } };
        const res = await post(path, good);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
        expect(logLines.join('')).not.toContain('ROWVALUE');
      });
    });
  }

  it('logout looks up the session by token hash and deletes only that session', async () => {
    liveSession();
    const res = await post('/api/auth/logout', good);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    const lookup = callsOf(0);
    expect(lookup?.table).toBe('sessions');
    expect(lookup?.calls).toContainEqual(['eq', ['token_hash', hashSessionToken(TOKEN)]]);

    expect(deletes()).toEqual([{ table: 'sessions', calls: [['delete', []], ['eq', ['id', SESSION_ID]]] }]);

    const cleared = cookieNamed(res, SESSION_COOKIE);
    expect(cleared).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(cleared).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(cleared).toContain('Path=/');
    expect(logLines.join('')).not.toContain(TOKEN);
  });

  it('logout-all deletes every session of the profile', async () => {
    liveSession();
    const res = await post('/api/auth/logout-all', good);
    expect(res.status).toBe(204);
    expect(deletes()).toEqual([{ table: 'sessions', calls: [['delete', []], ['eq', ['profile_id', PROFILE_ID]]] }]);
    expect(cookieNamed(res, SESSION_COOKIE)).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
  });

  it('logout-all broadcasts exactly one session:expired to user:<id> after the delete', async () => {
    liveSession();
    const res = await post('/api/auth/logout-all', good);
    expect(res.status).toBe(204);
    expect(sentBroadcasts()).toEqual([
      { topic: `user:${PROFILE_ID}`, event: 'session:expired', payload: {}, private: true },
    ]);
    const deleteAt = fakeDb.from.mock.invocationCallOrder.at(-1) ?? Infinity;
    expect(broadcastFetch.mock.invocationCallOrder[0]).toBeGreaterThan(deleteAt);
  });

  it('logout-all broadcasts nothing when the delete fails', async () => {
    liveSession();
    results.delete = { error: { code: 'XX000', message: 'db down' } };
    const res = await post('/api/auth/logout-all', good);
    expect(res.status).toBe(500);
    expect(broadcastFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['rejects', () => Promise.resolve(new Response(null, { status: 500 }))],
    ['throws', () => Promise.reject(new Error('realtime down'))],
  ])('logout-all still returns 204 and clears the cookie when the broadcast %s', async (_name, impl) => {
    liveSession();
    broadcastFetch.mockImplementation(impl);
    const res = await post('/api/auth/logout-all', good);
    expect(res.status).toBe(204);
    expect(deletes()).toHaveLength(1);
    expect(broadcastFetch).toHaveBeenCalledTimes(1);
    expect(cookieNamed(res, SESSION_COOKIE)).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
  });

  it('logout (this device only) never broadcasts', async () => {
    liveSession();
    const res = await post('/api/auth/logout', good);
    expect(res.status).toBe(204);
    expect(broadcastFetch).not.toHaveBeenCalled();
  });
});

function withoutKey(params: Record<string, string>, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(params).filter(([k]) => k !== key));
}
