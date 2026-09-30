# ManaWG readiness audit — 2026-09-26

**Release decision: blocked pending hosted and operational evidence.** This is a dated verification record, not standing production approval. The application candidate was tested on `2ec77476d3d993afad26a1f5bef0a84f2e12b30d`, based on `main` at `6b12c154bb98810d5097923c9b797b05a6c6115e`. Subsequent changes only stabilize the shopping test's viewport arrangement and record this evidence.

The original checkout and its tracked and untracked work were preserved. No production deployment, production migration, provider configuration change, payment, or Auth email was performed during this audit.

## Current-main integration — 2026-09-26, 19:23 CEST

Merged `origin/main` at `36c5b55e099aef36658c4a43342ae5ab36a152a9` into this candidate as `446963182980440a78f0de73dd0185abb1c91ee1`. On Node 22.23.2 and pnpm 9, lint, typecheck, unit tests, production build, bundle budget, analytics privacy, security boundaries, focused browser regressions, and the full fixture browser suite passed. Playwright's final run status was `passed` with no failed tests. An independent code review found no actionable issue in the integrated diff. This is local and fixture evidence; the protected Preview and Production flows remain unverified for this candidate. GitHub Actions jobs for the current main SHA did not start because of the account billing or spending-limit block.

A separate focused WebKit fixture run on the same integrated branch also finished with Playwright status `passed` and no failed tests. It covered the expense, calendar, shopping, offline/PWA, chore, and security-header paths listed in the example command below.

## Corrections

- Expense creation, recurring-template creation, and direct recurring-expense creation retain the same idempotency key and request body after malformed successful HTTP responses. Only definitive 4xx responses other than 429 release the pending key.
- Timed calendar recurrences advance on Berlin calendar dates. Daily and weekly dates remain correct across daylight-saving changes; month-end clamping and finite-series filtering use the same calendar semantics. All-day UTC dates and the existing spring-gap fallback are preserved.
- Reopening a purchased item while an equal item is already open returns `409 shopping_item_duplicate`. The client restores both items, refreshes the list, and explains the conflict. Unrelated database errors remain errors.

All three corrections received independent review. Their regression cases failed before the fixes and passed afterwards.

## Local verification

Node 22.23.2 and pnpm 9 were used. A fresh offline install with `--frozen-lockfile` succeeded; the installed lock exactly matches the committed lockfile.

| Check | Result |
| --- | --- |
| Unit and handler checks | 163 passed, no skips |
| Complete Chromium fixture suite | 470 passed, 41 specialized cases skipped, no retries |
| Focused WebKit fixture suite | 55 passed, one PostgreSQL case skipped, no retries |
| Separate Auth UI and PostgreSQL lanes | Nine local Auth UI checks with simulated provider responses passed; 13 account-deletion DB checks and one shopping unique-index DB check passed |
| Static and build gates | Lint, typecheck, regular production build, security-boundary check, analytics privacy, feature boundaries, and all eight OpenSpec validations passed; production dependency audit reported zero advisories |

Shared first-load JavaScript is 102.2 kB gzip against a 120 kB budget. The DB lane applied all 16 journaled SQL files with `psql` solely as setup for a fresh disposable PostgreSQL container. Both containers were removed. This does not replace the guarded Supabase migration workflow.

The separate lanes cover 20 of the 41 cases skipped by the default fixture run. The remaining specialized/hosted cases were not claimed as passed. Tests adjusted after the complete Chromium run were also rerun in Chromium and WebKit.

WebKit's HTTP fixture mode now omits only `upgrade-insecure-requests`, and only when the strict fixture guard and loopback HTTP checks all pass. Production, remote Preview, HTTPS, nonce protection, and the rest of CSP retain their behavior. The default policy and the Production-denial guard are tested.

`playwright.webkit-fixtures.config.ts` disables service workers so API requests reach Playwright's mocks. It is an optional fixture configuration; the default CI project is unchanged. These checks do not establish real PWA installation, service-worker offline recovery, or push delivery. Geometry is measured consistently, native clicks remain native clicks, and asynchronous request completion is controlled explicitly.

Example repeat command from the repository root:

```sh
E2E_PORT=3232 pnpm --filter @manawg/web test:e2e:fixtures \
  --config=playwright.webkit-fixtures.config.ts --retries=0 \
  e2e/security-headers.spec.ts e2e/expense-idempotency-retry.spec.ts \
  e2e/expense-edit-payer.spec.ts e2e/manual-split-validation.spec.ts \
  e2e/pilot-shopping-conflict.spec.ts e2e/pilot-calendar-fixes.spec.ts \
  e2e/offline-page.spec.ts e2e/pwa-platform.spec.ts e2e/chore-next-assignee.spec.ts
```

## Hosted evidence and remaining gates

- The latest checked main [CI run 36228241200](https://github.com/Abuarchiv/manawg-app/actions/runs/36228241200) did not start its jobs. GitHub reports: “The job was not started because recent account payments have failed or your spending limit needs to be increased.” The protected exact-current-main Preview/Auth/privacy checks must run after this account issue is resolved; local checks do not replace them.
- During the audit, Production health returned HTTP 200 with database `ok`, no missing required variables, and no degraded features. The authorized test account could sign in and read the dashboard, finances, shopping, chores, inventory, Pinnwand, and calendar. Five of those views were checked at 320 px without horizontal overflow. The inspected READY Vercel deployment had no `gitSource` or commit metadata, so these observations do not identify Production with this candidate.
- Supabase's Production SMTP UI confirms custom SMTP enabled through `smtp.resend.com:465`. Actual Supabase confirmation/reset email receipt was not verified. PayPal's public client configuration was absent from both Vercel environments; an all-functions claim still needs configured and verified payment flows.
- Real-device push/install, current-candidate private-file and external-calendar workflows, hosted recovery, and alarm delivery remain separate acceptance work. Keep the existing [external prerequisites](external-prerequisites.md), [recovery procedure](../database-recovery.md), and [support runbook](../support-runbook.md) as explicit gates, without interpreting a health probe as end-to-end proof.
