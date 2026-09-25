import { vi } from 'vitest';

/*
 * Offline stand-in for the supabase-js service client (src/db/client.ts), at the
 * query-builder boundary. Mount with:
 *
 *   vi.mock('../src/db/client.js', async () => ({ db: (await import('./helpers/fakeDb.js')).fakeDb }));
 *
 * Every `db.from(table)` records its chained calls; awaiting the chain resolves to
 * `results.lookup` for selects and `results.delete` for deletes. A select on a table
 * listed in `results.selectByTable` resolves to that entry instead (for routes that
 * query more than one table, e.g. the session lookup followed by the profile lookup).
 * An entry may also be a function of the recorded query, for tables read by several
 * different queries in one request (e.g. room_members: membership check vs member list);
 * it runs when the chain is awaited, so every chained call is visible to it.
 *
 * `db.rpc(name, args)` resolves to `results.rpcByName[name]`, falling back to `results.rpc`. An
 * rpcByName entry may be a function of the args (e.g. to apply the write to an in-memory world);
 * it runs when the call is awaited.
 * `db.storage.from(bucket).createSignedUrls(paths, ttl)` resolves to `results.signUrls(paths)`
 * (default: every path signed as an https URL); calls are recorded in `storageCalls`.
 */

export interface RecordedQuery {
  table: string;
  calls: [method: string, args: unknown[]][];
}

export interface DbResult {
  data?: unknown;
  error: { code?: string; message?: string; details?: string; hint?: string } | null;
}

export type SelectResult = DbResult | ((query: RecordedQuery) => DbResult);

export type RpcResult = DbResult | ((args: Record<string, unknown>) => DbResult);

export interface SignedUrlsResult {
  data: { path: string | null; signedUrl: string; error: string | null }[] | null;
  error: { message: string } | null;
}

export interface StorageCall {
  bucket: string;
  paths: string[];
  expiresIn: number;
}

export const queries: RecordedQuery[] = [];
export const storageCalls: StorageCall[] = [];

/** Signs every path as an https URL; the default for `results.signUrls`. */
export function signAll(paths: string[]): SignedUrlsResult {
  return {
    data: paths.map((path) => ({ path, signedUrl: `https://storage.test/sign/${path}?token=signed`, error: null })),
    error: null,
  };
}

export const results: {
  lookup: DbResult;
  delete: DbResult;
  rpc: DbResult;
  rpcByName: Partial<Record<string, RpcResult>>;
  selectByTable: Partial<Record<string, SelectResult>>;
  signUrls: (paths: string[]) => SignedUrlsResult | Promise<SignedUrlsResult>;
} = {
  lookup: { data: null, error: null },
  selectByTable: {},
  delete: { error: null },
  rpc: { data: null, error: null },
  rpcByName: {},
  signUrls: signAll,
};

const CHAIN_METHODS = [
  'select',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'is',
  'in',
  'or',
  'order',
  'limit',
  'range',
  'delete',
  'maybeSingle',
  'single',
  'overrideTypes',
] as const;

function thenable<T>(resolve: () => T) {
  return (onFulfilled: (value: T) => unknown, onRejected: (reason: unknown) => unknown) =>
    Promise.resolve()
      .then(resolve)
      .then(onFulfilled, onRejected);
}

function builder(table: string): Record<string, unknown> {
  const record: RecordedQuery = { table, calls: [] };
  queries.push(record);
  const chain: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    chain[method] = (...args: unknown[]) => {
      record.calls.push([method, args]);
      return chain;
    };
  }
  // supabase-js builders are thenables; mimic that so `await db.from(...)...` works.
  chain.then = thenable((): DbResult => {
    const first = record.calls[0]?.[0];
    if (first === 'delete') return results.delete;
    if (first !== 'select') return results.lookup;
    const entry = results.selectByTable[table];
    if (typeof entry === 'function') return entry(record);
    return entry ?? results.lookup;
  });
  return chain;
}

function rpcBuilder(fn: string, args: Record<string, unknown>): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.overrideTypes = () => chain;
  chain.then = thenable((): DbResult => {
    const entry = results.rpcByName[fn];
    if (typeof entry === 'function') return entry(args);
    return entry ?? results.rpc;
  });
  return chain;
}

const createSignedUrls = vi.fn((paths: string[], _expiresIn: number) =>
  Promise.resolve(results.signUrls(paths)),
);

export const fakeDb = {
  from: vi.fn((table: string) => builder(table)),
  rpc: vi.fn((fn: string, args: Record<string, unknown>) => rpcBuilder(fn, args)),
  storage: {
    from: vi.fn((bucket: string) => ({
      createSignedUrls: (paths: string[], expiresIn: number) => {
        storageCalls.push({ bucket, paths, expiresIn });
        return createSignedUrls(paths, expiresIn);
      },
    })),
  },
};

export function resetFakeDb(): void {
  queries.length = 0;
  storageCalls.length = 0;
  results.lookup = { data: null, error: null };
  results.delete = { error: null };
  results.rpc = { data: null, error: null };
  results.rpcByName = {};
  results.selectByTable = {};
  results.signUrls = signAll;
  fakeDb.from.mockClear();
  fakeDb.rpc.mockClear();
  fakeDb.storage.from.mockClear();
  createSignedUrls.mockClear();
}

/** The chained calls of the n-th `db.from(...)` query, e.g. [['delete', []], ['eq', ['id', '...']]]. */
export function callsOf(index: number): RecordedQuery | undefined {
  return queries[index];
}

/** The argument passed to the first `method(...)` call in a recorded query, e.g. the `select` columns. */
export function firstArg(query: RecordedQuery, method: string): unknown {
  return query.calls.find(([m]) => m === method)?.[1][0];
}
