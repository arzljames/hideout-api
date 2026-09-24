/*
 * Pure pgTAP helpers used by scripts/db.ts (kept separate so they can be unit tested).
 */
import type pg from 'pg';

/**
 * The SQL with comments, string literals, quoted identifiers, and dollar-quoted bodies
 * replaced by spaces of the same length, so indexes still line up with the original.
 */
export function maskLiterals(sql: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/--[^\n]*/g, blank)
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, blank)
    .replace(/'(?:[^']|'')*'/g, blank)
    .replace(/"(?:[^"]|"")*"/g, blank);
}

const TX_CONTROL = /^(begin|start\s+transaction|commit|end|abort|rollback|savepoint|release|prepare\s+transaction)\b/i;

interface Statement {
  start: number;
  end: number; // index just past the terminating ';' (or end of text)
  text: string; // masked, trimmed
}

function statements(sql: string): Statement[] {
  const masked = maskLiterals(sql);
  const result: Statement[] = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (i === masked.length || masked[i] === ';') {
      const text = masked.slice(start, i).trim();
      if (text) result.push({ start, end: Math.min(i + 1, masked.length), text });
      start = i + 1;
    }
  }
  return result;
}

/*
 * The runner owns the transaction. A file may open with `begin;` and close with
 * `rollback;` (Supabase docs style); exactly those two are blanked out. Any other
 * transaction control would end the runner's transaction and commit to the shared
 * database, so the file is rejected instead of run.
 */
export function prepareBody(sql: string): { body: string } | { error: string } {
  const list = statements(sql);
  const control = list.filter((s) => TX_CONTROL.test(s.text));
  const first = list[0];
  const last = list.at(-1);
  const docsStyle =
    control.length === 2 && first !== undefined && last !== undefined &&
    /^begin$/i.test(first.text) && /^rollback$/i.test(last.text);

  if (control.length > 0 && !docsStyle) {
    const names = control.map((s) => s.text.split(/\s+/)[0]?.toLowerCase()).join(', ');
    return { error: `transaction control is not allowed in test files (${names})` };
  }
  if (!docsStyle) return { body: sql };

  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  const body =
    blank(sql.slice(0, first.end)) +
    sql.slice(first.end, last.start) +
    blank(sql.slice(last.start, last.end)) +
    sql.slice(last.end);
  return { body };
}

/** String values of every row of every statement's result, split into lines. */
export function outputLines(results: pg.QueryResult | pg.QueryResult[]): string[] {
  const list = Array.isArray(results) ? results : [results];
  return list
    .flatMap((r) => r.rows as Record<string, unknown>[])
    .flatMap((row) => Object.values(row))
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => v.split('\n'));
}

const TAP = {
  ok: /^ok \d+\b/,
  notOk: /^not ok \d+\b/,
  todo: /#\s*TODO\b/i,
  plan: /^1\.\.(\d+)\s*$/,
  diagnostic: /^# /,
};

export interface FileResult {
  name: string;
  lines: string[];
  passed: number;
  failed: number;
  problems: string[];
}

export function evaluate(name: string, lines: string[]): FileResult {
  const tap = lines.filter((l) => TAP.ok.test(l) || TAP.notOk.test(l) || TAP.plan.test(l) || TAP.diagnostic.test(l));
  const assertions = tap.filter((l) => TAP.ok.test(l) || TAP.notOk.test(l));
  const failed = assertions.filter((l) => TAP.notOk.test(l) && !TAP.todo.test(l)).length;
  const problems: string[] = [];

  const plan = tap.map((l) => TAP.plan.exec(l)?.[1]).find((n) => n !== undefined);
  if (plan === undefined) problems.push('missing select plan(n) / finish()');
  else if (Number(plan) !== assertions.length) problems.push(`planned ${plan} tests but ran ${assertions.length}`);

  return { name, lines: tap, passed: assertions.length - failed, failed, problems };
}

export interface DbTarget {
  url: string;
  ref: string;
}

/**
 * Validates SUPABASE_DB_URL and refuses anything but the dev project
 * (SUPABASE_DEV_PROJECT_REF). Error messages never include the URL.
 */
export function parseDbTarget(env: NodeJS.ProcessEnv): DbTarget | { error: string } {
  const raw = env.SUPABASE_DB_URL;
  const expectedRef = env.SUPABASE_DEV_PROJECT_REF;
  if (!raw) return { error: 'SUPABASE_DB_URL is not set. Add it to .env (see .env.example).' };
  if (!expectedRef) return { error: 'SUPABASE_DEV_PROJECT_REF is not set. Add it to .env (see .env.example).' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'SUPABASE_DB_URL is not a valid URL (percent-encode special characters in the password).' };
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return { error: 'SUPABASE_DB_URL must start with postgres:// or postgresql://.' };
  }

  // Pooler URLs carry the ref in the user (postgres.<ref>); direct URLs in the host (db.<ref>.supabase.co).
  const ref =
    /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(url.username))?.[1] ??
    /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1];
  if (ref !== expectedRef) {
    return { error: `SUPABASE_DB_URL does not point at the dev project (${expectedRef}). Refusing to run.` };
  }

  if (env.SUPABASE_URL) {
    let apiHost: string | undefined;
    try {
      apiHost = new URL(env.SUPABASE_URL).hostname;
    } catch {
      apiHost = undefined;
    }
    if (apiHost !== `${expectedRef}.supabase.co`) {
      return { error: 'SUPABASE_URL and SUPABASE_DEV_PROJECT_REF point at different projects. Refusing to run.' };
    }
  }

  // sslmode/ssl in the URL would override the TLS settings in code (pg merges URL params last).
  url.searchParams.delete('sslmode');
  url.searchParams.delete('ssl');
  return { url: url.toString(), ref };
}
