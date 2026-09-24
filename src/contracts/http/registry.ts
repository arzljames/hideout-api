import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

/** Every REST schema and path registers here; `npm run contracts` turns it into contract/openapi.json. */
export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'session', {
  type: 'apiKey',
  in: 'cookie',
  name: 'hideout_session',
  description: 'httpOnly session cookie, named __Host-hideout_session over HTTPS.',
});
