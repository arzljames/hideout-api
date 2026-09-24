import { describe, expect, it } from 'vitest';
import { registry } from '../src/contracts/http/index.js';
import { documentedRouter, openApiPath } from '../src/routes/documentedRouter.js';
import openapi from '../contract/openapi.json' with { type: 'json' };

describe('documentedRouter (every route is in /api/docs)', () => {
  it('refuses a route that is not registered in the contract', () => {
    expect(() => documentedRouter('/api').get('/not-documented', (_req, res) => res.end())).toThrow(
      /GET \/api\/not-documented is not documented/,
    );
  });

  it('accepts registered routes', () => {
    expect(() => documentedRouter('/api').get('/health', (_req, res) => res.end())).not.toThrow();
  });

  it('matches methods, not just paths', () => {
    expect(() => documentedRouter('/api').post('/health', (_req, res) => res.end())).toThrow(/POST/);
  });

  it('converts Express params to OpenAPI form', () => {
    expect(openApiPath('/api/rooms', '/:roomId/members')).toBe('/api/rooms/{roomId}/members');
    expect(openApiPath('/api/docs', '/')).toBe('/api/docs');
  });

  it('requires a reason for undocumented routes', () => {
    expect(() => documentedRouter('/api').undocumented(' ', () => undefined)).toThrow(/reason/);
  });

  it('every registered route is in the committed openapi.json (run `npm run contracts`)', () => {
    const paths = openapi.paths as Record<string, Record<string, unknown>>;
    for (const def of registry.definitions) {
      if (def.type !== 'route') continue;
      expect(paths[def.route.path]?.[def.route.method], `${def.route.method} ${def.route.path}`).toBeDefined();
    }
  });
});

describe('mount paths', () => {
  it('rejects mount paths outside /api', () => {
    expect(() => documentedRouter('/auth')).toThrow(/must be under \/api/);
    expect(() => documentedRouter('/apix')).toThrow(/must be under \/api/);
  });

  it('mount() serves routes at exactly the documented path', async () => {
    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { mount } = await import('../src/routes/documentedRouter.js');
    const api = express.Router();
    mount(api, documentedRouter('/api/auth').post('/logout', (_req, res) => res.status(204).end()));
    const app = express().use('/api', api);
    expect((await request(app).post('/api/auth/logout')).status).toBe(204);
  });
});
