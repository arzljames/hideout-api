# hideout-api

Backend for Hideout: invite-only voice and text rooms for Steam players. This repo owns the API, the database schema, the realtime event design, and the contract. The React frontend lives in a separate repo (`hideout-web`).

## The data flow in one sentence

**Node does every database read and write; the browser only subscribes to Supabase Realtime channels to receive events that Node broadcasts.**

| Action | Path |
|---|---|
| Load data (rooms, members, message history) | Browser → REST → Node → Postgres |
| Change data (send message, invite, remove member) | Browser → REST → Node → Postgres → Node broadcasts event |
| Receive live updates | Supabase Realtime private channel → Browser |
| Typing indicators, who's online | Browser ↔ Supabase Realtime (Broadcast/Presence, ephemeral, never stored) |
| Voice | Browser ↔ LiveKit, with a token from Node |

The browser never queries tables, never calls Postgres functions, and never writes to the database.

## Stack

- Node.js 24 LTS (`.nvmrc`; `engines` allows `^22.13.0 || ^24.0.0 || >=26.0.0`, the floor set by supabase-js, Vitest, and ESLint) + Express + TypeScript (strict)
- Supabase: hosted Postgres (accessed only from this server with the service role key) + Realtime (Broadcast and Presence on private channels)
- `@supabase/supabase-js` (server only)
- Zod for validation; `@asteasolutions/zod-to-openapi` for the REST contract; Zod → JSON Schema for the realtime event contract
- `swagger-ui-dist` for the API docs page (Swagger UI served same-origin at `/api/docs`)
- `livekit-server-sdk` for voice tokens, webhooks, and participant removal
- `jsonwebtoken`, `helmet`, `cookie-parser`, `cors`, `express-rate-limit`
- `pino` + `pino-http` for structured logs
- Vitest + supertest for tests; pgTAP for database and Realtime-policy tests

## Structure

```
hideout-api/
├── src/
│   ├── index.ts          boots the server, graceful shutdown on SIGTERM
│   ├── app.ts            builds the Express app (importable in tests)
│   ├── config/env.ts     Zod-validated env; exits on invalid config
│   ├── contracts/
│   │   ├── http/         Zod request/response schemas (REST source of truth)
│   │   └── events.ts     Zod schemas for every realtime event + topic names (source of truth)
│   ├── middleware/       requireAuth, requireRoomMember, validate, errorHandler, cors, rateLimits
│   ├── routes/           thin HTTP layer: parse → service → respond (docs.ts serves Swagger UI)
│   ├── realtime/
│   │   ├── broadcast.ts  typed helpers: broadcastToChannel, broadcastToRoom, broadcastToUser
│   │   └── token.ts      mints the short-lived Supabase Realtime JWT
│   ├── services/         business logic: auth, rooms, channels, messages, invites, voice
│   ├── db/               supabase admin client, typed query helpers
│   ├── lib/              livekit clients, steam client, logger
│   └── errors.ts         AppError subclasses mapped to HTTP by errorHandler
├── contract/
│   ├── openapi.json       generated REST contract (committed, never edit)
│   └── events.schema.json generated realtime event contract (committed, never edit)
├── supabase/
│   ├── migrations/       the only way the schema and Realtime policies change
│   ├── tests/            pgTAP tests (run by `npm run test:db`)
│   └── seed.sql
└── .claude/
```

Routes contain no business logic. Services never see `req`/`res`; they call `realtime/broadcast.ts` after successful writes.

## Commands

```bash
npm install
npm run dev               # tsx watch on :3001; API docs at http://localhost:3001/api/docs
npm run typecheck
npm run lint
npm run test
npm run build             # tsc → dist/
npm run contracts         # regenerate contract/openapi.json and contract/events.schema.json
npx supabase migration new <name>   # create a migration file (offline)
npm run db:status         # migrations applied on the dev project vs local
npm run db:push           # apply pending migrations to the dev project
npm run db:reset          # DESTRUCTIVE, humans only: re-create the schema from migrations + seed (type the project ref to confirm)
npm run test:db           # pgTAP tests against the dev project (each file rolled back)
```

### Database: one hosted Supabase project, no Docker

This is a side project with **one hosted Supabase project used as the dev database**. There is no local Supabase stack and no Docker. There is no production project yet; create a separate one before real users arrive (see "Before production" below).

- `npm run db:*` and `npm run test:db` wrap the Supabase CLI and `scripts/db.ts`, reading `SUPABASE_DB_URL` (session pooler connection string; contains the DB password), `SUPABASE_DEV_PROJECT_REF`, and optionally `SUPABASE_DB_CA_CERT` from `.env`. Every command refuses a URL for any project other than `SUPABASE_DEV_PROJECT_REF`. The URL is never typed into a shell, but it is passed to the Supabase CLI as `--db-url`, so it is visible in that process's arguments while it runs.
- `npm run db:reset` only runs in an interactive terminal and asks you to type the project ref, so agents can't run it. It re-applies all migrations and the seed to a clean schema; confirm on the first run what it keeps (e.g. `auth` users).
- `npm run test:db` runs every `supabase/tests/**/*.sql` file in its own transaction that is always rolled back (including `create extension pgtap`), with a 30s statement timeout. A file may open with `begin;` and close with `rollback;` (Supabase docs style); any other transaction control (`commit`, `end`, `savepoint`, ...) fails the file without running it, because it would commit to the shared database. Each file needs `select plan(n)` and `select * from finish()`; the runner also fails a file whose assertion count doesn't match its plan. Without `SUPABASE_DB_CA_CERT`, TLS is encrypted but the server certificate isn't verified.
- `npm run test` (Vitest) never touches the database: it mocks at the supabase-js / `fetch` boundary, so it runs offline. Database behavior is tested with pgTAP.
- Supabase Auth sign-ups must be off in the dashboard (Authentication → Sign In / Providers). `supabase/config.toml` only affects a local stack.
- `db:push` changes the shared dev database; agents ask before running it. When a clean slate is needed, agents ask you to run `db:reset`.

**Before production:** create a second Supabase project with a different database password, apply the same migrations to it, turn on backups, and put its keys only in the deployment's env. Never put its connection string in a dev `.env`; the project-ref guard exists to catch that mistake.

Done means: `npm run typecheck && npm run lint && npm run test` pass. If contracts changed, `npm run contracts` was run and the diff committed. If migrations changed, `npm run db:push && npm run test:db` pass against the dev project.

## The contract with hideout-web

Two generated files, both committed and served by the API:

- `contract/openapi.json` (REST), served at `GET /api/contract/openapi.json`
- `contract/events.schema.json` (realtime topics, event names, payloads), served at `GET /api/contract/events.schema.json`

Interactive REST docs: **Swagger UI at `GET /api/docs`** (locally http://localhost:3001/api/docs, or via the Vite proxy at http://localhost:5173/api/docs). It renders `contract/openapi.json`, is public like the contract, and is served from `swagger-ui-dist` on the same origin so helmet's CSP stays strict. "Try it out" sends your session cookie. Opened on the API origin, only GETs work (state-changing requests fail the Origin check, since the page's origin isn't `WEB_ORIGIN`); opened through the Vite proxy, the page shares `WEB_ORIGIN`, so mutations go through like the app's own requests.

hideout-web generates its TypeScript types from both. Rules:

- `src/contracts/` is the source of truth; never edit the generated files.
- Every REST endpoint is registered with `registry.registerPath` in `src/contracts/http/` (method, path, tags, summary, request, responses, error codes) so it appears in `openapi.json` and `/api/docs`. Public endpoints set `security: []`; everything else inherits the `session` cookie scheme. **Every new feature adds its endpoints to Swagger.** This is enforced: routes are created with `documentedRouter()` (`src/routes/documentedRouter.ts`; plain Express `Router` is lint-banned in `src/routes`), which throws when a route isn't registered, so the app and every test fail until it is. Non-API routes (Swagger UI's own assets) use `.undocumented(reason, ...)`.
- **No breaking changes** to existing endpoints or events (removing/renaming fields or events, changing types, new required fields). Add new fields or events, mark the old ones deprecated, remove only after hideout-web has shipped without them.
- Every PR that changes `contract/` must say so in its description, with a summary for the frontend.
- **Every feature updates the hideout-web handoff doc**, `docs/hideout-web-handoff.md` (source of truth, committed in the same PR, with a Changelog line), and mirrors it to the shared Claude doc when the Docs connector is available. See `/new-feature` Phase 5.

## Realtime design

All channels are **private** (`config: { private: true }`), so Supabase checks RLS policies on `realtime.messages` before a browser can join, receive, or send.

**Topics**
- `room:<roomId>`: room-level events + Presence (who's online in the room)
- `channel:<channelId>`: message events (receive-only for browsers)
- `typing:<channelId>`: typing broadcasts between members (the only topic browsers may broadcast on)
- `user:<profileId>`: events for one person (invites, removals, session expiry)

**Events Node broadcasts** (defined in `src/contracts/events.ts`)
- `channel:<id>`: `message:created`, `message:updated`, `message:deleted`
- `room:<id>`: `channel:created`, `channel:updated`, `channel:deleted`, `member:joined`, `member:left`, `member:role_changed`, `voice:participants`, `room:updated`, `room:deleted`
- `user:<id>`: `invite:received`, `member:removed`, `session:expired`

**Events browsers may send** (enforced by RLS insert policies): Broadcast only on `typing:<id>` topics and Presence only on `room:<id>` topics, and only for rooms the user belongs to. Realtime checks send rights once per join, without seeing the event or payload, so RLS can't limit which events are sent: that's why typing has its own topic, and why receivers treat typing and Presence payloads as untrusted (ignore userIds not in the member list). Accepted limits: a member can spoof another member's typing or Presence (never use them for authorization), and can flood `typing:`/Presence, which counts against the project-wide Realtime quota; clients subscribe only to the `typing` event, and if abuse appears, typing moves behind a rate-limited Node endpoint.

**Rules**
- Broadcast **only after** the database write succeeds, from services via `realtime/broadcast.ts`. Payloads are complete (e.g. a message includes author name and avatar) so the browser doesn't need a follow-up request.
- Delivery is best-effort. Clients fill gaps by calling `GET /api/channels/:id/messages?after=<lastMessageId>` after reconnecting.
- Application tables are **not** in the `supabase_realtime` publication. We use Broadcast, not Postgres Changes.
- Verify server-side Broadcast methods against the current Supabase docs before changing `broadcast.ts`.

**Realtime auth**
- `GET /api/auth/realtime-token` returns a Supabase JWT (`role: authenticated`, `sub: profiles.id`, TTL 15 minutes) plus `expiresAt`. The browser refreshes it before expiry.
- Verify the custom-JWT approach against the current Supabase docs for the project's JWT signing configuration before changing `token.ts`.
- **Revocation:** Realtime checks policies when a browser joins a channel and when it sends a refreshed token, not per message. On removal (or room deletion), Node broadcasts `member:removed` to `user:<id>` and an honest client leaves; a removed member fails the policy on their next join or token refresh. A client that never refreshes keeps access until its current token's `exp` (15 minutes at most). Tokens are per user, not per room. Confirm current Supabase behavior before relying on anything stronger.

## Deployment topology (important for cookies)

Web and API must be **same-site**: e.g. `app.hideout.gg` (web) and `api.hideout.gg` (API). Different registrable domains make the session cookie third-party and browsers will block it.

- CORS: allow exactly `WEB_ORIGIN`, `credentials: true`.
- Session cookie: httpOnly, Secure, SameSite=Lax, host-only on the API domain.
- Steam OpenID `return_to` = `API_URL/api/auth/steam/callback`; after login, redirect to `WEB_ORIGIN`.
- Local dev: hideout-web's Vite proxy forwards `/api` to `localhost:3001`, so `API_URL` = `WEB_ORIGIN` = `http://localhost:5173`.
- Node holds no long-lived connections, so it can run on any host, including serverless.

## Domain model

- `profiles` (id uuid, steam_id unique, display_name, avatar_url, current_game, current_game_updated_at, created_at, updated_at). `current_game` caches Steam's "currently playing", refreshed by Node.
- `sessions` (id, profile_id, token_hash, created_at, expires_at): server-side login sessions; `token_hash` = HMAC-SHA256(SESSION_SECRET, cookie token), the raw token is never stored
- `rooms` (id, name 1–48, icon_emoji | icon_path (exactly one), created_at, updated_at, deleted_at). No owner column: ownership is the single `owner` row in `room_members`.
- `room_members` (room_id, user_id, role: owner | admin | member, joined_at) PK(room_id, user_id); exactly one owner per live room: a partial unique index stops two, and a trigger stops deleting the owner row (so leaving, removal, or a profile delete can't orphan a room); ownership only moves via `transfer_ownership`
- `channels` (id, room_id, type: text | voice, name 1–32, position, created_at, deleted_at); live names unique per room + type (case-insensitive). The default channel ("You'll land in #general") is the lowest-position live text channel.
- `messages` (id, channel_id, author_id, body 1–2000, idempotency_key, created_at, edited_at, deleted_at); unique (author_id, idempotency_key) makes send-message retries safe
- `invites` (id, room_id, created_by, kind: link | direct, token_hash, invitee_steam_id, max_uses, uses, expires_at, revoked_at, accepted_at, declined_at, created_at). **link**: shareable, token hash only, optional max uses and expiry. **direct**: to a SteamID (the person may not have signed in yet; it appears in their inbox when they do), one use, accept or decline; only one pending per room + SteamID, so revoke an expired pending one before re-inviting. Link expiry and max uses are optional in the DB; the API sets allowed values in Zod.
- Room icons: private Storage bucket `room-icons`; Node uploads and serves signed URLs. Browsers get no storage policies.
- Ephemeral, never stored: online status and typing (Realtime Presence/Broadcast), voice speaking/muted/deafened (LiveKit), voice device and push-to-talk settings (hideout-web localStorage).
- Multi-step writes are Postgres functions (service role only): `create_login_session`, `create_room`, `redeem_invite_link`, `respond_to_direct_invite`, `transfer_ownership`, `delete_room`, `remove_member`, `change_role`. Their error SQLSTATEs map to HTTP in the migration header (`HX001` → 404 for non-members and missing rooms, `HX002` → 403 for members lacking the role). Realtime access is `private.can_access_topic(topic)`, the only Hideout function `authenticated` can execute.
- Invite preview "N online": not decided yet. Presence lives only in Realtime and Node holds no connections, so the preview shows the member count only until a design is chosen.

## Non-negotiable rules

1. **Node is the gate for all data.** The service role bypasses RLS, so every room-scoped route must check membership and role in code.
2. **Application tables have RLS enabled and no policies for `anon` or `authenticated`.** The browser cannot read or write them, even with the anon key.
3. **Realtime access is enforced by RLS on `realtime.messages`**, using the same membership rules as the API. Every topic type has pgTAP tests.
4. Non-members get 404, never 403, so room existence doesn't leak.
5. Secrets (service role key, database URL, JWT signing secret, Steam API key, LiveKit secret, session secret) never appear in responses, broadcasts, or logs.
6. Every REST input is validated with Zod from `src/contracts`; every broadcast payload is built from the event schemas.
7. Schema and policy changes only through new migrations, with tests in the same change. Never edit an applied migration. Every new function in `public` must `revoke execute ... from public, anon, authenticated` itself (Postgres grants PUBLIC execute by default, and schema-level defaults can't remove it). `supabase/tests/001_lockdown_guard.test.sql` fails `test:db` if any `public` table lacks RLS or any table/function is reachable by `anon`/`authenticated`. Functions browsers must call (the Realtime topic helper) go in a separate schema.
8. Soft delete rooms and messages.
9. Revoking access (member removal, room deletion) updates the database, broadcasts the event, and removes the user from LiveKit, together.

## API conventions

- REST under `/api`, JSON only, plural nouns, cursor pagination (`{ data, nextCursor }`).
- Errors: `{ error: { code: 'INVITE_EXPIRED', message: 'This invite has expired.' } }`. 401 unauthenticated, 404 not a member or not found, 403 member lacking role, 422 validation (with field details).
- Retryable mutations (send message, redeem invite) accept `Idempotency-Key`.

## Security rules

- `requireAuth` everywhere except `/api/auth/steam*`, `/api/health`, `/api/ready`, `/api/contract/*`, `/api/docs*`, `GET /api/invites/:token/preview`.
- Steam callback checks `openid.mode`, exact `return_to`, `op_endpoint`, claimed_id regex, then `check_authentication` → `is_valid:true`.
- CSRF: state-changing routes require `Content-Type: application/json` and an `Origin` equal to `WEB_ORIGIN`.
- Invite tokens: 32 random bytes, base64url; store SHA-256 only; redeem in a Postgres function that locks the invite row.
- LiveKit tokens: identity = profile id, room = `voice_<channelId>`, TTL 10 min. Webhooks verified with `WebhookReceiver` on the raw body.
- Rate limits: auth 10/min/IP (separately for `/api/auth/steam` and the callback; both redirect with `?auth_error=RATE_LIMITED` instead of a JSON 429, since they are browser navigations), realtime-token 30/hour/user, messages 10/10s/user, invite create 20/hour/user, invite redeem 10/min/user.
- Pino redaction covers cookies, authorization headers, tokens, and keys.

## Operational

- `GET /api/health` (liveness), `GET /api/ready` (DB, Realtime, and LiveKit reachable).
- Graceful shutdown with a 10s drain. `trust proxy` set for one proxy hop.
- New env vars go in `.env.example` and `src/config/env.ts` in the same change. Tooling-only vars the app never reads (`SUPABASE_DB_URL`, `SUPABASE_DEV_PROJECT_REF`, `SUPABASE_DB_CA_CERT`) go in `.env.example` and are validated by the script that uses them.

## Conventions

- Named exports, strict types, no `any` without a comment. Conventional Commits. No new dependency without saying why.

## Slash commands

- `/new-feature <description>`: plan → approval → build with subagents → review → handoff. Always use it for new features instead of ad-hoc changes.
- `/pr [notes]`: branch check → verify ("Done means") → security/code review → Conventional Commit → push → `gh pr create` with the contract/frontend-handoff template. Always use it to open PRs.
- **Every slash command that changes code ends by invoking `/pr`** as its final phase. When adding a new command in `.claude/commands/`, give it a last phase that does this.

## Subagents

- `backend-engineer`: routes, services, auth, invites, contracts
- `database-architect`: migrations, table lockdown, Realtime policies, indexes, Postgres functions, pgTAP (MUST be used for `supabase/`)
- `voice-realtime-engineer`: Realtime topics, broadcasts, token minting, LiveKit tokens/webhooks/removal
- `test-engineer`: supertest and pgTAP
- `security-reviewer`: read-only audit (MUST be used for auth, rooms, invites, membership, realtime)
- `code-reviewer`: read-only review before anything is called done
