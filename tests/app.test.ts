import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/readiness.js', () => ({
  getReadiness: vi.fn(() =>
    Promise.resolve({ ready: false, checks: { database: 'ok', realtime: 'fail', livekit: 'ok' } }),
  ),
}));

const { createApp } = await import('../src/app.js');
const app = createApp();
const ORIGIN = 'http://localhost:5173';

describe('system routes', () => {
  it('GET /api/health is public', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/ready returns 503 without revealing which dependency failed', async () => {
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready' });
  });

  it('serves the generated contracts publicly', async () => {
    const openapi = await request(app).get('/api/contract/openapi.json');
    expect(openapi.status).toBe(200);
    expect(openapi.body).toHaveProperty('openapi', '3.1.0');

    const events = await request(app).get('/api/contract/events.schema.json');
    expect(events.status).toBe(200);
    expect(events.body).toHaveProperty('serverEvents.channel');
  });
});

describe('error handling', () => {
  it('unknown routes return the standard 404 error shape', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });

  it('unknown routes under /api require a session, so they reveal nothing', async () => {
    const res = await request(app).get('/api/rooms');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('malformed JSON returns 400 INVALID_JSON', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('sets security headers and hides x-powered-by', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests from another origin', async () => {
    const res = await request(app).post('/api/anything').set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('rejects state-changing requests with no Origin', async () => {
    const res = await request(app).post('/api/anything').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('rejects non-JSON content types', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'text/plain')
      .send('hi');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  it('lets same-origin JSON requests through to auth', async () => {
    const res = await request(app).post('/api/anything').set('Origin', ORIGIN).send({});
    expect(res.status).toBe(401);
  });
});

describe('CORS', () => {
  it('allows exactly WEB_ORIGIN with credentials', async () => {
    const res = await request(app)
      .options('/api/health')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not allow other origins', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    // cors sends the configured origin regardless; the browser then blocks the mismatch.
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
  });
});

describe('API docs (Swagger UI)', () => {
  it('serves the Swagger UI page publicly, pointing at the generated contract', async () => {
    const page = await request(app).get('/api/docs');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toContain('/api/docs/assets/swagger-ui-bundle.js');

    const init = await request(app).get('/api/docs/init.js');
    expect(init.status).toBe(200);
    expect(init.text).toContain("url: '/api/contract/openapi.json'");
  });

  it('serves the Swagger UI assets same-origin', async () => {
    for (const file of ['swagger-ui.css', 'swagger-ui-bundle.js']) {
      const res = await request(app).get(`/api/docs/assets/${file}`);
      expect(res.status).toBe(200);
    }
  });

  it('only serves the listed assets, not the rest of swagger-ui-dist', async () => {
    const res = await request(app).get('/api/docs/assets/index.html');
    expect(res.status).toBe(401);
  });

  it("keeps helmet's CSP (no inline scripts, no third-party origins)", async () => {
    const res = await request(app).get('/api/docs');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(page(res.text)).not.toMatch(/<script>(?!<\/script>)/);
  });
});

function page(html: string): string {
  return html.replace(/<script src="[^"]+"><\/script>/g, '');
}
