import express, { type RequestHandler } from 'express';
import type { WebhookEvent } from 'livekit-server-sdk';
import { AppError, ServiceUnavailableError } from '../errors.js';
import { livekitWebhooks } from '../lib/livekit.js';
import { livekitWebhookLimiter } from '../middleware/rateLimits.js';
import { handleLivekitWebhook } from '../services/voice.js';
import { documentedRouter } from './documentedRouter.js';

/*
 * POST /api/livekit/webhook. Server to server: mounted in app.ts before express.json and
 * requireSameOrigin, and outside requireAuth; the LiveKit signature is the authentication.
 *
 * The signature (a JWT in Authorization carrying the body's sha256) is checked against the raw
 * body before anything else. Unverified requests get 401 with no side effects; neither the body
 * nor the header is logged. A verified event is handled before responding (no background work,
 * so it also works on serverless hosts). It gets 200 even if handling failed (logged): the next
 * event for that channel, or the REST read, corrects the participant list, so a retry adds
 * nothing. The one exception fails closed: a participant_joined whose membership can't be
 * checked gets 503, so LiveKit retries it rather than a removed member staying connected.
 * https://docs.livekit.io/home/server/webhooks/
 */

function invalidSignature(): AppError {
  return new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature is invalid.');
}

const receiveWebhook: RequestHandler = async (req, res) => {
  // express.raw leaves req.body as {} for any other Content-Type.
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body)) throw invalidSignature();

  let event: WebhookEvent;
  try {
    event = await livekitWebhooks.receive(body.toString('utf8'), req.get('authorization'));
  } catch {
    // Not logged beyond the 401 pino-http records: the error text can echo claims.
    throw invalidSignature();
  }

  try {
    await handleLivekitWebhook(event);
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    req.log.warn({ err, event: event.event }, 'LiveKit webhook handling failed; acknowledged anyway');
  }
  res.status(200).end();
};

export const livekitWebhookRouter = documentedRouter('/api/livekit').post(
  '/webhook',
  livekitWebhookLimiter,
  express.raw({ type: 'application/webhook+json', limit: '100kb' }),
  receiveWebhook,
);
