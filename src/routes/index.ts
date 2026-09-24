import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { createContractRouter } from './contract.js';
import { docsRouter } from './docs.js';
import { systemRouter } from './system.js';

export const apiRouter = Router();

// Public routes (see CLAUDE.md "Security rules" for the full allowlist).
apiRouter.use(systemRouter);
apiRouter.use('/contract', createContractRouter());
apiRouter.use('/docs', docsRouter);

// Everything mounted below this line requires a session.
apiRouter.use(requireAuth);
