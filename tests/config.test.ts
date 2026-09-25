import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { TEST_JWT_KID, TEST_JWT_PRIVATE_JWK } from './helpers/jwtKey.js';

const testJwk = JSON.parse(TEST_JWT_PRIVATE_JWK) as Record<string, string>;

function exportJwk(key: ReturnType<typeof generateKeyPairSync>['privateKey']): Record<string, unknown> {
  return { ...key.export({ format: 'jwk' }), kid: 'k1' };
}

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

  const prod = {
    ...valid,
    NODE_ENV: 'production',
    TRUST_PROXY: '1',
    API_URL: 'https://api.hideout.gg',
    WEB_ORIGIN: 'https://app.hideout.gg',
    SUPABASE_URL: 'https://example.supabase.co',
    LIVEKIT_URL: 'wss://livekit.hideout.gg',
    SUPABASE_JWT_PRIVATE_JWK: JSON.stringify(exportJwk(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey)),
  };

  it('accepts a complete production configuration', () => {
    expect(parseEnv(prod).TRUST_PROXY).toBe(1);
  });

  describe('refuses the committed test signing key in production', () => {
    const TEST_KEY = /SUPABASE_JWT_PRIVATE_JWK: must not be the committed test key in production/;
    const fresh = JSON.parse(prod.SUPABASE_JWT_PRIVATE_JWK) as Record<string, string>;

    it.each([
      ['the test key itself', TEST_JWT_PRIVATE_JWK],
      ['the test key under another kid', JSON.stringify({ ...testJwk, kid: 'renamed' })],
      ['another key under the test kid', JSON.stringify({ ...fresh, kid: TEST_JWT_KID })],
    ])('rejects %s', (_name, jwk) => {
      expect(() => parseEnv({ ...prod, SUPABASE_JWT_PRIVATE_JWK: jwk })).toThrow(TEST_KEY);
    });

    it('still accepts the test key outside production', () => {
      expect(parseEnv(valid).SUPABASE_JWT_SIGNING_KEY.kid).toBe(TEST_JWT_KID);
    });
  });

  it('refuses an https API_URL outside production (forgotten NODE_ENV)', () => {
    expect(() => parseEnv({ ...valid, API_URL: 'https://api.hideout.gg' })).toThrow(/NODE_ENV/);
  });

  it('parses the Realtime signing JWK into a kid and a private KeyObject, dropping the raw string', () => {
    const parsed = parseEnv(valid);
    expect(parsed.SUPABASE_JWT_SIGNING_KEY.kid).toBe(TEST_JWT_KID);
    expect(parsed.SUPABASE_JWT_SIGNING_KEY.privateKey.type).toBe('private');
    expect(parsed.SUPABASE_JWT_SIGNING_KEY.privateKey.asymmetricKeyType).toBe('ec');
    expect(parsed).not.toHaveProperty('SUPABASE_JWT_PRIVATE_JWK');
    expect(JSON.stringify(parsed)).not.toContain(testJwk.d);
  });

  describe('SUPABASE_JWT_PRIVATE_JWK validation', () => {
    const { d: _d, ...publicOnly } = testJwk;
    const { kid: _kid, ...noKid } = testJwk;
    const { x: _x, ...noX } = testJwk;
    // A valid P-256 private scalar from a different key: parses, but can't sign for the test key's x/y.
    const otherD = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }).d;
    const NOT_OBJECT = /must be a single-line JSON object \(the JWK from npm run jwt:keygen\)/;
    const ARRAY = /must be a JSON object \(the JWK from npm run jwt:keygen\)/;
    const NOT_P256 = /must be an EC P-256 key \(kty "EC", crv "P-256"\)/;
    const NO_KID = /must include a non-empty string kid/;
    const cases: [string, string, RegExp][] = [
      ['invalid JSON', `{"kty":"EC","d":"${testJwk.d}"`, NOT_OBJECT],
      ['a JSON array', JSON.stringify([testJwk]), ARRAY],
      ['a public-only key', JSON.stringify(publicOnly), /must be a private key \(include d\)/],
      ['a missing x', JSON.stringify(noX), /must include the public coordinates x and y/],
      ['a missing kid', JSON.stringify(noKid), NO_KID],
      ['an empty kid', JSON.stringify({ ...testJwk, kid: '' }), NO_KID],
      ['a P-384 key', JSON.stringify(exportJwk(generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey)), NOT_P256],
      ['an RSA key', JSON.stringify(exportJwk(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)), NOT_P256],
      ['an oct key', JSON.stringify({ kty: 'oct', k: randomBytes(32).toString('base64url'), kid: 'k1' }), NOT_P256],
      ['a non-ES256 alg', JSON.stringify({ ...testJwk, alg: 'ES384' }), /alg must be ES256 when present/],
      ['a point that is not on the curve', JSON.stringify({ ...testJwk, x: testJwk.y }), /is not a valid EC P-256 private key/],
      ['a d from a different key', JSON.stringify({ ...testJwk, d: otherD }), /d does not match the public coordinates x and y/],
    ];

    it.each(cases)('rejects %s with its own message, without echoing key material', (_name, value, expected) => {
      let message = '';
      try {
        parseEnv({ ...valid, SUPABASE_JWT_PRIVATE_JWK: value });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(new RegExp(`SUPABASE_JWT_PRIVATE_JWK: ${expected.source}`));
      const parsed = (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return {};
        }
      })();
      const material = [testJwk.d, testJwk.x, testJwk.y, otherD, ...Object.values(parsed as Record<string, unknown>)]
        .filter((v): v is string => typeof v === 'string' && v.length > 8);
      for (const secret of material) expect(message).not.toContain(secret);
      expect(message).not.toContain(value);
    });

    it('is required', () => {
      const { SUPABASE_JWT_PRIVATE_JWK: _omit, ...rest } = valid;
      expect(() => parseEnv(rest)).toThrow(/SUPABASE_JWT_PRIVATE_JWK/);
    });
  });

  it('requires API_URL to be a bare origin (it builds Steam return_to)', () => {
    expect(() => parseEnv({ ...valid, API_URL: 'http://localhost:5173/' })).toThrow(/API_URL/);
  });

  it('requires WEB_ORIGIN to be a bare origin', () => {
    expect(() => parseEnv({ ...valid, WEB_ORIGIN: 'http://localhost:5173/' })).toThrow(/WEB_ORIGIN/);
  });
});
