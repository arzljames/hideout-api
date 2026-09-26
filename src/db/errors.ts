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
 * Maps an error raised by a room/channel/invite Postgres function to an AppError, using the
 * SQLSTATE table in supabase/migrations/20260925010655_core_schema_fixes.sql (HX001–HX005,
 * including HX005 → 409 OWNER_PROTECTED); HX006–HX008 come from the channels migration,
 * HX009–HX010 from the messages migration, HX011–HX012 from the invites migration, and HX013
 * from the bans migration. The DB message and details are never echoed to the client (they can
 * carry row values).
 *
 * @param options.field request field blamed for 22023/23514/HX004 failures (default `body`).
 * @param options.uniqueViolation returned for 23505 when the caller knows which unique
 *   constraint a function can hit (e.g. a channel name); otherwise 23505 is a 500.
 */
export function rpcFailure(
  operation: string,
  error: DbError,
  { field = 'body', uniqueViolation }: { field?: string; uniqueViolation?: AppError } = {},
): AppError {
  switch (error.code) {
    case 'HX001':
      return new NotFoundError();
    case 'HX002':
      return new ForbiddenError();
    case 'HX003': // target_not_member
      return new NotFoundError();
    case 'HX005': // owner_cannot_leave_or_be_removed
      return new ConflictError(
        "The room owner can't leave or be removed; transfer ownership or delete the room first.",
        'OWNER_PROTECTED',
      );
    case 'HX006': // channel_limit_reached
      return new ConflictError('This room has the maximum number of channels.', 'CHANNEL_LIMIT_REACHED');
    case 'HX007': // stale channel list (reorder)
      return new ConflictError('The channel list changed. Reload and try again.', 'CHANNEL_ORDER_STALE');
    case 'HX008': // last_text_channel
      return new ConflictError("A room needs at least one text channel, so this one can't be deleted.", 'LAST_TEXT_CHANNEL');
    case 'HX009': // channel_not_text
      return new ConflictError('Messages can only be sent in text channels.', 'CHANNEL_NOT_TEXT');
    case 'HX010': // idempotency key reused for a different message
      return new ConflictError(
        'This Idempotency-Key was already used for a different message. Use a new key for each message.',
        'IDEMPOTENCY_KEY_REUSED',
      );
    case 'HX011': // already_member (direct invite to someone already in the room)
      return new ConflictError('That person is already a member of this room.', 'ALREADY_MEMBER');
    case 'HX012': // invite_already_pending (one pending direct invite per room + SteamID)
      return new ConflictError(
        'That person already has a pending invite to this room. Revoke it to send a new one.',
        'INVITE_ALREADY_PENDING',
      );
    case 'HX013': // user_banned (direct invite to a banned SteamID)
      return new ConflictError('That person is banned from this room.', 'USER_BANNED');
    case '23505':
      return uniqueViolation ?? dbFailure(operation, error);
    case 'HX004': // same_user
    case '22023':
    case '23514':
      return new ValidationError([{ path: field, message: 'The request is invalid.' }]);
    default:
      return dbFailure(operation, error);
  }
}
