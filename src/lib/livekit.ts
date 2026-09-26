import { RoomServiceClient, ServerError, WebhookReceiver } from 'livekit-server-sdk';
import { env } from '../config/env.js';

function httpUrl(url: string): string {
  return url.replace(/^ws(s?):\/\//, 'http$1://');
}

export const livekitRooms = new RoomServiceClient(
  httpUrl(env.LIVEKIT_URL),
  env.LIVEKIT_API_KEY,
  env.LIVEKIT_API_SECRET,
);

export const livekitWebhooks = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

export function voiceRoomName(channelId: string): string {
  return `voice_${channelId}`;
}

export const VOICE_ROOM_PREFIX = 'voice_';

// Lowercase only: voiceRoomName always writes lowercase ids, so that is the one canonical form.
const VOICE_ROOM_NAME = /^voice_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * The channel id of a canonical `voice_<lowercase uuid>` LiveKit room name, or null for any
 * other name (including `voice_` names in another case). Room names come from LiveKit webhooks,
 * so anything else is never trusted.
 */
export function parseVoiceRoomName(name: string): string | null {
  return VOICE_ROOM_NAME.exec(name)?.[1] ?? null;
}

/**
 * True only for LiveKit's "not found" (Twirp code `not_found` or HTTP 404), e.g. deleting a
 * room nobody ever joined. Anything else, including network errors, is a real failure.
 */
export function isLivekitNotFound(err: unknown): boolean {
  return err instanceof ServerError && (err.code === 'not_found' || err.status === 404);
}
