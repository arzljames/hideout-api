import { pino } from 'pino';
import { env } from '../config/env.js';

/*
 * URLs can carry credentials: invite tokens in the path, Steam OpenID signatures and
 * nonces in the callback query. Query strings are always dropped from logged URLs.
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const path = url.split('?')[0] ?? '';
  // Case-insensitive: Express routes /API/Invites/<token>/... to the same handlers.
  return path.replace(/^\/api\/invites\/[^/]+/i, '/api/invites/[redacted]');
}

/*
 * The invite page (WEB_ORIGIN/invite/<token>) calls the API, so browsers send the link token
 * in Referer. Keep the origin and path shape, censor any /invite/<token> or /invites/<token>
 * segment (any case), and drop the query and fragment like redactUrl does.
 */
export function redactReferer(referer: unknown): unknown {
  if (typeof referer !== 'string') return referer;
  const withoutQuery = referer.split(/[?#]/)[0] ?? '';
  return withoutQuery.replace(/\/(invites?)\/[^/]+/gi, (_match, segment: string) => `/${segment}/[redacted]`);
}

interface SerializedReq {
  id?: unknown;
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
}

/** Keeps only fields that can't carry upstream request config (headers, keys, bodies). */
function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const extra = err as Error & { code?: unknown; status?: unknown };
  return {
    type: err.name,
    message: err.message,
    ...(extra.code !== undefined && { code: extra.code }),
    ...(extra.status !== undefined && { status: extra.status }),
    stack: err.stack,
  };
}

export const logger = pino({
  level: env.LOG_LEVEL,
  serializers: { err: serializeError },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["idempotency-key"]',
      'res.headers["set-cookie"]',
      // The Steam login redirect carries the login state (same value as the state cookie).
      'res.headers.location',
      'token',
      'secret',
      'apiKey',
      'password',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.secret',
      '*.apiKey',
      '*.password',
      '*.serviceRoleKey',
      // Realtime JWT signing key (raw JWK string or parsed KeyObject).
      'privateKey',
      'SUPABASE_JWT_PRIVATE_JWK',
      'SUPABASE_JWT_SIGNING_KEY',
      '*.privateKey',
      '*.SUPABASE_JWT_PRIVATE_JWK',
      '*.SUPABASE_JWT_SIGNING_KEY',
    ],
    censor: '[redacted]',
  },
});

/** pino-http request serializer: no query/params, redacted URL and Referer (the live headers are never mutated). */
export function serializeRequest(req: SerializedReq): SerializedReq {
  const headers = req.headers && 'referer' in req.headers ? { ...req.headers, referer: redactReferer(req.headers.referer) } : req.headers;
  return { id: req.id, method: req.method, url: redactUrl(req.url), headers };
}
