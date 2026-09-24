import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, BadRequestError, NotFoundError, PayloadTooLargeError } from '../errors.js';
import { logger } from '../lib/logger.js';

interface HttpParserError {
  type?: string;
  status?: number;
  expose?: boolean;
}

export const notFoundHandler: RequestHandler = () => {
  throw new NotFoundError();
};

/** Maps body-parser and other exposed 4xx errors to AppErrors; everything else is a 500. */
function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  const parserError = err as HttpParserError;
  if (parserError.type === 'entity.parse.failed') {
    return new BadRequestError('The request body is not valid JSON.', 'INVALID_JSON');
  }
  if (parserError.type === 'entity.too.large') return new PayloadTooLargeError();
  const status = parserError.status ?? 0;
  if (parserError.expose && status >= 400 && status < 500) return new BadRequestError();
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const appError = toAppError(err);
  if (appError) {
    res.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details && { details: appError.details }),
      },
    });
    return;
  }

  // req.log is absent when pino-http isn't mounted (e.g. minimal test apps).
  ((req.log as typeof logger | undefined) ?? logger).error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
};
