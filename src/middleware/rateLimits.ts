import type { Request, Response } from 'express';
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

function limiter(
  windowMs: number,
  limit: number,
  keyGenerator?: Options['keyGenerator'],
  onLimit?: (req: Request, res: Response) => void,
) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyGenerator && { keyGenerator }),
    handler: (req, res, next) => {
      if (onLimit) onLimit(req, res);
      else next(new RateLimitedError());
    },
  });
}

/**
 * Per-IP limiter for routes the browser navigates to (not fetch), where a JSON 429
 * would strand the user on the API origin; onLimit redirects instead.
 */
export function navigationLimiter(windowMs: number, limit: number, onLimit: (req: Request, res: Response) => void) {
  return limiter(windowMs, limit, undefined, onLimit);
}

export const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const authLimiter = limiter(MINUTE, 10);
export const readyLimiter = limiter(MINUTE, 30);
export const realtimeTokenLimiter = limiter(HOUR, 30, byUser);
export const messageLimiter = limiter(10_000, 10, byUser);
export const inviteCreateLimiter = limiter(HOUR, 20, byUser);
export const inviteRedeemLimiter = limiter(MINUTE, 10, byUser);
export const roomCreateLimiter = limiter(HOUR, 10, byUser);
export const roomUpdateLimiter = limiter(HOUR, 30, byUser);
