import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ValidationError,
  type AppError,
} from '../errors.js';

/** The fields of a supabase-js / PostgREST error that are safe to keep. */
export interface DbError {
  code?: string;
  message?: string;
}

/** Keeps only the Postgres code and message for logs; details/hints can carry row values. */
export function dbFailure(operation: string, error: DbError): InternalError {
  const cause = new Error(`${operation} failed: ${error.message ?? 'unknown error'}`);
  return new InternalError(Object.assign(cause, { code: error.code }));
}

/**
 * Maps an error raised by a room/invite Postgres function to an AppError, using the SQLSTATE
 * table in supabase/migrations/20260925010655_core_schema_fixes.sql. The DB message and
 * details are never echoed to the client (they can carry row values).
 *
 * @param field request field blamed for 22023/23514/HX004 failures (e.g. `body`).
 */
export function rpcFailure(operation: string, error: DbError, field = 'body'): AppError {
  switch (error.code) {
    case 'HX001':
      return new NotFoundError();
    case 'HX002':
      return new ForbiddenError();
    case 'HX003': // target_not_member
      return new NotFoundError();
    case 'HX005': // owner_cannot_leave_or_be_removed
      return new ConflictError("The room owner can't leave or be removed; transfer ownership or delete the room.");
    case 'HX004': // same_user
    case '22023':
    case '23514':
      return new ValidationError([{ path: field, message: 'The request is invalid.' }]);
    default:
      return dbFailure(operation, error);
  }
}
