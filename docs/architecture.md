# Architecture

Overview of `apps/web` for contributors. Paths are relative to `apps/web/src` unless stated
otherwise. Setup, commands and deployment are in [development](development.md).

## Request flow

```text
browser
  -> proxy.ts                         CSP nonce, Origin check, rate limit, Supabase session refresh
  -> app/api/wg/[code]/**/route.ts    thin handler
       withWgRoute / readShareCode    normalize + validate share code, catch -> server_error
       (body validation)              before auth, so invalid_body cannot leak membership
       requireWgMember                Supabase user -> WG by share code -> active wg_members row
       withIdempotentWrite            mutations carrying an Idempotency-Key (and keyless writes)
       features/<x> / composition    domain logic
       core/db (Drizzle, pg Pool)     Postgres
```

**Proxy** (`proxy.ts`, runs before every matched request):

- Pages (non-`/api`): fresh CSP nonce per request (`core/infra/security-headers.ts`), COOP
  header, Supabase session refresh. `/wg/*` without a session redirects to `/login?next=...`
  (`core/auth/middleware.ts`).
- API paths in the matcher (`/api/account`, `/api/auth/*`, `/api/wg[/*]`, `/api/calendar/*`,
  `/api/upload/*`, `/api/cron/*`):
  1. `MIGRATION_READ_ONLY=true`: writes and crons get `503 migration_read_only`.
  2. Mutating requests need an `Origin` matching host and protocol, else `403 cross_origin_blocked`.
  3. Sliding-window limit per client IP: share-code lookup, read or write bucket
     (`core/rate-limit.ts`). With Upstash configured it counts in Redis. A standalone server
     (`NODE_ENV=production` without `VERCEL_ENV`, the Docker image) without Upstash counts in
     memory per process (`core/memory-rate-limit.ts`). Otherwise the fail mode decides: `closed`
     when `VERCEL_ENV=production` or `NODE_ENV=test`, else `open`; closed plus missing or failing
     Upstash means `503 rate_limiter_unavailable`.
  4. Database-free fixture build only (`src/fixtures/`, development.md "Fixture mode"): fixture API
     reads and `POST /api/wg` are answered here; every other build gets `null` from
     `resolveFixtureRequest` and skips this step.
  5. Supabase session refresh.
- `/api/health` is outside the matcher and applies its own limiter.

**Route handlers** use `withWgRoute` (`core/guards/with-wg-route.ts`) for the share-code
preamble and the catch-all `logApiError` + `server_error`. It deliberately does not authenticate;
handlers call `requireWgMember` (`core/guards/require-wg-member.ts`) after body validation.
Unknown or foreign share codes count against `wgShareCodeMissLimiter` (20/hour/account).
WG-settings writes use `requireWgAdmin` (`core/guards/require-wg-admin.ts`).

**Pages under `app/wg/[code]/`** are authenticated only by `app/wg/[code]/layout.tsx`
(`loadWgViewer`, which calls `getAuthenticatedUserFromCookies()`). The proxy is not an independent barrier there: on a
transient Supabase Auth failure it serves the page instead of redirecting.
`scripts/check-wg-auth-invariant.mjs` therefore fails on any `route.ts` or `'use server'` file
under `app/wg/**`; WG APIs belong under `app/api/wg/**`.

## Layering

| Layer | Contains | May import |
| --- | --- | --- |
| `app/` | Pages, layouts, route handlers. Thin. | everything below |
| `fixtures/` | Database-free fixture build: mode detection, fixture API and page data (development.md "Fixture mode") | `composition/` and everything below |
| `features/<x>/` | Vertical slices: `chat`, `chores`, `events`, `expenses`, `inventory`, `announcements`, `shopping` (logic, hooks, components, and a `server/` folder) | `components/`, `core/`, `shared/`, own files |
| `composition/` | Cross-feature reads: dashboard data and insights, activity, export | `features/`, `components/`, `core/`, `shared/` |
| `core/` | Domain-neutral blocks: `db`, `auth`, `guards`, `http`, `hooks`, `offline`, `sync`, `notifications`, `infra`, `utils`, `validators`, `i18n` (server-side locale translation helpers), `mail` (SMTP and Resend transport, templates) | `core/`, `shared/` |
| `components/` | Shared UI: `ui/` shadcn primitives (plus `LogoMark`, `Toast`, `ConfirmDialog`), `animate-ui/`, `app/` app-wide composites (shell, PWA install/push prompts, theme), `wg/` WG-wide composites, `auth/` (sign-in, sign-up and password-reset forms), `brand/` (splash screen), `entry/` (public signed-out entry app, WG welcome) | `components/`, `core/`, `shared/` |
| `shared/` | Framework-light utilities (`lib/`, `i18n/` message catalogs, fonts, css): theme, analytics, header names | `shared/` |

Rules:

- A feature never imports another feature. `scripts/check-architecture.mjs` resolves aliased
  and relative specifiers and fails lint and CI on any import against the matrix above.
- Code that touches the database or other server-only dependencies (`drizzle-orm`, `core/db`,
  `core/auth/server`, secrets, `node:` modules) lives in `features/<x>/server/` and starts with
  `import 'server-only'`. Files directly under `features/<x>/`, `components/` and `hooks/` stay
  client-safe: shared types and pure logic go there, so a client module never pulls in a server
  module. The check fails any `features/<x>/server/` file without the import and any
  `'use client'` module importing from a `server/` folder. Unit tests resolve `server-only` to an
  empty module (`tests/support/resolve-hooks.mjs`).
- Cross-feature side effects go through `core/` (e.g. `core/activity-feed.ts` posts system
  notices to the chat timeline; `core/audit.ts` records audit events).
- Cross-feature reads go through `composition/`.

## Identity model

- **Auth user**: Supabase Auth (Google, e-mail code, e-mail/password). All auth calls go through
  the route handlers `app/api/auth/*` (`core/auth/route-helpers.ts`); there is no Supabase client
  in the browser. The session cookies are HttpOnly (`core/auth/cookie-options.ts`), the proxy
  refreshes them and keeps the readable hint cookie `manawg_signed_in` in step. Callback
  `app/auth/callback/route.ts`, password reset `app/auth/reset`. The account name entered at
  registration is `user_metadata.full_name` and prefills the member name.
- **Invitations**: `wg_invites` (token, 7 days, max 10 uses, revocable). Joining needs a valid
  token (`POST /api/wg/<code>/members` with `inviteToken`); the share code is only an address.
- **Member**: one `wg_members` row per WG and auth user (`auth_user_id`, unique per WG). A user
  can be a member of several WGs. `deactivated_at` is the move-out soft delete; deactivated
  members lose API access and push, history stays.
- **Membership check** (`core/guards/api-auth.ts` `requireMember`): the server-verified
  Supabase user is looked up in `wg_members`. That lookup is the only identity proof; CSRF is
  covered by the proxy's same-origin check. Failures carry a typed `reason`
  (`auth_required`, `not_a_member`, `member_deactivated`, `member_context_changed`,
  `db_error`). `x-manawg-expected-member-id` mismatch yields `409 member_context_changed`, so a
  stale tab cannot act as a different member. `requireWgMember` and `requireWgAdmin`
  (`core/guards/require-wg-*.ts`) share the auth and share-code resolution steps.
- **Client session state**: `components/wg/wg-session-state.ts` is the one reducer behind the WG
  context. It holds the member identity plus `accountReady`, `memberLoaded`, `memberLoadError` and
  `sessionEnded`, so a transient failure keeps the server-verified member while a gone session or
  a lost membership is told apart. The layout hands in the server-verified member read by
  `loadWgShell` (`core/guards/load-wg-viewer.ts`: viewer, moved-out check, roster and admin flag in
  one memoized call). That identity carries `authUserId`, so the provider starts ready; remembering
  a WG for offline use (`rememberWg`) requires `authUserId`, because remembered WGs and queued
  actions are bound to the account.
- **Fixture mode** answers as `FIXTURE_AUTH_USER_ID` (`fixtures/data.ts`) through the same member
  lookup the app uses; product code has no fixture branch beyond the `app/` seams named in development.md.
- **Admin**: `wg_members.role` is `admin` or `member`, at most one admin per WG (partial unique
  index). `core/guards/admin.ts`: `isWgAdmin` and `requireOwnerOrAdmin` (owner or admin for
  edits/deletes of others' items); `requireWgAdmin` gates WG rename/delete.

## Idempotency

Mutations that may be retried (offline replay, flaky mobile networks) send a UUID
`Idempotency-Key` header (`core/idempotency-store.ts` `readIdempotencyKey`; non-UUIDs are
ignored). Every such write goes through one primitive, `withIdempotentWrite`
(`core/db/idempotent-write.ts`), on top of table `idempotency_responses` (primary key
`scope, key`). Route handlers never touch the claim helpers themselves; the architecture check
fails on any claim-protocol identifier under `app/`.

```ts
withIdempotentWrite(
  { scope, key, codec, prepare?, beforeReplay?, inTransaction?, storeStatus?, retryAfterRollback? },
  async (tx, input) => ({ status, body, context }),
)
// -> { kind: 'replayed', status, body } | { kind: 'written', status, body, context } | { kind: 'stopped', response }
```

1. **Replay lookup**: a stored response for `scope:key` is replayed before any other work.
   `beforeReplay` can refuse it (e.g. a member who moved out, an account being deleted).
2. **`prepare`**: checks that must pass before the claim (rate limits, membership of named
   members, parsing an import); it can stop the request or hand an input to the write.
3. **Claim**: `claimResponseSlot` inserts a `{"_claimed": true}` placeholder with a 15-minute
   lease and returns that lease to the winner. A request that loses the claim polls (`claimReplaySlot`) until the winner's response is
   stored, then replays it. Claim and store errors fail closed (retryable 503).
4. **One transaction** (`inTransaction`, default `withTransaction`; money paths pass
   `withExpensePaymentLock` so the payment lock comes before the claim row and any WG or member
   row lock): `lockClaimedResponse` locks the claim, a completed response replays, otherwise the
   write runs and `completeClaimedResponse` stores its response under the same lease, so the
   response commits atomically with the write. Outcomes rejected by `storeStatus` (default: 2xx
   only) delete the claim in the same transaction (`releaseLockedClaim`) so a retry runs again.
5. **Rollback**: after a confirmed rollback (the write's own error) the claim is released with
   its lease (`releaseClaimedResponse`), and so is a claim whose transaction failed before the
   write started (pool checkout, `BEGIN`); a failed COMMIT keeps the claim until the lease ends,
   so an unknown outcome never runs twice. A request whose lease ran out can neither complete nor
   delete the claim of the request that took the key over. `retryAfterRollback` runs a second
   write under the same lease (a unique index that found the canonical row, a fresh share code).
6. **Storage**: a `codec` decides the stored shape (`responseCodec` stores `{status, body}`,
   `bodyCodec` the bare body; legacy readers keep older rows inside the window replayable).
   Responses over 32 KiB are stored as replay-unavailable unless the route opts out (import
   results); a retry of such a write answers a final 409 `idempotency_response_unavailable`. Rows live 7 days (`RESPONSE_REPLAY_TTL_SECONDS`) and are purged by the maintenance
   cron.

Side effects that must not undo the write (audit events, push, chat notices) run after the
call, for `written` results only, so a replay never repeats them. A warning that only becomes
known then (a failed push) is written into the stored response with `setReplayWarning`. Without a
key the write runs in a plain transaction (`retryAfterRollback` still applies).

**Client side.** One key lifecycle lives in `core/http/idempotency-key.ts`, client-safe.
`createIdempotencyKey` makes the UUID, `resolveIdempotencyKey` reuses the pending key for an
identical retry (same request fingerprint) and otherwise makes a fresh one, and
`shouldReleaseIdempotencyKey` decides after an answer whether the key is spent. A definitive
answer (a final 4xx other than 429, a success) releases it. A 429, a server error and an in-flight
duplicate (`idempotency_response_pending`) keep it, so the retry replays instead of writing twice.
Keeping the key on 429 is safe because no route stores a 429 as a replayable response.

## Money

- All amounts are integer cents. `features/expenses/split-math.ts`: equal splits use
  largest-remainder rounding, so `sum(splits) === amount` and shares differ by at most 1 cent.
  `validateSplits` rejects duplicates, negative/non-finite cents and sums that differ from the
  total. The payer's own split is stored as already settled (`settledAtForOwnShare`).
- Balances: `features/expenses/debts.ts` aggregates unsettled splits per debtor/creditor pair;
  `debt-reduction.ts` computes net balances (including completed cash payments) and
  `simplifyDebts` for settlement suggestions.
- Paid-by rule (`features/expenses/paid-by-guard.ts`): whoever records an expense paid by
  someone else must bear a positive share. It applies to manual entry, recurring expenses and CSV/OCR imports;
  only the WG admin may import a shared history with rows they are not part of.
- Manual settlement sets `expense_splits.settled_at`
  (`/api/wg/<code>/expenses/[id]/splits/[splitId]/settle`, `/expenses/settle-batch`).
- Cash payments (`/api/wg/<code>/payments/manual`, `features/expenses/server/manual-payment.ts`)
  record the whole net debt of a pair as one `expense_payments` row with status `completed`;
  voiding sets it to `voided`. Payment work takes a per-WG advisory lock (`lockExpensePayments`).
- Recurring expenses (UI label "Fixkosten") are templates in `recurring_expenses`, materialized by the
  `recurring-advance` cron. `anchor_at` keeps the day-of-month (31.01 → 28.02 → 31.03); edits are
  a compare-and-set on `next_due_at` so a concurrent booking is never written back
  (`409 recurring_expense_changed`).

## Offline queue

`core/offline/`:

- Supported actions (`OfflineActionType`): shopping create/update, announcement create, absence
  create, chore create/complete, expense create/update, recurring create/advance. Per-type request
  building lives in one handler table (`offline-action-handlers.ts`), builders in
  `offline-action-builders.ts`; `offline-queue.ts` is the public entry for both.
- The queue is JSON in `localStorage` (`manawg:offline-actions`, `offline-store.ts`), guarded by
  a queue lock. `offline-sync.ts` replays it with the rules in `offline-replay-rules.ts`;
  `offline-client.ts` is the public entry. Each action stores a stable `idempotencyKey`; replay sends it as
  `Idempotency-Key`, so a request that reached the server before the connection dropped is
  replayed rather than duplicated. Retries back off exponentially (max 15 min).
- Review window: the server keeps replay rows for 7 days, so actions older than
  `OFFLINE_REPLAY_MAX_AGE_MS` (7 days minus clock skew and two request timeouts,
  `replay-retention.ts`) are not resent automatically and need manual review in settings.
  Edited actions, missing local images and some server errors also require review.

## Client data sync

`core/sync/use-synced-collection.ts` keeps one server collection in sync on the client. It owns
the cached fetch (`core/hooks/use-cached-fetch.ts`, store in `cached-fetch-store.ts`), the overlay
of unconfirmed rows (`pending`), offline replay after a successful load, polling paused while the
tab is hidden, the refresh on reconnect, and the single place where server responses and local
changes (`commit`) are reconciled into the rows on screen. Feature hooks for shopping, chores and
absences, inventory, announcements, expenses, recurring expenses, reminders, calendar and activity only describe the
resource (URL, `select`/`assemble`, id, an optional `reconcile` merge, error policy, offline page)
and keep their domain actions. A direct `useCachedFetch` is only for single documents and side
reads (a detail view, a lookup next to a list), never for a second copy of a collection. Chat
pages through its history, so its refresh loop is a separate framework-free module
(`features/chat/chat-refresh.ts`).

Other client hooks that several features share live in `core/hooks/` (`use-confirm-delete.ts`,
`use-pending-set.ts`, `use-stable-callback.ts`); the offline queue sync hook is
`core/offline/use-offline-queue-sync.ts`. Hook files are kebab-case (`use-*.ts`), enforced by
`scripts/check-architecture.mjs`.

All `online`/`offline` and `visibilitychange` listeners go through
`core/hooks/use-online-status.ts` (`subscribeConnectivity`, `subscribeOnline`,
`subscribeVisibility`, `useOnlineStatus`), so one listener pair serves the whole app.

## Shared helpers

Small helpers that several features use, with the layer they live in:

| Helper | Layer | Purpose |
| --- | --- | --- |
| `core/utils/amount.ts` | core | Euro text to cents and back: `parseEuroAmount`, `formatEuroInput`, `eurosToCents`, `formatCentsInput` |
| `core/utils/time.ts` `formatDayMonthYear` | core | Berlin day with year (`06.10.2026`) from an ISO timestamp; the parse counterpart is `parseDayMonthYear` in `features/expenses/import-csv-helpers.ts` |
| `shared/lib/support-mailto.ts` `SUPPORT_MAILTO` | shared | The support `mailto:` link used by error screens |
| `core/db/pg-errors.ts` | core | Pure Postgres error inspection (`isUniqueViolation`, `findUniqueViolation`); no server imports, so client-safe feature files may use it |
| `core/infra/api-client.ts` `readApiErrorCode` | core | Reads the `error` code of a failed API response |
| `core/utils/use-visibility-paused-interval.ts` `LIST_REFRESH_INTERVAL_MS` | core | The one list polling interval |

Mutation error copy goes through `mutationError` (`core/http/error-codes.ts`); feature
`*-errors.ts` files only add their own codes.

## Notifications

- Web Push via `web-push` with VAPID keys; service worker `public/sw.js`. Subscriptions live in
  `push_subscriptions`; 404/410 responses delete the subscription.
- `core/notifications/notification-dispatch.ts` `dispatchNotification` resolves active members,
  applies per-category preferences (`notify_*` columns), quiet hours (Berlin time, skipped for
  `urgent`) and `push_opt_in`, and sends in batches of 10. `dispatchNotificationSafely` adds a
  5 s timeout so a push failure never fails the triggering request.
- A browser endpoint is stored once per member (`(member_id, endpoint)` unique), so one device
  receives pushes for every WG of the same account. Unsubscribing in one WG keeps the browser
  subscription while another WG still uses it (`endpointInUse`); an endpoint still owned by an
  active member of another account is refused (`endpoint_owned`).
- Payloads carry a relative `/wg/<code>/…` link, a TTL (12 h urgent, 24 h otherwise) and a
  10 s request timeout, so stale reminders are not delivered days later.
- Without VAPID keys push is disabled. `VAPID_SUBJECT` (the contact for the push services) is
  required when `NODE_ENV` is `production`; in development and tests, push is skipped without it.

## Privacy and observability

- **Sentry** (`core/infra/sentry.ts`, only with `NEXT_PUBLIC_SENTRY_DSN`):
  `sanitizeSentryEvent` (`core/infra/sentry-privacy.ts`) drops user, message, extra and most
  contexts, replaces exception values with `[redacted]`, normalizes error names, strips query
  strings, redacts share codes in `/wg/<code>`, calendar tokens and storage object paths, and
  only keeps allowlisted tags. Console and UI breadcrumbs are dropped.
- **Server logs**: `logApiError` (`core/infra/observability.ts`) logs the static label and the
  error name only, never message or stack.
- **PostHog** (`instrumentation-client.ts`): initialized only when `NEXT_PUBLIC_POSTHOG_HOST` is
  `https://eu.i.posthog.com`; cookieless, memory persistence, no person profiles, no autocapture
  or session recording. `before_send` allows only `$pageview`, `wg_created`, `wg_joined` and
  rebuilds the event without URL or caller properties. `scripts/check-analytics-privacy.mjs`
  enforces this in CI.
- **Boot report**: `instrumentation.ts` runs `checkEnv` and logs `[env] MISSING REQUIRED` /
  `[env] DEGRADED`; it reports to Sentry but does not crash the server. `/api/health` returns only
  counts and feature names.

## Database

- Schema: `core/db/schema/` (Drizzle, one file per area; `core/db/schema.ts` re-exports them) plus the
  tables of the newer areas in `core/db/schema-*.ts` (inventory, invites, mail log, statement emails). Migrations: `apps/web/drizzle/` with
  `meta/_journal.json`; `0000_baseline.sql` creates the full schema and later files are
  incremental. `scripts/db-migrate.mjs` applies them under an advisory lock, checks the ledger
  against the journal (fail-closed) and verifies the result (`--check`). One reviewed historical
  ledger hash (`HISTORICAL_LEDGER_ROWS` in `scripts/db-migrate/ledger.mjs`) is tolerated at its
  exact position; a database with the schema but an empty ledger is refused.
- Security: RLS is enabled on the application tables (`0010_enable_public_rls.sql`; later tables
  in `0015`, `0017`) without policies, as defense in depth. Privileges for `anon`,
  `authenticated` and `PUBLIC` are revoked (`0007`, `0016`). The app reads and writes tables
  through its own server connection, not the Supabase Data API. Triggers
  (`0013_member_wg_invariants.sql`) enforce that member references belong to the same WG.
- Runtime connections (`core/db/index.ts`, `transaction.ts`, `connection.ts`): one lazily built
  `pg.Pool` per instance serves both `db` and `withTransaction`, with `max: 5`,
  `statement_timeout` 5 s, `lock_timeout` 2 s, `query_timeout` 5.5 s, connect timeout 2 s, on
  `POSTGRES_URL || DATABASE_URL`. `withFreshTransaction` opens one short-lived client on the same
  URL to resolve an uncertain commit. Remote URLs must carry a
  port; TLS is forced to `verify-full` with the pinned Supabase root CA (`supabase-ca.ts`). URLs
  may not override timeouts or host via query parameters. Differing alias pairs log a warning.

## Image storage

Images live in a private Supabase Storage bucket (`core/infra/supabase-storage.ts`). Uploads are
signed via `/api/upload/sign`; reads go through `/api/upload/read?key=...`, which re-checks
membership of the WG encoded in the key and the deletion tombstones, and streams with `no-store`.
The bucket (`SUPABASE_STORAGE_BUCKET`) must be private with an 8 MiB limit and exactly the MIME
types in `core/infra/private-image-policy.ts`; otherwise uploads report themselves unconfigured.
Deletions are tombstoned in `private_image_deletions` and removed by the maintenance cron. The same
cron queues pictures no row points at after 14 days (`core/db/orphan-uploads.ts`, a few WGs per
run); a queued picture that a row points at again is taken off the queue.

## Cron jobs

Five cron jobs, scheduled by `apps/web/vercel.json` on Vercel and by the `cron` container
(`scripts/selfhost/cron.mjs`) in Docker; see the table in [development](development.md#cron-jobs). All open with
`requireCronSecret` (constant-time bearer compare, `core/infra/cron-auth.ts`) and fail closed
without `CRON_SECRET`, cap
work per run (batches, limits) and leave the rest to the next run. Reminder crons deduplicate
with claim rows/throttle timestamps so a re-run does not notify twice.

## Key decisions

- **Response replay in Postgres, not Redis.** A Redis client with empty `UPSTASH_*` values
  no-ops silently, so a retried write would insert twice; Postgres is always there and commits the
  response with the write (`core/idempotency-store.ts`, `core/db/idempotent-write.ts`).
- **Supabase session as the only identity proof.** A second per-member token would prove
  nothing the session cookie does not; the client sends only the expected member id, which the
  server checks against the session (`core/guards/api-auth.ts`).
- **Rate limiter never passes traffic unthrottled in production.** On Vercel a missing or failing
  Upstash answers 503 instead of leaving share-code lookups (brute-force defense) and writes
  unthrottled, because serverless instances cannot share memory. A standalone server counts in its
  own memory instead (`core/rate-limit.ts`, `core/memory-rate-limit.ts`).
- **Missing env does not crash boot.** A crash would take down every tenant; instead
  `instrumentation.ts` reports to Sentry and logs, and features degrade.
- **Validation before auth in WG routes.** `withWgRoute` does not call `requireWgMember`, so
  `invalid_share_code`/`invalid_body` precedence is stable and cannot reveal membership.
- **Integer cents with largest-remainder rounding.** Summing rounded floats does not reproduce
  the total; splits must sum exactly (`features/expenses/split-math.ts`).
- **Cross-feature effects via `core/`.** Posting a chat notice is infrastructure, not
  chat logic, so features do not import each other (`core/activity-feed.ts`).
- **Offline handlers in one core table.** Splitting them per feature would need a registration
  bootstrap; a `Record<OfflineActionType, ...>` lets `tsc` enforce a handler per type
  (`core/offline/offline-action-handlers.ts`).
- **Redacted logging.** Raw errors copied stacks and Postgres payloads into
  long-lived logs, so only label and error name are logged (`core/infra/observability.ts`).
- **Shared input limits.** Forms and API validation read name limits from
  `shared/lib/limits.ts`, so browser and server reject the same values; a test keeps it equal to
  the database's `LIMITS.NAME_MAX`.
- **Deleted means deleted.** A deleted chat message loses its text at rest, the audit log keeps
  no preview, and exports never contain deleted text or images.
- **Oversized bodies are 413, not 400.** `readJsonLimited` routes map its error through
  `unreadableJsonBody`, so the client can tell "shorten this" from "malformed".
- **Browser floor Safari 16.4.** `api-client.ts` falls back from `AbortSignal.any` (Safari 17.4+)
  to its own controller; raw `fetch` calls carry the same 15 s timeout as `apiFetch`.
- **Counts, not rows, for summaries.** `GET /export?summary=counts` counts with the dump's filters,
  so the settings page does not download a WG's whole chat to show numbers.
- **Bounded service-worker cache.** Chunks fetched while browsing live in a capped runtime cache;
  `sw.js` does not change between deploys, so nothing else would evict them.
- **Migrations give up instead of queueing.** `db-migrate.mjs` sets `lock_timeout = 5s`, so DDL
  that cannot get its lock rolls back rather than stalling every query on the table.
- **Calendar feed keeps 90 days of history.** Subscribed calendar apps mirror the feed and delete
  what leaves it; starting at today removed yesterday's events from everyone's phone.
- **Event years 1900–2200.** Wide enough for yearly birthdays; a typo like year 0026 or 20266 is
  rejected in the form and the API instead of being stored and expanded.

## Glossary

Route folders under `app/wg/[code]/`, with the code names behind them. The first column gives the German UI label and the route slug. Old German URLs redirect permanently to the English routes (`redirects()` in `next.config.ts`).

| UI label / route | Code | API (`/api/wg/<code>/...`) | Tables |
| --- | --- | --- | --- |
| WG (`/wg/[code]`, share code) | `wgs` | `/api/wg/<code>` | `wgs` |
| Mitglied, Auszug | members, `deactivatedAt` | `members` | `wg_members` |
| Ausgaben (`expenses`) | `features/expenses` | `expenses` | `expenses`, `expense_splits`, `expense_payments` |
| Fixkosten (`recurring`) | recurring expense (`features/expenses/recurring-expenses.ts`, type `RecurringExpense` in `features/expenses/expense-types.ts`) | `recurring-expenses` | `recurring_expenses` |
| Import (`import`) | expense import (`features/expenses/import-*.ts`, commit in `features/expenses/server/import-commit.ts`) | `imports` | `expense_imports` |
| Mahnungen / Erinnerungen (`reminders`) | payment reminders (`features/expenses/reminders.ts`) | `reminders` | `expense_reminders` |
| Abrechnung (`statement`) | monthly statement (`features/expenses/monthly-statement.ts`) | `expenses` | |
| Putzen / Putzplan (`chores`) | `features/chores` | `chores` | `chores`, `chore_completions` |
| Abwesenheiten (panel on `chores`) | absences (`features/chores/absence.ts`) | `absences` | `member_absences` |
| Pinnwand (`pinboard`) | announcements (`features/announcements`) | `announcements` | `announcements`, `announcement_comments`, `announcement_reactions` |
| Einkauf (`shopping`) | `features/shopping` | `shopping` | `shopping_items` |
| Vorräte / Inventar (`supplies`) | `features/inventory` | `inventory` | `wg_inventory_items`, `wg_inventory_log` |
| Kalender (`calendar`) | events (`features/events`) | `events`, `calendar-subscription` | `wg_events`, `calendar_subscriptions` |
| Chat (`chat`) | `features/chat` | `chat` | `wg_chat_messages`, `wg_chat_reactions`, `wg_chat_reads`, `wg_chat_mentions` |
| Aktivität (`activity`) | activity (`composition/activity.ts`) | `activity` | `audit_events` |
| Einstellungen (`settings`) | settings | `notifications`, `export`, ... | |

"Erinnerungen" for chores and events are push notifications sent by the `chore-reminders` and
`event-reminders` crons, not the `reminders` API.

## Decisions on trust, retention and exposure

These behaviors are deliberate.

- **Expenses run on household trust.** A member may log an expense paid by someone else only while
  carrying a positive share themselves (`features/expenses/paid-by-guard.ts`); any debtor may remove
  an expense or mark their own share settled. The audit trail records who did it. Stricter rules
  (payer confirmation) would end the "log it for a flatmate" flow and are not planned.
- **Edit rights.** Editing an expense is payer-only; removing is payer or any debtor. The UI offers
  only what the server accepts (`ExpenseRow`).
- **Account deletion keeps names.** The member leaves like an "Auszug": login link and push
  subscriptions are removed, the display name stays on past entries so that balances, chat and
  history of the remaining flatmates stay understandable. The name is a household-internal label, not
  an account identifier. Changing this is a legal decision, not a technical one.
- **Activity feed.** Every member reads it. Private details (one person's quiet hours, push opt-in,
  the creation-time share code) are removed before the response (`core/audit-visibility.ts`).
- **Member names** are unique ignoring case among active members. A moved-out member who holds a name
  a current member wants is renamed to "Name (2)", numbered, with no language in the stored name. The cap of 20 counts active members only.
- **Time zones.** Event times are entered and shown in the device's zone; repeats, reminders and the
  calendar feed follow Berlin wall time. A device elsewhere gets a notice on the calendar page
  (`TimeZoneNotice`). Pinning every display to Berlin would change the month grid, the agenda and
  all-day handling together and is not planned.
- **One date of a series.** A repeating event keeps its removed dates as `EXDATE=` in the rule
  (`features/events/event-recurrence-rule.ts`, capped by `MAX_EXDATES`); changing one date removes it
  and creates a single event in one transaction (`POST /events/[id]/occurrence`). Removed dates still
  count toward `COUNT`.
- **Import.** Duplicates are counted, not collapsed: the n-th identical row of a file is skipped only
  while the WG already holds n of them. An import can be taken back by the member who ran it or an
  admin until any of its shares is settled.
- **Fixed-cost cents.** An even split's extra cents move on to another member with every booking
  (`recurring-split-rotation.ts`); uneven custom splits stay as entered.
- **Uploads.** Pictures that no row points at after 14 days are removed from the private bucket by
  the maintenance cron, a few WGs per run.
- **Signing secret rotation.** `MEMBER_SESSION_SECRET_PREVIOUS` keeps calendar feed URLs and
  unsubscribe links valid while the secret changes.
- **Session JWT verified locally.** `readVerifiedUser` (`core/auth/verified-user.ts`) checks the
  session JWT with `getClaims` instead of a Supabase round trip per request. The cost is that a
  revoked session ("sign out on all devices") or a deleted account stays valid on other devices
  until the access token expires, about 1 hour (Supabase default). The database lock after account
  deletion is unaffected by this.
- **Preview limiter.** A configured rate limiter that fails does not pass traffic on Preview; an
  unconfigured one still does (fixtures, local runs).
