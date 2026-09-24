import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

const DRAIN_MS = 10_000;

const server = createApp().listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'hideout-api listening');
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const force = setTimeout(() => {
    logger.error('drain timed out, forcing exit');
    process.exit(1);
  }, DRAIN_MS);
  force.unref();

  server.close((err) => {
    if (err) logger.error({ err }, 'error while closing server');
    process.exit(err ? 1 : 0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// State is unknown after either of these; log and exit so the platform restarts the process.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
