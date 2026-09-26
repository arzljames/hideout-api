import { ConflictError } from '../errors.js';
import { voiceReadLimiter, voiceTokenLimiter } from '../middleware/rateLimits.js';
import { authOf } from '../middleware/requireAuth.js';
import { channelOf, requireChannelMember } from '../middleware/requireChannelMember.js';
import { requireRoomMember, roomOf } from '../middleware/requireRoomMember.js';
import { issueVoiceToken, listRoomVoiceParticipants } from '../services/voice.js';
import { documentedRouter } from './documentedRouter.js';

// Both mounted below the global requireAuth; requireSameOrigin (CSRF) covers the token POST.
// The per-user limiters run before the membership checks: their key is the caller, so a 429
// reveals nothing about the channel or room, and probing ids is rate limited too.

/** `POST /api/channels/:channelId/voice/token`: any member of the channel's room. */
export const channelVoiceRouter = documentedRouter('/api/channels').post(
  '/:channelId/voice/token',
  voiceTokenLimiter,
  requireChannelMember(),
  async (req, res) => {
    const channel = channelOf(req);
    if (channel.type !== 'voice') throw new ConflictError('This is not a voice channel.', 'CHANNEL_NOT_VOICE');
    const token = await issueVoiceToken(channel.channelId, authOf(req).profileId);
    res.set('Cache-Control', 'no-store').json(token);
  },
);

/** `GET /api/rooms/:roomId/voice/participants`: any member. */
export const roomVoiceRouter = documentedRouter('/api/rooms').get(
  '/:roomId/voice/participants',
  voiceReadLimiter,
  requireRoomMember(),
  async (req, res) => {
    res.json(await listRoomVoiceParticipants(roomOf(req).roomId));
  },
);
