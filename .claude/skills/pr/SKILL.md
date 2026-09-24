---
name: pr
description: Verify, review, commit, push, and open a GitHub pull request for the current branch of hideout-api. Use when the user asks to open, create, or ship a PR, or says a change is ready for review.
argument-hint: [optional PR title or notes, e.g. "draft" or "feat: pin messages"]
---

# Pull request (hideout-api): $ARGUMENTS

Follow `CLAUDE.md`. Work through the steps in order. Stop and report if any check fails; never open a PR on a red build.

## Step 1: Branch

1. `git status` and `git branch --show-current`.
2. If on `main`, stop and ask for a branch name (`feat/…`, `fix/…`, `chore/…`, `refactor/…`, `docs/…`, `test/…`), then `git switch -c <name>`. Never commit to or push `main`.
3. `git fetch origin` and check `git log --oneline origin/main..HEAD` to see what the PR will contain. If the branch is behind `origin/main`, say so and ask before rebasing.

## Step 2: Scope the diff

Run `git diff origin/main...HEAD --stat` plus the uncommitted `git diff` / `git diff --staged`, and classify what changed:

- **Contract:** anything in `src/contracts/` or `contract/`. Every new or changed REST route must be registered with `registry.registerPath` so it appears in `/api/docs`; flag any route under `src/routes/` that isn't.
- **Database:** anything in `supabase/`
- **Sensitive:** auth, rooms, invites, membership, realtime, voice
- **Env:** new env vars (must be in both `.env.example` and `src/config/env.ts`)
- **Dependencies:** changes to `package.json` / lockfile (each new dependency needs a stated reason)

Flag anything that should not ship: `.env*` files, secrets, debug logs, stray `console.log`, edits to already-applied migrations, hand edits to `contract/*.json`.

## Step 3: Verify ("Done means")

1. `npm run typecheck && npm run lint && npm run test`
2. If **Contract** changed: `npm run contracts`, then confirm `git status` shows no further diff in `contract/` (otherwise the generated files are stale and must be committed).
3. If **Database** changed: `npm run db:status` (every local migration applied?), then `npm run db:push && npm run test:db` against the dev project.

Fix failures before continuing, then re-run the failed command.

## Step 4: Review

1. Run `security-reviewer` if the diff is **Sensitive** or touches **Database** policies.
2. Run `code-reviewer`.
3. Fix every **Critical/High** and **Must fix** finding and re-run Step 3. List anything deferred for the PR description.

## Step 5: Commit

1. Stage only the files that belong to this change (by path, not `git add -A`).
2. Write a Conventional Commit message (`type(scope): summary`, imperative, ≤72 chars), with a body explaining why when it isn't obvious.
3. Commit. Do not use `--no-verify`.

## Step 6: Push and open the PR

1. `git push -u origin <branch>` (never `--force`; use `--force-with-lease` only if I ask after a rebase).
2. `gh pr create --base main --title "<conventional title>" --body-file <file>` using the template below. Add `--draft` if `$ARGUMENTS` says draft or anything was deferred as Must fix.
3. Report the PR URL.

### PR description template

```markdown
## Summary
<1–3 sentences: what and why>

## Changes
- <bullet per meaningful change>

## Contract changes
<"None." or: each endpoint/event added, changed, or deprecated; confirm every change is additive (no breaking changes)>

### Frontend handoff (hideout-web)
<only if contract changed: new/changed fields, events, error codes, and what the web repo needs to regenerate or build>

## Database
<"None." or: migration file names, new tables/columns/policies, pgTAP coverage>

## Security
<membership/role checks, rate limits, validation, 404-not-403, secrets; security-reviewer verdict>

## Verification
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run test`
- [ ] `npm run contracts` (contract changed)
- [ ] `npm run db:push && npm run test:db` (migrations changed)

## Review
<code-reviewer and security-reviewer verdicts; anything deferred>

## Env / dependencies
<"None." or: new env vars and new dependencies with the reason for each>
```

Tick only the boxes for commands that actually ran and passed; delete lines that don't apply.
