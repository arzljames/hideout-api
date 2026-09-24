import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { ForbiddenError } from '../errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/*
 * State-changing requests must come from WEB_ORIGIN with a JSON content type
 * (which also forces a CORS preflight). Server-to-server endpoints such as the
 * LiveKit webhook must be mounted before this middleware.
 */
export const requireSameOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (req.get('origin') !== env.WEB_ORIGIN) {
    next(new ForbiddenError('Request origin not allowed.', 'ORIGIN_NOT_ALLOWED'));
    return;
  }
  // Checked on the header, not req.is(), so bodiless requests (e.g. DELETE) still need it.
  const contentType = req.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    next(new ForbiddenError('Content-Type must be application/json.', 'UNSUPPORTED_CONTENT_TYPE'));
    return;
  }
  next();
};
