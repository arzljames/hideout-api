import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callsOf, fakeDb, resetFakeDb, results } from './helpers/fakeDb.js';
import {
  assertionParams,
  resetFakeSteam,
  steam,
  STEAM_ID,
  steamFetch,
  summariesResponse,
} from './helpers/fakeSteam.js';

vi.mock('../src/db/client.js', async () => ({ db: (await import('./helpers/fakeDb.js')).fakeDb }));
vi.stubGlobal('fetch', steamFetch);

const session = await import('../src/lib/session.js');
const auth = await import('../src/services/auth.js');
const steamLib = await import('../src/lib/steam.js');
const { InternalError } = await import('../src/errors.js');

const SECRET = 'test-session-secret-at-least-32-characters';

beforeEach(() => {
  resetFakeDb();
  resetFakeSteam();
});

describe('session helpers', () => {
  it('hashSessionToken is HMAC-SHA256 keyed with SESSION_SECRET, not a plain SHA-256', () => {
    const token = session.newSessionToken();
    const hash = session.hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHmac('sha256', SECRET).update(token).digest('hex'));
    expect(hash).not.toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).not.toBe(createHmac('sha256', 'another-session-secret-of-32-chars!!').update(token).digest('hex'));
  });

  it('hashSessionToken changes when SESSION_SECRET changes', async () => {
    const token = session.newSessionToken();
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'a-completely-different-secret-of-32+';
    try {
      vi.resetModules();
      const reloaded = await import('../src/lib/session.js');
      expect(reloaded.hashSessionToken(token)).not.toBe(session.hashSessionToken(token));
    } finally {
      process.env.SESSION_SECRET = saved;
      vi.resetModules();
    }
  });

  it('newSessionToken returns distinct 43-char base64url tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => session.newSessionToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(session.TOKEN_PATTERN);
  });

  it('safeEqual compares exactly, including different lengths', () => {
    expect(session.safeEqual('abc', 'abc')).toBe(true);
    expect(session.safeEqual('abc', 'abd')).toBe(false);
    expect(session.safeEqual('abc', 'abcd')).toBe(false);
    expect(session.safeEqual('', 'a')).toBe(false);
  });
});

describe('findSession', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['42 chars', 'a'.repeat(42)],
    ['44 chars', 'a'.repeat(44)],
    ['padding', `${'a'.repeat(42)}=`],
    ['non-base64url chars', `${'a'.repeat(42)}.`],
    ['a SQL-ish string', `' or 1=1 --${'a'.repeat(32)}`],
  ])('returns null for a malformed token (%s) without querying the database', async (_name, token) => {
    await expect(auth.findSession(token)).resolves.toBeNull();
    expect(fakeDb.from).not.toHaveBeenCalled();
  });

  it('looks up an unexpired session by token hash', async () => {
    results.lookup = { data: { id: 'sid', profile_id: 'pid' }, error: null };
    const token = session.newSessionToken();
    const before = Date.now();
    await expect(auth.findSession(token)).resolves.toEqual({ sessionId: 'sid', profileId: 'pid' });

    const query = callsOf(0);
    expect(query?.table).toBe('sessions');
    expect(query?.calls).toContainEqual(['eq', ['token_hash', session.hashSessionToken(token)]]);
    const gt = query?.calls.find(([m]) => m === 'gt');
    expect(gt?.[1][0]).toBe('expires_at');
    expect(Date.parse(String(gt?.[1][1]))).toBeGreaterThanOrEqual(before);
    expect(JSON.stringify(query)).not.toContain(token);
  });

  it('returns null when no live session matches', async () => {
    await expect(auth.findSession(session.newSessionToken())).resolves.toBeNull();
  });

  it('throws InternalError carrying only the Postgres code and message on a database error', async () => {
    results.lookup = { data: null, error: { code: '57014', message: 'timeout', details: 'ROWVALUE' } };
    const err: unknown = await auth.findSession(session.newSessionToken()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalError);
    const cause = (err as InstanceType<typeof InternalError>).cause as Error & { code?: string };
    expect(cause.message).toBe('session lookup failed: timeout');
    expect(cause.code).toBe('57014');
    expect(JSON.stringify(cause)).not.toContain('ROWVALUE');
  });
});

describe('createLoginSession / deleteSession / deleteAllSessions', () => {
  it('returns a raw token whose HMAC is what the RPC stores', async () => {
    const token = await auth.createLoginSession({
      steamId: STEAM_ID,
      displayName: 'G',
      avatarUrl: null,
      keepExistingProfile: false,
    });
    expect(token).toMatch(session.TOKEN_PATTERN);
    const [fn, args] = fakeDb.rpc.mock.calls[0] ?? [];
    expect(fn).toBe('create_login_session');
    expect(args?.p_token_hash).toBe(session.hashSessionToken(token));
  });

  it('throws InternalError when the RPC fails', async () => {
    results.rpc = { data: null, error: { message: 'nope' } };
    await expect(
      auth.createLoginSession({ steamId: STEAM_ID, displayName: 'G', avatarUrl: null, keepExistingProfile: true }),
    ).rejects.toBeInstanceOf(InternalError);
  });

  it('throws InternalError when deleting sessions fails', async () => {
    results.delete = { error: { message: 'nope' } };
    await expect(auth.deleteSession('sid')).rejects.toBeInstanceOf(InternalError);
    await expect(auth.deleteAllSessions('pid')).rejects.toBeInstanceOf(InternalError);
  });
});

describe('completeSteamLogin', () => {
  const returnTo = (state: string) => `http://localhost:5173/api/auth/steam/callback?state=${state}`;

  it('does not create a session when verification fails', async () => {
    const result = await auth.completeSteamLogin(assertionParams(returnTo('other')), 'state');
    expect(result).toEqual({ ok: false, reason: 'STEAM_LOGIN_FAILED' });
    expect(fakeDb.rpc).not.toHaveBeenCalled();
  });

  it('rebuilds return_to from the checked state and signs in', async () => {
    const result = await auth.completeSteamLogin(assertionParams(returnTo('s1')), 's1');
    expect(result).toMatchObject({ ok: true, token: expect.stringMatching(session.TOKEN_PATTERN) });
    expect(fakeDb.rpc).toHaveBeenCalledOnce();
  });

  it('propagates RPC failures (the route maps them to STEAM_UNAVAILABLE)', async () => {
    results.rpc = { data: null, error: { message: 'nope' } };
    await expect(auth.completeSteamLogin(assertionParams(returnTo('s1')), 's1')).rejects.toBeInstanceOf(
      InternalError,
    );
  });
});

describe('steam client', () => {
  it.each([
    ['openid.signed omits return_to', { 'openid.signed': 'signed,op_endpoint,claimed_id,identity,response_nonce,assoc_handle' }],
    ['openid.signed missing', { 'openid.signed': '' }],
    ['wrong openid.ns', { 'openid.ns': 'http://openid.net/signon/1.1' }],
  ])('rejects assertions where %s, without asking Steam', async (_label, override) => {
    const params = { ...assertionParams(returnTo('s')), ...override };
    await expect(steamLib.verifyCallback(params, returnTo('s'))).resolves.toEqual({
      ok: false,
      reason: 'STEAM_LOGIN_FAILED',
    });
    expect(steamFetch).not.toHaveBeenCalled();
  });

  it('rejects query values that are not strings (arrays from repeated params, nested objects)', async () => {
    const params = assertionParams(returnTo('s'));
    await expect(steamLib.verifyCallback({ ...params, 'openid.sig': ['a', 'b'] }, returnTo('s'))).resolves.toEqual({
      ok: false,
      reason: 'STEAM_LOGIN_FAILED',
    });
    await expect(steamLib.verifyCallback({ ...params, 'openid.ns': { x: '1' } }, returnTo('s'))).resolves.toEqual({
      ok: false,
      reason: 'STEAM_LOGIN_FAILED',
    });
    expect(steamFetch).not.toHaveBeenCalled();
  });

  it('only forwards openid.* params to check_authentication', async () => {
    const params = assertionParams(returnTo('s'));
    await steamLib.verifyCallback({ ...params, state: 's', other: 'x' }, returnTo('s'));
    const body = steamFetch.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect([...body.keys()].every((k) => k.startsWith('openid.'))).toBe(true);
  });

  it('requires an exact is_valid:true line', async () => {
    steam.checkAuth = () => Promise.resolve(new Response('ns:x\nis_valid:true \n'));
    await expect(steamLib.verifyCallback(assertionParams(returnTo('s')), returnTo('s'))).resolves.toEqual({
      ok: false,
      reason: 'STEAM_LOGIN_FAILED',
    });
  });

  it('getPlayerSummary picks the matching player and trims the name', async () => {
    steam.summaries = () =>
      Promise.resolve(
        summariesResponse([
          { steamid: '76561197960287931', personaname: 'Other' },
          { steamid: STEAM_ID, personaname: '  Alyx ', avatarfull: 'https://a/b.jpg' },
        ]),
      );
    await expect(steamLib.getPlayerSummary(STEAM_ID)).resolves.toEqual({
      displayName: 'Alyx',
      avatarUrl: 'https://a/b.jpg',
    });
  });

  it('fallbackDisplayName uses the last 4 digits', () => {
    expect(steamLib.fallbackDisplayName(STEAM_ID)).toBe('Steam user 7930');
  });

  function returnTo(state: string): string {
    return `http://localhost:5173/api/auth/steam/callback?state=${state}`;
  }
});
