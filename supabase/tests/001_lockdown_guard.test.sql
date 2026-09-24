-- Catalog-wide guard for Non-negotiable rules 1 and 2: runs on every test:db, so a
-- future migration that forgets RLS or a `revoke execute` fails here.
-- Functions browsers must call (e.g. the Realtime topic helper) belong in a separate
-- schema, not public, so they don't need an exception here.
select plan(4);

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (
        select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e'
      )
      and (
        has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')
      )
  $$,
  'no public function is executable by anon or authenticated'
);

select is_empty(
  $$
    select c.relname::text
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  $$,
  'every public table has RLS enabled'
);

select is_empty(
  $$
    select c.relname::text
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
      and (
        has_table_privilege('anon', c.oid, 'select, insert, update, delete')
        or has_table_privilege('authenticated', c.oid, 'select, insert, update, delete')
      )
  $$,
  'no public table or view is readable or writable by anon or authenticated'
);

select is_empty(
  $$
    select tablename::text from pg_catalog.pg_policies
    where schemaname = 'public'
      and roles && array['anon', 'authenticated', 'public']::name[]
  $$,
  'no RLS policies for anon, authenticated, or public on application tables'
);

select * from finish();
