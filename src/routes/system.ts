import { readyLimiter } from '../middleware/rateLimits.js';
import { getReadiness } from '../services/readiness.js';
import { documentedRouter } from './documentedRouter.js';

export const systemRouter = documentedRouter('/api')
  .get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  })
  // Public, so per-dependency detail goes to logs only.
  .get('/ready', readyLimiter, async (req, res) => {
    const { ready, checks } = await getReadiness();
    if (!ready) req.log.warn({ checks }, 'not ready');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });
