import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger, serializeRequest } from './lib/logger.js';
import { corsMiddleware } from './middleware/cors.js';
import { requireSameOrigin } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';
import { livekitWebhookRouter } from './routes/livekitWebhook.js';

export function createApp(): express.Express {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      serializers: { req: serializeRequest },
      autoLogging: { ignore: (req) => req.url === '/api/health' || req.url === '/api/ready' },
    }),
  );
  app.use(corsMiddleware);

  // Server-to-server routes that need the raw body and no Origin check (LiveKit webhook) mount here,
  // before the JSON parser and requireSameOrigin. The webhook authenticates by its signature.
  app.use(livekitWebhookRouter.mountPath, livekitWebhookRouter.router);

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use('/api', requireSameOrigin, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
