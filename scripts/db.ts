/*
 * Database tooling against the hosted Supabase dev project (no Docker).
 *
 *   npm run db:status   migrations applied vs local        (supabase migration list)
 *   npm run db:push     apply pending migrations            (supabase db push)
 *   npm run db:reset    DESTRUCTIVE: re-create the schema from migrations + seed (supabase db reset);
 *                       interactive only, you must type the project ref
 *   npm run test:db     run supabase/tests/**\/*.sql with pgTAP, each file rolled back
 *
 * Extra args pass through, e.g. `npm run db:push -- --dry-run`.
 *
 * Config (tooling only, from .env; the app never reads these, so they're validated here):
 *   SUPABASE_DB_URL           session pooler connection string. Contains the DB password.
 *   SUPABASE_DEV_PROJECT_REF  the dev project's ref; every command refuses any other project.
 *   SUPABASE_DB_CA_CERT       optional path to the Supabase root CA; enables verified TLS for test:db.
 *
 * The URL is never typed into a shell, but it is passed to the Supabase CLI as `--db-url`,
 * so it is visible in that child process's arguments while it runs.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { evaluate, outputLines, parseDbTarget, prepareBody, type DbTarget, type FileResult } from './pgtap.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** SUPABASE_DB_URL, checked to point at the dev project. Exits without echoing the URL. */
function dbTarget(): DbTarget {
  const result = parseDbTarget(process.env);
  if ('error' in result) fail(result.error);
  return result;
}

function supabase(args: string[]): never {
  if (args.some((a) => a.startsWith('--debug'))) fail('--debug is not allowed: it can print connection details.');
  const { url } = dbTarget();
  const cli = join(dirname(createRequire(import.meta.url).resolve('supabase/package.json')), 'dist', 'supabase.js');
  const result = spawnSync(process.execPath, [cli, ...args, '--db-url', url], { cwd: root, stdio: 'inherit' });
  if (result.error) fail(`Could not start the Supabase CLI: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

/** A person at a terminal must type the project ref. Agents have no TTY, so they can't run this. */
async function confirmReset(): Promise<void> {
  const { ref } = dbTarget();
  if (!process.stdin.isTTY) fail('db:reset must be run by a person in an interactive terminal.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `This drops and re-creates the schema of project ${ref} from migrations + seed. Type the project ref to continue: `,
  );
  rl.close();
  if (answer.trim() !== ref) fail('Project ref did not match. Nothing was changed.');
}

async function sqlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

// --- pgTAP runner -----------------------------------------------------------

function sslConfig(): pg.ClientConfig['ssl'] {
  const caPath = process.env.SUPABASE_DB_CA_CERT;
  if (caPath) return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  process.stdout.write(
    'Warning: SUPABASE_DB_CA_CERT not set; TLS is encrypted but the server certificate is not verified.\n',
  );
  return { rejectUnauthorized: false };
}

async function runFile(client: pg.Client, file: string): Promise<FileResult> {
  const name = relative(root, file).replaceAll('\\', '/');
  const prepared = prepareBody(await readFile(file, 'utf8'));
  if ('error' in prepared) return { name, lines: [], passed: 0, failed: 0, problems: [prepared.error] };

  let lines: string[] = [];
  const problems: string[] = [];
  try {
    await client.query('begin');
    const { rows } = await client.query<{ xid: string }>('select txid_current()::text as xid');
    await client.query("set local statement_timeout = '30s'; set local lock_timeout = '10s'");
    await client.query('create extension if not exists pgtap with schema extensions');
    try {
      lines = outputLines(await client.query(prepared.body));
    } catch (err) {
      const e = err as pg.DatabaseError;
      problems.push(`SQL error: ${e.message}${e.position ? ` (at character ${e.position})` : ''}`);
    }
    // Defense in depth: if the file somehow ended the transaction, its changes may be committed.
    const after = await client.query<{ xid: string | null }>('select txid_current_if_assigned()::text as xid');
    if (!problems.length && after.rows[0]?.xid !== rows[0]?.xid) {
      problems.push('file ended the test transaction; changes may have been committed to the dev database');
    }
  } finally {
    await client.query('rollback');
  }

  const result = evaluate(name, lines);
  return { ...result, problems: [...problems, ...(problems.length ? [] : result.problems)] };
}

async function runTests(): Promise<void> {
  const files = await sqlFiles(join(root, 'supabase', 'tests'));
  if (files.length === 0) {
    process.stdout.write('No pgTAP tests in supabase/tests.\n');
    return;
  }

  const client = new pg.Client({ connectionString: dbTarget().url, ssl: sslConfig() });
  await client.connect();

  const results: FileResult[] = [];
  try {
    for (const file of files) {
      const result = await runFile(client, file);
      results.push(result);
      const ok = result.failed === 0 && result.problems.length === 0;
      process.stdout.write(`\n${ok ? 'PASS' : 'FAIL'} ${result.name}\n`);
      for (const line of result.lines) process.stdout.write(`  ${line}\n`);
      for (const problem of result.problems) process.stdout.write(`  ! ${problem}\n`);
    }
  } finally {
    await client.end();
  }

  const passed = results.reduce((n, r) => n + r.passed, 0);
  const failed = results.reduce((n, r) => n + r.failed, 0);
  const badFiles = results.filter((r) => r.failed > 0 || r.problems.length > 0);
  process.stdout.write(
    `\n${results.length} files, ${passed} assertions passed, ${failed} failed, ${badFiles.length} files with problems\n`,
  );
  if (badFiles.length > 0) fail(`Failed: ${badFiles.map((r) => r.name).join(', ')}`);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'status':
    supabase(['migration', 'list', ...args]);
    break;
  case 'push':
    supabase(['db', 'push', ...args]);
    break;
  case 'reset':
    await confirmReset();
    supabase(['db', 'reset', '--yes', ...args]);
    break;
  case 'test':
    await runTests();
    break;
  default:
    fail('Usage: tsx scripts/db.ts <status|push|reset|test> [args]');
}
