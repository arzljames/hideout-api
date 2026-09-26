import { z } from 'zod';
import type { ChangeRoleBody } from '../contracts/http/members.js';
import type { RoomDetail } from '../contracts/http/rooms.js';
import { db } from '../db/client.js';
import { rpcFailure } from '../db/errors.js';
import { NotFoundError } from '../errors.js';
import { logger } from '../lib/logger.js';
import { broadcastToRoom, broadcastToUser } from '../realtime/broadcast.js';
import { findMember, getRoomDetail, listVoiceChannelIds, removeFromVoice, type MemberShape } from './rooms.js';

/*
 * Membership writes. Every rule is enforced by the Postgres function under the room lock
 * (remove_member, change_role, transfer_ownership); the route middleware is only a fast path.
 * Ids arrive lowercased (requireRoomMember / requireMemberTarget / the service for body ids).
 *
 * Revoking access (leave, removal) updates the database, broadcasts, and removes the person from
 * LiveKit together (CLAUDE.md rule 9). Voice channels are read before the write, so a failed read
 * fails the request with nothing changed; nothing after the write can fail it.
 */

/**
 * One row per direct invite remove_member revoked (ones the target created and ones addressed to
 * the target). invitee_profile_id is null when the invitee hasn't signed in yet.
 */
const RevokedInviteRows = z.array(
  z.object({ invite_id: z.guid(), invitee_profile_id: z.guid().nullable() }),
);

interface RevokedInvite {
  inviteId: string;
  inviteeProfileId: string;
}

interface DeletedMembership {
  voiceChannelIds: string[];
  revokedInvites: RevokedInvite[];
}

/** Parses remove_member's rows. The write has committed, so a bad shape is logged, not thrown. */
function parseRevokedInvites(data: unknown): RevokedInvite[] {
  const rows = RevokedInviteRows.safeParse(data ?? []);
  if (!rows.success) {
    // Issue paths and codes only: the rows carry ids.
    const issues = rows.error.issues.map(({ path, code }) => ({ path, code }));
    logger.error({ issues }, 'remove_member returned unexpected rows; invite:revoked not sent');
    return [];
  }
  return rows.data.flatMap(({ invite_id, invitee_profile_id }) =>
    invitee_profile_id
      ? [{ inviteId: invite_id.toLowerCase(), inviteeProfileId: invitee_profile_id.toLowerCase() }]
      : [],
  );
}

async function deleteMembership(roomId: string, actorId: string, targetId: string): Promise<DeletedMembership> {
  const voiceChannelIds = await listVoiceChannelIds(roomId);
  const { data, error } = await db
    .rpc('remove_member', { p_room: roomId, p_actor: actorId, p_target: targetId })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('remove_member', error);
  return { voiceChannelIds, revokedInvites: parseRevokedInvites(data) };
}

function broadcastRevokedInvites(revokedInvites: readonly RevokedInvite[]): Promise<boolean>[] {
  return revokedInvites.map(({ inviteId, inviteeProfileId }) =>
    broadcastToUser(inviteeProfileId, 'invite:revoked', { inviteId }),
  );
}

/** The caller leaves the room. The owner can't (409 OWNER_PROTECTED). */
export async function leaveRoom(roomId: string, profileId: string): Promise<void> {
  const { voiceChannelIds, revokedInvites } = await deleteMembership(roomId, profileId, profileId);
  await Promise.allSettled([
    broadcastToRoom(roomId, 'member:left', { roomId, userId: profileId }),
    removeFromVoice(voiceChannelIds, profileId),
    ...broadcastRevokedInvites(revokedInvites),
  ]);
}

/**
 * Removes another member (owner: anyone but themself; admin: plain members) and tells them on
 * their user topic. Targeting yourself is exactly leaveRoom.
 */
export async function removeMember(roomId: string, actorId: string, targetId: string): Promise<void> {
  if (targetId.toLowerCase() === actorId.toLowerCase()) return leaveRoom(roomId, actorId);

  const { voiceChannelIds, revokedInvites } = await deleteMembership(roomId, actorId, targetId);
  await Promise.allSettled([
    broadcastToRoom(roomId, 'member:left', { roomId, userId: targetId }),
    broadcastToUser(targetId, 'member:removed', { roomId }),
    removeFromVoice(voiceChannelIds, targetId),
    ...broadcastRevokedInvites(revokedInvites),
  ]);
}

/**
 * Owner only: sets another member's role to admin or member, tells the room, and returns the
 * member. member:role_changed and the read run concurrently: a slow broadcast doesn't delay the
 * response, and a failing read can't stop the broadcast (it has already been started).
 */
export async function changeRole(
  roomId: string,
  actorId: string,
  targetId: string,
  { role }: ChangeRoleBody,
): Promise<MemberShape> {
  const { error } = await db.rpc('change_role', { p_room: roomId, p_actor: actorId, p_target: targetId, p_role: role });
  if (error) throw rpcFailure('change_role', error, { field: 'params.userId' });

  // The broadcast never rejects, so a failing read rejects this without orphaning it.
  const [, member] = await Promise.all([
    broadcastToRoom(roomId, 'member:role_changed', { roomId, userId: targetId, role }),
    findMember(roomId, targetId),
  ]);
  // Null only if they left or were removed in between; they're no longer a member to return.
  if (!member) throw new NotFoundError();
  return member;
}

/**
 * Owner only: makes another member the owner; the caller becomes an admin. Returns the room as
 * the caller now sees it.
 */
export async function transferOwnership(roomId: string, actorId: string, targetId: string): Promise<RoomDetail> {
  const newOwnerId = targetId.toLowerCase();
  const { error } = await db.rpc('transfer_ownership', { p_room: roomId, p_from: actorId, p_to: newOwnerId });
  if (error) throw rpcFailure('transfer_ownership', error, { field: 'body.userId' });

  // In order (broadcasts never throw), so clients always see the old owner step down first.
  await broadcastToRoom(roomId, 'member:role_changed', { roomId, userId: actorId, role: 'admin' });
  await broadcastToRoom(roomId, 'member:role_changed', { roomId, userId: newOwnerId, role: 'owner' });
  return getRoomDetail(roomId, actorId);
}
