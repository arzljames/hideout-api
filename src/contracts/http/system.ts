import { z } from 'zod';
import { errorResponse } from './common.js';
import { registry } from './registry.js';

export const HealthResponse = registry.register(
  'HealthResponse',
  z.object({ status: z.literal('ok') }),
);

export const ReadyResponse = registry.register(
  'ReadyResponse',
  z.object({ status: z.enum(['ready', 'not_ready']) }),
);

registry.registerPath({
  method: 'get',
  path: '/api/health',
  tags: ['system'],
  security: [],
  summary: 'Liveness probe',
  responses: {
    200: { description: 'The process is up.', content: { 'application/json': { schema: HealthResponse } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/ready',
  tags: ['system'],
  security: [],
  summary: 'Readiness probe (database, Realtime, LiveKit reachable)',
  responses: {
    200: { description: 'All dependencies reachable.', content: { 'application/json': { schema: ReadyResponse } } },
    503: { description: 'A dependency is unreachable.', content: { 'application/json': { schema: ReadyResponse } } },
    429: errorResponse('Rate limited.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/contract/openapi.json',
  tags: ['contract'],
  security: [],
  summary: 'This REST contract',
  responses: { 200: { description: 'OpenAPI document.' }, 404: errorResponse('Not generated.') },
});

registry.registerPath({
  method: 'get',
  path: '/api/contract/events.schema.json',
  tags: ['contract'],
  security: [],
  summary: 'The realtime event contract',
  responses: { 200: { description: 'JSON Schema document.' }, 404: errorResponse('Not generated.') },
});

registry.registerPath({
  method: 'get',
  path: '/api/docs',
  tags: ['contract'],
  security: [],
  summary: 'Swagger UI for this REST contract',
  responses: { 200: { description: 'HTML page.', content: { 'text/html': { schema: { type: 'string' } } } } },
});
