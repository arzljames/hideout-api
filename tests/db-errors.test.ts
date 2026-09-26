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
    ['HX005', ConflictError, 409, 'OWNER_PROTECTED'],
    ['HX006', ConflictError, 409, 'CHANNEL_LIMIT_REACHED'],
    ['HX007', ConflictError, 409, 'CHANNEL_ORDER_STALE'],
    ['HX008', ConflictError, 409, 'LAST_TEXT_CHANNEL'],
    ['HX009', ConflictError, 409, 'CHANNEL_NOT_TEXT'],
    ['HX010', ConflictError, 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['HX011', ConflictError, 409, 'ALREADY_MEMBER'],
    ['HX012', ConflictError, 409, 'INVITE_ALREADY_PENDING'],
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
    const sameUser = rpcFailure('transfer_ownership', { code: 'HX004', message: SECRET }, { field: 'body.userId' });
    expect(sameUser.message).toBe('The request is invalid.');
    expect(sameUser.details).toEqual([{ path: 'body.userId', message: 'The request is invalid.' }]);

    const owner = rpcFailure('remove_member', { code: 'HX005', message: SECRET });
    expect(owner.message).toBe("The room owner can't leave or be removed; transfer ownership or delete the room first.");
    expect(owner.details).toBeUndefined();
  });

  it.each(['22023', '23514', 'HX004'])('blames `body` for %s by default, or the given field', (code) => {
    expect(rpcFailure('some_fn', { code, message: SECRET }).details).toEqual([
      { path: 'body', message: 'The request is invalid.' },
    ]);
    const taken = new ConflictError('taken', 'CHANNEL_NAME_TAKEN');
    expect(rpcFailure('some_fn', { code, message: SECRET }, { field: 'body.name', uniqueViolation: taken }).details).toEqual([
      { path: 'body.name', message: 'The request is invalid.' },
    ]);
  });

  it('uses generic messages for the channel codes HX006, HX007, and HX008', () => {
    expect(rpcFailure('create_channel', { code: 'HX006', message: SECRET }).message).toBe(
      'This room has the maximum number of channels.',
    );
    expect(rpcFailure('reorder_channels', { code: 'HX007', message: SECRET }).message).toBe(
      'The channel list changed. Reload and try again.',
    );
    expect(rpcFailure('delete_channel', { code: 'HX008', message: SECRET }).message).toBe(
      "A room needs at least one text channel, so this one can't be deleted.",
    );
  });

  it('uses generic messages without details for the message codes HX009 and HX010', () => {
    const notText = rpcFailure('send_message', { code: 'HX009', message: SECRET }, { field: 'body.body' });
    expect(notText.message).toBe('Messages can only be sent in text channels.');
    expect(notText.details).toBeUndefined();
    const reused = rpcFailure('send_message', { code: 'HX010', message: SECRET }, { field: 'body.body' });
    expect(reused.message).toBe(
      'This Idempotency-Key was already used for a different message. Use a new key for each message.',
    );
    expect(reused.details).toBeUndefined();
  });

  it('uses generic messages without details for the invite codes HX011 and HX012', () => {
    const member = rpcFailure('create_direct_invite', { code: 'HX011', message: SECRET }, { field: 'body.steamId' });
    expect(member.message).toBe('That person is already a member of this room.');
    expect(member.details).toBeUndefined();
    const pending = rpcFailure('create_direct_invite', { code: 'HX012', message: SECRET }, { field: 'body.steamId' });
    expect(pending.message).toBe('That person already has a pending invite to this room. Revoke it to send a new one.');
    expect(pending.details).toBeUndefined();
  });

  it('returns the caller-supplied error for 23505 when the function knows which unique constraint it hits', () => {
    const taken = new ConflictError('A channel with this name already exists in this room.', 'CHANNEL_NAME_TAKEN');
    const err = rpcFailure('create_channel', { code: '23505', message: SECRET }, { uniqueViolation: taken });
    expect(err).toBe(taken);
    expect(err.status).toBe(409);
    expect(clientFacing(err)).not.toContain('SECRET');
  });

  it.each(['HX001', 'HX002', 'HX006', 'HX009', 'HX010', 'HX011', 'HX012', '22023', 'XX000'])('ignores the uniqueViolation override for %s', (code) => {
    const taken = new ConflictError('taken', 'CHANNEL_NAME_TAKEN');
    expect(rpcFailure('create_channel', { code, message: SECRET }, { uniqueViolation: taken })).not.toBe(taken);
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
