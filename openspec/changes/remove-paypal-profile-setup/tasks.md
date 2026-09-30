## 1. Remove profile setup
- [x] 1.1 Remove PayPal profile UI, state and requests while preserving other controls.
- [x] 1.2 Verify the profile in the browser and run focused regression, type, lint and build checks.
- [x] 1.3 Independently review the change and update the graph.

## 2. Complete the requested payment journey
- [x] 2.1 Confirm product journey and official provider contract; owner delegates account/payment choices to PayPal.
- [x] 2.2 Implement and test provider referral, signed attempt binding, readiness and safe URLs.
- [x] 2.3 Implement and test connection persistence, remove manual ID setter and gate new orders.
- [x] 2.4 Implement and browser-test account connection/return and confirmed payment without typed PayPal data.
- [x] 2.5 Complete final type/lint/build/payment checks, independent review, graph and deployment documentation.

## Verification evidence — 2026-09-27

- `pnpm --filter @manawg/web typecheck`: passed on Node 22.23.2.
- `pnpm exec biome check apps/web/src/components/wg/einstellungen/ProfileTab.tsx apps/web/e2e/paypal-profile-free.spec.ts`: passed.
- Focused fixture Playwright test: 1 passed (32.4 s), 320px viewport, light/dark interaction and no PayPal member GET. The first invocation lacked fixture environment flags and was corrected before this successful run.
- `pnpm --filter @manawg/web build` with explicit fixture flags and `.next-paypal-profile-build`: passed. Generated edits in `next-env.d.ts` and `tsconfig.json` were inspected and restored.
- Independent Astra review: no actionable findings in profile removal and test.
- `graphify update .`: passed, 4,803 nodes / 13,096 edges. SQL AST extraction unavailable because optional `tree_sitter_sql` is missing; no SQL changed.
- `openspec validate remove-paypal-profile-setup --strict` and `git diff --check`: passed.

## Final implementation verification — 2026-09-27

- Node 22.23.2 full unit suite: 138 passed, zero failed/skipped.
- Full typecheck and lint: passed; Biome checked 538 files and feature boundaries passed.
- Final optimized Next build in explicit fixture mode: passed, including connect and generic return routes.
- Browser fixture suite: 7 cases passed; additional untrusted action-host case passed separately (8 distinct cases total). Includes account connection, cancellation, transient retries, readiness/unavailable display, debtor/recipient guidance, and simulated SDK cancelled/failed/completed capture. It performs no real payment.
- Light/dark 320px screenshots inspected: no manual PayPal field, readable consent explanation and connect button, no clipping.
- Independent UI review finding fixed and re-reviewed without further findings. Backend legacy-ID and provider-404 findings fixed; stable customer tracking and per-attempt nonce accepted. Final environment hash isolation assertion passes.
- graphify AST update passed: 4,874 nodes / 13,279 edges / 304 communities. Optional SQL grammar remains unavailable; no SQL changed.
- Generated next-env.d.ts change inspected and restored; tsconfig.json unchanged.
- Production and Preview environment NAME listings confirmed no PayPal configuration. Real PayPal login/payment and deployment remain unverified; see docs/paypal-setup.md for exact provider prerequisites.

This implementation is local and isolated. No real payment, provider permission grant, production data change or deployment was performed.


## Current-main integration verification — 2026-09-27

- Rebased only the PayPal feature onto origin/main 75f387ed; preserved main's capturing-payment deactivation guard, expense-payment locks, profile Help/LinkRow and complete test inventory.
- Installed the committed dependency lockfile in this worktree; primary checkout and its dependencies were not changed.
- The default fixture lane now supplies public dummy PayPal client/BN values, so the capture regression runs without provider credentials.
- Updated both pre-existing PayPal settings tests to retain load-error/accessibility/keyboard retry and 320/360px light/dark coverage for the new connection UI.
- Fixed two existing-main observability test loaders after the Sentry import change; real wrapper/privacy behavior and assertions remain tested.
- Reused the existing optional Sentry client split (616602b9) to repair the required bundle gate on current main. Added runtime entrypoint checks for disabled, enabled/deferred and failed optional load.
- Final Node 22.23.2 unit suite: 186 passed, zero failed/skipped.
- Standard fixture lane, all four PayPal specs: 13 passed, zero skipped, including optimized build. Real phone/provider testing is deferred by the user.
- Full root lint (612 files), typecheck, feature boundaries and analytics privacy check: passed.
- Builds with Sentry unconfigured and a synthetic configured DSN passed. Shared initial gzip JS: 101.4 kB / 102.2 kB, both below 120 kB; both bundle checks passed.
- Independent integration/test reviews found no remaining issues; generated next-env.d.ts restored. Graph AST update: 5,088 nodes / 13,860 edges.
- Hosted CI, deployment and real provider payment are separate from these local results. No production changes or actual funds movement performed.


## Hosted build configuration correction — 2026-09-27

The first Preview build exposed a pre-existing Sentry 11 runtime export mismatch: `withSentryConfig` is undefined from the package root. Changed the config import to the supported `@sentry/nextjs/config` entrypoint and added a real config-evaluation smoke test with the Vercel branch enabled. The prior import reproduced the failure; corrected import passes. Full Node 22 unit suite now passes 187 tests; lint, typecheck and diff check pass. No PayPal product logic changed. Hosted results are tracked on PR #488; real phone/payment testing remains deferred.
