/**
 * Every error code the API returns. Documented in the REST contract; add new codes
 * here (adding is non-breaking, renaming or removing is breaking for hideout-web).
 */
export const errorCodes = [
  'BAD_REQUEST',
  'INVALID_JSON',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
  'UNSUPPORTED_CONTENT_TYPE',
  'NOT_FOUND',
  'CONFLICT',
  'CHANNEL_NAME_TAKEN',
  'CHANNEL_LIMIT_REACHED',
  'LAST_TEXT_CHANNEL',
  'CHANNEL_ORDER_STALE',
  'CHANNEL_NOT_TEXT',
  'IDEMPOTENCY_KEY_REUSED',
  'ALREADY_MEMBER',
  'INVITE_ALREADY_PENDING',
  'INVITE_ALREADY_RESPONDED',
  'INVITE_EXPIRED',
  'INVITE_REVOKED',
  'INVITE_USED_UP',
  'OWNER_PROTECTED',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export interface FieldIssue {
  path: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: FieldIssue[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'The request could not be read.', code: ErrorCode = 'BAD_REQUEST') {
    super(400, code, message);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'You need to sign in.') {
    super(401, 'UNAUTHENTICATED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do that.", code: ErrorCode = 'FORBIDDEN') {
    super(403, code, message);
  }
}

/** Also used for non-members, so room existence never leaks. */
export class NotFoundError extends AppError {
  constructor(message = 'Not found.', code: ErrorCode = 'NOT_FOUND') {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode = 'CONFLICT') {
    super(409, code, message);
  }
}

/** The resource existed but can no longer be used (e.g. an expired, revoked, or used-up invite). */
export class GoneError extends AppError {
  constructor(message: string, code: ErrorCode) {
    super(410, code, message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'The request body is too large.') {
    super(413, 'PAYLOAD_TOO_LARGE', message);
  }
}

export class ValidationError extends AppError {
  constructor(details: FieldIssue[], message = 'The request is invalid.') {
    super(422, 'VALIDATION_FAILED', message, details);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests. Try again shortly.') {
    super(429, 'RATE_LIMITED', message);
  }
}

/**
 * An unexpected failure (e.g. a database error). The response is always the generic
 * 500 message; `cause` is logged by errorHandler and never sent to the client.
 */
export class InternalError extends AppError {
  constructor(cause?: unknown) {
    super(500, 'INTERNAL', 'Something went wrong.');
    this.cause = cause;
  }
}
