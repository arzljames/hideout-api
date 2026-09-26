import { BanBody, ListBansQuery } from '../contracts/http/bans.js';
import { banReadLimiter, memberWriteLimiter } from '../middleware/rateLimits.js';
import { authOf } from '../middleware/requireAuth.js';
import { requireRoomMember, roomOf } from '../middleware/requireRoomMember.js';
import { validate } from '../middleware/validate.js';
import { banMember, listBans, unbanMember } from '../services/bans.js';
import { documentedRouter } from './documentedRouter.js';

// Mounted below the global requireAuth; requireSameOrigin (CSRF) covers every write under /api.
// ban_member and unban re-check every rule under the room lock; the role check here is a fast path.
// Malformed SteamIDs in the path are 404 (checked in the service), not 422.

/** Bans of one room (`/api/rooms/:roomId/bans...`), next to roomsRouter. Owner or admin only. */
export const roomBansRouter = documentedRouter('/api/rooms')
  .post(
    '/:roomId/bans',
    requireRoomMember('admin'),
    memberWriteLimiter,
    validate({ body: BanBody }),
    async (req, res) => {
      const { userId, reason } = req.body as BanBody;
      const ban = await banMember(roomOf(req).roomId, authOf(req).profileId, userId, reason);
      res.status(201).json(ban);
    },
  )
  .get('/:roomId/bans', requireRoomMember('admin'), banReadLimiter, validate({ query: ListBansQuery }), async (req, res) => {
    const page = await listBans(roomOf(req).roomId, req.query as unknown as ListBansQuery);
    res.set('Cache-Control', 'no-store').json(page);
  })
  .delete('/:roomId/bans/:steamId', requireRoomMember('admin'), memberWriteLimiter, async (req, res) => {
    await unbanMember(roomOf(req).roomId, authOf(req).profileId, String(req.params.steamId));
    res.status(204).end();
  });
