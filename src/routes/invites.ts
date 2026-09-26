import { CreateInviteBody, ListInvitesQuery } from '../contracts/http/invites.js';
import {
  inviteCreateLimiter,
  invitePreviewLimiter,
  inviteReadLimiter,
  inviteRedeemLimiter,
  inviteRevokeLimiter,
} from '../middleware/rateLimits.js';
import { authOf } from '../middleware/requireAuth.js';
import { inviteOf, requireInviteMember } from '../middleware/requireInviteMember.js';
import { requireRoomMember, roomOf } from '../middleware/requireRoomMember.js';
import { validate } from '../middleware/validate.js';
import {
  acceptInvite,
  createInvite,
  declineInvite,
  getInvitePreview,
  listInbox,
  listInvites,
  redeemInvite,
  revokeInvite,
} from '../services/invites.js';
import { documentedRouter } from './documentedRouter.js';

// Link tokens travel in the path: lib/logger.ts redacts /api/invites/<token> from logged URLs.
// Malformed tokens and invite ids are 404 (checked in the service), not 422.

/** Public: mounted before requireAuth (see CLAUDE.md "Security rules"). */
export const invitePreviewRouter = documentedRouter('/api/invites').get(
  '/:token/preview',
  invitePreviewLimiter,
  async (req, res) => {
    // Set first, so the 404 for an unusable link isn't cached either.
    res.set('Cache-Control', 'no-store');
    res.json(await getInvitePreview(String(req.params.token)));
  },
);

// The routers below are mounted below the global requireAuth; requireSameOrigin (CSRF) covers every write.

/** Invites of one room (`/api/rooms/:roomId/invites`), next to roomsRouter. */
export const roomInvitesRouter = documentedRouter('/api/rooms')
  .post(
    '/:roomId/invites',
    requireRoomMember(),
    inviteCreateLimiter,
    validate({ body: CreateInviteBody }),
    async (req, res) => {
      const { roomId, role } = roomOf(req);
      const created = await createInvite(roomId, authOf(req).profileId, role, req.body as CreateInviteBody);
      res.status(201).set('Cache-Control', 'no-store').json(created);
    },
  )
  .get('/:roomId/invites', requireRoomMember(), inviteReadLimiter, validate({ query: ListInvitesQuery }), async (req, res) => {
    const { roomId, role } = roomOf(req);
    const page = await listInvites(roomId, authOf(req).profileId, role, req.query as unknown as ListInvitesQuery);
    res.set('Cache-Control', 'no-store').json(page);
  });

/** Routes on one invite (`/api/invites/...`): revoke by id, redeem by token. */
export const invitesRouter = documentedRouter('/api/invites')
  .delete('/:inviteId', requireInviteMember(), inviteRevokeLimiter, async (req, res) => {
    await revokeInvite(inviteOf(req), authOf(req).profileId);
    res.status(204).end();
  })
  .post('/:token/redeem', inviteRedeemLimiter, async (req, res) => {
    const result = await redeemInvite(String(req.params.token), authOf(req).profileId);
    res.json(result);
  });

/** The caller's direct invites (`/api/me/invites`). */
export const myInvitesRouter = documentedRouter('/api/me/invites')
  .get('/', inviteReadLimiter, async (req, res) => {
    const inbox = await listInbox(authOf(req).profileId);
    res.set('Cache-Control', 'no-store').json(inbox);
  })
  .post('/:inviteId/accept', inviteRedeemLimiter, async (req, res) => {
    const result = await acceptInvite(String(req.params.inviteId), authOf(req).profileId);
    res.json(result);
  })
  .post('/:inviteId/decline', inviteRedeemLimiter, async (req, res) => {
    await declineInvite(String(req.params.inviteId), authOf(req).profileId);
    res.status(204).end();
  });
