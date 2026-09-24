import { z } from 'zod';
import {
  serverEvents,
  topics,
  type ServerEventName,
  type ServerEventPayload,
  type TopicKind,
} from '../contracts/events.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/*
 * Server-side Broadcast via the Realtime REST endpoint: one stateless POST per event,
 * no supabase-js channel objects (those buffer leave messages on a socket that never
 * connects). Call only after the database write succeeds.
 *
 * Never throws: the write has already committed, so every failure (delivery, or an
 * invalid id/payload, which is a bug) is logged and reported as `false`. Clients
 * backfill via GET /api/channels/:id/messages?after=<lastMessageId>.
 */

const BROADCAST_URL = `${env.SUPABASE_URL}/realtime/v1/api/broadcast`;
const TIMEOUT_MS = 5_000;

// Ids go into topic strings, so anything but an id could address the wrong topic.
const TopicId = z.guid();

/** Low-level send to a private topic. Resolves true on 2xx. */
export async function sendBroadcast(topic: string, event: string, payload: object): Promise<boolean> {
  const res = await fetch(BROADCAST_URL, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ topic, event, payload, private: true }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.body?.cancel();
  return res.ok;
}

async function broadcast<K extends TopicKind, E extends ServerEventName<K>>(
  kind: K,
  id: string,
  event: E,
  payload: ServerEventPayload<K, E>,
): Promise<boolean> {
  const schema = (serverEvents[kind] as Record<string, z.ZodType>)[event];
  const parsedId = TopicId.safeParse(id);
  // Parsing strips unknown keys, so a payload can't carry fields the contract doesn't define.
  const parsed = schema?.safeParse(payload);
  if (!schema || !parsedId.success || !parsed?.success) {
    logger.error(
      { kind, event, issues: parsed?.error?.issues.map((i) => i.path.join('.')), validId: parsedId.success },
      'invalid realtime broadcast (bug): not sent',
    );
    return false;
  }

  const topic = topics[kind](parsedId.data);
  try {
    const ok = await sendBroadcast(topic, event, parsed.data as object);
    if (!ok) logger.warn({ topic, event }, 'realtime broadcast rejected');
    return ok;
  } catch (err) {
    logger.warn({ topic, event, err }, 'realtime broadcast failed');
    return false;
  }
}

export function broadcastToChannel<E extends ServerEventName<'channel'>>(
  channelId: string,
  event: E,
  payload: ServerEventPayload<'channel', E>,
): Promise<boolean> {
  return broadcast('channel', channelId, event, payload);
}

export function broadcastToRoom<E extends ServerEventName<'room'>>(
  roomId: string,
  event: E,
  payload: ServerEventPayload<'room', E>,
): Promise<boolean> {
  return broadcast('room', roomId, event, payload);
}

export function broadcastToUser<E extends ServerEventName<'user'>>(
  profileId: string,
  event: E,
  payload: ServerEventPayload<'user', E>,
): Promise<boolean> {
  return broadcast('user', profileId, event, payload);
}
