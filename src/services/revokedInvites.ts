import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { broadcastToUser } from '../realtime/broadcast.js';

/*
 * remove_member, ban_member, and delete_room return one row per pending direct invite they
 * revoked; invitee_profile_id is null when the invitee hasn't signed in yet (nobody to tell).
 */

const RevokedInviteRows = z.array(z.object({ invite_id: z.guid(), invitee_profile_id: z.guid().nullable() }));

export interface RevokedInvite {
  inviteId: string;
  inviteeProfileId: string;
}

/**
 * Parses the revoked-invite rows of `operation`, keeping those with a signed-in invitee. The
 * write has committed, so a bad shape is logged (issue paths and codes only: the rows carry
 * ids) and treated as none, never thrown.
 */
export function parseRevokedInvites(operation: string, data: unknown): RevokedInvite[] {
  const rows = RevokedInviteRows.safeParse(data ?? []);
  if (!rows.success) {
    const issues = rows.error.issues.map(({ path, code }) => ({ path, code }));
    logger.error({ issues }, `${operation} returned unexpected rows; invite:revoked not sent`);
    return [];
  }
  return rows.data.flatMap(({ invite_id, invitee_profile_id }) =>
    invitee_profile_id
      ? [{ inviteId: invite_id.toLowerCase(), inviteeProfileId: invitee_profile_id.toLowerCase() }]
      : [],
  );
}

/** Tells each invitee their invite is gone from their inbox. The promises never reject. */
export function broadcastRevokedInvites(revokedInvites: readonly RevokedInvite[]): Promise<boolean>[] {
  return revokedInvites.map(({ inviteId, inviteeProfileId }) =>
    broadcastToUser(inviteeProfileId, 'invite:revoked', { inviteId }),
  );
}
