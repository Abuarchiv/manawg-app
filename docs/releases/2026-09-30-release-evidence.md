# Release evidence — 2026-09-30

This is dated evidence, not unconditional release approval. CI work is deferred
at the owner's explicit request. No Production migration was performed.

## Confirmed Production application — initial readback

- `app.manawg.com` resolves to READY deployment
  `dpl_37GfugtVpdpbuXJMKyPvvSuyQEyV`, source
  `6aa0b666bb4704138e6976629716f8a9eac19c07`.
- Health returned 200, database OK, zero missing required configuration and no
  degraded features. The dedicated Production test account could log in and
  read its own WG. Anonymous and foreign-WG reads returned 401.
- The integrated runtime passed 393 unit/route checks (one skip), 512 Chromium
  fixture cases (43 explicit skips), lint, typecheck, build and bundle budget.
  These are local results, not hosted Preview or real-device acceptance.
- The isolated Pinnwand route fixture now blocks service workers and updates
  its in-memory comments after deletion. All five cases passed in Chromium and
  WebKit; the focused comment case independently passed three times in each.

## Final dependency correction

- The existing narrow brace-expansion override now pins patched `5.0.12`.
  The package and lock diff passed independent review; no other dependency
  versions changed. Node 22/pnpm 9 frozen installation succeeded.
- Live Production dependency audit after integration reported zero known
  vulnerabilities across 316 dependencies. Repository lint passed (669 files).
  The patched dependency tree also passed typecheck, 393 unit/route checks
  (one skip), Next 15.5.24 build and bundle budgets (102.2/120 kB shared).
- These checks cover the updated dependency tree. The 512-case fixture run
  above preceded the lock correction and is not presented as a new final-SHA
  hosted or device test.
- Subsequent Production delivery `89319773cd09dc1e39479004720208921e0b2f82`
  reached READY as `dpl_AAgehM7awZmKTmeuRG7FhTvL9i8B`, Node 22, with
  `app.manawg.com` assigned. Fresh health, dedicated-account login and own-WG
  reads passed; foreign and anonymous WG reads returned 401. This is a dated
  delivery readback, not an assertion about future deployments.

## Hosted Preview authentication and isolation

- Protected Preview `manawg-n4rmhme9p-abditubes-projects.vercel.app`
  (`dpl_7HrAmh3k9gYwYw1AxB7qr4jvp616`) was uploaded from the clean local
  `6aa0b666` tree. The provider readback has no GitSource/commit SHA; this is
  not native exact-SHA provider provenance or a final-revision CI gate.
- Connected Chrome SSO succeeded without a human prompt. Fresh QA signup and
  signed-in `/api/wg/mine` returned 200. All 29 inspected script chunks used
  only the exact Preview Supabase host.
- A direct Preview DB transaction, guarded by exact project reference and
  verify-full TLS, created one non-joinable canary WG and one owner membership.
  Owner list returned 200 with exactly that marker; its dashboard returned 200.
  A second authenticated QA user had an empty WG list (200) and was denied the
  same dashboard with 401 `not_a_member`. This proves the hosted runtime DB
  target through the unique Preview canary; the sensitive Vercel env value
  itself remained unreadable.
- Cleanup removed exactly one member, one WG and both QA Auth users. Remaining
  canary WG/member/user, session and identity counts were zero; no additional
  profile or app-generated WG records remained. The browser signed out.
- The earlier CLI-cookie 401 was not reproduced in fresh native Chrome. Its
  cookie-validity/forwarding cause remains unclassified; no auth weakening was
  made. App source under `apps/web/src` is identical between this Preview source
  and delivered `8931977`; only the separately checked dependency tree differs.

## Final native delivery and operational follow-up

- Production and native GitSource Preview both reached READY on
  `746f889b383c666b883c736ea73069777bde916e`. Production:
  `dpl_26PWi8KTovgRt7VjcbeFv4Dt19FN`, alias `app.manawg.com`; fresh health and
  own-WG/authenticated foreign-WG checks passed (200/401).
- Preview: `dpl_6tskc352VSEJYi1NwJnQURc1zg1x`,
  `manawg-3j43fosxj-abditubes-projects.vercel.app`. All 29 fetched scripts used
  only the Preview Supabase host. Post-cleanup health returned database OK and
  zero missing required configuration; KV/rate limiting and push were
  intentionally disabled for the isolated Preview.
- Its 25 temporary Preview-only env overrides were removed. All 51 original
  env records retained their ID/key/type/target/branch metadata. The temporary
  GitHub ref was removed only at the exact owned SHA; main and the primary WIP
  were preserved. The initial Preview attempt without overrides was canceled
  before build completion. Secret-bearing temporary artifacts were removed.
- After explicit owner confirmation, the guarded Redis Lua operation deleted
  exactly 552 reviewed persistent analytics keys containing 1,111 entries.
  Fresh metadata matched fingerprint `b4871484...` before execution. A separate
  TLS readback at `2026-09-30T19:18:42.525Z` found zero keys matching the reviewed
  analytics namespace. This does not assert deletion of provider logs/backups.
- A diagnostic accidentally printed two existing Vercel automation-bypass
  secrets as protection-map keys into the internal tool log. Saved artifacts
  were sanitized; no public disclosure or use is evidenced. App authentication
  is still required. The owner explicitly deferred targeted rotation, including
  possible updates to the repository and Preview GitHub secrets. CI work remains
  deferred. No secret values are recorded here.
- A later read of the previous EUR 0.01 Sandbox order returned provider HTTP
  404; no capture or WG settlement was observed. The exact cause is not proven.
  The existing Sandbox setup is retained; no replacement order was created.

Later operational documentation edits do not change the delivered app source
or dependency tree. The native delivery SHA above identifies the built app.

## Database and private storage

- Production readback found 18 migrations through `0017`, 28 public tables,
  RLS on every public table, and no direct anon/authenticated table grants.
- A fresh isolated sole-member test WG completed private upload and readback:
  7,786 bytes, identical SHA-256 to the uploaded icon, private/no-store response.
  Anonymous read returned 401. Expense deletion revoked the copied image URL
  with 404 before membership removal; the test WG was then removed. Existing
  test WG data was untouched. Provider object cleanup remains pending normal
  maintenance; the tombstone is intentionally retained.

## Recovery and accompanying services

- The fresh Production export at `2026-09-30T11:46:29Z` restored in isolated
  Supabase PostgreSQL 17.6 with all 62 COPY section counts matching. Temporary
  restore resources were removed. The encrypted AES-256/OCB bundle decrypted
  successfully and all five member hashes matched. Storage inventory was empty
  at snapshot time; this does not prove restoration of later object bytes.
- OrbStack login startup is enabled. The backup script checks only its local
  context and bounds daemon readiness to 60 seconds; Stopped fails immediately.
  A future login startup race remains possible. Offsite storage, separate key
  custody and hosted restore/PITR remain unproven.
- ManaWG MCP `e7406872` passed 154 tests, lint, types, build and smoke; an
  independent 87-test run passed. Installed dist was rebuilt. No running MCP
  process was found, so no restart was performed.
- Landing `47d0ff76` is deployed to `manawg.com`. The current privacy page was
  fetched with verified TLS/SNI/Host through the reachable Vercel endpoint.
  Sentry disclosures are conditional; Upstash historical retention is explicit.

## Remaining acceptance boundaries

- The existing PayPal Sandbox credentials and seller readiness work (OAuth and
  readiness HTTP 200 in the recorded probe). The EUR 0.01 order was initially
  CREATED; its later read returned 404 as recorded above. Buyer approval,
  capture and WG settlement are not proven. The existing Sandbox is retained.
- Hosted Preview auth and own/foreign WG access have controlled evidence above;
  the final native Preview also has exact GitSource SHA and health evidence.
  Full final-revision hosted journeys remain separate from this focused probe;
  no CI success is claimed.
- Historical Upstash metadata scan found 552 persistent ZSET keys containing
  1,111 entries. No event payloads were read. The owner-authorized deletion and
  zero-key readback are recorded above; no TTL change was made.
  The guarded helper passed independent review, 17 Node 22 mock checks and
  eight real Lua scenarios against isolated official Redis (network none,
  tmpfs, no host mounts). Guard failures preserved all supplied keys. Temporary
  resources were removed. Execution remains disabled without the exact
  confirmation literal and unchanged metadata fingerprint.
- Real iOS/Android push, install and offline acceptance, offsite recovery and
  alert-mail receipt are not proven. Absence of a matching inbox search result
  is not proof that an alert was never delivered.
