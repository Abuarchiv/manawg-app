# Development

Reference for working on the code. Start with [CONTRIBUTING.md](../CONTRIBUTING.md) for the
workflow and conventions, and [architecture](architecture.md) for how the app is built.

The stack: Next.js 16 App Router, React 19, Supabase Auth, PostgreSQL via Drizzle, Tailwind 4
with shadcn/Base UI, Playwright and `node:test`.

## Layout

```text
apps/web/
  src/app/        routes only: pages, layouts, API handlers (thin, call core/features)
  src/core/       domain-neutral building blocks: db, auth, guards, http, hooks, offline, sync, notifications, infra,
                  utils, validators, i18n (server-side translation), mail (SMTP/Resend transport, templates)
  src/composition/ cross-feature reads (dashboard, activity, export)
  src/features/   vertical slices (chat, chores, events, expenses, inventory, announcements, shopping)
                  a feature may import core/, shared/ and itself, never another feature
                  features/<x>/server/ holds database and server-only code (import 'server-only')
  src/components/ reusable UI: ui/ (shadcn), animate-ui/ (motion variants), app/ (shell, PWA, theme), wg/ (WG-wide),
                  auth/ (sign-in, sign-up, password-reset forms), brand/ (splash screen), entry/ (signed-out entry app, WG welcome)
  src/fixtures/   in-memory fixture build for e2e (see Fixture mode); only src/app/ imports it
  src/shared/     framework-light utilities (lib/, i18n/, fonts, css): theme, brand, analytics
  public/         static files: PWA manifest, service worker, icons, mail images
  drizzle/        SQL migrations (`pnpm --filter @manawg/web db:generate` / `db:migrate`)
  e2e/            Playwright specs (fixture mode needs no database)
  tests/          node:test suites that are not colocated with a module
  scripts/        CI gates (architecture, bundle budget, analytics privacy, preview/release workflow checks), the migrator
                  (`db-migrate*`), `selfhost/` (Docker setup and cron) and `real-stack/` (see below)
  components.json shadcn registry configuration
  vercel.json     cron schedule and settings for Vercel deployments
  playwright*.ts  Playwright configs: default, and WebKit against the fixture build
docs/             architecture, self-hosting, backup and recovery, brand/ (design language, English glossary)
docker/           self-hosting stack: setup, gateway, backup, restore and smoke test (with compose.yaml)
supabase/templates/  Auth mail templates (HTML, subjects) used by the Docker stack and hosted Supabase
scripts/          maintenance scripts: `generate-brand-assets.mjs` (icons from the brand mark),
                  `supabase-auth-templates.mjs` (push the mail templates to a hosted Supabase project)
.github/          CI workflows, issue and PR templates
openspec/         behaviour specs per capability
```

Root files: `compose.yaml` and `Dockerfile` (self-hosting image), `biome.json` (lint and format),
`knip.json` (unused code check), `.vercelignore`.

## Prerequisites

- Linux, macOS, or Windows via WSL2; the package scripts assume a POSIX shell.
- Node 22 (`.nvmrc`, `engines.node: 22.x`).
- pnpm 9.0.0 (`packageManager: pnpm@9.0.0`; `corepack enable` picks it up).
- Nothing else for fixture mode (`dev:fixtures`, see [Fixture mode](#fixture-mode-no-database)).
- For sign-in and a real database: Docker for the [self-hosting stack](self-hosting.md#docker), or
  a Supabase project of your own that serves no users.

## Local setup

```sh
pnpm install
pnpm --filter @manawg/web dev:fixtures         # http://localhost:3000, needs no .env.local
```

`dev:fixtures` serves sample WGs from memory (see [Fixture mode](#fixture-mode-no-database)).
For anything behind sign-in, run against a real backend: your own Supabase project with
`pnpm dev`, or the Docker stack (`docker compose up -d --build`, no hot reload) from the
[self-hosting guide](self-hosting.md#docker).

```sh
cp apps/web/.env.example apps/web/.env.local   # only for a real backend
pnpm dev                                       # http://localhost:3000
```

Minimum variables in `apps/web/.env.local` (`checkEnv` in `src/core/infra/env.ts`, logged once at boot):

| Variable | Why |
| --- | --- |
| `POSTGRES_URL` (or `DATABASE_URL`) | Runtime database. Remote URLs need an explicit port; TLS is enforced (`src/core/db/connection.ts`). |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase Auth. Without them every `/wg/*` page redirects to `/login`. |
| `MEMBER_SESSION_SECRET` | Signs calendar feed URLs and unsubscribe links (`openssl rand -hex 32`). Not used for normal API access. Rotate by moving the old value to `MEMBER_SESSION_SECRET_PREVIOUS`, so existing feeds and links keep working. |

In production `SUPABASE_SERVICE_ROLE_KEY` is also required (account deletion, Supabase image storage).

Optional features degrade when unset and are reported as `[env] DEGRADED ...`: Upstash rate
limiting (`UPSTASH_REDIS_REST_*`, fails open outside production), Web Push (`VAPID_*`,
`NEXT_PUBLIC_VAPID_PUBLIC_KEY`), image uploads
(`SUPABASE_STORAGE_BUCKET` with `SUPABASE_SERVICE_ROLE_KEY`). Every variable the app reads is described in `apps/web/.env.example`. Variables
that only CI and test runs use are listed under [Opt-in test gates](#opt-in-test-gates). Never
commit or print env values.

### Database migrations

```sh
DATABASE_MIGRATION_URL=... pnpm --filter @manawg/web db:migrate   # apply pending migrations
DATABASE_MIGRATION_URL=... pnpm --filter @manawg/web db:check     # verify schema + ledger only
```

`scripts/db-migrate.mjs` does not read `.env` files; export the variable in the shell. It
resolves `DATABASE_MIGRATION_URL` first (then `POSTGRES_URL`/`DATABASE_URL`, then the
non-pooling pair) and only accepts a Supabase session connection on port `5432` (direct host `*.supabase.co` or the
session pooler `*.pooler.supabase.com`), with `sslmode` as the only query parameter. The
transaction pooler port `6543` is rejected.
The Docker stack migrates itself on every start (`scripts/selfhost/setup.mjs` with
`MANAWG_SELF_HOSTED=true`, which only skips the Supabase URL check; the server still needs the `anon` and `authenticated` roles, which the stack's `supabase/postgres` image provides).

New migrations: edit the table definition in `src/core/db/schema/` (`schema.ts` re-exports those files) or in one of the
`src/core/db/schema-*.ts` files (inventory, invites, mail log, statement emails), then run `pnpm --filter @manawg/web db:generate`
(drizzle-kit; `drizzle.config.ts` lists every schema file and loads `.env` via `dotenv/config`).

### Fixture mode (no database)

The app can run against in-memory fixtures from `src/fixtures/` (two fixture WGs, share codes
`MTE8PZAT` and `SMKETEST`). `isE2EDbDownMode()` (`src/fixtures/mode.ts`) only switches on when all
of these hold: `E2E_FIXTURE_MODE=true` (or `NODE_ENV=test`), `NEXT_PUBLIC_DB_DOWN=true`,
`CI=true`, `VERCEL` not `1`, `VERCEL_ENV` not `production`, and neither `POSTGRES_URL` nor
`DATABASE_URL` set. It trusts the plain `x-manawg-expected-member-id` header without real
authentication, so it can never activate on a Vercel deployment. `test:e2e:fixtures` sets all of
this and builds an isolated server on port `3101` (`E2E_PORT`). `pnpm --filter @manawg/web
dev:fixtures` sets the same for `next dev` on port `3000`: open
[localhost:3000/wg/MTE8PZAT](http://localhost:3000/wg/MTE8PZAT) to click through a sample WG.
Sign-in and saving to a database are not available there.

Only `src/app/` (including `src/proxy.ts`) imports `src/fixtures/`, through one seam per
entry: `resolveFixtureRequest` in the proxy (`src/proxy.ts`) answers fixture API reads and `POST /api/wg`
before any route runs, `loadFixtureWgView` feeds the WG layout and chat page,
and the WG layout hands the first fixture member to the provider as the initial identity, without
`authUserId`: the provider is not server-verified there and confirms the account through the member
lookup like in the app. The fixture API answers as the account `FIXTURE_AUTH_USER_ID`
(`src/fixtures/data.ts`): `GET /api/wg/[code]` reports it as `authUserId` and `GET /api/wg/mine`
lists the fixture WGs. The API client needs no fixture switch: it always sends
`x-manawg-expected-member-id`, which the fixture API reads as the caller. Core, components and features receive plain options (`requireWgSignIn`)
and never see fixture mode. Specs that seed the offline queue or open `/offline` before visiting a
WG store that account as `manawg_account` first (`seedLocalAccount` in `e2e/support/helpers.ts`).

## Texts and translations

User-facing text lives in `apps/web/src/shared/i18n/messages/{de,en}/*.ts`, never in components,
and every key needs both locales. English wording follows the
[English glossary](brand/glossary-en.md). The `i18n-literal` check in
`apps/web/scripts/check-architecture.mjs` fails on German UI copy outside the catalogs;
`// i18n-ignore <reason>` is only for technical literals such as stored keys. Server texts (push,
mail, export, activity feed) are written in the recipient's language. `tests/i18n-catalog.test.ts`
(part of `pnpm test:unit`) enforces equal keys and ICU argument names in both locales.

## Commands

```sh
pnpm install
pnpm dev                          # http://localhost:3000
pnpm lint                         # biome (whole repo) + architecture and wg-auth-invariant checks
pnpm --filter @manawg/web lint   # the same two checks, with biome limited to the web package
pnpm typecheck                    # runs next typegen first
pnpm --filter @manawg/web test:unit
pnpm build
pnpm --filter @manawg/web exec playwright install chromium   # once per machine
pnpm --filter @manawg/web test:e2e:fixtures   # full Playwright suite against a fixture build
```

The Playwright browser install is needed once per machine (on Linux use `--with-deps`). The
fixture suite builds the app first and takes a few minutes.

More scripts in `apps/web/package.json`:

| Command | What it runs |
| --- | --- |
| `pnpm test` (root) | The unit tests (`test:unit`); Playwright is `pnpm e2e` (dev server with your `.env.local`) |
| `pnpm --filter @manawg/web test:unit` | `node --test` over `src/**/*.test.mjs`, `src/**/*.test.ts` and `tests/*.test.ts` |
| `pnpm --filter @manawg/web dev:fixtures` | `next dev` in fixture mode, no database |
| `pnpm --filter @manawg/web test:e2e:fixtures` | Playwright against a production build in fixture mode (install Chromium once, see above) |
| `pnpm --filter @manawg/web test:e2e:webkit` | The fixture suite on WebKit (`playwright.webkit-fixtures.config.ts`); run weekly by `webkit.yml`, needs `playwright install webkit` once |
| `pnpm --filter @manawg/web test:e2e:account-delete-db` | Account deletion against a disposable loopback Postgres in `ACCOUNT_DELETE_TEST_URL` |
| `pnpm --filter @manawg/web test:db` | Database-backed unit tests against the loopback Postgres in `TEST_DATABASE_URL` (exits 2 when it is unset) |
| `pnpm --filter @manawg/web test:db-timeouts` | Runtime pool timeouts against a throwaway local Postgres (`RUN_DB_TIMEOUT_INTEGRATION=1` is set by the script) |
| `pnpm --filter @manawg/web bundle:check` | Bundle budget (`scripts/check-bundle-budget.mjs`, needs a build) |
| `pnpm --filter @manawg/web analytics:check` | PostHog privacy contract (`scripts/check-analytics-privacy.mjs`) |
| `pnpm --filter @manawg/web analyze` | Build with the Next bundle analyzer |

### Real-stack checks and previews

Scripts that drive a production build against a local Supabase stack (sign-in, mails, every
module, fuzzing, load) are described in
[`apps/web/scripts/real-stack/README.md`](../apps/web/scripts/real-stack/README.md). They are
not part of CI.

To look at the Auth mail templates while you change them, run `node supabase/templates/preview.mjs`
(usage in the first lines of the file).

### Opt-in test gates

These tests skip themselves unless their variable is set. `pnpm test:unit` and `test:e2e:fixtures` never set them, because each needs something those lanes do not provide: a database, a public network, or real credentials. The database suites run in their own workflow (`.github/workflows/database.yml`) against a PostgreSQL service. Locally, `node scripts/test-db-setup.mjs <url>` (from `apps/web`) prepares a fresh loopback database for them: the Supabase roles, a minimal `auth` schema and every migration. The auth UI specs (`e2e/auth-ui.spec.ts`) are not gated: `test:e2e:fixtures` starts a second fixture server on `E2E_PORT` + 1000 built with a fake Supabase project (the specs answer its `/auth/v1` and `/api/auth` requests through page routes), so they run in CI.

| Variable | Enables | How to run | Why not in CI |
| --- | --- | --- | --- |
| `TEST_DATABASE_URL` | `tests/statement-run-ledger.test.ts`, `tests/db-connection.test.ts` (live transaction check), `src/core/db/private-image-deletions.test.ts`, `tests/shopping-unique-index.test.ts`, `tests/expense-member-lock.test.ts` and `tests/selfhost-image-origin.test.ts` | `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/manawg_test pnpm --filter @manawg/web test:db`. The URL must be a disposable loopback Postgres prepared with `scripts/test-db-setup.mjs` | Runs in `database.yml` |
| `RUN_DB_TIMEOUT_INTEGRATION` | The pool timeout case in `tests/runtime-pool.test.ts` | `pnpm --filter @manawg/web test:db-timeouts` (needs `initdb` and `pg_ctl` on the PATH and a non-root user) | Runs in `database.yml` |
| `ACCOUNT_DELETE_TEST_URL` | `e2e/account-delete-db-*.spec.ts` (account deletion against real data) | `ACCOUNT_DELETE_TEST_URL=postgresql://postgres@127.0.0.1:55432/manawg_test pnpm --filter @manawg/web test:e2e:account-delete-db` (loopback host and explicit port required) | Runs in `database.yml` |
| `OCR_RUNTIME_E2E` | The real Tesseract worker proof in `e2e/expense-ui-form.spec.ts` | `OCR_RUNTIME_E2E=true pnpm --filter @manawg/web test:e2e:fixtures e2e/expense-ui-form.spec.ts` | Needs no network: the worker, WASM core and models come from the app's `public/tesseract` (copied from `node_modules` by `next.config.ts`) |

`test:e2e:fixtures` and `dev:fixtures` set the fixture-mode variables themselves, so you never export them: `E2E_FIXTURE_MODE` and `NEXT_PUBLIC_E2E_FIXTURE_MODE` (`true`) and `NEXT_PUBLIC_DB_DOWN` (`true`, see [Fixture mode](#fixture-mode-no-database)). `E2E_PORT` (default `3101`) is the port of the fixture suite; set it to run the suite next to another server, for example `E2E_PORT=3221 pnpm --filter @manawg/web test:e2e:fixtures`. `BASE_URL` defaults to `http://localhost:$E2E_PORT`.

### Checks against a deployed instance (maintainers, optional)

Contributors need no Vercel or Supabase account for any of these. The specs run against a hosted deployment with real Supabase, and stay off unless you set them.

| Variable | Enables | How to run | Why not in CI |
| --- | --- | --- | --- |
| `PREVIEW_E2E` | `e2e/preview-protection.spec.ts` and the Preview branches of `e2e/smoke-launch.spec.ts` | Set by the `e2e-preview` job in `.github/workflows/ci.yml` against a trusted Vercel Preview URL (`BASE_URL`) with `VERCEL_AUTOMATION_BYPASS_SECRET` | Needs a deployed, protected Preview and the bypass secret |
| `REAL_PRODUCT_E2E` | The real-account path of `e2e/smoke-launch.spec.ts` | Same job as `PREVIEW_E2E`, or locally against a hosted `BASE_URL` with the `E2E_SUPABASE_*` credentials | Needs a hosted deployment and a real test account |
| `PUBLIC_ENTRY_E2E` | `e2e/public-entry-live.spec.ts` (hosted public entry) | `BASE_URL=<hosted origin> PUBLIC_ENTRY_E2E=true pnpm --filter @manawg/web exec playwright test public-entry-live.spec.ts` | Needs a deployed app on real Supabase |
| `AUTH_LIVE_E2E` | `e2e/social-login-live.spec.ts` (OAuth callback errors) | `BASE_URL=<hosted origin> AUTH_LIVE_E2E=true pnpm --filter @manawg/web exec playwright test social-login-live.spec.ts` | Needs a deployed app on real Supabase |
| `SUPABASE_AUTH_LIVE_E2E` | `e2e/supabase-auth-live.spec.ts` (live sign-in and session checks; needs `SUPABASE_AUTH_TEST_EMAIL`, `SUPABASE_AUTH_TEST_PASSWORD` and the member WG variables) | `BASE_URL=<hosted origin> SUPABASE_AUTH_LIVE_E2E=true pnpm --filter @manawg/web exec playwright test supabase-auth-live.spec.ts` | Needs a deployed app and real test credentials |
| `SUPABASE_AUTH_PASSWORD_RESET_SMOKE` | The no-session password reset page check in `e2e/supabase-auth-live.spec.ts` (sends no e-mail) | `BASE_URL=<hosted origin> SUPABASE_AUTH_PASSWORD_RESET_SMOKE=true pnpm --filter @manawg/web exec playwright test supabase-auth-live.spec.ts` | Needs a deployed app on real Supabase |

| Variable | Used for |
| --- | --- |
| `BASE_URL` | Origin of the deployed instance the specs above run against |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Lets the specs pass the deployment protection of a Vercel Preview |
| `E2E_SUPABASE_URL`, `E2E_SUPABASE_PUBLISHABLE_KEY`, `E2E_SUPABASE_TEST_EMAIL`, `E2E_SUPABASE_TEST_PASSWORD` | Project and disposable test account for the real-account path of `smoke-launch.spec.ts` |
| `SUPABASE_AUTH_TEST_EMAIL`, `SUPABASE_AUTH_TEST_PASSWORD`, `SUPABASE_AUTH_TEST_MEMBER_WG_CODE`, `SUPABASE_AUTH_TEST_MEMBER_NAME`, `SUPABASE_AUTH_TEST_MEMBER_INVITE_TOKEN` | Test account and member WG for `supabase-auth-live.spec.ts` |

The `e2e-preview` job of the CI workflow sets the six gate variables to `true`. While the repo variable `PREVIEW_GATE` is `on`, the Preview jobs (`preview-source`, `db-supabase-preview`, `e2e-preview`) migrate and test the Preview deployment of the current `main` tip.

## Quality gates

CI (`.github/workflows/ci.yml`, job `validate`) runs, in this order:

1. `pnpm install --frozen-lockfile`
2. `pnpm audit --prod --audit-level high`
3. `pnpm lint`
4. `pnpm knip` (unused files, exports and dependencies; config in `knip.json`)
5. `pnpm --dir apps/web analytics:check`
6. `pnpm --filter @manawg/web exec node scripts/check-architecture.mjs`
7. `pnpm --filter @manawg/web exec node scripts/check-wg-auth-invariant.mjs`
8. Schema drift check: `db:generate` must not produce a new migration from the committed schema
9. `pnpm typecheck` (app, plus `tsconfig.e2e.json` for `e2e/`, `tests/*.test.ts` and Playwright configs)
10. `pnpm --filter @manawg/web test:unit`
11. `TZ=Pacific/Kiritimati pnpm --filter @manawg/web test:unit` (the same unit tests in UTC+14, so date code must not depend on the host time zone)
12. `pnpm build`
13. `pnpm --filter @manawg/web bundle:check`

`validate` runs on every PR (drafts and docs-only PRs included) and every push to `main`. Job
`e2e-fixtures` (`test:e2e:fixtures`, Chromium) runs on every non-draft PR and every push to
`main`. Dependabot (`.github/dependabot.yml`) opens one grouped minor/patch PR per week and
ecosystem (npm, GitHub Actions, Docker) and a separate PR per major update; third-party actions
are pinned by commit SHA. Workflow `database.yml` runs the database suites from the table above
against a PostgreSQL service on every PR and every push to `main`. Workflow `webkit.yml` runs
`test:e2e:webkit` weekly and on demand.

Workflow `security.yml` runs Trivy over the lockfile, the Dockerfile and the tree (known
vulnerabilities, misconfigurations, secrets) on every PR, on `main` and weekly. Workflow
`docker.yml` builds the self-hosting image and scans it with Trivy when a PR touches the image
inputs, and the release scan blocks the push of a vulnerable image; `scorecard.yml` publishes the OpenSSF Scorecard.

Run the same gates locally before you open a pull request.

## Cron jobs

Defined in `apps/web/vercel.json` (UTC schedules), which Vercel reads and the `cron` container of
the Docker stack follows (`scripts/selfhost/cron.mjs`). Every route requires
`Authorization: Bearer $CRON_SECRET` (`src/core/infra/cron-auth.ts`): without `CRON_SECRET` it
answers `503 cron_secret_missing`, with a wrong header `401`.

| Path | Schedule | Does |
| --- | --- | --- |
| `/api/cron/maintenance` | `45 4 * * *` | Purges expired `idempotency_responses`, retries pending account deletions, deletes tombstoned private images from Supabase Storage. |
| `/api/cron/recurring-advance` | `10 6 * * *` | Turns due, unpaused recurring-expense templates into expenses (max 500 per run, batches of 10) and advances them. |
| `/api/cron/chore-reminders` | `0 8 * * *` | Push reminders for assigned chores due today or overdue up to 7 days (18 h throttle per chore, max 500). |
| `/api/cron/event-reminders` | `0 9 * * *` | Push reminders for calendar events (including recurring occurrences) starting tomorrow (Berlin day). |
| `/api/cron/monthly-statements` | `0 7 1-5 * *` | Mails the statement of the finished month. Day 1 sends; days 2–5 retry what failed or was deferred by the provider quota. |

## Troubleshooting

| Symptom | Cause / check |
| --- | --- |
| `/api/health` returns 503 `degraded` | `missingRequiredCount > 0` or `database: unreachable`. Variable names are only in the boot log line `[env] MISSING REQUIRED: ...` (`src/instrumentation.ts`), never in the response. |
| API answers `503 rate_limiter_unavailable` | Limiter fails closed when `VERCEL_ENV=production` or `NODE_ENV=test` and Upstash is missing or erroring, or when only one of the two Upstash variables is set (`src/core/rate-limit.ts`). Set `UPSTASH_REDIS_REST_URL` (https) and `UPSTASH_REDIS_REST_TOKEN`, or leave both unset on a standalone server, which then counts in memory. |
| Writes answer `403 cross_origin_blocked` | Middleware requires a same-origin `Origin` header on mutating requests to the matched API paths (`/api/wg`, `/api/account`, `/api/auth/*`, `/api/upload/*`, ...). |
| Writes and crons answer `503 migration_read_only` | `MIGRATION_READ_ONLY=true` is set (migration window). |
| Cron answers `503 cron_secret_missing` / `401` | `CRON_SECRET` unset / wrong bearer header. |
| Image upload or read answers `503 feature_disabled` | Storage variables missing, or the bucket is not private with an 8 MiB limit and exactly the allowed image MIME types (`src/core/infra/private-image-policy.ts`). |
| Fixture E2E hits the real app instead of fixtures | A fixture condition is missing (e.g. `VERCEL=1` or `POSTGRES_URL` exported in the shell). Use the `test:e2e:fixtures` script. |
| `db:migrate` rejects the URL | Not a Supabase session connection on port `5432`, port `6543`, missing `sslmode`, or extra query parameters. Other PostgreSQL servers need `MANAWG_SELF_HOSTED=true` and must have the `anon` and `authenticated` roles. |
