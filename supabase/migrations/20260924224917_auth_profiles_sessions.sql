-- Auth foundation: schema-wide lockdown, profiles, sessions, and create_login_session().
--
-- Access model (CLAUDE.md): only Node touches application tables, via the service role.
-- Browsers (anon, authenticated) get no table or function privileges in schema public.

-- ---------------------------------------------------------------------------
-- 1. Default privileges for future objects in schema public
-- ---------------------------------------------------------------------------
-- On hosted Supabase, new objects in public are granted to anon, authenticated, and
-- service_role by default. Make exposure opt-in. Migrations run as `postgres`, so the
-- defaults are changed for objects created by `postgres`.
-- See https://supabase.com/docs/guides/database/hardening-data-api
--
-- Not covered: `for role supabase_admin`. The hosted `postgres` role is not a member of
-- supabase_admin, so it cannot alter that role's defaults; our migrations never create
-- objects as supabase_admin.
--
-- PUBLIC and functions: Postgres grants EXECUTE on functions to PUBLIC through a *global*
-- default, and per-schema default privileges can only add to global ones, never remove
-- them (Postgres docs, ALTER DEFAULT PRIVILEGES). A global revoke would also strip PUBLIC
-- execute from extension functions created later (e.g. pgTAP, which test:db creates per
-- run and calls as `authenticated`). So every function in public MUST explicitly
-- `revoke execute ... from public, anon, authenticated` in its own migration.

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, public;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, public;

alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;

-- Node uses the service role (PostgREST), so it keeps access to future objects.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;

alter default privileges for role postgres in schema public
  grant usage, select on sequences to service_role;

alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

-- ---------------------------------------------------------------------------
-- 2. profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid        primary key default gen_random_uuid(),
  steam_id     text        not null unique check (steam_id ~ '^[0-9]{17}$'),
  display_name text        not null check (char_length(display_name) between 1 and 64),
  avatar_url   text        check (avatar_url is null or avatar_url ~ '^https://'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is 'One row per Steam account that has logged in. Server-only (service role).';

alter table public.profiles enable row level security;

revoke all on table public.profiles from anon, authenticated, public;
grant select, insert, update, delete on table public.profiles to service_role;

-- ---------------------------------------------------------------------------
-- 3. sessions
-- ---------------------------------------------------------------------------
-- token_hash is the lowercase hex HMAC-SHA256 (keyed with SESSION_SECRET) of the session cookie value; the raw token is
-- never stored.
create table public.sessions (
  id         uuid        primary key default gen_random_uuid(),
  profile_id uuid        not null references public.profiles (id) on delete cascade,
  token_hash text        not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint sessions_expires_after_created check (expires_at > created_at)
);

comment on table public.sessions is 'Login sessions; token_hash = hex HMAC-SHA256(SESSION_SECRET, cookie token). Server-only (service role).';

-- FK lookups (delete expired sessions per profile, cascade) and expiry sweeps.
create index sessions_profile_id_idx on public.sessions (profile_id);
create index sessions_expires_at_idx on public.sessions (expires_at);

alter table public.sessions enable row level security;

revoke all on table public.sessions from anon, authenticated, public;
grant select, insert, update, delete on table public.sessions to service_role;

-- No RLS policies on either table: anon/authenticated have no privileges and no policies.
-- Neither table is added to the supabase_realtime publication (we use Broadcast).

-- ---------------------------------------------------------------------------
-- 4. create_login_session
-- ---------------------------------------------------------------------------
-- Called by Node after a verified Steam login. In one transaction:
--   1. upsert the profile by steam_id (the upsert row-locks an existing profile, so
--      concurrent logins for the same Steam account serialize here);
--      if p_keep_existing_profile is true (Steam's profile API failed), an existing row's
--      display_name/avatar_url are left unchanged; a new row still uses the given values,
--      so Node must pass a valid fallback display_name;
--   2. delete that profile's expired sessions;
--   3. insert the new session.
-- Returns the profile id.
-- Failures:
--   22023 invalid_parameter_value  p_expires_at is null or not in the future
--   23514 check_violation          bad steam_id, display_name, avatar_url, or token_hash
--   23502 not_null_violation       null steam_id, display_name, or token_hash
--   23505 unique_violation         token_hash already exists
create function public.create_login_session(
  p_steam_id              text,
  p_display_name          text,
  p_avatar_url            text,
  p_token_hash            text,
  p_expires_at            timestamptz,
  p_keep_existing_profile boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_keep       boolean := coalesce(p_keep_existing_profile, false);
begin
  if p_expires_at is null or p_expires_at <= pg_catalog.now() then
    raise exception 'expires_at must be in the future'
      using errcode = '22023';
  end if;

  insert into public.profiles as p (steam_id, display_name, avatar_url)
  values (p_steam_id, p_display_name, p_avatar_url)
  on conflict (steam_id) do update
    set display_name = case when v_keep then p.display_name else excluded.display_name end,
        avatar_url   = case when v_keep then p.avatar_url   else excluded.avatar_url   end,
        updated_at   = case when v_keep then p.updated_at   else pg_catalog.now()      end
  returning p.id into v_profile_id;

  delete from public.sessions s
  where s.profile_id = v_profile_id
    and s.expires_at <= pg_catalog.now();

  insert into public.sessions (profile_id, token_hash, expires_at)
  values (v_profile_id, p_token_hash, p_expires_at);

  return v_profile_id;
end;
$$;

comment on function public.create_login_session(text, text, text, text, timestamptz, boolean) is
  'Upserts a profile by steam_id, prunes its expired sessions, inserts a new session. service_role only.';

revoke execute on function public.create_login_session(text, text, text, text, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.create_login_session(text, text, text, text, timestamptz, boolean)
  to service_role;
