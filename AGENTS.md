# ManaWG agent workflow


## Required workflow

1. For a new feature or architectural change, use OpenSpec: `spec -> plan -> tasks -> implement`.
2. Use Superpowers for brainstorming, implementation planning, TDD, code review, and verification.
3. Reuse existing patterns and dependencies. Keep changes narrowly scoped.
4. Before handoff, run the applicable lint, typecheck, test, build, and E2E gates and report exact results.

## Safety

- Preserve existing working-tree changes; never reset or discard user work.
- Treat secrets and environment files as local-only; never print or request their values.

## Direct delivery on main (user instruction, 2026-09-27)

- Deliver completed, verified changes directly to `main` and push to `origin/main`. Do not create pull requests or wait for PR approval. This supersedes older branch/PR handoff rules in plans and workflow guidance.
- Use isolated worktrees when needed to protect ongoing work; integrate each verified change into current `main` before pushing. Inspect existing diffs, preserve unfinished or unrelated changes, and never force-push shared history.
- Every delivered app change must reach Vercel Production immediately after the push. Use the existing Git deployment integration; if it does not trigger, deploy the exact pushed commit through the authorized Vercel workflow. Routine pushes and Production app deployments are authorized without another confirmation.
- Wait for the deployment to finish, verify its commit SHA matches the pushed commit, and smoke-test the affected flow on Production. Report the commit, deployment URL, and actual check results; a successful push alone is not completion. Resolve failures autonomously and report unavoidable external blockers accurately.
- Target completion of the agreed app scope by **1 October 2026 (Europe/Berlin)**. Prioritize small, tested deliveries and remaining release blockers; avoid speculative features and unnecessary refactoring. Keep required checks and independent review for substantial changes, without a PR requirement.

## Environment separation

- Preview and Production remain separate. Never use Production credentials or data in Preview. Never treat local, fixture, or Preview success as Production proof.
- Database migrations retain their separate safety gates: Production migrations run through `.github/workflows/migrate-production.yml` on `main`, using the exact `candidate_sha`, a matching successful `preview_run_id`, and `MIGRATE_PRODUCTION`. Direct app deployment authorization does not bypass Preview/Auth/RLS or migration checks.

## Test account (Production)

- Login on https://app.manawg.com with "E-Mail und Passwort": `testuser@manawg.com` / `Mana-8743778e9c0e-Test`.
- Supabase project `bwsvsvfgbrsonepffqff`, user id `21d891cd-1bda-428a-84ad-cf9e5392d64e`, e-mail already confirmed, created 2026-09-25.
- Test-only account without real data; this is the one deliberate exception to the local-only secrets rule. Do not use it in Preview.

## Project commands

- OpenSpec: `openspec list --json`, `openspec status`, `openspec validate`
- Package manager: `pnpm`
- Repository-specific OpenSpec instructions live under `openspec/`.

## WG header design

- Keep the WG header free of search controls. The user explicitly removed the search icon; restore a header search entry only on a new explicit user request. This supersedes older design plans that place search in the header.
- Show account/settings as an original shadcn ghost icon button with a 44px touch target and an accessible label. Keep the visible control icon-only, without the text "Konto & WG".

## Brandbook

For UI, typography, icons, motion, or product wording, read
[the design contract](docs/brand/design-language.md) and the relevant chapter of
[Brandbook v1.0](docs/brand/brandbook.html) before editing. This source supersedes
older visual-design documents. Verify the changed view in light/dark and at a
iphone 17 viewport; retain the header accessibility rules above.
