import type { Request } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import { RateLimitedError } from '../errors.js';

/*
 * In-memory store: correct for a single long-running instance. Switch to a shared
 * store (e.g. Redis) before running more than one instance or on serverless.
 */

/** Per-user limiters must be mounted after requireAuth; fail loudly if they aren't. */
function byUser(req: Request): string {
  if (!req.auth) throw new Error('per-user rate limiter mounted before requireAuth');
  return `user:${req.auth.profileId}`;
}

function limiter(windowMs: number, limit: number, keyGenerator?: Options['keyGenerator']) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyGenerator && { keyGenerator }),
    handler: (_req, _res, next) => {
      next(new RateLimitedError());
    },
  });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const authLimiter = limiter(MINUTE, 10);
export const readyLimiter = limiter(MINUTE, 30);
export const realtimeTokenLimiter = limiter(HOUR, 30, byUser);
export const messageLimiter = limiter(10_000, 10, byUser);
export const inviteCreateLimiter = limiter(HOUR, 20, byUser);
export const inviteRedeemLimiter = limiter(MINUTE, 10, byUser);
