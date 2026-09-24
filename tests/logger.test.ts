import { describe, expect, it } from 'vitest';
import { redactUrl, serializeRequest } from '../src/lib/logger.js';

describe('log redaction', () => {
  it('redacts invite tokens in the path', () => {
    expect(redactUrl('/api/invites/abc123SECRET/preview')).toBe('/api/invites/[redacted]/preview');
    expect(redactUrl('/api/invites/abc123SECRET')).toBe('/api/invites/[redacted]');
  });

  it('drops query strings (Steam OpenID signatures, nonces)', () => {
    expect(redactUrl('/api/auth/steam/callback?openid.sig=SECRET&openid.response_nonce=N')).toBe(
      '/api/auth/steam/callback',
    );
  });

  it('leaves ordinary paths alone', () => {
    expect(redactUrl('/api/rooms/1/channels')).toBe('/api/rooms/1/channels');
  });

  it('serializes requests without query or params', () => {
    const serialized = serializeRequest({
      id: 1,
      method: 'GET',
      url: '/api/invites/SECRET/preview?x=1',
      headers: {},
      ...({ query: { x: '1' }, params: { token: 'SECRET' } } as object),
    });
    expect(serialized).toEqual({ id: 1, method: 'GET', url: '/api/invites/[redacted]/preview', headers: {} });
    expect(JSON.stringify(serialized)).not.toContain('SECRET');
  });
});
