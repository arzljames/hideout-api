import { AccessToken, ParticipantInfo_State, TrackSource, type ParticipantInfo, type WebhookEvent } from 'livekit-server-sdk';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { ProfileSummary } from '../contracts/http/rooms.js';
import { VOICE_TOKEN_TTL_SECONDS, type VoiceParticipantList, type VoiceToken } from '../contracts/http/voice.js';
import { db } from '../db/client.js';
import { dbFailure } from '../db/errors.js';
import { InternalError, ServiceUnavailableError, UnauthenticatedError } from '../errors.js';
import { isLivekitNotFound, livekitRooms, parseVoiceRoomName, VOICE_ROOM_PREFIX, voiceRoomName } from '../lib/livekit.js';
import { logger } from '../lib/logger.js';
import { broadcastToRoom } from '../realtime/broadcast.js';
import { getProfile } from './auth.js';
import { findChannelAccess } from './channels.js';
import { PROFILE_COLUMNS, ProfileRow, toProfileSummary } from './profiles.js';

/*
 * Voice. LiveKit is the source of truth for who is connected; Postgres decides who may be.
 * Tokens only let a member *join* for VOICE_TOKEN_TTL_SECONDS (LiveKit refreshes them for
 * connected participants). Revocation is removeParticipant with LiveKit's default token
 * revocation (see removeWithRetry in rooms.ts). Backstops for a removal LiveKit never got: the
 * webhook kicks any non-member who joins, and every participant list read kicks connected
 * non-members.
 * Docs (checked 2026-09-26):
 *   https://docs.livekit.io/home/get-started/authentication/
 *   https://docs.livekit.io/home/server/managing-participants/
 *   https://docs.livekit.io/home/server/webhooks/
 */

type ProfileSummaryShape = z.infer<typeof ProfileSummary>;

const Uuid = z.guid();

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * A LiveKit join token for one voice channel. The caller must already have passed
 * requireChannelMember and the voice-type check; identity comes from the session, never the request.
 */
export async function issueVoiceToken(channelId: string, profileId: string): Promise<VoiceToken> {
  const profile = await getProfile(profileId);
  // A valid session whose profile is gone is treated as signed out (as GET /api/auth/me does).
  if (!profile) throw new UnauthenticatedError();

  const roomName = voiceRoomName(channelId.toLowerCase());
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: profileId.toLowerCase(),
    name: profile.displayName,
    ttl: VOICE_TOKEN_TTL_SECONDS,
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    roomCreate: false,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  // Floor to whole seconds like the SDK's exp; toJwt() also sets nbf = now, which LiveKit's revocation compares against.
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await at.toJwt();
  return {
    token,
    url: env.LIVEKIT_URL,
    roomName,
    expiresAt: new Date((issuedAt + VOICE_TOKEN_TTL_SECONDS) * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Kicking
// ---------------------------------------------------------------------------

/**
 * One attempt to remove someone who is connected to a voice room they may not be in. No options,
 * so LiveKit's default revocation also invalidates their earlier tokens. Never throws.
 */
async function kickFromVoice(roomName: string, identity: string, channelId: string | null, why: string): Promise<void> {
  try {
    await livekitRooms.removeParticipant(roomName, identity);
    logger.warn({ channelId }, `${why}; removed from LiveKit`);
  } catch (err) {
    if (isLivekitNotFound(err)) logger.debug({ channelId }, `${why}; already gone`);
    else logger.warn({ err, channelId }, `${why}; could not remove non-member from LiveKit room`);
  }
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

function joinedAtMs(p: ParticipantInfo): bigint {
  return p.joinedAtMs > 0n ? p.joinedAtMs : p.joinedAt * 1000n;
}

/**
 * Participants connected to a voice channel's LiveKit room, in join order. A room that doesn't
 * exist (nobody joined yet) is empty. `excludeSid` drops a participant a participant_left
 * webhook is about, in case LiveKit still lists them.
 */
async function connectedParticipants(channelId: string, excludeSid?: string): Promise<ParticipantInfo[]> {
  let participants: ParticipantInfo[];
  try {
    participants = await livekitRooms.listParticipants(voiceRoomName(channelId));
  } catch (err) {
    if (isLivekitNotFound(err)) return [];
    throw err;
  }
  return participants
    .filter((p) => p.state !== ParticipantInfo_State.DISCONNECTED && p.sid !== excludeSid)
    .sort((a, b) => {
      const diff = joinedAtMs(a) - joinedAtMs(b);
      return diff < 0n ? -1 : diff > 0n ? 1 : 0;
    });
}

/** The lowercased profile id a LiveKit identity names, or null if it isn't a uuid. */
function identityProfileId(identity: string): string | null {
  const id = Uuid.safeParse(identity);
  return id.success ? id.data.toLowerCase() : null;
}

const MemberProfileRow = z.object({ user_id: z.guid(), profiles: ProfileRow.nullable() });

/** ProfileSummary of each given profile that is currently a member of the room, keyed by lowercased id. */
async function memberProfiles(roomId: string, profileIds: readonly string[]): Promise<Map<string, ProfileSummaryShape>> {
  const result = new Map<string, ProfileSummaryShape>();
  if (profileIds.length === 0) return result;

  const { data, error } = await db
    .from('room_members')
    .select(`user_id, profiles!inner(${PROFILE_COLUMNS})`)
    .eq('room_id', roomId)
    .in('user_id', [...profileIds])
    .overrideTypes<unknown[], { merge: false }>();
  if (error) throw dbFailure('voice participant profiles', error);

  const rows = z.array(MemberProfileRow).safeParse(data);
  if (!rows.success) throw new InternalError(new Error('voice participant profiles returned an unexpected shape'));
  for (const { profiles: profile } of rows.data) {
    if (profile) result.set(profile.id.toLowerCase(), toProfileSummary(profile));
  }
  return result;
}

function uuidIdentities(participants: readonly ParticipantInfo[]): string[] {
  return [...new Set(participants.flatMap((p) => identityProfileId(p.identity) ?? []))];
}

/**
 * Maps one channel's connected participants to member profiles (join order, one entry per
 * person) and kicks everyone connected who isn't a current member of the room, including
 * non-uuid identities: a backstop for removals LiveKit never received. Kicks never fail the caller.
 */
async function membersInChannel(
  channelId: string,
  participants: readonly ParticipantInfo[],
  profiles: ReadonlyMap<string, ProfileSummaryShape>,
): Promise<ProfileSummaryShape[]> {
  const members = new Map<string, ProfileSummaryShape>();
  const strangers = new Set<string>();
  for (const p of participants) {
    const id = identityProfileId(p.identity);
    const profile = id ? profiles.get(id) : undefined;
    if (profile) members.set(profile.id, profile);
    else strangers.add(p.identity);
  }
  const roomName = voiceRoomName(channelId);
  await Promise.allSettled(
    [...strangers].map((identity) =>
      kickFromVoice(roomName, identity, channelId, 'non-member connected to a voice channel'),
    ),
  );
  return [...members.values()];
}

/** Profiles of the room members connected to one voice channel, in join order. Used by the webhook. */
export async function listChannelParticipants(
  roomId: string,
  channelId: string,
  excludeSid?: string,
): Promise<ProfileSummaryShape[]> {
  const participants = await connectedParticipants(channelId, excludeSid);
  const profiles = await memberProfiles(roomId, uuidIdentities(participants));
  return membersInChannel(channelId, participants, profiles);
}

/**
 * Every live voice channel of the room with its participants, by channel position. A channel
 * LiveKit can't list is logged and shown empty rather than failing the whole read.
 */
export async function listRoomVoiceParticipants(roomId: string): Promise<VoiceParticipantList> {
  const { data, error } = await db
    .from('channels')
    .select('id')
    .eq('room_id', roomId)
    .eq('type', 'voice')
    .is('deleted_at', null)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .overrideTypes<{ id: string }[], { merge: false }>();
  if (error) throw dbFailure('voice channel list', error);

  const channelIds = data.map((channel) => channel.id.toLowerCase());
  const settled = await Promise.allSettled(channelIds.map((channelId) => connectedParticipants(channelId)));
  const perChannel = settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    logger.warn({ err: result.reason as unknown, channelId: channelIds[i] }, 'could not list LiveKit participants; showing none');
    return [];
  });
  const profiles = await memberProfiles(roomId, uuidIdentities(perChannel.flat()));
  const lists = await Promise.all(
    channelIds.map((channelId, i) => membersInChannel(channelId, perChannel[i] ?? [], profiles)),
  );
  return { data: channelIds.map((channelId, i) => ({ channelId, participants: lists[i] ?? [] })) };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

const LiveVoiceChannelRow = z.object({ room_id: z.guid() });

/** The room of a live voice channel in a live room, or null. */
async function findLiveVoiceChannelRoom(channelId: string): Promise<string | null> {
  const { data, error } = await db
    .from('channels')
    .select('room_id, rooms!inner(id)')
    .eq('id', channelId)
    .eq('type', 'voice')
    .is('deleted_at', null)
    .is('rooms.deleted_at', null)
    .maybeSingle<unknown>();
  if (error) throw dbFailure('voice channel lookup', error);
  if (data === null) return null;
  const row = LiveVoiceChannelRow.safeParse(data);
  if (!row.success) throw new InternalError(new Error('voice channel lookup returned an unexpected shape'));
  return row.data.room_id.toLowerCase();
}

/**
 * Handles a verified LiveKit webhook. Events and rooms Hideout doesn't use are ignored.
 * Throws ServiceUnavailableError when a participant_joined can't be checked against the
 * database (the route answers 503 so LiveKit retries: failing open would let a removed member
 * stay). Any other throw (database or LiveKit failure) is logged by the route and acknowledged.
 */
export async function handleLivekitWebhook(event: WebhookEvent): Promise<void> {
  const roomName = event.room?.name ?? '';
  const identity = event.participant?.identity ?? '';
  const channelId = parseVoiceRoomName(roomName);

  if (!channelId) {
    // Tokens only ever name canonical rooms; anyone in another voice_ room gets there some other way.
    if (event.event === 'participant_joined' && identity && roomName.startsWith(VOICE_ROOM_PREFIX)) {
      await kickFromVoice(roomName, identity, null, 'participant joined a non-canonical voice room');
    }
    return;
  }

  switch (event.event) {
    case 'participant_joined': {
      if (!identity) return;
      const profileId = identityProfileId(identity);
      let access: Awaited<ReturnType<typeof findChannelAccess>> = null;
      if (profileId) {
        try {
          access = await findChannelAccess(channelId, profileId);
        } catch (err) {
          throw new ServiceUnavailableError(err instanceof InternalError ? err.cause : err);
        }
      }
      if (!access || access.type !== 'voice') {
        await kickFromVoice(roomName, identity, channelId, 'non-member joined a voice channel');
        return;
      }
      const participants = await listChannelParticipants(access.roomId, channelId);
      await broadcastToRoom(access.roomId, 'voice:participants', { channelId, participants });
      return;
    }
    case 'participant_left':
    case 'participant_connection_aborted':
    case 'room_finished': {
      const roomId = await findLiveVoiceChannelRoom(channelId);
      // A deleted channel or room already told everyone (channel:deleted / room:deleted).
      if (!roomId) return;
      const participants =
        event.event === 'room_finished'
          ? []
          : await listChannelParticipants(roomId, channelId, event.participant?.sid || undefined);
      await broadcastToRoom(roomId, 'voice:participants', { channelId, participants });
      return;
    }
    default:
      return;
  }
}
