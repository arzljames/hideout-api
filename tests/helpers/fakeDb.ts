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
 */

export interface RecordedQuery {
  table: string;
  calls: [method: string, args: unknown[]][];
}

interface DbResult {
  data?: unknown;
  error: { code?: string; message?: string; details?: string; hint?: string } | null;
}

export const queries: RecordedQuery[] = [];

export const results: {
  lookup: DbResult;
  delete: DbResult;
  rpc: DbResult;
  selectByTable: Partial<Record<string, DbResult>>;
} = {
  lookup: { data: null, error: null },
  selectByTable: {},
  delete: { error: null },
  rpc: { data: null, error: null },
};

const CHAIN_METHODS = ['select', 'eq', 'gt', 'delete', 'maybeSingle'] as const;

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
  chain.then = (onFulfilled: (value: DbResult) => unknown, onRejected: (reason: unknown) => unknown) => {
    const result =
      record.calls[0]?.[0] === 'delete'
        ? results.delete
        : record.calls[0]?.[0] === 'select'
          ? (results.selectByTable[table] ?? results.lookup)
          : results.lookup;
    return Promise.resolve(result).then(onFulfilled, onRejected);
  };
  return chain;
}

export const fakeDb = {
  from: vi.fn((table: string) => builder(table)),
  rpc: vi.fn((_fn: string, _args: Record<string, unknown>) => Promise.resolve(results.rpc)),
};

export function resetFakeDb(): void {
  queries.length = 0;
  results.lookup = { data: null, error: null };
  results.delete = { error: null };
  results.rpc = { data: null, error: null };
  results.selectByTable = {};
  fakeDb.from.mockClear();
  fakeDb.rpc.mockClear();
}

/** The chained calls of the n-th `db.from(...)` query, e.g. [['delete', []], ['eq', ['id', '...']]]. */
export function callsOf(index: number): RecordedQuery | undefined {
  return queries[index];
}
