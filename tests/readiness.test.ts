import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendBroadcast, listRooms } = vi.hoisted(() => ({
  sendBroadcast: vi.fn(() => Promise.resolve(true)),
  listRooms: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../src/realtime/broadcast.js', () => ({ sendBroadcast }));
vi.mock('../src/lib/livekit.js', () => ({ livekitRooms: { listRooms } }));

const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
vi.stubGlobal('fetch', fetchMock);
afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const { getReadiness } = await import('../src/services/readiness.js');
const { inviteCreateLimiter } = await import('../src/middleware/rateLimits.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

let clock = 1_000_000;
function uncachedCall() {
  clock += 60_000;
  return getReadiness(clock);
}

describe('getReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports each dependency', async () => {
    await expect(uncachedCall()).resolves.toEqual({
      ready: true,
      checks: { database: 'ok', realtime: 'ok', livekit: 'ok' },
    });
    expect(sendBroadcast).toHaveBeenCalledWith('system:ready', 'ping', {});
  });

  it('caches the result for 5s so probes cannot fan out to upstream services', async () => {
    const t = (clock += 60_000);
    await getReadiness(t);
    await getReadiness(t + 4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getReadiness(t + 5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps thrown errors and false results to fail', async () => {
    listRooms.mockRejectedValueOnce(new Error('down'));
    sendBroadcast.mockResolvedValueOnce(false);
    await expect(uncachedCall()).resolves.toEqual({
      ready: false,
      checks: { database: 'ok', realtime: 'fail', livekit: 'fail' },
    });
  });

  it('maps a hung dependency to fail after the timeout', async () => {
    vi.useFakeTimers();
    sendBroadcast.mockReturnValueOnce(new Promise(() => undefined));
    const pending = uncachedCall();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ ready: false, checks: { realtime: 'fail' } });
    vi.useRealTimers();
  });
});

describe('per-user rate limiters', () => {
  it('fail loudly when mounted before requireAuth', async () => {
    const app = express()
      .get('/x', inviteCreateLimiter, (_req, res) => {
        res.json({});
      })
      .use(errorHandler);
    const res = await request(app).get('/x');
    expect(res.status).toBe(500);
  });
});
