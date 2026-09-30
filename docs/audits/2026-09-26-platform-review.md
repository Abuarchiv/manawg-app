# ManaWG platform review — 2026-09-26

Source checked: `origin/main` at `36c5b55e099aef36658c4a43342ae5ab36a152a9`. The older local `main` checkout has unrelated uncommitted work and was not edited.

## Verified

- Vercel Production for `app.manawg.com` is Ready on the same source SHA. `/api/health` returned HTTP 200 with database `ok`, no missing required configuration, and no degraded features. Public pages send CSP with a nonce, HSTS, frame denial, `nosniff`, and a restricted Permissions Policy.
- The isolated local build used Node 22 and pnpm 9. Lint, typecheck, 159 unit tests, Next.js build, bundle budget, analytics privacy check, and production dependency audit passed. Fixture E2E: 492 passed, 41 skipped, 0 failed. These are local checks; hosted authentication and database writes were not exercised.
- A real PayPal accounting race was reproduced on the original source: an expense could be deleted during external capture, then the payment was recorded as completed. The local fix guards debt-changing writes and deletion while the payment is `capturing`, keeps payer membership available for recovery, and rechecks membership under the capture lock. A regression test failed with `DELETE 200` before the fix and passed with `409` afterward. A second test observed `200 COMPLETED` after membership loss before the fix and `403` without a PayPal call afterward.
- The standalone security-boundary script had an outdated text assertion about read-only Origin handling. That assertion was removed; the runnable `csrf-origin.spec.ts` covers the intended write protection. The script now passes.

## Open gates and limits

- [Main CI run 36256779790](https://github.com/Abuarchiv/manawg-app/actions/runs/36256779790) never started its failed jobs. GitHub's check annotation says: “The job was not started because recent account payments have failed or your spending limit needs to be increased.” Fixture and Preview jobs were skipped. This is an account billing gate, not a demonstrated code failure.
- `main` has no required branch protection. Dependabot alerts, code scanning, and secret scanning are disabled. Enabling paid or access-changing settings needs a separate account decision.
- Production still runs `36c5b55`; the local PayPal fix is not deployed. No real PostgreSQL concurrency or live PayPal charge was executed. A real Supabase signup/reset and authenticated multi-WG flow remain unverified.
- Warm TTFB samples from this environment were 281–388 ms on public routes. Speed Insights had only older, sparse LCP samples (2.86 s for the start page, 3.67 s for a WG route) and none in the last 24 hours. They do not establish current optimal performance or a specific bottleneck.

## Vercel follow-up, later on 2026-09-26

- [Speed Insights](https://vercel.com/abditubes-projects/manawg-app/speed-insights) shows Desktop RES 68 across 57 events over seven days; Vercel's target is above 90. The WG start route scores 55 (17 events in the route table, 10 in its detail filter), expenses 65/3, announcements 75/4, public start 80/9, `/neu` 85/17, and shopping 90/3. The detail view gives no specific code recommendation. FCP, LCP, INP, CLS, FID, TTFB, geographic breakdowns, and useful Function detail are unavailable on the current plan.
- The active Production deployment is still `36c5b55e`, while `main` is `75f387ed`. There are no Speed Insights samples in the last 24 hours; the 19 older LCP samples belong to another deployment. The seven-day RES cannot establish the performance of the latest source. Function Error Rate and Timeout were both 0% in the available 12-hour overview.
- At `75f387ed`, eager Sentry client loading made the local shared first-load JavaScript 184.8 kB gzip against a 120 kB budget. Loading the optional SDK as a separate chunk only when its DSN is configured reduced this to 102.2 kB, including a build with a test DSN. The bundle gate is green. Four unit tests also failed because old test harnesses did not resolve new Sentry imports; the repaired suite passes 171/171. No Production RES improvement is claimed before a same-SHA deployment and fresh field samples.
- New Speed Insights samples stopped after Vercel Speed Insights was deliberately removed in `e7f1414a` to honor the then-current no-tracking privacy promise. Re-enabling field tracking would require a separate privacy decision and matching disclosure.
- The project Overview's two Recommendations are plan suggestions, not fixes for RES. On-Demand Concurrent Builds is disabled and requires paid Pro/Enterprise capacity; Production build prioritization is already on. Skew Protection is disabled and also requires Pro/Enterprise; it can prevent certain frontend/backend version mismatches during a rollout, but does not improve page load metrics. No setting or plan was changed.
