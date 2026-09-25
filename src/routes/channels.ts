import { CreateChannelBody, RenameChannelBody, ReorderChannelsBody } from '../contracts/http/channels.js';
import { channelWriteLimiter } from '../middleware/rateLimits.js';
import { authOf } from '../middleware/requireAuth.js';
import { channelOf, requireChannelMember } from '../middleware/requireChannelMember.js';
import { requireRoomMember, roomOf } from '../middleware/requireRoomMember.js';
import { validate } from '../middleware/validate.js';
import { createChannel, deleteChannel, renameChannel, reorderChannels } from '../services/channels.js';
import { documentedRouter } from './documentedRouter.js';

// Both mounted below the global requireAuth; requireSameOrigin (CSRF) covers every write under /api.

/** Channel routes scoped to a room (`/api/rooms/:roomId/channels...`), next to roomsRouter. */
export const roomChannelsRouter = documentedRouter('/api/rooms')
  .post(
    '/:roomId/channels',
    requireRoomMember('admin'),
    channelWriteLimiter,
    validate({ body: CreateChannelBody }),
    async (req, res) => {
      const channel = await createChannel(roomOf(req).roomId, authOf(req).profileId, req.body as CreateChannelBody);
      res.status(201).json(channel);
    },
  )
  .put(
    '/:roomId/channels/order',
    requireRoomMember('admin'),
    channelWriteLimiter,
    validate({ body: ReorderChannelsBody }),
    async (req, res) => {
      const list = await reorderChannels(roomOf(req).roomId, authOf(req).profileId, req.body as ReorderChannelsBody);
      res.json(list);
    },
  );

/** Routes on one channel (`/api/channels/:channelId`). */
export const channelsRouter = documentedRouter('/api/channels')
  .patch(
    '/:channelId',
    requireChannelMember('admin'),
    channelWriteLimiter,
    validate({ body: RenameChannelBody }),
    async (req, res) => {
      const channel = await renameChannel(channelOf(req).channelId, authOf(req).profileId, req.body as RenameChannelBody);
      res.json(channel);
    },
  )
  .delete('/:channelId', requireChannelMember('admin'), channelWriteLimiter, async (req, res) => {
    await deleteChannel(channelOf(req), authOf(req).profileId);
    res.status(204).end();
  });
