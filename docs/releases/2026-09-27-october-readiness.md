# October release readiness — 2026-09-27

Status: **local app gates and independent reviews pass on the integrated source; external release gates remain open; no Production release approval**.
Initial baseline: `75f387ed55a6ddd0a61db6c3cf203f54e0b77a0c`; upstream `63833dd5160f8857720a1e7dbbce05bcb92a6649` was subsequently integrated.
Latest remote main readback: `63833dd5160f8857720a1e7dbbce05bcb92a6649`, unchanged at final verification; merge `b947034` retains the audited payment/privacy behavior alongside the new PayPal account-linking flow.
Work branch: `audit/release-october-20260927`. The original dirty checkout is preserved.
GitHub Actions are unavailable until month end. This is the only accepted deferred verification; other unknowns remain open gates.

## Product and Definition of Done

ManaWG is a phone-first shared-household application. Residents use one authenticated identity to join or create households and coordinate their daily work, money and communication. Former members' financial history must survive deactivation without preserving access.

| Acceptance area | Required result | Evidence required |
| --- | --- | --- |
| Identity and household lifecycle | Sign-in, signup, recovery, invitations, joining, switching households/accounts, admin changes, move-out and account deletion have truthful outcomes. Guests, other households and removed members cannot access private data. | Route/security regressions and authenticated multi-user Preview journeys, including denied access and recovery. |
| Household work | Shopping, stock consumption and chore assignment/absence/recurrence remain correct across concurrent residents, failed responses, offline queues and reconnects. Dashboard summaries reflect saved state. | Executable race/retry regressions plus browser create/edit/complete/reopen flows. |
| Household money | Expenses, historical participants, currencies, rounding, splits, recurring costs, import/export and settlements preserve balances. PayPal uncertainty never permits duplicate settlement or unlocked debt changes. | Money invariants, provider-state failure probes and isolated end-to-end payment evidence. |
| Communication and usable interface | Chat, board, calendar/feeds/reminders and private attachments work through success, empty, error and recovery states. Navigation, forms and dialogs remain usable by touch, keyboard and assistive technology, in light/dark and narrow views. | Browser flows, accessibility checks, timezone/recurrence and delivery checks; emulator and real-device evidence labelled separately. |
| Operation and repeatable delivery | Node 22/pnpm 9 frozen install, lint, types, unit/route/browser checks, build and budgets pass for the candidate. Preview/Production isolation and exact-revision migration gates hold. Recovery, external delivery, monitoring and support have demonstrated outcomes. | Command logs tied to a commit/tree, live platform readbacks, restore and delivery evidence. After Actions reset, protected exact-SHA CI/Preview gates must pass before Production release. |

An unavailable or skipped test is not a pass. A health response is not proof of a user journey, delivery or recoverability. No finite audit establishes absence of every possible defect; the release decision follows the concrete acceptance evidence and unresolved risks.

## Work sequence

- [x] Read mission, project instructions, scoped memories and graph; reconcile checkout against remote.
- [x] Establish current candidate without touching original WIP. Review confirms product WIP is already integrated upstream; do not transplant stale files.
- [x] Complete complementary audits: product/architecture, auth/security, finance, household, communication, offline/storage, database/recovery, CI/supply chain, UX/accessibility, performance/privacy, live platforms.
- [x] Cross-review and reproduce findings, prioritize by data/security/financial impact, implement narrow changes with regression evidence and independent review.
- [x] Run all applicable local candidate gates and browser flows; audit skipped lanes individually. Hosted/provider gates remain explicitly open below.
- [x] Obtain a fresh whole-app review without implementation history; resolve new substantive findings.
- [x] Integrate the four newer upstream commits, preserving audited privacy/payment safeguards.
- [x] Close the fresh capture/layout findings and refresh app evidence; companion contract refresh is complete; external requirements are recorded below.

## Findings and verification ledger

All findings below were traced against the current candidate. Runtime probes used actual application modules with local/provider doubles unless explicitly labelled otherwise. None are claims of exploitation in Production.

| Priority / area | Verified defect | Disposition / proof |
| --- | --- | --- |
| P1 migration transport | pg query parameters override validated host, port or TLS mode | Fixed `bb88477`; independent reproduction; 18 checker tests. |
| P1 migration grants | Historical SELECT grants conflict with catalog checks; foreign-owned already-clean tables need safe treatment | Forward 0016 revokes current-role grants/defaults only. Fresh/upgrade non-superuser PostgreSQL 17 rehearsal passes; provider-owned defaults unchanged. |
| P1 PayPal state/concurrency | Pending or ambiguous capture can be replaced; concurrent capture can validate stale debt | Same-order GET-first reconciliation, stable provider idempotency key, strict payee/currency/cents checks, WG-locked new capture validation and serialization. Independent actual-route race probes pass. Configured browser proof passes below. |
| P1 financial residuals | Individual settlement can exceed remaining balances; reductions/deletions can hide refund direction | Fixed `d6c33e5d`, `2a27706`; residual-budget checks and signed balances; independent actual-code probes plus 2,000 seeded cases. |
| P1 chores | Replay persistence outside transaction and stale offline occurrence advance a second recurrence | Fixed `e0023c9`: atomic replay and original due/assignee expectations. Focused route/queue proof passes. |
| P1 offline | Account-switch replay, stale merges, blob loss, uncertain responses permit incorrect replay | Fixed `9f942b3`, `c0fc203`: account binding, durable upload URL, operation-preserving merge and explicit manual review; unreadable 2xx becomes unknown result. 17 integrity tests plus independent browser/probe checks. |
| P1 private attachments | Deleted references retain readable private object URLs | Additive 0017 permanent tombstones; last-reference deletion immediately denies reads; rejected reattachment; bounded delayed/retried provider cleanup. 56 focused tests and real PG17 lock-order/race/cascade proof pass. Hosted byte deletion remains unverified. |
| P1 observability privacy | Pinned SDK infers IP and sessions after sanitizer; policy omits tracker | Fixed `fc16e05`: explicit SDK privacy controls, private-key/calendar bearer redaction, conditional dynamic loading. Real SDK/local transport proof. Separate landing correction committed; publication prerequisites remain. |
| P2 shopping / inventory | Lost response overwrites reopened item; stale GET overwrites saved stock | Fixed `e0023c9`, `195d1927`: version+replay contract and mutation-aware cache. Four inventory browser cases pass. MCP companion updated first for compatible rollout. |
| P2 finance / export | Import ignores currency; legacy monthly recurrence drifts; export omits payments and stable payer IDs | Fixed `db3f54f4`, `7da42db`; 11 import/recurrence and 6 export checks. Export scope disclosed accurately. |
| P2 notification / calendar / PWA | Logout retains push; calendar day/time errors; partial reminder delivery lost; cold offline shell missing assets; click loses query/hash | Fixed `c776ab21`, `78f13af`, `c466cc3d`, `e250f6b`; focused auth/time/reminder/worker tests and cold offline browser proof. Real device push remains unverified. |
| P2 access UX | Controls offer forbidden admin/member actions; deactivation falsely promises access | Role-aware controls and accurate explanation, including stale-role 403 recovery. All three access-control tests pass in the root stable-build suite. |
| P2 database availability | Pools allow unbounded acquisition/query waits and reuse timed-out clients | Fixed `8146d28`; 2s acquisition/locks, 5s statements, 5.5s reads. Real disposable PG lost-response rollback/eviction/recovery proof passes. |
| P2 MCP contract | Chore/shopping clients omit new stale-write expectations; advertised chore detail API returns 405 | MCP `2ad279c`: explicit expected versions and list-before-write guidance. App `ff874bc`: protected tenant-scoped GET; four route cases. 154 MCP tests, lint/types/build and built-dist contract pass. |
| P1 configured PayPal browser | CSP blocks SDK style/frame/connect; COOP severs popup opener | Independently reproduced with official public SDK and isolated popup. Fixed `763fee5`; independent actual production-build browser probe passes: original nonce survives real SPA navigation, official public SDK yields zero CSP violations with intercepted followups, popup opener remains connected. |

Initial local baseline: frozen install Node 22.23.2 / pnpm 9; lint and typecheck pass; unit 167 pass / 4 fail (all four custom test loaders fail resolving the newly introduced Sentry module); production build passes; shared bundle 184.7 kB exceeds 120 kB. These initial results precede repairs and are not final-candidate evidence.

Live GitHub readback: exact-baseline push run `36271021157` has zero executed steps in failed validate/preview-source jobs, with the known billing/spending-limit annotation. Environment branch policies exist; required reviewer/required-check enforcement was not established. Actions are not being retried during the known blocked interval.

## Boundaries

No destructive data, Production migration/deployment, paid provider setting, credential rotation or Git history rewrite is authorized by this audit. Test-only local and isolated Preview checks must preserve resident data. Existing release gates must not be bypassed to compensate for unavailable GitHub Actions.

## Fresh environment readback

- App Production: READY deployment `dpl_5ZSVAXfpSvv7PkChwqXWpWDjqS3F`, SHA `36c5b55e099aef36658c4a43342ae5ab36a152a9`. It is not the audit baseline or repaired candidate. A connected authenticated browser loaded dashboard and shopping; no resident data was changed.
- Latest Preview: READY `dpl_C98jhu1qbAzVWhpF98e9NayLTgsk`, SHA `80c26c670e32245c28ce8d08cbcb781a7ba7fe01`; no Preview found for baseline `75f387ed`.
- Landing privacy source: `Abuarchiv/manawg-landing`, main `7e00fdf832d4856a19570d9f366e13fe76d718fb`, deployed as `dpl_6XeMXv17xjp3FHJWnmsrb4P8XBum`. A separate isolated disclosure patch is committed as `b196367`; no publication yet.
- Both Supabase projects ACTIVE_HEALTHY. Root independently compared every live Drizzle `(hash, timestamp, position)` to the journal: 16 applied rows, zero unexplained mismatches, historical 0007 exactly matches its explicit allowlist. Migration 0016 is pending; no ledger edits or live migrations were performed.
- Current public tables have RLS and no effective CRUD grants for anon/authenticated. Provider-owned `supabase_admin` defaults still grant future-table privileges; ordinary migration-role defaults are separate. The current SQL identity cannot alter the provider owner; no privilege escalation attempted.
- PayPal environment keys absent in both app environments. Sentry key names present; presence is not event-delivery evidence. Leaked-password protection remains an advisor warning. Backup/PITR retention and real alert/device/mail receipt are not established by health or empty logs.
- Production dependency audit: 316 production dependencies, zero reported advisories (September 27).


## Independent fresh whole-app review

A reviewer without implementation history reviewed all 56 API route files and the major app domains. Four additional issues were reproduced: PayPal capture/debt races, reversed refund residuals, unreadable successful HTTP responses losing retry identity, and notification query/hash navigation. All four corrections were independently cleared with 23 focused tests and actual route/client/worker probes. This is source/local runtime evidence; configured-provider and final integrated gates are tracked separately.

The integrated browser round found three further product defects, all corrected and independently reviewed:

- `ee6a705`: an ambiguously accepted recurring template could be queued twice while its expense form stayed open. The existing durable queue now identifies the pending intent after repeated clicks and draft restoration, including equal-split cent rotation. Storage failure retains the original request identity; a changed intent remains distinct.
- `51acd0b`: streamed parent metadata overwrote feature titles. Twelve native server layouts now own their static feature titles; the competing client hook is removed. All twelve titles, Chat and SPA return to the WG dashboard pass in the rebuilt PWA suite.
- `55049e0`: the generic HTTP 409 path masked `image_removed`. The form now asks for re-upload without setting stale-expense conflict state; ordinary conflicts keep their existing behavior. Independent branch probes and actual Chromium/WebKit recovery tests pass.

A new attachment browser test was initially skipped because its runner lacked the fixture flag. Actual execution exposed a CSP-incompatible mock upload origin and then the real 409-message bug. The mock now uses a controlled same-origin endpoint under the unchanged CSP; explicit fixture-enabled runs pass in both engines with zero skips and zero CSP violations. Earlier 25-pass/1-skip evidence is only contract-test evidence, not proof that this browser case ran.

## Database recovery evidence

The September 27 snapshot (01:15:28Z / 03:15:28 Europe/Berlin) was restored into a disposable, blank Supabase PostgreSQL 17.6.1.165 database using the original four payloads, unchanged and rehashed. All 61 COPY sections and 450 rows match exact multisets; both sequences and financial aggregates match. All 27 public tables have RLS, all 84 FKs validate without orphans, and tenant/financial checks show zero mismatches. The 16-row migration ledger is a canonical prefix of the candidate's 18 migrations (0007 matches the exact accepted legacy hash). Runtime-role insert/read/delete with rollback and fresh-session absence passed. The container was removed; private evidence is retained under the existing 0700 recovery directory.

FileVault status was independently checked on September 27 and is **On**. This confirms the local disk-protection setting, not offsite replication.

This proves local database recovery only. The export is non-atomic and contains zero Storage objects. Offsite recovery, hosted Auth restoration, Storage recovery, RPO and RTO are not proven. See the [database recovery runbook](../database-recovery.md) for the tested bootstrap and limitations.

## Provider and operational boundaries

- Both Supabase projects are ACTIVE_HEALTHY in eu-central-1 on Free plans. Read-only checks find matching 238 public columns, 27 RLS-enabled tables and no effective anon/auth CRUD; zero unexplained ledger mismatches. Migrations 0016/0017 are pending; no hosted migration was run.
- Public Auth settings return 200. Production enables email and Google, disables phone, permits signup and requires email confirmation. Preview enables email, disables Google/phone and auto-confirms email. The Preview Google button remains visible but returns unavailable; these settings do not prove a completed login or email delivery.
- Sentry UI confirms EU storage for organization `manawg`, project `javascript-nextjs` (4512021577334865). Outgoing TLS verification was enabled and verified after reload. September 28 readback: DPA acceptance is still not proven; Legal & Compliance offers Review and Accept, and the complete visible 19-row audit history since organization creation contains no acceptance action. Additional aggregated identifying-data use is already off. No legal agreement was accepted. Plan wording “30-day lookback” is not a deletion guarantee. Vercel sensitive DSNs cannot be read through authorized APIs. A read-only scan of the current Production page and its 25 same-origin scripts found no Sentry client reference or DSN, consistent with that older deployment; the inspected existing issue is a development/tooling event without an App URL, so actual Production DSN/project association and deployed-app delivery remain unverified. See the [Sentry prerequisites note](2026-09-27-sentry-privacy-prerequisites.md).
- Upstash resource `upstash-kv-carmine-clock` is attached across environments; endpoint comparisons and a single normal health-request correlation strongly support Production association, while the Sensitive UPSTASH env record itself remains unreadable. Complete metadata inventory: 539 event-index keys, all no-expiry, 1,067 total entries. No payload reads or deletions. See [Upstash prerequisites](2026-09-27-rate-limit-privacy-prerequisites.md).
- PayPal configuration names are absent from both hosted environments; no real payment was attempted. Updated September 28: the authorized developer session now opens the Sandbox app list and Default Application. Platform-app creation is available, but would generate new API credentials and a Sandbox business account and accept the displayed US Developer Agreement. A United States draft is prepared but unsubmitted; Germany is absent from that form’s region list. Explicit approval for this new access/contract is required, and sandbox success would not prove Germany/Live eligibility. See the current [operator setup](../paypal-setup.md). Sandbox account/partner access and an actual sandbox payment remain required before enabling this release feature. Existing manual settlement stays available.
- Standard Vercel protection redirects both current and older immutable deployment health URLs to SSO. This does not remove authorized/bypass access to older code. Attachment rollout and rollback must retain tombstone-aware readers/writers or make incompatible deployments inaccessible.

## Companion candidates

- MCP: `fix/release-client-contracts-20260927`, commit `2ad279c53c85cf8ca90802ee9a36604492eaafef`; Node 22, pnpm 9.15.9; 154 tests, lint, types, build, smoke and built-distribution contract pass. Deploy/update client before the stricter App API. The MCP update also removes manual PayPal merchant-ID writes, requires an active flag for member changes, and documents payer approval in the browser plus same-order pending reconciliation. Existing running MCP process was neither changed nor restarted.
- Landing: `docs/release-privacy-20260927`, commit `b1963676f728b2f2ae5c857972d73c9cb0dac915`; Node 24.19; Biome and build/types pass. Only privacy page changed. No publication; resolve Sentry association/DPA and historical Upstash analytics prerequisites first.
- No branch has been pushed, no PR merged, no site deployed and no Production migration or direct resident-data mutation occurred during this mission. Ordinary read requests can still produce provider logs and rate-limit telemetry.

## October 1 release sequence and stop conditions

1. Resolve provider prerequisites: authorized PayPal Sandbox test if enabling payments; Sentry project/DSN association, DPA status and safe delivery proof; publish the accurate privacy disclosure before activating the tracker. Keep unverified optional providers disabled.
2. Integrate reviewed commits through the normal GitHub workflow. Update MCP first. Once billing allows Actions, require green main CI and Preview evidence for the exact candidate SHA/tree; local passes do not replace hosted gates. GitHub protection APIs returned 403, so required-review/check enforcement was not established.
3. Rehearse 0016/0017 and the full create/read/revoke/provider-remove lifecycle on disposable Preview data. Apply schema before compatible app readers/writers. Drain or fence incompatible old deployments and stale clients; never roll back to code that ignores tombstones.
4. Run the exact-SHA authenticated Preview smoke, provider email/reset/OAuth and device push checks as applicable. Prepare a fresh verified backup and compatible rollback. Trigger Production only through the existing gated workflow after these checks and explicit deployment authorization.
5. Verify Production health, login, WG access, finance and attachment revocation after deployment, then verify alert delivery. Stop on any mismatch; use the documented compatible rollback. No claim of Production readiness is made before that evidence exists.

## Local verification evidence

Latest production source: `89bb06b04e3653fdc385974dc2d171c084b94a58` (capture correction `9801b42`, integrated upstream `b947034`, OCR `275e7a8`, rate-limit privacy/timeout `a242a81`, offline expiry `2a965a3`). Later changes are tests and documentation only. App runtime: Node 22.23.2 / pnpm 9.0.0. No dependency or lockfile changes were needed.

| Gate | Result / scope |
| --- | --- |
| Production builds | Unconfigured, synthetic Sentry/PayPal-configured, and isolated fixture builds pass on the latest production source. |
| Bundle budgets | Shared first-load 102.2 kB gzip in both variants; unchanged cap 120 kB. Baseline 184.7/184.8 kB. All per-route budgets pass. |
| Static gates | Biome 651 files; seven feature boundaries; analytics privacy and security boundaries pass. Both TypeScript configurations pass after restoring generated next-env.d.ts. |
| Node unit suite | 303 tests: 302 pass, zero fail, one explicit opt-in PG test skipped; actual PG integration executed separately. |
| Chromium full suite | 535 pass, zero fail, 41 conditional skips; retained full process exits zero. Final test-only changes for native WebKit tab behavior and current-dated offline fixture also pass focused Chromium checks (1 and 5 cases). |
| WebKit expanded pack | 62 pass, zero fail/skips, retries 0. Includes real OCR, offline recovery, financial replay, PayPal linking/checkout/reconciliation, attachment recovery, native titles and 320px/large-text layout. Native WebKit anchor-skipping behavior is explicit in keyboard-modality checks; Chromium retains actual Tab-order assertions. |
| Local Auth UI | 9/9 pass using a local fake Supabase provider; six cases supplement fixture-suite skips. No real email/OTP delivery claim. |
| Configured PayPal document security | 4/4 pass across Chromium/WebKit on the latest configured build. Independent official public SDK proof has zero CSP violations with downstream calls intercepted, original document nonce across real SPA navigation, and preserved popup opener. No real payment claim. |
| Private attachment recovery | Explicit fixture=true: Chromium 1/1 and WebKit 1/1, zero skips. Two uploads, restored draft/preview, read retry, removed-key error, new-key re-upload and zero CSP violations. |
| Database integration | Disposable PG17 account-delete suite 13/13, shopping uniqueness 1/1, attachment transaction/race/cleanup suite including injected rollback 1/1, and real runtime-pool timeout/rollback recovery 1/1. Separate migration fresh/upgrade rehearsal passes. |
| Local chore coordination | 1/1 passes in a dedicated PG17/auth-fixture worker. Worker base is `0bbe51319920c38d66d352b7d5f75261d9d95211`; tested chore/announcement routes, relevant pages and patched spec are byte-identical to the candidate. Completion route SHA-256 `03c0db18e1675ed007f83b6c91a05c03b8448f3956d8936aa7ca73c5a732eb63`. This is route-equivalent evidence, not an exact whole-worker-SHA claim. |
| Restore | Original September 27 backup restored and verified as described above; local database only. |
| OpenSpec | `openspec validate private-attachment-deletion --strict` passes; hosted cutover/provider-removal task remains open. |

The account-deletion integration runner is now reproducible through `pnpm --filter @manawg/web test:e2e:account-delete-db` with an explicitly supplied disposable loopback URL. It rejects query/fragment/remote overrides, clears `PG*`, pins all four runtime URL aliases, and checks the actual nonconnecting driver target before mutations. Independent review caught and resolved an ambient non-pooling URL escape before the final guarded run. Previous runs used `env -i` with only the isolated loopback target. No remote database was used. The original dirty checkout's accidentally touched `pilot-chore-coordination.spec.ts` hunk was restored; that file's diff remains empty. Other pre-existing dirty files are preserved.

WebKit's temporary nonpersistent test contexts reject IndexedDB Blob/File writes while allowing ArrayBuffer. A fresh owned persistent WebKit profile stores/reads the actual offline-image bytes, rejects a foreign-member lookup, and survives both reload and browser restart. The app reports storage failure and does not fabricate success. No product rewrite was justified; real Safari private-window persistence and physical-device push remain unverified.

### Conditional lanes

The final fixture suite has 41 explicit skips. Separate local lanes cover 21: account deletion (13), shopping index (1), chore worker (1), and Auth UI (6 additional). The PayPal document cases now execute in the configured fixture suite. The remaining 20 require genuine hosted/protected/authenticated infrastructure: Preview transaction (1), Preview protection (2), deployed public entry (6), social login (4), Supabase auth/reset (6), and real authenticated WG creation (1). Local doubles do not replace those gates.

### Evidence and reproducibility

Final integrated evidence (30 files plus SHA-256/size manifest) is stored under `/Users/abu/.local/share/manawg-recovery/release-checks/20260927T213818Z-410bed7` with directory 0700 and files 0600. Both owned final test servers were stopped after verification. Evidence snapshots: earlier `55049e0` logs remain under `/Users/abu/.local/share/manawg-recovery/release-checks/20260927T172725Z-55049e0/`; current pre-upstream integration logs and sanitized Upstash mapping/inventory are under `/Users/abu/.local/share/manawg-recovery/release-checks/20260927T201739Z-2a965a3-pre-upstream/`. Both have SHA-256/size manifests and private permissions. Failed runs remain labelled as failures. Current working diagnostics are `/tmp/manawg-october-replay-*`; run browser gates against production fixture builds with Node 22, one worker, `--retries=0`, explicit fixture flags and `OCR_RUNTIME_E2E=true` for the real OCR lane.

### Maintenance constraints

Keep the frozen lockfile and supported Node versions. Preserve original operation keys across ambiguous HTTP results, keep offline retry horizons shorter than durable replay retention, validate stale mutation versions, and store replay results in the same transaction as the mutation. Rehearse future additive migrations and restores in disposable PostgreSQL before hosted rollout. Re-run the configured browser/security lanes whenever optional SDKs or CSP change. A green fixture run does not cover protected deployments, provider delivery or device behavior.


## Release disposition

The application is locally hardened and reviewable, but **not yet cleared for October 1 Production release**. The known GitHub billing block prevents exact-revision hosted CI/Preview evidence. The other remaining requirements are genuine operational/provider gates, not silently accepted exceptions: sandbox payment access and completion, Sentry association/legal/disclosure/delivery confirmation (or keeping it disabled), current-SHA authenticated Preview flows and migration/storage-removal rehearsal, real device/email/push receipt, and a chosen offsite recovery/RPO/RTO arrangement. Local database restore, encryption and permission proof do not replace those checks.

No Production database migration, app deployment, live payment, user deletion, real push/email/OTP send, Git history rewrite or paid change was performed. The only external configuration change was enabling and rereading Sentry's outgoing TLS verification; its cropped local screenshot is retained in the task's visualizations directory. The original application checkout's pre-existing WIP is preserved. App, MCP and landing changes are committed in their isolated branches; nothing was pushed and no remote PR was merged. The reviewed upstream merge was local to the isolated audit branch.

## Completion-audit follow-up

The completion audit found and fixed additional previously uncovered paths:

- `275e7a8`: OCR incorrectly interpreted `Brot 12.34 EUR` as 123400 cents. Whole-token parsing now accepts valid dot/comma decimal and grouped EUR values, rejects malformed/date/signed/foreign-currency inputs, and honors the amount cap. Twelve parser tests and 78 independent adversarial cases pass. Actual Tesseract worker/WASM/models run under narrow CSP: `wasm-unsafe-eval` and only the two exact German/English model URLs. Initialization/recognition failures are bounded, workers cleaned up, and controls recover. No image upload or application write occurs in OCR verification.
- `a242a81`: unused Upstash SDK analytics stored raw limiter identifiers/outcomes with no expiry; SDK timeout bypassed configured fail-closed behavior. Analytics are disabled and SDK timeout enters the existing failure policy. Two actual pinned-SDK regressions pass. Historical data remains; see the rate-limit privacy prerequisites.
- `2a965a3`: a fresh whole-app reviewer reproduced automatic replay of an eight-day-old uncertain expense after the server response cache had expired, allowing duplication. The client now fences original queue timestamps at the shared seven-day retention minus five minutes thirty seconds for clock/transport uncertainty, including force, crash-without-attempt-metadata and uploads crossing the horizon. Original content/keys remain for manual comparison; no blind recreation. Twenty integrity tests pass independently.
- The same reviewer twice reproduced React hydration error #418 on `/offline`. A stable initial online state now matches SSR/client, and the existing effect reads actual connectivity. The browser regression failed before the fix and passes on the rebuilt source in both engines.

A read-only `tmutil destinationinfo -X` check returned an empty destination inventory; it provides no evidence of an external backup and does not rule out other backup products.

## Integrated upstream and final fresh review

Four newer upstream commits were merged after the remote-main check exposed drift. The OAuth-style PayPal connection flow now replaces manual merchant-ID entry. The merge preserves stable payment request IDs, pending reservations, PAYEE classification and complete capture responses. A slow negative readiness result can release only its unchanged `created` placeholder; it cannot overwrite a real provider order, `capturing` or `completed` row. Sixteen focused onboarding/order/connect checks pass independently. Sentry now imports its actual version-11 configuration entrypoint while retaining the audit's privacy filters and conditional client loading; fourteen independent config/privacy/maintenance/export checks pass.

Another reviewer with no implementation history found one new capture precondition gap: a created A→B order could still capture after direct A→B debt had become an equal-net A→C→B path. `9801b42` checks the current direct pair/currency under the payment lock before a new capture, preserving GET-first reconciliation of already ambiguous captures. Thirteen route-state cases using real balance helpers pass, including no provider calls for the reshaped graph. Independent follow-up found no further material defect within its stated whole-app source pass.

The upstream PayPal hint used a forced two-column span in an auto-fit grid. At 390px/200% text this created a zero-width reminder column; `89bb06b` changes both hints to `col-span-full`. The rebuilt existing 12-condition layout/keyboard test passes. Test-only updates wait for real import readiness/theme effects, model the PayPal status lookup before mount, load its mock SDK through the actual nonce-bearing script, and verify same-order reconciliation before clearing debt. Real OCR is verified in Chromium and WebKit; WebKit's exact blocked embedded-WASM data-URI fetch warning is a handled SDK fallback, and no CSP permission was broadened for it.

The companion MCP refresh is committed as `2ad279c`; its strict member-update schema rejects both manual merchant-ID assignment and null removal. Independent review and 154 tests pass, along with lint, types, build, smoke (56 tools, 13 resources, four templates, four prompts) and built-dist checks. Publish/update this companion before enabling the stricter app contract.
