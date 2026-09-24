import { z } from 'zod';

const secret = z.string().min(32, 'must be at least 32 characters');

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
    SUPABASE_JWT_SECRET: secret,

    SESSION_SECRET: secret,

    STEAM_API_KEY: z.string().min(1),

    LIVEKIT_URL: z.url(),
    LIVEKIT_API_KEY: z.string().min(1),
    LIVEKIT_API_SECRET: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.SESSION_SECRET === value.SUPABASE_JWT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'must differ from SUPABASE_JWT_SECRET' });
    }

    const https = value.API_URL.startsWith('https://');
    if (https && value.NODE_ENV !== 'production') {
      ctx.addIssue({ code: 'custom', path: ['NODE_ENV'], message: 'must be production when API_URL is https' });
    }
    if (value.NODE_ENV !== 'production') return;

    const required: [keyof typeof value, string][] = [
      ['API_URL', 'https://'],
      ['WEB_ORIGIN', 'https://'],
      ['SUPABASE_URL', 'https://'],
      ['LIVEKIT_URL', 'wss://'],
    ];
    for (const [key, scheme] of required) {
      if (!String(value[key]).startsWith(scheme)) {
        ctx.addIssue({ code: 'custom', path: [key], message: `must start with ${scheme} in production` });
      }
    }
    if (value.TRUST_PROXY === undefined) {
      ctx.addIssue({ code: 'custom', path: ['TRUST_PROXY'], message: 'must be set explicitly in production' });
    }
  })
  .transform((value) => ({ ...value, TRUST_PROXY: value.TRUST_PROXY ?? 0 }));

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
