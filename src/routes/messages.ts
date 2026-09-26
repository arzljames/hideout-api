import { EditMessageBody, ListMessagesQuery, SendMessageBody, SendMessageHeaders } from '../contracts/http/messages.js';
import { messageLimiter, messageReadLimiter } from '../middleware/rateLimits.js';
import { authOf } from '../middleware/requireAuth.js';
import { channelOf, requireChannelMember } from '../middleware/requireChannelMember.js';
import { messageOf, requireMessageMember } from '../middleware/requireMessageMember.js';
import { validate } from '../middleware/validate.js';
import { deleteMessage, editMessage, listMessages, sendMessage } from '../services/messages.js';
import { documentedRouter } from './documentedRouter.js';

// Both mounted below the global requireAuth; requireSameOrigin (CSRF) covers every write under /api.
// The Idempotency-Key header is redacted from logs (lib/logger.ts); message bodies are never logged.

/** Messages of one channel (`/api/channels/:channelId/messages`), next to channelsRouter. */
export const channelMessagesRouter = documentedRouter('/api/channels')
  .post(
    '/:channelId/messages',
    requireChannelMember(),
    messageLimiter,
    validate({ headers: SendMessageHeaders, body: SendMessageBody }),
    async (req, res) => {
      const { channelId } = channelOf(req);
      const key = req.get('idempotency-key');
      const { message, replayed } = await sendMessage(channelId, authOf(req).profileId, req.body as SendMessageBody, key);
      if (replayed) res.set('Idempotent-Replayed', 'true');
      res.status(replayed ? 200 : 201).json(message);
    },
  )
  .get('/:channelId/messages', requireChannelMember(), messageReadLimiter, validate({ query: ListMessagesQuery }), async (req, res) => {
    const page = await listMessages(channelOf(req), req.query as unknown as ListMessagesQuery);
    res.set('Cache-Control', 'no-store').json(page);
  });

/** Routes on one message (`/api/messages/:messageId`). */
export const messagesRouter = documentedRouter('/api/messages')
  .patch(
    '/:messageId',
    requireMessageMember('edit'),
    messageLimiter,
    validate({ body: EditMessageBody }),
    async (req, res) => {
      const message = await editMessage(messageOf(req).messageId, authOf(req).profileId, req.body as EditMessageBody);
      res.json(message);
    },
  )
  .delete('/:messageId', requireMessageMember('delete'), messageLimiter, async (req, res) => {
    await deleteMessage(messageOf(req), authOf(req).profileId);
    res.status(204).end();
  });
