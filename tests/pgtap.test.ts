import { describe, expect, it } from 'vitest';
import { evaluate, maskLiterals, parseDbTarget, prepareBody } from '../scripts/pgtap.js';

describe('prepareBody (transaction guard)', () => {
  it('runs files without transaction control unchanged', () => {
    const sql = "select plan(1);\nselect ok(true);\nselect * from finish();\n";
    expect(prepareBody(sql)).toEqual({ body: sql });
  });

  it('blanks exactly the leading begin and trailing rollback of docs-style files', () => {
    const sql = '-- header\nbegin;\nselect plan(1);\nselect ok(true);\nselect * from finish();\nrollback;\n';
    const result = prepareBody(sql);
    expect('body' in result && result.body).toBeTruthy();
    const body = (result as { body: string }).body;
    expect(body).not.toMatch(/\bbegin\b|\brollback\b/i);
    expect(body).toContain('select plan(1);');
    expect(body.length).toBe(sql.length);
  });

  it.each([
    ['commit', 'select plan(1);\nselect ok(true);\ncommit;\n'],
    ['commit on a shared line', 'select plan(1); select ok(true); commit;'],
    ['commit work', 'select plan(1);\ncommit work;\n'],
    ['end', 'select plan(1);\nend;\n'],
    ['abort', 'select plan(1);\nabort;\n'],
    ['begin mid-file', 'select plan(1);\nbegin;\nselect ok(true);\n'],
    ['start transaction', 'start transaction;\nselect plan(1);\n'],
    ['savepoint', 'select plan(1);\nsavepoint a;\n'],
    ['rollback followed by more SQL', 'begin;\nselect plan(1);\nrollback;\ndrop table x;\n'],
    ['uppercase with spaces', 'select plan(1);\nCOMMIT ;\n'],
  ])('rejects %s', (_label, sql) => {
    expect(prepareBody(sql)).toHaveProperty('error');
  });

  it('ignores transaction keywords inside strings, comments, and dollar-quoted bodies', () => {
    const sql = [
      "select plan(1);",
      "-- commit; in a comment",
      "/* end; */",
      "select ok('commit;' = 'commit;', 'commit; in a string');",
      "do $$ begin perform 1; end $$;",
      "select * from finish();",
    ].join('\n');
    expect(prepareBody(sql)).toEqual({ body: sql });
  });

  it('maskLiterals preserves length and line breaks', () => {
    const sql = "select 'a;b' -- c;\n, $x$ d; $x$;";
    const masked = maskLiterals(sql);
    expect(masked.length).toBe(sql.length);
    expect(masked.split('\n')).toHaveLength(2);
    expect(masked).not.toMatch(/a;b|c;|d;/);
  });
});

describe('evaluate (TAP parsing)', () => {
  it('passes when every planned assertion is ok', () => {
    const r = evaluate('t.sql', ['1..2', 'ok 1 - a', 'ok 2 - b']);
    expect(r).toMatchObject({ passed: 2, failed: 0, problems: [] });
  });

  it('counts not ok as a failure once (not again for the finish() diagnostic)', () => {
    const r = evaluate('t.sql', ['1..2', 'ok 1 - a', 'not ok 2 - b', '# Looks like you failed 1 test of 2']);
    expect(r).toMatchObject({ passed: 1, failed: 1, problems: [] });
  });

  it('does not count TODO failures', () => {
    const r = evaluate('t.sql', ['1..1', 'not ok 1 - later # TODO not built yet']);
    expect(r.failed).toBe(0);
  });

  it('flags a short run when finish() is missing', () => {
    const r = evaluate('t.sql', ['1..5', 'ok 1', 'ok 2', 'ok 3']);
    expect(r.problems).toEqual(['planned 5 tests but ran 3']);
  });

  it('flags a missing plan', () => {
    expect(evaluate('t.sql', ['ok 1']).problems).toEqual(['missing select plan(n) / finish()']);
  });

  it('ignores non-TAP row values like set_config results and "okay"', () => {
    const r = evaluate('t.sql', ['1..1', '{"sub":"x","role":"authenticated"}', 'okay', 'ok_to_send', '1..3x', 'ok 1']);
    expect(r).toMatchObject({ passed: 1, failed: 0, problems: [] });
    expect(r.lines).toEqual(['1..1', 'ok 1']);
  });
});

describe('parseDbTarget (dev-project guard)', () => {
  const ref = 'abcdefghijklmnop';
  const pooler = `postgresql://postgres.${ref}:p%40ss@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
  const base = { SUPABASE_DEV_PROJECT_REF: ref, SUPABASE_URL: `https://${ref}.supabase.co` };

  it('accepts the dev project pooler and direct URLs', () => {
    expect(parseDbTarget({ ...base, SUPABASE_DB_URL: pooler })).toMatchObject({ ref });
    const direct = `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`;
    expect(parseDbTarget({ ...base, SUPABASE_DB_URL: direct })).toMatchObject({ ref });
  });

  it('refuses another project, without echoing the URL', () => {
    const other = pooler.replace(ref, 'zzzzzzzzzzzzzzzz');
    const result = parseDbTarget({ ...base, SUPABASE_DB_URL: other });
    expect(result).toHaveProperty('error');
    expect(JSON.stringify(result)).not.toContain('p%40ss');
    expect(JSON.stringify(result)).not.toContain('zzzz');
  });

  it('refuses when SUPABASE_URL points at a different project', () => {
    const result = parseDbTarget({ ...base, SUPABASE_URL: 'https://evil.example/?x=abcdefghijklmnop.supabase.co', SUPABASE_DB_URL: pooler });
    expect(result).toHaveProperty('error');
  });

  it('requires both variables', () => {
    expect(parseDbTarget({ SUPABASE_DB_URL: pooler })).toHaveProperty('error');
    expect(parseDbTarget({ SUPABASE_DEV_PROJECT_REF: ref })).toHaveProperty('error');
  });

  it('strips sslmode so the URL cannot override TLS settings', () => {
    const result = parseDbTarget({ ...base, SUPABASE_DB_URL: `${pooler}?sslmode=disable` });
    expect('url' in result && result.url).not.toContain('sslmode');
  });
});
