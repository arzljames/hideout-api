import { describe, expect, it } from 'vitest';
import { redactReferer, redactUrl, serializeRequest } from '../src/lib/logger.js';

describe('log redaction', () => {
  it('redacts invite tokens in the path', () => {
    expect(redactUrl('/api/invites/abc123SECRET/preview')).toBe('/api/invites/[redacted]/preview');
    expect(redactUrl('/api/invites/abc123SECRET')).toBe('/api/invites/[redacted]');
  });

  it('redacts invite tokens whatever the path case (Express routes paths case-insensitively)', () => {
    expect(redactUrl('/API/Invites/abc123SECRET/preview')).toBe('/api/invites/[redacted]/preview');
    expect(redactUrl('/api/INVITES/abc123SECRET/redeem')).toBe('/api/invites/[redacted]/redeem');
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

  it('redacts the invite token in a Referer from the invite page, keeping the origin', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
    expect(redactReferer(`http://localhost:5173/invite/${token}`)).toBe('http://localhost:5173/invite/[redacted]');
    expect(redactReferer(`https://app.hideout.gg/invite/${token}/`)).toBe('https://app.hideout.gg/invite/[redacted]/');
    expect(redactReferer(`https://app.hideout.gg/INVITE/${token}?ref=x#top`)).toBe('https://app.hideout.gg/INVITE/[redacted]');
    expect(redactReferer(`http://localhost:3001/api/invites/${token}/preview`)).toBe(
      'http://localhost:3001/api/invites/[redacted]/preview',
    );
  });

  it('leaves a Referer without an invite path alone, apart from dropping its query and fragment', () => {
    expect(redactReferer('http://localhost:5173/rooms/1/channels/2')).toBe('http://localhost:5173/rooms/1/channels/2');
    expect(redactReferer('http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(redactReferer('http://localhost:5173/inviteX/abc')).toBe('http://localhost:5173/inviteX/abc');
    expect(redactReferer('http://localhost:5173/settings?tab=SECRET#x')).toBe('http://localhost:5173/settings');
    expect(redactReferer(undefined)).toBeUndefined();
  });

  it('serializes a request with its Referer redacted, without mutating the live headers', () => {
    const headers = { referer: 'http://localhost:5173/invite/SECRETTOKEN', accept: 'application/json' };
    const serialized = serializeRequest({ id: 2, method: 'POST', url: '/api/invites/SECRETTOKEN/redeem', headers });
    expect(serialized.headers).toEqual({ referer: 'http://localhost:5173/invite/[redacted]', accept: 'application/json' });
    expect(JSON.stringify(serialized)).not.toContain('SECRETTOKEN');
    expect(headers.referer).toBe('http://localhost:5173/invite/SECRETTOKEN');
  });

  it('serializes a request without a Referer unchanged', () => {
    const headers = { accept: 'application/json' };
    expect(serializeRequest({ id: 3, method: 'GET', url: '/api/rooms', headers }).headers).toBe(headers);
  });
});
