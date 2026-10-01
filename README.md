# ManaWG App

Mobile-first shared household app: expenses, recurring costs, shopping, chores,
inventory, calendar, chat and notices. This repository contains the Next.js app
in `apps/web`; the marketing website has its own repository.

## Local development

Use **Node 22.x** and **pnpm 9.x** (`pnpm@9.0.0` is pinned).

```sh
pnpm install --frozen-lockfile
cp apps/web/.env.example apps/web/.env.local
pnpm dev
```

Configure `.env.local` with local or dedicated development services before
testing authenticated, persistent workflows. The template documents the keys;
it does not provision Supabase, PostgreSQL, storage or notification services.
Keep credentials out of Git. See [environment separation](docs/releases/external-prerequisites.md)
before working with hosted environments.

## Where code belongs

| Directory | Responsibility |
| --- | --- |
| `apps/web/src/app` | Next.js pages, layouts and HTTP route handlers |
| `apps/web/src/features` | Domain logic and UI for the seven household features |
| `apps/web/src/core/auth`, `guards`, `db`, `infra` | Authentication, authorization, persistence and external services |
| `apps/web/src/core/reads` | Product projections combining several domains, such as dashboard, search and export |
| `apps/web/src/core/offline` | Persisted local actions, attachments and replay |
| `apps/web/src/components/ui` | Shared UI primitives |
| `apps/web/src/components/wg` | WG shell and reused household UI |
| `apps/web/src/shared` | Theme, CSS, small shared utilities and PWA components |
| `apps/web/drizzle` | Database migrations and schema history |
| `docs`, `openspec` | Design, dated verification evidence and change proposals |

Pages compose existing domain functions; server mutations authorize the current
member, validate input and preserve transaction/idempotency boundaries. The
feature-boundary check forbids direct imports between features. Cross-domain
reads are deliberate composition, so that check alone does not prove complete
domain isolation.

## Verification

```sh
pnpm --filter @manawg/web lint
pnpm typecheck
pnpm --filter @manawg/web test:unit
E2E_PORT=3101 pnpm --filter @manawg/web test:e2e:fixtures --retries=0
pnpm build
pnpm --filter @manawg/web bundle:check
```

The fixture command starts an isolated local build with database/provider
credentials disabled. It proves simulated browser behavior, not real storage,
payments, mail, push delivery or hosted authorization. Opt-in live/database
tests may be skipped. `pnpm test` runs Playwright; it does **not** include the
separate Node `test:unit` suite. Build before running the bundle check.

CI and hosted release procedures are in [the workflow](.github/workflows/ci.yml)
and [release evidence](docs/releases/release-candidate.md). Each release requires
fresh evidence for its own commit; historical green checks are not a release gate.

## Design and review

[Brandbook v1.0](docs/brand/brandbook.html) is the visual source of truth.
[Implementation rules and source resolutions](docs/brand/design-language.md)
connect it to the shared theme, components and brand assets. Verify changed UI
at 320px in light/dark and with enlarged text.

The [2026-09-26 deep review](docs/audits/2026-09-26/README.md) records the examined
snapshot, source coverage, reproduced bugs, local corrections and remaining
design decisions. Its findings and test results are dated evidence.
