import { env } from '../config/env.js';
import { livekitRooms } from '../lib/livekit.js';
import { sendBroadcast } from '../realtime/broadcast.js';

export type CheckStatus = 'ok' | 'fail';

export interface Readiness {
  ready: boolean;
  checks: { database: CheckStatus; realtime: CheckStatus; livekit: CheckStatus };
}

const TIMEOUT_MS = 2_000;

async function check(run: () => Promise<boolean>): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { resolve(false); }, TIMEOUT_MS);
  });
  try {
    return (await Promise.race([run(), timeout])) ? 'ok' : 'fail';
  } catch {
    return 'fail';
  } finally {
    clearTimeout(timer);
  }
}

/** PostgREST answers only when Postgres is reachable. */
async function database(): Promise<boolean> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.body?.cancel();
  return res.ok;
}

/** A REST broadcast to a topic no browser policy matches, so nobody can receive it. */
function realtime(): Promise<boolean> {
  return sendBroadcast('system:ready', 'ping', {});
}

async function livekit(): Promise<boolean> {
  await livekitRooms.listRooms(['__ready__']);
  return true;
}

async function runChecks(): Promise<Readiness> {
  const [databaseStatus, realtimeStatus, livekitStatus] = await Promise.all([
    check(database),
    check(realtime),
    check(livekit),
  ]);
  const checks = { database: databaseStatus, realtime: realtimeStatus, livekit: livekitStatus };
  return { ready: Object.values(checks).every((s) => s === 'ok'), checks };
}

const CACHE_MS = 5_000;
let cached: { at: number; result: Promise<Readiness> } | undefined;

/** Cached and shared across callers, so probe traffic can't fan out to upstream services. */
export function getReadiness(now = Date.now()): Promise<Readiness> {
  if (!cached || now - cached.at >= CACHE_MS) {
    cached = { at: now, result: runChecks() };
  }
  return cached.result;
}
