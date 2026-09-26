import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { authRouter } from './auth.js';
import { channelsRouter, roomChannelsRouter } from './channels.js';
import { createContractRouter } from './contract.js';
import { docsRouter } from './docs.js';
import { mount } from './documentedRouter.js';
import { invitePreviewRouter, invitesRouter, myInvitesRouter, roomInvitesRouter } from './invites.js';
import { roomMembersRouter } from './members.js';
import { channelMessagesRouter, messagesRouter } from './messages.js';
import { roomsRouter } from './rooms.js';
import { systemRouter } from './system.js';

export const apiRouter = Router();

// Public routes (see CLAUDE.md "Security rules" for the full allowlist).
// mount() uses each router's documented path, so docs and real paths always agree.
mount(apiRouter, systemRouter);
mount(apiRouter, createContractRouter());
mount(apiRouter, docsRouter);
// Steam sign-in routes are public; logout routes apply requireAuth themselves.
mount(apiRouter, authRouter);
// Link invite preview (GET /api/invites/:token/preview) is public; the rest of /api/invites isn't.
mount(apiRouter, invitePreviewRouter);

// Everything mounted below this line requires a session.
apiRouter.use(requireAuth);
mount(apiRouter, roomsRouter);
mount(apiRouter, roomChannelsRouter);
mount(apiRouter, roomMembersRouter);
mount(apiRouter, channelsRouter);
mount(apiRouter, channelMessagesRouter);
mount(apiRouter, messagesRouter);
mount(apiRouter, roomInvitesRouter);
mount(apiRouter, invitesRouter);
mount(apiRouter, myInvitesRouter);
