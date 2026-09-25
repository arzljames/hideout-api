# hideout-web handoff

What hideout-web needs to build against hideout-api right now. Updated by every hideout-api feature (see `/new-feature` Phase 5); the newest changes are at the bottom under [Changelog](#changelog).

- **Contract (source of truth for types):** `GET /api/contract/openapi.json` (REST) and `GET /api/contract/events.schema.json` (Realtime). Regenerate hideout-web's types whenever the Changelog says the contract changed.
- **Browse endpoints:** Swagger UI at `http://localhost:3001/api/docs` (or `http://localhost:5173/api/docs` through the Vite proxy).
- **Shared copy of this doc:** https://claude.ai/code/artifact/fdbf4d28-6d8f-47b9-b973-4d0b93621bca (mirrored when possible; this file wins if they differ).

## Status

| Area | State |
|---|---|
| Steam sign-in, sign-out, sessions | Shipped (PR #2) |
| Current user (`GET /api/auth/me`) | PR #4 |
| Database schema for rooms, channels, messages, invites, Realtime policies | Shipped (PR #3); no REST endpoints yet |
| Rooms, channels, messages, invites, voice, Realtime token | Not built yet |

## Endpoints

| Method + path | Auth | How to call it | Success | Failure |
|---|---|---|---|---|
| `GET /api/auth/steam` | public | Full page navigation (`window.location.href = '/api/auth/steam'`), never `fetch` | 302 to Steam's sign-in page | 302 to `WEB_ORIGIN/?auth_error=RATE_LIMITED` (10 tries/min per IP) |
| `GET /api/auth/steam/callback` | public | Never called by hideout-web; Steam sends the browser here | 302 to `WEB_ORIGIN/`, session cookie set (7 days) | 302 to `WEB_ORIGIN/?auth_error=<code>` |
| `GET /api/auth/me` | session | `fetch` with `credentials: 'include'`, on app load | 200 `Me`: `{ id, steamId, displayName, avatarUrl \| null }`, sent `no-store` | 401 `UNAUTHENTICATED` = signed out |
| `POST /api/auth/logout` | session | `fetch`, `credentials: 'include'`, `Content-Type: application/json`, no body | 204, this device signed out, cookie cleared | 401; 403 (Origin/Content-Type) |
| `POST /api/auth/logout-all` | session | Same as logout | 204, every device signed out | 401; 403 |

## Sign-in flow

1. On load, call `GET /api/auth/me`. 200 → signed in (use the body for the name and avatar). 401 → show **Sign in with Steam**.
2. The button navigates to `/api/auth/steam`. The API sets a 10-minute login state cookie and redirects to Steam.
3. After Steam, the browser lands on `WEB_ORIGIN/` signed in, or on `WEB_ORIGIN/?auth_error=<code>`.
4. After landing, call `/api/auth/me` again (never cache it).

Cookies are httpOnly (JavaScript can't read them): `hideout_session` / `hideout_login_state` in local dev, `__Host-hideout_session` / `__Host-hideout_login_state` over HTTPS. Signing in again on the same browser ends that browser's previous session.

## Error codes

Sign-in failures arrive as `WEB_ORIGIN/?auth_error=<code>` (the `AuthRedirectError` enum). Show a message, then remove the param (`history.replaceState`).

| `auth_error` | Meaning | Suggested message |
|---|---|---|
| `STEAM_LOGIN_FAILED` | Steam rejected the sign-in, or it couldn't be verified | "Steam sign-in didn't go through. Please try again." |
| `LOGIN_STATE_MISMATCH` | Not started from this browser, or took over 10 minutes | "That sign-in link expired. Please sign in again." |
| `STEAM_UNAVAILABLE` | Steam couldn't be reached | "Steam isn't responding right now. Try again in a moment." |
| `LOGIN_FAILED` | Our server couldn't create the session | "Something went wrong on our side. Please try again." |
| `RATE_LIMITED` | Too many attempts from this network | "Too many sign-in attempts. Wait a minute and try again." |

JSON endpoints return `{ "error": { "code", "message", "details"? } }`:

| Status | `error.code` | hideout-web should |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Treat as signed out |
| 403 | `ORIGIN_NOT_ALLOWED` / `UNSUPPORTED_CONTENT_TYPE` | Fix the request (see rules below) |
| 404 | `NOT_FOUND` | Not found, or not a member of the room (the API never reveals which) |
| 422 | `VALIDATION_FAILED` | Show `details[].path` / `message` |
| 429 | `RATE_LIMITED` | Back off and retry |
| 500 | `INTERNAL` | Generic error |

Treat unknown codes as generic; new ones can be added.

## Request rules

- Always send credentials: `fetch(url, { credentials: 'include' })`.
- State-changing requests (POST/PATCH/PUT/DELETE) need `Content-Type: application/json`, even with no body.
- Use relative URLs (`/api/...`) through the Vite proxy in dev, so the cookie and `Origin` match `WEB_ORIGIN` (`http://localhost:5173`).
- Production: app and API must be same-site (e.g. `app.hideout.gg` + `api.hideout.gg`), or the session cookie is blocked.

```ts
// vite.config.ts
export default defineConfig({
  server: { proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: false } } },
});
```

## Realtime (for later features)

Browsers connect to Supabase Realtime with a short-lived token from Node (`GET /api/auth/realtime-token`, not built yet). All topics are private.

| Topic | Receive | Browser may send |
|---|---|---|
| `room:<roomId>` | Room events (`channel:*`, `member:*`, `voice:participants`, `room:updated`, `room:deleted`) + Presence | Presence only |
| `channel:<channelId>` | `message:created` / `updated` / `deleted` | Nothing |
| `typing:<channelId>` | `typing` | `typing` with `{ userId }` |
| `user:<profileId>` (own) | `invite:received`, `member:removed`, `session:expired` | Nothing |

Shapes to know (from `events.schema.json`):

- `Room.icon` is `RoomIcon`: `{ kind: 'emoji', emoji }` or `{ kind: 'image', url }` (short-lived signed URL). There's no `Room.ownerId`: the owner is the `Member` with `role: 'owner'`.
- `Message.author` can be `null` (deleted user).
- `Member.currentGame` is the Steam "Playing …" text, or `null`.
- Typing and Presence payloads come from other browsers and aren't checked by the server: ignore `userId`s not in the member list, take names/avatars from the member list, and never use them for anything security-related.
- The invite preview's "N online" count isn't available yet; show the member count only.

## Build checklist

- [ ] Vite proxy forwards `/api` to `http://localhost:3001`
- [ ] Types generated from `openapi.json` (and `events.schema.json` when Realtime work starts)
- [ ] Shared fetch wrapper: `credentials: 'include'`, `Content-Type: application/json` on writes, 401 → signed-out state
- [ ] On load: `GET /api/auth/me` decides signed-in vs signed-out; show `displayName` and `avatarUrl` (fallback avatar when null)
- [ ] **Sign in with Steam** navigates to `/api/auth/steam` (full page load)
- [ ] Read `?auth_error=`, show the matching message, strip the param
- [ ] **Sign out** → `POST /api/auth/logout`; **Sign out everywhere** → `POST /api/auth/logout-all`; then back to signed-out
- [ ] Tested through the Vite proxy with a real Steam account

Paste into hideout-web:

```text
/new-feature Steam sign-in UI. On app load call GET /api/auth/me with credentials: 200 = signed in (show displayName + avatarUrl, fallback when null), 401 = show a "Sign in with Steam" button that does a full-page navigation to /api/auth/steam. On return, read ?auth_error= (AuthRedirectError from openapi.json: STEAM_LOGIN_FAILED, LOGIN_STATE_MISMATCH, STEAM_UNAVAILABLE, LOGIN_FAILED, RATE_LIMITED), show a friendly message, strip the param, and re-fetch /api/auth/me. Shared fetch wrapper: credentials: 'include', Content-Type: application/json on writes, 401 = signed out. "Sign out" -> POST /api/auth/logout, "Sign out everywhere" -> POST /api/auth/logout-all (204). Vite proxies /api to http://localhost:3001. Generate types from /api/contract/openapi.json.
```

## Not built yet

| Missing | Effect on hideout-web now |
|---|---|
| `GET /api/auth/realtime-token` | Can't join Realtime channels |
| Rooms, channels, messages, invites, voice endpoints | No app screens beyond sign-in |
| `currentGame` on `/api/auth/me` | Not needed for your own profile; may be added later (nullable) |
| Sign-in return to a specific page | Always lands on `WEB_ORIGIN/` (avoids open redirects) |

## Changelog

| Date | PR | Change | hideout-web must |
|---|---|---|---|
| 2026-09-25 | #2 | Steam sign-in, sign-out, `AuthRedirectError` codes | Build the sign-in button, error banner, sign-out |
| 2026-09-25 | #3 | Core schema; Realtime topics incl. new `typing:<channelId>`; `RoomIcon`, nullable `Message.author`, no `Room.ownerId`, `Member.currentGame` (breaking vs the scaffold, nothing consumed it) | Regenerate `events.schema.json` types before Realtime work |
| 2026-09-25 | #4 | `GET /api/auth/me` + `Me` schema (additive) | Call it on load to decide signed-in vs signed-out; regenerate `openapi.json` types |
