import { createPrivateKey, createPublicKey, sign, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';

const secret = z.string().min(32, 'must be at least 32 characters');

/** The Realtime JWT signing key: the private key as a KeyObject, never the raw JWK string. */
export interface JwtSigningKey {
  kid: string;
  privateKey: KeyObject;
}

/*
 * The committed test key (tests/helpers/jwtKey.ts). Its private half is public, so production
 * refuses it by kid and by public x coordinate. Hardcoded: app code never imports from tests/.
 */
const TEST_JWT_KID = 'hideout-test-key';
const TEST_JWT_X = 'dN4P6MmoG4ukk2feknwU5sztFayoqEUq6Jg5YJRz7B8';

function isTestSigningKey({ kid, privateKey }: JwtSigningKey): boolean {
  return kid === TEST_JWT_KID || createPublicKey(privateKey).export({ format: 'jwk' }).x === TEST_JWT_X;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/*
 * A single-line ES256 (P-256) private JWK with a kid, imported into Supabase as a JWT
 * signing key (npm run jwt:keygen). Messages are fixed strings: JSON.parse and
 * createPrivateKey errors can echo parts of the input, so they are never surfaced.
 */
const jwtPrivateJwk = z.string().transform((raw, ctx): JwtSigningKey => {
  const fail = (message: string) => {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  };
  let jwk: unknown;
  try {
    jwk = JSON.parse(raw);
  } catch {
    return fail('must be a single-line JSON object (the JWK from npm run jwt:keygen)');
  }
  if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) {
    return fail('must be a JSON object (the JWK from npm run jwt:keygen)');
  }
  const key = jwk as Record<string, unknown>;
  if (key.kty !== 'EC' || key.crv !== 'P-256') return fail('must be an EC P-256 key (kty "EC", crv "P-256")');
  if (!isNonEmptyString(key.x) || !isNonEmptyString(key.y)) return fail('must include the public coordinates x and y');
  if (!isNonEmptyString(key.d)) return fail('must be a private key (include d)');
  if (!isNonEmptyString(key.kid)) return fail('must include a non-empty string kid');
  if (key.alg !== undefined && key.alg !== 'ES256') return fail('alg must be ES256 when present');
  let privateKey: KeyObject;
  let matches: boolean;
  try {
    privateKey = createPrivateKey({ key: key as JsonWebKey, format: 'jwk' });
    // Node doesn't check that d matches x/y; a mismatch would sign tokens the imported public key rejects.
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, format: 'jwk' });
    const probe = Buffer.from('hideout-jwk-check');
    matches = verify('sha256', probe, publicKey, sign('sha256', probe, privateKey));
  } catch {
    return fail('is not a valid EC P-256 private key');
  }
  if (!matches) return fail('d does not match the public coordinates x and y');
  return { kid: key.kid, privateKey };
});

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // Number of proxy hops in front of the API (sets req.ip for rate limits). 0 = none.
    TRUST_PROXY: z.coerce.number().int().min(0).optional(),

    // Used to build Steam's return_to/realm, so no path or trailing slash.
    API_URL: z.url().refine((v) => new URL(v).origin === v, 'must be a bare origin, e.g. https://api.hideout.gg'),
    // Compared exactly against the Origin header, so no path or trailing slash.
    WEB_ORIGIN: z.url().refine((v) => new URL(v).origin === v, 'must be a bare origin, e.g. https://app.hideout.gg'),

    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SUPABASE_JWT_PRIVATE_JWK: jwtPrivateJwk,

    SESSION_SECRET: secret,

    STEAM_API_KEY: z.string().min(1),

    LIVEKIT_URL: z.url(),
    LIVEKIT_API_KEY: z.string().min(1),
    LIVEKIT_API_SECRET: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    const https = value.API_URL.startsWith('https://');
    if (https && value.NODE_ENV !== 'production') {
      ctx.addIssue({ code: 'custom', path: ['NODE_ENV'], message: 'must be production when API_URL is https' });
    }
    if (value.NODE_ENV !== 'production') return;

    const required: [('API_URL' | 'WEB_ORIGIN' | 'SUPABASE_URL' | 'LIVEKIT_URL'), string][] = [
      ['API_URL', 'https://'],
      ['WEB_ORIGIN', 'https://'],
      ['SUPABASE_URL', 'https://'],
      ['LIVEKIT_URL', 'wss://'],
    ];
    for (const [key, scheme] of required) {
      if (!value[key].startsWith(scheme)) {
        ctx.addIssue({ code: 'custom', path: [key], message: `must start with ${scheme} in production` });
      }
    }
    if (value.TRUST_PROXY === undefined) {
      ctx.addIssue({ code: 'custom', path: ['TRUST_PROXY'], message: 'must be set explicitly in production' });
    }
    if (isTestSigningKey(value.SUPABASE_JWT_PRIVATE_JWK)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SUPABASE_JWT_PRIVATE_JWK'],
        message: 'must not be the committed test key in production (run npm run jwt:keygen)',
      });
    }
  })
  .transform(({ SUPABASE_JWT_PRIVATE_JWK, ...value }) => ({
    ...value,
    TRUST_PROXY: value.TRUST_PROXY ?? 0,
    // Renamed so the parsed env never carries the raw JWK string.
    SUPABASE_JWT_SIGNING_KEY: SUPABASE_JWT_PRIVATE_JWK,
  }));

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Only variable names and messages are printed, never values.
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
}

export const env = loadEnv();
