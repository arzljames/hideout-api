import { z } from 'zod';
import { Ban, STEAM_ID_PATTERN, type BanPage, type ListBansQuery } from '../contracts/http/bans.js';
import { db } from '../db/client.js';
import { dbFailure, rpcFailure, type DbError } from '../db/errors.js';
import { ConflictError, InternalError, type AppError, NotFoundError, ValidationError } from '../errors.js';
import { logger } from '../lib/logger.js';
import { announceMembershipEnded } from './members.js';
import { PROFILE_COLUMNS, ProfileRow, toProfileSummary } from './profiles.js';
import { parseRevokedInvites } from './revokedInvites.js';
import { listVoiceChannelIds } from './rooms.js';

/*
 * Room bans (owner/admin). Bans are keyed by SteamID64 in public.room_bans; ban_member and
 * unban enforce every rule under the room lock (requireRoomMember('admin') is a fast path).
 * Ids arrive lowercased (requireRoomMember; body ids are lowercased here).
 *
 * Banning revokes access like a removal (CLAUDE.md rule 9): everything that can fail the request
 * is read before ban_member, and the post-commit effects never fail it.
 */

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const SteamProfileRow = ProfileRow.extend({ steam_id: z.string() });

/**
 * A room_bans row with the issuer embedded (room_bans.banned_by -> profiles; null once deleted).
 * The embed names the FK (Postgres' default name for the unnamed banned_by constraint in the
 * membership migration) so it can't become ambiguous if room_bans ever gains another profiles FK.
 */
const BanRow = z.object({
  steam_id: z.string(),
  reason: z.string().nullable(),
  created_at: z.string(),
  profiles: ProfileRow.nullable(),
});
type BanRow = z.infer<typeof BanRow>;
const BAN_COLUMNS = `steam_id, reason, created_at, profiles!room_bans_banned_by_fkey(${PROFILE_COLUMNS})`;

/** Validates a response against its contract schema; a mismatch is a server bug (values never logged). */
function checked<T extends z.ZodType>(operation: string, schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new InternalError(new Error(`${operation}: response does not match the contract: ${fields}`));
  }
  return parsed.data;
}

function toBan(operation: string, row: BanRow, user: ProfileRow | null): Ban {
  return checked(operation, Ban, {
    steamId: row.steam_id,
    user: user ? toProfileSummary(user) : null,
    bannedBy: row.profiles ? toProfileSummary(row.profiles) : null,
    reason: row.reason,
    createdAt: row.created_at,
  });
}

// ---------------------------------------------------------------------------
// Ban / unban
// ---------------------------------------------------------------------------

/** The target's profile (with their SteamID, which the ban is keyed by), or null if it's gone. */
async function loadTargetProfile(profileId: string): Promise<z.infer<typeof SteamProfileRow> | null> {
  const { data, error } = await db
    .from('profiles')
    .select(`${PROFILE_COLUMNS}, steam_id`)
    .eq('id', profileId)
    .maybeSingle<unknown>();
  if (error) throw dbFailure('profile lookup', error);
  if (data === null) return null;
  const row = SteamProfileRow.safeParse(data);
  if (!row.success) throw new InternalError(new Error('profile lookup returned an unexpected row'));
  return row.data;
}

/**
 * Reads a just-committed ban back, or null if that fails (a read error, or the ban was lifted in
 * between). Never throws: the ban has committed, so the caller answers from known values instead.
 * Logs no values (no SteamID, reason, or DB message).
 */
async function readBanBack(roomId: string, steamId: string): Promise<BanRow | null> {
  const { data, error } = await db
    .from('room_bans')
    .select(BAN_COLUMNS)
    .eq('room_id', roomId)
    .eq('steam_id', steamId)
    .maybeSingle<unknown>();
  if (error) {
    logger.warn({ roomId, dbCode: error.code }, 'could not read the new ban back; answering from known values');
    return null;
  }
  const row = BanRow.safeParse(data);
  if (!row.success) {
    logger.warn({ roomId }, 'new ban missing or malformed on read-back; answering from known values');
    return null;
  }
  return row.data;
}

/** The actor's profile for a fallback ban response, or null if it can't be read (never throws). */
async function readActorProfile(actorId: string): Promise<ProfileRow | null> {
  const { data, error } = await db.from('profiles').select(PROFILE_COLUMNS).eq('id', actorId).maybeSingle<unknown>();
  if (error) return null;
  const row = ProfileRow.safeParse(data);
  return row.success ? row.data : null;
}

/** ban_member errors with a ban-specific meaning; everything else maps like the other room functions. */
function banFailure(error: DbError): AppError {
  switch (error.code) {
    case 'HX004': // same_user: checked before the call too; the database re-checks it
      return new ValidationError([{ path: 'body.userId', message: "You can't ban yourself." }]);
    case 'HX005': // the target is the owner
      return new ConflictError("The room owner can't be banned.", 'OWNER_PROTECTED');
    default:
      return rpcFailure('ban_member', error, { field: 'body.reason' });
  }
}

/**
 * Bans a member (owner: anyone but themself; admin: plain members): removes them, records the
 * ban by their SteamID, and runs the same effects as a removal, with `banned: true` on
 * member:removed. Returns the ban.
 */
export async function banMember(roomId: string, actorId: string, targetId: string, reason?: string): Promise<Ban> {
  const target = targetId.toLowerCase();
  if (target === actorId.toLowerCase()) {
    throw new ValidationError([{ path: 'body.userId', message: "You can't ban yourself." }]);
  }

  const [voiceChannelIds, profile] = await Promise.all([listVoiceChannelIds(roomId), loadTargetProfile(target)]);
  // No profile means no membership (ban_member would raise HX003): the same 404.
  if (!profile) throw new NotFoundError();

  const { data, error } = await db
    .rpc('ban_member', { p_room: roomId, p_actor: actorId, p_target: target, p_reason: reason ?? null })
    .overrideTypes<unknown, { merge: false }>();
  if (error) throw banFailure(error);

  const ended = { voiceChannelIds, revokedInvites: parseRevokedInvites('ban_member', data) };
  // Neither the effects nor the read-back reject: the ban has committed, so nothing fails the request now.
  const [, row] = await Promise.all([
    announceMembershipEnded(roomId, target, ended, 'banned'),
    readBanBack(roomId, profile.steam_id),
  ]);
  if (row) return toBan('ban member', row, profile);

  // Read-back failed: answer with what we know. created_at is the DB's clock, so this is approximate.
  const issuer = await readActorProfile(actorId);
  return checked('ban member', Ban, {
    steamId: profile.steam_id,
    user: toProfileSummary(profile),
    bannedBy: issuer ? toProfileSummary(issuer) : null,
    reason: reason ?? null,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Lifts a ban (owner or admin, any ban). The person isn't re-added; they need a new invite.
 * A malformed SteamID is a 404, like one that isn't banned. No broadcast: nobody's view of the
 * room changes.
 */
export async function unbanMember(roomId: string, actorId: string, steamId: string): Promise<void> {
  if (!STEAM_ID_PATTERN.test(steamId)) throw new NotFoundError();
  const { error } = await db.rpc('unban', { p_room: roomId, p_actor: actorId, p_steam_id: steamId });
  if (error) throw rpcFailure('unban', error, { field: 'params.steamId' });
  // Moderation audit trail. A SteamID isn't a secret; the reason is never logged.
  logger.info({ roomId, actorId, steamId }, 'ban lifted');
}

// ---------------------------------------------------------------------------
// Ban list
// ---------------------------------------------------------------------------

// Keyset cursor: (created_at, steam_id), newest first, opaque base64url JSON. Same timestamp rules
// as the rooms and invites cursors, which keep quotes, commas, and parens out of the filter
// string; the SteamID is digits only.
const CursorTimestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/.test(value))
  .refine((value) => !value.startsWith('0000'), 'Postgres has no year 0.');
const Cursor = z.tuple([CursorTimestamp, z.string().regex(STEAM_ID_PATTERN)]);

function encodeCursor(row: BanRow): string {
  return Buffer.from(JSON.stringify([row.created_at, row.steam_id])).toString('base64url');
}

function decodeCursor(cursor: string): [createdAt: string, steamId: string] {
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through: not base64url JSON
  }
  throw new ValidationError([{ path: 'query.cursor', message: 'Invalid cursor.' }]);
}

/** Profiles for the given SteamIDs, keyed by SteamID (accounts that never signed in or were deleted are absent). */
async function profilesBySteamId(steamIds: readonly string[]): Promise<Map<string, ProfileRow>> {
  if (steamIds.length === 0) return new Map();
  const { data, error } = await db
    .from('profiles')
    .select(`${PROFILE_COLUMNS}, steam_id`)
    .in('steam_id', steamIds)
    .overrideTypes<unknown[], { merge: false }>();
  if (error) throw dbFailure('banned profile lookup', error);
  const rows = z.array(SteamProfileRow).safeParse(data);
  if (!rows.success) throw new InternalError(new Error('banned profile lookup returned an unexpected shape'));
  return new Map(rows.data.map((row) => [row.steam_id, row]));
}

/** A room's bans, newest first, keyset-paginated, with the banned account's profile when it has one. */
export async function listBans(roomId: string, { cursor, limit }: ListBansQuery): Promise<BanPage> {
  let query = db.from('room_bans').select(BAN_COLUMNS).eq('room_id', roomId);
  if (cursor) {
    // Both values were validated by decodeCursor, so they can't break out of the filter.
    const [createdAt, steamId] = decodeCursor(cursor);
    query = query.or(`created_at.lt."${createdAt}",and(created_at.eq."${createdAt}",steam_id.lt.${steamId})`);
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('steam_id', { ascending: false })
    .limit(limit + 1)
    .overrideTypes<unknown[], { merge: false }>();
  if (error) throw dbFailure('ban list', error);

  const rows = z.array(BanRow).safeParse(data);
  if (!rows.success) throw new InternalError(new Error('ban list returned an unexpected shape'));
  const pageRows = rows.data.slice(0, limit);
  const profiles = await profilesBySteamId(pageRows.map((row) => row.steam_id));
  const bans = pageRows.map((row) => toBan('ban list', row, profiles.get(row.steam_id) ?? null));
  const last = pageRows.at(-1);
  return { data: bans, nextCursor: rows.data.length > limit && last ? encodeCursor(last) : null };
}
