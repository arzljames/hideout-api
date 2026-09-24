import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

describe('parseEnv', () => {
  const valid = { ...process.env };

  it('accepts the test configuration', () => {
    expect(() => parseEnv(valid)).not.toThrow();
  });

  it('reports variable names but never values', () => {
    const bad = { ...valid, SESSION_SECRET: 'short-secret-value' };
    expect(() => parseEnv(bad)).toThrow(/SESSION_SECRET/);
    expect(() => parseEnv(bad)).not.toThrow(/short-secret-value/);
  });

  it('requires https/wss URLs and an explicit TRUST_PROXY in production', () => {
    const attempt = () => parseEnv({ ...valid, NODE_ENV: 'production' });
    for (const key of ['API_URL', 'WEB_ORIGIN', 'SUPABASE_URL', 'LIVEKIT_URL', 'TRUST_PROXY']) {
      expect(attempt).toThrow(new RegExp(key));
    }
  });

  it('accepts a complete production configuration', () => {
    const prod = {
      ...valid,
      NODE_ENV: 'production',
      TRUST_PROXY: '1',
      API_URL: 'https://api.hideout.gg',
      WEB_ORIGIN: 'https://app.hideout.gg',
      SUPABASE_URL: 'https://example.supabase.co',
      LIVEKIT_URL: 'wss://livekit.hideout.gg',
    };
    expect(parseEnv(prod).TRUST_PROXY).toBe(1);
  });

  it('refuses an https API_URL outside production (forgotten NODE_ENV)', () => {
    expect(() => parseEnv({ ...valid, API_URL: 'https://api.hideout.gg' })).toThrow(/NODE_ENV/);
  });

  it('refuses reusing one secret for sessions and Realtime tokens', () => {
    expect(() => parseEnv({ ...valid, SESSION_SECRET: valid.SUPABASE_JWT_SECRET })).toThrow(/must differ/);
  });

  it('requires WEB_ORIGIN to be a bare origin', () => {
    expect(() => parseEnv({ ...valid, WEB_ORIGIN: 'http://localhost:5173/' })).toThrow(/WEB_ORIGIN/);
  });
});
