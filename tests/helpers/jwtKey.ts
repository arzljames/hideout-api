/*
 * Test-only ES256 key (generated once, never imported into any Supabase project).
 * src/config/env.ts refuses this kid and x in production, so keep them in sync.
 */
export const TEST_JWT_KID = 'hideout-test-key';
export const TEST_JWT_PRIVATE_JWK = JSON.stringify({
  kty: 'EC',
  crv: 'P-256',
  x: 'dN4P6MmoG4ukk2feknwU5sztFayoqEUq6Jg5YJRz7B8',
  y: 'gZw4d4fOHuGnr_opeXvqTjhtGAbuIPcLQAzzQOZE9qI',
  d: 'xat5UNmv1TYsKqAXzSwjSWACaXQdC4fN4vHSqm6Rz4M',
  kid: TEST_JWT_KID,
  alg: 'ES256',
  use: 'sig',
});
