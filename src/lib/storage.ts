import { z } from 'zod';
import { db } from '../db/client.js';
import { logger } from './logger.js';

const ROOM_ICONS_BUCKET = 'room-icons';
const SIGNED_URL_TTL_SECONDS = 3600;
// Signed URLs are rendered by every member's browser, so only https ones are returned.
const HttpsUrl = z.url({ protocol: /^https$/ });

/**
 * Signs room icon object paths in the private room-icons bucket. Never throws: a path that
 * can't be signed (or the whole call failing) is left out of the map and logged, so the
 * caller can fall back instead of failing the request. Paths and URLs are never logged.
 */
export async function signRoomIconUrls(paths: string[]): Promise<Map<string, string>> {
  const signed = new Map<string, string>();
  const unique = [...new Set(paths)];
  if (unique.length === 0) return signed;

  try {
    const { data, error } = await db.storage.from(ROOM_ICONS_BUCKET).createSignedUrls(unique, SIGNED_URL_TTL_SECONDS);
    if (error) {
      logger.warn({ err: error }, 'room icon signing failed');
      return signed;
    }
    for (const item of data) {
      const url = HttpsUrl.safeParse(item.signedUrl);
      if (item.path && !item.error && url.success) signed.set(item.path, url.data);
    }
    if (signed.size < unique.length) {
      logger.warn({ requested: unique.length, signed: signed.size }, 'some room icons could not be signed');
    }
  } catch (err) {
    logger.warn({ err }, 'room icon signing failed');
  }
  return signed;
}
