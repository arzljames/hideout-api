import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { broadcastToChannel, broadcastToUser } from '../src/realtime/broadcast.js';

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);
afterAll(() => {
  vi.unstubAllGlobals();
});

const message = {
  id: '11111111-1111-4111-8111-111111111111',
  channelId: '22222222-2222-4222-8222-222222222222',
  author: { id: '33333333-3333-4333-8333-333333333333', displayName: 'Gordon', avatarUrl: null },
  body: 'hi',
  createdAt: '2026-09-25T10:00:00.000Z',
  editedAt: null,
};

function sentBody(): unknown {
  const init = fetchMock.mock.calls[0]?.[1];
  return JSON.parse(init?.body as string);
}

describe('broadcast', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  });

  it('POSTs one private message to the Realtime REST endpoint with the service key', async () => {
    await expect(broadcastToChannel(message.channelId, 'message:created', { message })).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:54321/realtime/v1/api/broadcast');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ apikey: 'test-service-role-key' });
    expect(sentBody()).toEqual({
      messages: [{ topic: `channel:${message.channelId}`, event: 'message:created', payload: { message }, private: true }],
    });
  });

  it('lowercases ids so topics match what clients subscribe to', async () => {
    await broadcastToChannel(message.channelId.toUpperCase(), 'message:created', { message });
    expect(sentBody()).toMatchObject({ messages: [{ topic: `channel:${message.channelId}` }] });
  });

  it('strips fields the contract does not define', async () => {
    const leaky = { roomId: message.channelId, steamApiKey: 'secret' };
    await broadcastToUser(message.author.id, 'member:removed', leaky);
    expect(sentBody()).toMatchObject({ messages: [{ payload: { roomId: message.channelId } }] });
    expect(JSON.stringify(sentBody())).not.toContain('secret');
  });

  it('does not send (and does not throw) when the payload violates the contract', async () => {
    const bad = { id: 'not-an-id', channelId: message.channelId };
    await expect(broadcastToChannel(message.channelId, 'message:deleted', bad)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send when the topic id is not an id', async () => {
    await expect(broadcastToChannel(`${message.channelId}:x`, 'message:created', { message })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is best-effort: rejected or failed delivery resolves false', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await expect(broadcastToChannel(message.channelId, 'message:created', { message })).resolves.toBe(false);
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await expect(broadcastToChannel(message.channelId, 'message:created', { message })).resolves.toBe(false);
  });
});
