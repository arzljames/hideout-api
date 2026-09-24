import { Router } from 'express';
import { readyLimiter } from '../middleware/rateLimits.js';
import { getReadiness } from '../services/readiness.js';

export const systemRouter = Router();

systemRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Public, so per-dependency detail goes to logs only.
systemRouter.get('/ready', readyLimiter, async (req, res) => {
  const { ready, checks } = await getReadiness();
  if (!ready) req.log.warn({ checks }, 'not ready');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
});
