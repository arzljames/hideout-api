import { RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
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
