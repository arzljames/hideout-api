import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateJwtSigningKey, refuseWithoutTty } from '../scripts/generate-jwt-key.js';
import { parseEnv } from '../src/config/env.js';

describe('generateJwtSigningKey', () => {
  it('returns an ES256 P-256 private JWK with a random kid that env accepts', () => {
    const jwk = generateJwtSigningKey();
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwk.kid).toMatch(/^[0-9a-f-]{36}$/);
    expect(generateJwtSigningKey().kid).not.toBe(jwk.kid);

    const parsed = parseEnv({ ...process.env, SUPABASE_JWT_PRIVATE_JWK: JSON.stringify(jwk) });
    expect(parsed.SUPABASE_JWT_SIGNING_KEY.kid).toBe(jwk.kid);

    const { d: _d, ...publicJwk } = jwk;
    const signature = sign('sha256', Buffer.from('x'), createPrivateKey({ key: jwk, format: 'jwk' }));
    expect(verify('sha256', Buffer.from('x'), createPublicKey({ key: publicJwk, format: 'jwk' }), signature)).toBe(true);
  });

  it('serializes to a single line', () => {
    expect(JSON.stringify(generateJwtSigningKey())).not.toContain('\n');
  });
});

describe('jwt:keygen CLI guard (humans only)', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [undefined, undefined],
  ])('refuses when stdin TTY is %s and stdout TTY is %s', (stdin, stdout) => {
    expect(refuseWithoutTty(stdin, stdout)).toMatch(/interactive terminal: it prints a private signing key/);
  });

  it('allows a person at an interactive terminal', () => {
    expect(refuseWithoutTty(true, true)).toBeNull();
  });

  it('exits non-zero with piped stdio and prints nothing to stdout', () => {
    const script = fileURLToPath(new URL('../scripts/generate-jwt-key.ts', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    // Length only: if the guard ever broke, the assertion output must not show a key.
    expect(result.stdout.length).toBe(0);
    expect(result.stderr).toMatch(/jwt:keygen must be run by a person in an interactive terminal/);
  }, 30_000);
});
