import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { authRouter } from './auth.js';
import { createContractRouter } from './contract.js';
import { docsRouter } from './docs.js';
import { mount } from './documentedRouter.js';
import { systemRouter } from './system.js';

export const apiRouter = Router();

// Public routes (see CLAUDE.md "Security rules" for the full allowlist).
// mount() uses each router's documented path, so docs and real paths always agree.
mount(apiRouter, systemRouter);
mount(apiRouter, createContractRouter());
mount(apiRouter, docsRouter);
// Steam sign-in routes are public; logout routes apply requireAuth themselves.
mount(apiRouter, authRouter);

// Everything mounted below this line requires a session.
apiRouter.use(requireAuth);
