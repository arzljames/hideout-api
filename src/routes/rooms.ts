import type { z } from 'zod';
import { CursorQuery } from '../contracts/http/common.js';
import { CreateRoomBody, UpdateRoomBody } from '../contracts/http/rooms.js';
import { roomCreateLimiter, roomUpdateLimiter } from '../middleware/rateLimits.js';
import { authOf } from '../middleware/requireAuth.js';
import { requireRoomMember, roomOf } from '../middleware/requireRoomMember.js';
import { validate } from '../middleware/validate.js';
import { createRoom, deleteRoom, getRoomDetail, listMyRooms, updateRoom } from '../services/rooms.js';
import { documentedRouter } from './documentedRouter.js';

// Mounted below the global requireAuth; requireSameOrigin (CSRF) covers every write under /api.
export const roomsRouter = documentedRouter('/api/rooms')
  .post('/', roomCreateLimiter, validate({ body: CreateRoomBody }), async (req, res) => {
    const detail = await createRoom(authOf(req).profileId, req.body as CreateRoomBody);
    res.status(201).json(detail);
  })
  .get('/', validate({ query: CursorQuery }), async (req, res) => {
    const page = await listMyRooms(authOf(req).profileId, req.query as unknown as z.infer<typeof CursorQuery>);
    res.set('Cache-Control', 'no-store').json(page);
  })
  .get('/:roomId', requireRoomMember(), async (req, res) => {
    const detail = await getRoomDetail(roomOf(req).roomId, authOf(req).profileId);
    res.set('Cache-Control', 'no-store').json(detail);
  })
  .patch(
    '/:roomId',
    requireRoomMember('admin'),
    roomUpdateLimiter,
    validate({ body: UpdateRoomBody }),
    async (req, res) => {
      const detail = await updateRoom(roomOf(req).roomId, authOf(req).profileId, req.body as UpdateRoomBody);
      res.json(detail);
    },
  )
  .delete('/:roomId', requireRoomMember('owner'), async (req, res) => {
    await deleteRoom(roomOf(req).roomId, authOf(req).profileId);
    res.status(204).end();
  });
