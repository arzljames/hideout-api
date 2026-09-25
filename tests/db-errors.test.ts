import { describe, expect, it } from 'vitest';
import { dbFailure, rpcFailure } from '../src/db/errors.js';
import { ConflictError, ForbiddenError, InternalError, NotFoundError, ValidationError } from '../src/errors.js';

/*
 * rpcFailure maps the SQLSTATEs raised by the room/invite Postgres functions (table in
 * supabase/migrations/20260925010655_core_schema_fixes.sql) to AppErrors, and never lets the
 * database message, details, or hint reach the client-facing message or details.
 */

const SECRET = 'SECRET-DB-MESSAGE (ROWVALUE)';

function clientFacing(err: { message: string; details?: unknown }): string {
  return JSON.stringify({ message: err.message, details: err.details });
}

describe('rpcFailure', () => {
  it.each([
    ['HX001', NotFoundError, 404, 'NOT_FOUND'],
    ['HX002', ForbiddenError, 403, 'FORBIDDEN'],
    ['HX003', NotFoundError, 404, 'NOT_FOUND'],
    ['HX004', ValidationError, 422, 'VALIDATION_FAILED'],
    ['HX005', ConflictError, 409, 'CONFLICT'],
    ['22023', ValidationError, 422, 'VALIDATION_FAILED'],
    ['23514', ValidationError, 422, 'VALIDATION_FAILED'],
  ] as const)('maps %s to %s (%i %s) without echoing the DB message', (code, type, status, errorCode) => {
    const err = rpcFailure('some_fn', { code, message: SECRET });
    expect(err).toBeInstanceOf(type);
    expect(err.status).toBe(status);
    expect(err.code).toBe(errorCode);
    expect(clientFacing(err)).not.toContain('SECRET');
    expect(clientFacing(err)).not.toContain(code);
  });

  it('uses generic messages for HX004 (blaming the given field) and HX005', () => {
    const sameUser = rpcFailure('transfer_ownership', { code: 'HX004', message: SECRET }, 'body.userId');
    expect(sameUser.message).toBe('The request is invalid.');
    expect(sameUser.details).toEqual([{ path: 'body.userId', message: 'The request is invalid.' }]);

    const owner = rpcFailure('remove_member', { code: 'HX005', message: SECRET });
    expect(owner.message).toBe("The room owner can't leave or be removed; transfer ownership or delete the room.");
    expect(owner.details).toBeUndefined();
  });

  it.each(['XX000', '23505', '23503', undefined])('maps %s to a generic 500 that keeps the cause for logs only', (code) => {
    const err = rpcFailure('some_fn', { code, message: SECRET });
    expect(err).toBeInstanceOf(InternalError);
    expect(err.status).toBe(500);
    expect(err.message).toBe('Something went wrong.');
    expect(clientFacing(err)).not.toContain('SECRET');
    expect((err.cause as Error).message).toBe(`some_fn failed: ${SECRET}`);
  });
});

describe('dbFailure', () => {
  it('keeps only the operation, message, and code on the cause', () => {
    const err = dbFailure('room lookup', { code: 'XX000', message: 'db down' });
    expect(err.message).toBe('Something went wrong.');
    expect(err.cause).toMatchObject({ message: 'room lookup failed: db down', code: 'XX000' });
  });
});
