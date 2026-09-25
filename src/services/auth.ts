import { Me, type AuthRedirectErrorCode } from '../contracts/http/auth.js';
import { db } from '../db/client.js';
import { fallbackDisplayName, getPlayerSummary, steamReturnTo, verifyCallback } from '../lib/steam.js';
import { InternalError } from '../errors.js';
import { hashSessionToken, newSessionToken, SESSION_TTL_SECONDS, TOKEN_PATTERN } from '../lib/session.js';

export interface AuthSession {
  profileId: string;
  sessionId: string;
}

export interface SteamProfile {
  steamId: string;
  displayName: string;
  avatarUrl: string | null;
  /** True when Steam's profile API failed: an existing profile keeps its stored name and avatar. */
  keepExistingProfile: boolean;
}

interface DbError {
  code?: string;
  message?: string;
}

/** Keeps only the Postgres code and message for logs; details/hints can carry row values. */
function dbFailure(operation: string, error: DbError): InternalError {
  const cause = new Error(`${operation} failed: ${error.message ?? 'unknown error'}`);
  return new InternalError(Object.assign(cause, { code: error.code }));
}

/** Returns the live session for a cookie token, or null if it is malformed, unknown, or expired. */
export async function findSession(token: string | undefined): Promise<AuthSession | null> {
  if (!token || !TOKEN_PATTERN.test(token)) return null;

  const { data, error } = await db
    .from('sessions')
    .select('id, profile_id')
    .eq('token_hash', hashSessionToken(token))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle<{ id: string; profile_id: string }>();

  if (error) throw dbFailure('session lookup', error);
  return data ? { profileId: data.profile_id, sessionId: data.id } : null;
}

/** Upserts the profile and creates a session atomically. Returns the raw token for the cookie. */
export async function createLoginSession(profile: SteamProfile): Promise<string> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  const { error } = await db.rpc('create_login_session', {
    p_steam_id: profile.steamId,
    p_display_name: profile.displayName,
    p_avatar_url: profile.avatarUrl,
    p_token_hash: hashSessionToken(token),
    p_expires_at: expiresAt.toISOString(),
    p_keep_existing_profile: profile.keepExistingProfile,
  });

  if (error) throw dbFailure('create_login_session', error);
  return token;
}

export type SteamLoginResult = { ok: true; token: string } | { ok: false; reason: AuthRedirectErrorCode };

/**
 * Verifies the Steam callback and signs the user in. `state` must already be checked
 * against the state cookie; it rebuilds the exact return_to Steam must echo back.
 */
export async function completeSteamLogin(query: Record<string, unknown>, state: string): Promise<SteamLoginResult> {
  const verified = await verifyCallback(query, steamReturnTo(state));
  if (!verified.ok) return verified;

  const { steamId } = verified;
  const summary = await getPlayerSummary(steamId);
  const token = await createLoginSession({
    steamId,
    displayName: summary?.displayName ?? fallbackDisplayName(steamId),
    avatarUrl: summary?.avatarUrl ?? null,
    keepExistingProfile: summary === null,
  });
  return { ok: true, token };
}

export async function deleteSession(sessionId: string): Promise<void> {
  const { error } = await db.from('sessions').delete().eq('id', sessionId);
  if (error) throw dbFailure('session delete', error);
}

export async function deleteAllSessions(profileId: string): Promise<void> {
  const { error } = await db.from('sessions').delete().eq('profile_id', profileId);
  if (error) throw dbFailure('session delete-all', error);
}

/** Deletes the session behind a cookie token, if it is live. No-op for a missing or unknown token. */
export async function endSessionByToken(token: string | undefined): Promise<void> {
  if (!token) return;
  const session = await findSession(token);
  if (session) await deleteSession(session.sessionId);
}

/**
 * The signed-in user's own profile, or null if the profile row is gone. A stored avatar
 * that isn't a valid https URL comes back as null instead of failing the request.
 */
export async function getProfile(profileId: string): Promise<Me | null> {
  const { data, error } = await db
    .from('profiles')
    .select('id, steam_id, display_name, avatar_url')
    .eq('id', profileId)
    .maybeSingle<{ id: string; steam_id: string; display_name: string; avatar_url: string | null }>();

  if (error) throw dbFailure('profile lookup', error);
  if (!data) return null;

  const avatar = Me.shape.avatarUrl.safeParse(data.avatar_url);
  const parsed = Me.safeParse({
    id: data.id,
    steamId: data.steam_id,
    displayName: data.display_name,
    avatarUrl: avatar.success ? avatar.data : null,
  });
  // A row that breaks the contract is a server bug; never send a partial or invalid body.
  if (!parsed.success) throw new InternalError(new Error('profile row does not match the Me schema'));
  return parsed.data;
}
