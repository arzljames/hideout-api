import { z } from 'zod';
import { authedErrors, errorResponse } from './common.js';
import { ChannelIdParams } from './channels.js';
import { registry } from './registry.js';
import { ProfileSummary, RoomIdParams } from './rooms.js';

/*
 * Voice: LiveKit join tokens, who is in each voice channel, and the LiveKit webhook that keeps
 * `voice:participants` up to date. Speaking/muted/deafened state lives only in LiveKit.
 */

/** Seconds a voice token can be used to *join*. LiveKit refreshes it for connected participants. */
export const VOICE_TOKEN_TTL_SECONDS = 60;

export const VoiceToken = registry.register(
  'VoiceToken',
  z.object({
    token: z.string().min(1).openapi({ description: 'LiveKit access token for `room.connect(url, token)`.' }),
    url: z.string().min(1).openapi({ description: 'LiveKit server URL (`wss://...`).', example: 'wss://hideout.livekit.cloud' }),
    roomName: z.string().min(1).openapi({
      description: 'The LiveKit room the token joins (`voice_<channelId>`). Informational; the token already names it.',
      example: 'voice_6f1c2a4e-8b1d-4c3a-9e2f-0a1b2c3d4e5f',
    }),
    expiresAt: z.iso.datetime({ offset: true }).openapi({
      example: '2026-09-25T10:01:00.000Z',
      description:
        `When the token stops being usable to join (${VOICE_TOKEN_TTL_SECONDS} seconds after issue). Fetch a token ` +
        'right before connecting, never ahead of time. Once connected, LiveKit refreshes it automatically; after a ' +
        'disconnect, fetch a new one to rejoin.',
    }),
  }),
);
export type VoiceToken = z.infer<typeof VoiceToken>;

export const VoiceChannelParticipants = registry.register(
  'VoiceChannelParticipants',
  z.object({
    channelId: z.guid(),
    participants: z.array(ProfileSummary).openapi({
      description: 'Room members currently in the voice channel, in the order they joined.',
    }),
  }),
);
export type VoiceChannelParticipants = z.infer<typeof VoiceChannelParticipants>;

export const VoiceParticipantList = registry.register(
  'VoiceParticipantList',
  z.object({
    data: z.array(VoiceChannelParticipants).openapi({
      description: 'One entry per live voice channel of the room (empty channels included), by channel position.',
    }),
  }),
);
export type VoiceParticipantList = z.infer<typeof VoiceParticipantList>;

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const serverError = errorResponse('Unexpected server error.');

registry.registerPath({
  method: 'post',
  path: '/api/channels/{channelId}/voice/token',
  tags: ['voice'],
  summary: 'Get a voice token',
  description:
    'Any member of the channel’s room. Returns a LiveKit token (identity = your profile id) that can join ' +
    `this voice channel for ${VOICE_TOKEN_TTL_SECONDS} seconds; connect immediately. It allows publishing your ` +
    'microphone only (no camera, screen share, or data messages). When you are removed from the room, banned, ' +
    'or the channel or room is deleted, you are disconnected and tokens issued before then stop working (so a ' +
    'member who leaves and is re-invited may need to wait about a minute to rejoin that voice channel). ' +
    'No request body: send `Content-Type: application/json` (the CSRF check requires it) with an empty body or ' +
    '`{}`; any body is ignored, but it must be valid JSON if present. Sent with `Cache-Control: no-store`. ' +
    'Rate limited to 20/minute per user (counted before the membership check). Non-members get 404.',
  request: { params: ChannelIdParams },
  responses: {
    200: { description: 'A LiveKit join token.', content: json(VoiceToken) },
    ...authedErrors,
    400: errorResponse('`INVALID_JSON`: a body was sent and it is not valid JSON.'),
    403: errorResponse('Origin or Content-Type check failed (send `Content-Type: application/json` from WEB_ORIGIN).'),
    404: errorResponse(
      'Channel not found or deleted, its room is deleted, or you are not a member of its room (non-members always get 404).',
    ),
    409: errorResponse('`CHANNEL_NOT_VOICE`: the channel is a text channel.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms/{roomId}/voice/participants',
  tags: ['voice'],
  summary: 'Who is in each voice channel',
  description:
    'Any member. The current participants of every live voice channel in the room, read from LiveKit. Load it ' +
    'when opening a room and after reconnecting to Realtime; afterwards `voice:participants` on `room:<roomId>` ' +
    'carries the full list for one channel whenever it changes (replace, don’t merge). A channel whose ' +
    'participants LiveKit can’t list right now is returned with an empty list. Rate limited to 60/minute per ' +
    'user (counted before the membership check). Non-members get 404.',
  request: { params: RoomIdParams },
  responses: {
    200: { description: 'Participants per voice channel.', content: json(VoiceParticipantList) },
    ...authedErrors,
    404: errorResponse('Room not found, deleted, or you are not a member (non-members always get 404).'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/livekit/webhook',
  tags: ['voice'],
  summary: 'LiveKit webhook (server to server)',
  description:
    'Called by LiveKit, not by browsers. Configure `API_URL/api/livekit/webhook` as the webhook URL in LiveKit ' +
    'Cloud. The body is a LiveKit `WebhookEvent` sent as `application/webhook+json`, signed by the JWT in the ' +
    '`Authorization` header (checked against the raw body with the LiveKit API secret). Unsigned or tampered ' +
    'requests get 401 and change nothing. A verified event gets 200, even one that is ignored or fails ' +
    'internally (failures are logged), so LiveKit doesn’t retry it; the exception is a `participant_joined` ' +
    'whose membership can’t be checked (database unavailable), which gets 503 so LiveKit retries it. ' +
    '`participant_joined`, `participant_left`, `participant_connection_aborted`, and `room_finished` on ' +
    '`voice_<channelId>` rooms broadcast `voice:participants`. A participant who joins without being a member ' +
    'of the channel’s room (or joins a non-canonical `voice_` room) is removed from LiveKit, and every ' +
    'participant list read removes connected non-members. ' +
    'Rate limited to 600/minute per IP.',
  security: [],
  request: {
    body: {
      required: true,
      description: 'A LiveKit webhook event (see https://docs.livekit.io/home/server/webhooks/).',
      content: {
        'application/webhook+json': {
          schema: z
            .object({ event: z.string(), id: z.string().optional(), createdAt: z.union([z.string(), z.number()]).optional() })
            .catchall(z.unknown())
            .openapi({ description: 'LiveKit `WebhookEvent` (protobuf JSON). Only the fields Hideout reads are listed.' }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Verified and acknowledged (handled or deliberately ignored).' },
    401: errorResponse(
      '`INVALID_SIGNATURE`: missing or invalid `Authorization` signature, a body that doesn’t match it, or a ' +
        'Content-Type other than `application/webhook+json`.',
    ),
    413: errorResponse('`PAYLOAD_TOO_LARGE`: the body is over 100 kB.'),
    429: authedErrors[429],
    503: errorResponse(
      '`SERVICE_UNAVAILABLE`: a `participant_joined` could not be checked against room membership; LiveKit retries.',
    ),
  },
});
