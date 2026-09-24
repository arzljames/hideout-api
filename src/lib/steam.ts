import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/*
 * Steam OpenID 2.0 sign-in and the Steam Web API, with plain fetch (no OpenID library).
 * Never log request URLs here: GetPlayerSummaries carries STEAM_API_KEY in its query.
 */

export const STEAM_OP_ENDPOINT = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const REQUIRED_SIGNED = ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle'];
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_ID_PATTERN = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const TIMEOUT_MS = 5_000;
const MAX_DISPLAY_NAME = 64;

export type SteamVerifyFailure = 'STEAM_LOGIN_FAILED' | 'STEAM_UNAVAILABLE';
export type SteamVerifyResult = { ok: true; steamId: string } | { ok: false; reason: SteamVerifyFailure };

/** Exact return_to URL sent to Steam and required back on the callback. */
export function steamReturnTo(state: string): string {
  return `${env.API_URL}/api/auth/steam/callback?state=${encodeURIComponent(state)}`;
}

export function buildLoginUrl(state: string): string {
  const params = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': steamReturnTo(state),
    'openid.realm': env.API_URL,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT,
  });
  return `${STEAM_OP_ENDPOINT}?${params.toString()}`;
}

/** All `openid.*` query params, or null if any of them is repeated or not a plain string. */
function openIdParams(query: Record<string, unknown>): Map<string, string> | null {
  const params = new Map<string, string>();
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('openid.')) continue;
    if (typeof value !== 'string') return null;
    params.set(key, value);
  }
  return params;
}

const fail = (reason: SteamVerifyFailure): SteamVerifyResult => ({ ok: false, reason });

/**
 * Checks the positive assertion Steam sent to the callback, then asks Steam to confirm
 * the signature (check_authentication). STEAM_LOGIN_FAILED means the assertion is
 * invalid; STEAM_UNAVAILABLE means Steam couldn't be asked (network, timeout, non-2xx).
 */
export async function verifyCallback(
  query: Record<string, unknown>,
  expectedReturnTo: string,
): Promise<SteamVerifyResult> {
  const params = openIdParams(query);
  if (!params) return fail('STEAM_LOGIN_FAILED');
  if (params.get('openid.ns') !== OPENID_NS) return fail('STEAM_LOGIN_FAILED');
  if (params.get('openid.mode') !== 'id_res') return fail('STEAM_LOGIN_FAILED');
  // OpenID 2.0 §11.4: these fields must be covered by the signature Steam verifies.
  const signed = new Set((params.get('openid.signed') ?? '').split(','));
  if (!REQUIRED_SIGNED.every((field) => signed.has(field))) return fail('STEAM_LOGIN_FAILED');
  if (params.get('openid.return_to') !== expectedReturnTo) return fail('STEAM_LOGIN_FAILED');
  if (params.get('openid.op_endpoint') !== STEAM_OP_ENDPOINT) return fail('STEAM_LOGIN_FAILED');

  const claimedId = params.get('openid.claimed_id') ?? '';
  const steamId = CLAIMED_ID_PATTERN.exec(claimedId)?.[1];
  if (!steamId || params.get('openid.identity') !== claimedId) return fail('STEAM_LOGIN_FAILED');

  const body = new URLSearchParams(params);
  body.set('openid.mode', 'check_authentication');

  let text: string;
  try {
    const res = await fetch(STEAM_OP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      logger.warn({ status: res.status }, 'steam check_authentication returned non-2xx');
      return fail('STEAM_UNAVAILABLE');
    }
    text = await res.text();
  } catch (err) {
    logger.warn({ err }, 'steam check_authentication request failed');
    return fail('STEAM_UNAVAILABLE');
  }

  const valid = text.split(/\r?\n/).some((line) => line === 'is_valid:true');
  return valid ? { ok: true, steamId } : fail('STEAM_LOGIN_FAILED');
}

const PlayerSummaries = z.object({
  response: z.object({
    players: z.array(
      z.object({
        steamid: z.string(),
        personaname: z.string().optional(),
        avatarfull: z.string().optional(),
      }),
    ),
  }),
});

export interface PlayerSummary {
  displayName: string;
  avatarUrl: string | null;
}

/** Name used when Steam gives us none. */
export function fallbackDisplayName(steamId: string): string {
  return `Steam user ${steamId.slice(-4)}`;
}

/** Trimmed and cut to 64 code points (the database counts characters, not UTF-16 units). */
function cleanDisplayName(name: string | undefined, steamId: string): string {
  // Control characters (e.g. NUL) are rejected by Postgres and render badly; drop them.
  const cleaned = (name ?? '').replace(/\p{Cc}/gu, '').trim();
  const trimmed = Array.from(cleaned).slice(0, MAX_DISPLAY_NAME).join('').trim();
  return trimmed || fallbackDisplayName(steamId);
}

/** Public profile from the Steam Web API, or null on any failure. */
export async function getPlayerSummary(steamId: string): Promise<PlayerSummary | null> {
  const url =
    'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/' +
    `?key=${encodeURIComponent(env.STEAM_API_KEY)}&steamids=${encodeURIComponent(steamId)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      logger.warn({ status: res.status }, 'steam GetPlayerSummaries returned non-2xx');
      return null;
    }
    const parsed = PlayerSummaries.safeParse(await res.json());
    const player = parsed.success ? parsed.data.response.players.find((p) => p.steamid === steamId) : undefined;
    if (!player) {
      logger.warn('steam GetPlayerSummaries returned no usable player');
      return null;
    }
    const avatar = player.avatarfull;
    return {
      displayName: cleanDisplayName(player.personaname, steamId),
      avatarUrl: avatar?.startsWith('https://') ? avatar : null,
    };
  } catch {
    // Not logging err: fetch errors can echo the request URL, which holds the API key.
    logger.warn('steam GetPlayerSummaries request failed');
    return null;
  }
}
