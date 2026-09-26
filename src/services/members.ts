import type { ChangeRoleBody } from '../contracts/http/members.js';
import type { RoomDetail } from '../contracts/http/rooms.js';
import { db } from '../db/client.js';
import { rpcFailure } from '../db/errors.js';
import { NotFoundError } from '../errors.js';
import { broadcastToRoom, broadcastToUser } from '../realtime/broadcast.js';
import { broadcastRevokedInvites, parseRevokedInvites, type RevokedInvite } from './revokedInvites.js';
import { findMember, getRoomDetail, listVoiceChannelIds, removeFromVoice, type MemberShape } from './rooms.js';

/*
 * Membership writes. Every rule is enforced by the Postgres function under the room lock
 * (remove_member, change_role, transfer_ownership; ban_member in services/bans.ts); the route
 * middleware is only a fast path.
 * Ids arrive lowercased (requireRoomMember / requireMemberTarget / the service for body ids).
 *
 * Revoking access (leave, removal, ban) updates the database, broadcasts, and removes the person from
 * LiveKit together (CLAUDE.md rule 9). Voice channels are read before the write, so a failed read
 * fails the request with nothing changed; nothing after the write can fail it.
 */

/** What a membership-ending write (remove_member, ban_member) left for the post-commit effects. */
export interface EndedMembership {
  /** The room's live voice channels, read before the write. */
  voiceChannelIds: string[];
  revokedInvites: RevokedInvite[];
}

async function deleteMembership(roomId: string, actorId: string, targetId: string): Promise<EndedMembership> {
  const voiceChannelIds = await listVoiceChannelIds(roomId);
  const { data, error } = await db
    .rpc('remove_member', { p_room: roomId, p_actor: actorId, p_target: targetId })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw rpcFailure('remove_member', error);
  return { voiceChannelIds, revokedInvites: parseRevokedInvites('remove_member', data) };
}

/**
 * The post-commit side effects of someone losing membership (leave, removal, ban): member:left
 * on the room, member:removed on their user topic (removal and ban only; `banned: true` for a
 * ban), LiveKit removal from every voice channel, and invite:revoked to each signed-in invitee
 * of a revoked direct invite. Never rejects: the write has committed.
 */
export async function announceMembershipEnded(
  roomId: string,
  userId: string,
  { voiceChannelIds, revokedInvites }: EndedMembership,
  removal: 'left' | 'removed' | 'banned',
): Promise<void> {
  const notifyTarget =
    removal === 'left'
      ? []
      : [broadcastToUser(userId, 'member:removed', removal === 'banned' ? { roomId, banned: true } : { roomId })];
  await Promise.allSettled([
    broadcastToRoom(roomId, 'member:left', { roomId, userId }),
    ...notifyTarget,
    removeFromVoice(voiceChannelIds, userId),
    ...broadcastRevokedInvites(revokedInvites),
  ]);
}

/** The caller leaves the room. The owner can't (409 OWNER_PROTECTED). */
export async function leaveRoom(roomId: string, profileId: string): Promise<void> {
  const ended = await deleteMembership(roomId, profileId, profileId);
  await announceMembershipEnded(roomId, profileId, ended, 'left');
}

/**
 * Removes another member (owner: anyone but themself; admin: plain members) and tells them on
 * their user topic. Targeting yourself is exactly leaveRoom.
 */
export async function removeMember(roomId: string, actorId: string, targetId: string): Promise<void> {
  if (targetId.toLowerCase() === actorId.toLowerCase()) return leaveRoom(roomId, actorId);

  const ended = await deleteMembership(roomId, actorId, targetId);
  await announceMembershipEnded(roomId, targetId, ended, 'removed');
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
