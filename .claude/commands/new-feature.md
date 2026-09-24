---
description: Plan and build a new backend feature end to end (contract, schema, API, tests, reviews)
argument-hint: <feature description, e.g. "let admins pin messages in a channel">
---

# New feature (hideout-api): $ARGUMENTS

If no feature description was given above, ask me for one and stop.

Follow `CLAUDE.md`. Work through the phases in order. Do not skip the approval checkpoint.

## Phase 1: Understand

1. Restate the feature in one or two sentences, including who can do it (owner / admin / member) and what non-members see.
2. Read the relevant existing code: `src/contracts/`, matching routes and services, and the migrations for any tables involved.
3. List open questions. If any would change the design (permissions, limits, what happens on delete), ask them now and wait for answers.

## Phase 2: Plan (approval checkpoint)

Write a plan with these sections, then **stop and wait for my approval** before changing any files:

- **Contract:** each endpoint (method, path, auth, minimum role, request, response, error codes). Mark each as new or changed, and confirm every change is additive (no breaking changes for hideout-web).
- **Database:** new tables/columns (locked down: RLS on, no browser policies), indexes, and Postgres functions for multi-step writes.
- **Realtime:** events to broadcast (topic, event name, payload, which write triggers it), and any `realtime.messages` policy changes. LiveKit changes, if any.
- **Security:** how membership, roles, rate limits, and validation apply; anything that could leak room existence.
- **Tests:** the behaviors that will be tested (access control first).
- **Files:** expected files to create or change.
- **Branch:** `feat/<short-kebab-name>`.

## Phase 3: Build (after approval)

1. Create the branch: `git switch -c feat/<short-kebab-name>`.
2. **Schema** (if needed): delegate to `database-architect` with the Database section of the plan. Wait for its report and passing `npx supabase db reset && npx supabase test db`.
3. **Contract:** add or update Zod schemas in `src/contracts/http/` and `src/contracts/events.ts`, register every endpoint with `registry.registerPath` (public ones with `security: []`), then `npm run contracts`. The endpoints must show up correctly in Swagger UI at `/api/docs`.
4. **API:** delegate to `backend-engineer` (and `voice-realtime-engineer` for broadcasts and LiveKit) with the Contract, Realtime, and Security sections.
5. **Tests:** delegate to `test-engineer` with the Tests section.
6. Run `npm run typecheck && npm run lint && npm run test`. Fix failures before continuing.

## Phase 4: Review

1. Run `security-reviewer` (required for anything touching rooms, invites, membership, auth, or voice).
2. Run `code-reviewer`.
3. Fix every **Critical/High** and **Must fix** finding, then re-run the checks from Phase 3 step 6.

## Phase 5: Hand off

Finish with a summary containing:

- What was built and the final endpoint list
- Migration file names
- Verification results (commands and outcomes)
- Review verdicts and anything deferred
- **Frontend handoff for hideout-web:** the `contract/openapi.json` and `contract/events.schema.json` changes, new error codes, and a suggested `/new-feature` prompt for the web repo

## Phase 6: Pull request

Invoke the `pr` skill (`/pr`) to commit, push, and open the PR, passing the feature description as notes. Steps 3–4 of `/pr` (verify and review) may reuse the Phase 3–4 results if no files changed since they last passed; otherwise re-run them. Use the Phase 5 summary and frontend handoff to fill the PR description.
