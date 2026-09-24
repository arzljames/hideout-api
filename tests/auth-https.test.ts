import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFakeDb, results } from './helpers/fakeDb.js';
import { assertionParams, resetFakeSteam, steamFetch } from './helpers/fakeSteam.js';

/*
 * Cookie naming and attributes when API_URL is https (production-shaped env).
 * Env is read once at import, so this file sets it before importing the app and
 * restores it afterwards.
 */

vi.mock('../src/db/client.js', async () => ({ db: (await import('./helpers/fakeDb.js')).fakeDb }));

const API_URL = 'https://api.hideout.test';
const WEB_ORIGIN = 'https://app.hideout.test';
const overrides: Record<string, string> = {
  NODE_ENV: 'production',
  API_URL,
  WEB_ORIGIN,
  SUPABASE_URL: 'https://project.supabase.test',
  LIVEKIT_URL: 'wss://livekit.hideout.test',
  TRUST_PROXY: '1',
};
const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
Object.assign(process.env, overrides);
vi.stubGlobal('fetch', steamFetch);

const { createApp } = await import('../src/app.js');
const { LOGIN_STATE_COOKIE, newRandomToken, SESSION_COOKIE } = await import('../src/lib/session.js');

afterAll(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

const app = createApp();
let ipCounter = 0;
const freshIp = () => `10.2.0.${String((ipCounter += 1))}`;

function cookieNamed(res: request.Response, name: string): string | undefined {
  const header = res.headers['set-cookie'] as string[] | undefined;
  return header?.find((c) => c.startsWith(`${name}=`));
}

beforeEach(() => {
  resetFakeDb();
  resetFakeSteam();
});

describe('cookies over https', () => {
  it('uses __Host- prefixed cookie names', () => {
    expect(SESSION_COOKIE).toBe('__Host-hideout_session');
    expect(LOGIN_STATE_COOKIE).toBe('__Host-hideout_login_state');
  });

  it('sets a Secure, host-only __Host- state cookie and an https realm/return_to', async () => {
    const res = await request(app).get('/api/auth/steam').set('X-Forwarded-For', freshIp());
    const cookie = cookieNamed(res, '__Host-hideout_login_state');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i);

    const q = new URL(String(res.headers.location)).searchParams;
    expect(q.get('openid.realm')).toBe(API_URL);
    expect(q.get('openid.return_to')).toMatch(new RegExp(`^${API_URL}/api/auth/steam/callback\\?state=`));
  });

  it('sets a Secure __Host- session cookie on login and redirects to the https WEB_ORIGIN', async () => {
    const state = newRandomToken();
    const qs = new URLSearchParams({
      state,
      ...assertionParams(`${API_URL}/api/auth/steam/callback?state=${state}`),
    });
    const res = await request(app)
      .get(`/api/auth/steam/callback?${qs.toString()}`)
      .set('X-Forwarded-For', freshIp())
      .set('Cookie', `__Host-hideout_login_state=${state}`);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/`);
    const cookie = cookieNamed(res, '__Host-hideout_session');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=604800');
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookieNamed(res, '__Host-hideout_login_state')).toContain('Secure');
  });

  it('ignores an unprefixed state cookie (a sibling subdomain could have set it)', async () => {
    const state = newRandomToken();
    const qs = new URLSearchParams({
      state,
      ...assertionParams(`${API_URL}/api/auth/steam/callback?state=${state}`),
    });
    const res = await request(app)
      .get(`/api/auth/steam/callback?${qs.toString()}`)
      .set('X-Forwarded-For', freshIp())
      .set('Cookie', `hideout_login_state=${state}`);
    expect(res.headers.location).toBe(`${WEB_ORIGIN}/?auth_error=LOGIN_STATE_MISMATCH`);
  });

  it('authenticates logout with the __Host- session cookie and clears it with Secure', async () => {
    results.lookup = { data: { id: 'sid', profile_id: 'pid' }, error: null };
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .set('Cookie', `__Host-hideout_session=${newRandomToken()}`);
    expect(res.status).toBe(204);
    const cleared = cookieNamed(res, '__Host-hideout_session');
    expect(cleared).toMatch(/^__Host-hideout_session=;/);
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('Path=/');
  });

  it('ignores an unprefixed session cookie', async () => {
    results.lookup = { data: { id: 'sid', profile_id: 'pid' }, error: null };
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Origin', WEB_ORIGIN)
      .set('Content-Type', 'application/json')
      .set('Cookie', `hideout_session=${newRandomToken()}`);
    expect(res.status).toBe(401);
  });
});
