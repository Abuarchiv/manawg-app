# ManaWG Release Candidate Evidence

This is a dated evidence log, not a standing release approval. Older branch names, candidate SHAs, and blockers describe only their recorded date.

Production migration requires a successful `push` run of `.github/workflows/ci.yml` for the exact current `main` candidate SHA, with both `validate` and `e2e-fixtures` successful. A read-only Actions API preflight verifies this before the workflow enters the protected Production environment; the separate exact-SHA Preview evidence and explicit confirmation remain required.

## Readiness audit — 2026-09-25

**Not approved for another release.** The current local fixes are uncommitted on base SHA `1250ae33cfcad2412518b65fb90f7e62be3c774b` and have no exact-SHA hosted proof. Node 22 local checks passed: lint, typecheck, production build, 130 unit tests, and 311 fixture E2E tests (38 hosted cases skipped, no failures or flakes). These results do not establish Preview or Production behavior.

Local production-mode visual audit covered 20 route/viewport/theme combinations at 320/390 px in light/dark: no horizontal overflow or CSP errors; bottom navigation touch regions stayed at least 44 px. The error-report mail link was keyboard reachable. This fixture did not contain realistic dashboard data and is not a real-device or resident acceptance test.

Push CI run `36120001487` passed for the base SHA, including the Preview DB migration/schema gate, but `e2e-preview` was skipped. GitHub's deployment list returned no record for that SHA; a separate Vercel readback resolves `app.manawg.com` to READY Production deployment `dpl_ETw3Ygdk21Kc6e7GWEgCSx2PSCxm`, whose GitHub source metadata names base SHA `1250ae3`. Production `/api/health` returned HTTP 200 for that base deployment. None of this validates or deploys the uncommitted local fixes.

Current provider readback: Supabase Production and Preview are `ACTIVE_HEALTHY` on Free, with `backups:[]` and `pitr_enabled:false`; there is no provider-selected recovery point. A user-authorized free logical Production export now exists in a private `0700` directory on the FileVault-protected local Mac. The four SQL files and manifest are `0600`; hashes and structural counts were independently reviewed. This is **one local snapshot**, with no offsite copy, recurring schedule, approved numeric RPO/RTO, or isolated hosted restore.

The logical export contains public app schema/data, Auth rows, Storage metadata, and the 16-entry Drizzle ledger. Storage metadata had zero objects and current app rows had no image references. A no-network, RAM-only Supabase PostgreSQL 17 import succeeded into a fresh local database: all 61 COPY-section row counts, public money totals, ledger, RLS flags, selected grants, and Auth/member/expense references matched. The container was removed. This is **preliminary local import proof**, not hosted service recovery, offsite safety, Auth login, Storage-byte recovery, or measured RTO. An earlier disposable `db:migrate`/`db:check` trial correctly stopped at their direct-Supabase connection guard; that guard was not changed. Production Security Advisor still reports Leaked Password Protection disabled, which requires Pro or higher. Auth SMTP and actual mail receipt remain unverified; Vercel drains are empty, runtime-log APIs returned 403, and no alert receipt or on-call acknowledgement was proven.

External feature readback: PayPal client/secret/partner environment variables are absent from both Vercel environments, so its payment button is unavailable; no hosted sandbox order-to-settlement proof exists. Push keys, storage, Upstash, and reminder Cron definitions are present, but current-device delivery, receipt access, rate-limit behavior, and Cron execution remain unproven. iOS/Android installation, offline recovery, calendar subscription, and import/export still need current-candidate real-client/hosted checks. A prior Storage upload proof belongs to an older SHA.

Before release: make one reviewable candidate SHA; complete its protected Preview/authenticated privacy and product checks; establish and drill a recovery point; verify Auth mail and alert delivery; close device/resident and external-provider gates in `TASKS.md`. Keep the historical release entry below separate from this new candidate.

## Production release — 2026-09-25

`https://app.manawg.com` serves `main` candidate `8111767`. The `deployment_status` run `36100090000` for that exact SHA succeeded, including `db-supabase-preview` and `e2e-preview`. The Production migration ledger has 16 entries (through `0015`), matching the journal on `main`; these migrations were applied manually, outside `migrate-production.yml`, because the Production environment has no `DATABASE_MIGRATION_URL` secret. `/api/health` returned OK after the deploy. The Supabase organization reports the Free tier. Provider backup/PITR settings, completeness of the reported local export, Resend SMTP configuration, and end-to-end auth mail delivery have not yet been independently verified. The earlier BLOCKED entries below are historical.

## Read-only evidence update — 2026-09-24

For the then-current main candidate `7192dd443efee1b06d5b37942d89800b26d14bd9`, GitHub Actions push-CI run `36021471267` succeeded. `validate`, `e2e-fixtures`, and `db-supabase-preview` succeeded, including both `Apply pending Preview migrations` and `Verify Preview schema and migration ledger`; `e2e-preview` was skipped. This run does not provide hosted browser E2E proof for that candidate. The SQLSTATE `42501` report below is historical and is not evidence of a current Preview DDL blocker; no new `deployment_status` check is claimed here. No Production migration, deployment, or data change was performed.

Lockfile audit on 2026-09-24: `pnpm audit --prod` reported zero advisories; the full audit reported one moderate, dev-only `esbuild@0.18.20` advisory through `drizzle-kit` ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) and no high/critical findings. The advisory concerns esbuild's development server; no tracked app or CI command starts that server. Do not force a transitive override; review by 2026-10-24 or upon an upstream fix.

## Aktualisierung — 2026-09-22, Europe/Berlin

Der Release-Workflow ist auf den aktuellen Branch `fix/audit-158` gepusht. Anwendung/Test-Candidate ist `3abc5d9a1fefe55603067d872f476981289ee71f`; der spätere Branch-Tip enthält nur diese Evidenz-Aktualisierung. Pull Request #300 ist mergeable, aber wegen der geschützten Preview-Gates noch nicht freigabefähig. Die Vercel-Preview `https://manawg-eqqk2dsld-abditubes-projects.vercel.app` (`dpl_uwtuk6ewXfC1BdRXERmvXLxxjx2j`) ist mit Node 22 READY.

- GitHub-Preview-Secrets sind vorhanden; Werte wurden nicht ausgegeben.
- Der Node-22-`validate`-Job für den Candidate-Stand ist erfolgreich (`35663607827`); die Fixture-Suite ist mit 180 bestanden und 28 übersprungen grün. Fixture-E2E lief separat; ein Fixture-Erfolg ersetzt keine Hosted-Evidenz.
- Der damalige vertrauenswürdige Deployment-Status-Lauf `35663737497` stoppte vor Hosted-E2E: `db-supabase-preview` erreichte die Migration, scheiterte aber mit SQLSTATE `42501` (fehlende DDL-Berechtigung). `e2e-preview` wurde deshalb fail-closed übersprungen.
- Read-only Supabase-Katalogprüfung für Preview bestätigt: `manawg_preview_ci` hat `schema_create=false` auf `public` und `db_create=false`; bestehende Tabelle `public.wg_chat_messages` gehört `postgres`. Es wurde dabei keine SQL-Mutation ausgeführt.
- Die zwei historischen, bytegenau belegten Ledger-Hashes für 0007 und 0010 sind jetzt nur an ihren exakten Journalpositionen allowlisted; unbekannte Ledger-Zeilen bleiben fail-closed.

**Historischer Befund (2026-09-22; kein aktueller Preview-DDL-Status):** Der damalige Deployment-Status-Lauf `35663737497` scheiterte mit SQLSTATE `42501`; `e2e-preview` wurde übersprungen. Diese historische Fehlermeldung ist kein Nachweis eines aktuellen DDL-Blockers. Siehe den verifizierten Read-only-Push-CI-Lauf vom 2026-09-24 oben: Preview-Migration und Schema-/Ledger-Prüfung waren erfolgreich. Ein neuer `deployment_status`-Nachweis für Hosted-E2E liegt hier nicht vor; Production blieb unverändert.

## Aktualisierung — 2026-09-22, nach dem Fixture-Gate-Fix

Die CI-Regressionen waren testseitig: feste vergangene Chore-Zeitpunkte machten die Berlin-Fälligkeits-/Aktionsassertionen nach Mitternacht falsch, und ein visueller Screenshot nutzte einen lokalen absoluten Pfad. Die Fixtures verwenden jetzt den aktuellen Berlin-Kalendertag und Playwright-Artefaktpfade; der exakte Candidate-Lauf ist mit 180 Tests bestanden und 28 übersprungen grün. Zu diesem damaligen Stand galt die fehlende Preview-Owner-DDL-Berechtigung als Blocker; diese Aussage ist historisch und kein aktueller Preview-DDL-Status (siehe Evidenz-Update vom 2026-09-24 oben).

## Aktualisierung — 2026-09-20 20:10 CEST

Diese Evidenz ersetzt frühere Aussagen über fehlende GitHub-Preview-Secrets oder eine Freigabe anhand gleicher Git-Trees. Geschützte Preview-DB-/QA-Secrets sind eingerichtet; ein finaler vertrauenswürdiger Same-SHA-CI-Lauf fehlt weiterhin.

Storage-Preview: `7640b0c`, `dpl_AMnZJJnwwTRtzKMdJPcUwThdpYob`, https://manawg-m888bn03k-abditubes-projects.vercel.app. Native Vercel-Build mit Node 22 READY. Echte 8-MiB-Datei hochgeladen und byte-/SHA256-identisch gelesen (`55e348d20d20e12c5db5653ac1fad8cff4e340be835951378854db1b523db7c8`); Browser-Bilddekodierung bestanden. Eigener Zugriff erlaubt, andere WG/anonym/deaktiviertes Mitglied abgewiesen; Antworten enthalten nur JSON-Fehler, keine Bildbytes/Redirects. Provider verweigert Übergröße, unerlaubtes MIME und immutable overwrite; ursprünglicher Inhalt unverändert. Online-/Offline-UI-Integration ist damit noch nicht vollständig abgenommen.

Lokale Gates: 18 Storage-/Ledger-Tests bestanden; zuletzt 14 Release-/Limiter-Tests, Lint, Typecheck grün. Build/Bundle vor Middleware-Fix grün (102/120 kB). Hosted-Auth: vier gezielte Problemfälle plus Zwei-Nutzer-Privacy bestanden, Gesamtlauf zuletzt 22/27. Diagnose: ungültige temporäre WG-Codes und falsche Rate-Limiter-Klassifikation für `/api/wg/mine`; finaler erneuter Lauf steht aus.

Recovery-Schema/Daten lokal verifiziert, ACL-Differenz offen. Keine Provider-Recovery-/PITR-, Geräte- oder Residenten-Freigabe behauptet. Production unverändert.


Status: **BLOCKED — kein freigegebener Release-Kandidat**
Stand: 2026-09-20, Europe/Berlin
Checkout: `/Users/abu/Company/manawg-app`
HEAD: `cae9b0bf3f5e6e4a032933acc82fd7a99a301b96` (`main`)
Arbeitsbaum: dirty; kein Candidate-SHA eingefroren.

## Lokal verifiziert

Erneut geprüft am 2026-09-20, 16:54 CEST, mit Node 22.23.2 und pnpm 9.0.0:

- Typecheck, Lint und Feature-Boundaries: Exit 0.
- Production Build: Exit 0.
- Bundle: 102.0 kB shared first-load JS bei 120 kB Budget.
- Analytics Privacy: Exit 0.
- OpenSpec strict: 5/5.
- Fixture-E2E: 85 bestanden, 25 umgebungsabhängig übersprungen, keine Fehler. Die übersprungenen Live-Tests sind kein Auth-/Provider-Nachweis.
- Chat-Read-Recovery: 2/2 passed.
- Social-Login ohne Fixture-Modus: 7/7 bestanden (16:17 CEST), lokaler Server mit öffentlicher Preview-Supabase-Konfiguration; echte Auth-Settings und PKCE-Cleanup geprüft. Kein authentifizierter WG-/Hosted-Nachweis.
- Release-Workflow-Gates: 9/9 passed.
- `git diff --check`: Exit 0.
- Production Dependency Audit: keine bekannten High-Schwachstellen.

Der lokale Gate-Readback auf `cae9b0b` plus dirty Änderungen ist grün.

Unabhängiges Review der Änderungen an ChatView, MemberDeactivateDialog, ProfileTab,
Rate-Limits und Chat-Retry-Test: keine bestätigten Fehler. GitHub hatte zum Readback
keine offenen Issues oder Pull Requests. Beides ersetzt die unten offenen Live-Gates nicht.

## Behobene Root Causes

- Chat-Lesestatus bleibt bei Netzwerk-/503-Fehlern sichtbar und retrybar.
- Fire-and-forget-Fehler beim Auszug und in den PayPal-Profil-Einstellungen werden sichtbar behandelt.
- Vercel Preview behandelt fehlendes/ungültiges Upstash optional; Production bleibt fail-closed.
- Auth-Fehlerprecedence und Settlement-Cache-Header sind durch Regressionen belegt.
- App-Transaktionen beziehen ihre Verbindung aus Runtime-Variablen, nicht mehr aus DATABASE_MIGRATION_URL. Migrationskonfiguration bleibt unverändert. Vor Deployment müssen bestehende Runtime-Aliase gültige, dauerhafte Verbindungen enthalten.
- Der Ledger-Existenzcheck nutzt pg_catalog statt der rollenabhängigen information_schema-Sicht; fehlende Rechte können keine Baseline-Adoption auslösen.
- Drei Resolver- und drei Ledger-Regressionen bestanden. Echter Preview-Schreib-/Rollback-Test mit absichtlich ungültiger Migrations-URL bestand: temporäre Tabelle wurde zurückgerollt, gleiche pg_backend_pid vor/nach dem Fehler bestätigt.

## Preview-Live-Readback

- Supabase Preview `sthiwjebcwwiphashgla`: `ACTIVE_HEALTHY`.
- Repo-Migrationen `0010_enable_public_rls.sql`, `0011_explicit_member_roles.sql` und `0012_pale_drax.sql` wurden nach dem Restore im Preview angewendet.
- 26 öffentliche App-Tabellen haben RLS aktiv; direkte `anon`-/`authenticated`-Abfragen auf `public.wgs` werden mit `permission denied` abgewiesen.
- Keine Preview-Policies oder Rollen-Grants wurden ergänzt; das entspricht dem server-owned Access-Modell.
- Security Advisor: RLS-ohne-Policy ist INFO für das beabsichtigte Modell; Leaked-Password-Protection bleibt WARN.
- Exaktes `db:check` am 2026-09-20 16:40 CEST bestanden, einschließlich Schema, Security, Dateninvarianten, kanonischem Ledger und Transaktions-Rollback. Verbindung über autorisierte CLI-Anmeldung mit deren postgres-Rolle und TLS verify-full/Supabase-CA.
- Drizzle kannte 0000–0009; die bytegenau belegten, bereits über Supabase angewendeten Migrationen 0010–0012 wurden ausschließlich im Ledger ergänzt. Ein Rollback-Probelauf bewies unveränderte ursprüngliche zehn Rows; anschließend wurden genau drei Rows ergänzt.
- Sechs Hosted-Guest-/Auth-/Reset-Checks bestanden. Synthetischer Account und isolierte Test-WG wurden nach jedem Lauf entfernt; unabhängiger Readback: null Testaccounts und null Test-WGs. Der bisherige Deploy liefert bei POST-Mitgliedschaft 500 statt 409; der lokale Runtime-Fix benötigt einen neuen Preview-Deploy und Hosted-Nachweis. Revoked membership und Zwei-Nutzer-Privacy bleiben offen.
- Vercel CLI-Preview `https://manawg-qhpaco526-abditubes-projects.vercel.app` aus clean `main`-HEAD ist `Ready`; `vercel curl /api/health` meldet `database=ok`.
- Korrektur 2026-09-20 17:05 CEST: vercel env pull liefert Redaktionsmarker für sensitive Variablen, keine tatsächlichen Platzhalter. Vorhandene Vercel-Secrets werden im nativen Preview-Deploy genutzt; keine neue DB-Rolle oder Rotation nötig. CLI-Verifikation und dauerhafte CI-Konfiguration bleiben getrennte Nachweise.

## Weiter blockiert

- GitHub-Preview-Event/Candidate-SHA fehlt weiterhin: der alte PR-Deploy war SHA `44554575`, `main` ist `cae9b0b`; der neue CLI-Deploy hat kein GitHub-Deployment-Event.
- Dauerhafte CI-QA-Secrets fehlen; der manuelle Browserlauf verwendete kurzlebige Testaccounts mit anschließendem Cleanup.
- S3, Push, Kalender, PayPal, Import/Export, PWA und echte iOS-/Android-Geräte fehlen.
- Backup/PITR, RPO/RTO, Restore-Drill, Monitoring, Support-Ownership und Rollback fehlen.
- Production bleibt unverändert; dort wurde RLS im direkten Readback noch nicht aktiviert.

Keine Production-Migration, kein Push und kein Deployment wurden ausgeführt. Preview-Migrationen wurden ausschließlich im Preview-Projekt angewendet.

## Kontrollautomation

`manawg-release-control-2026-09-19` bleibt aktiv, alle 30 Minuten, isoliert, Astra High, ohne Zustellung. Der Job ist auf read-only umgestellt und darf keine Dateien mehr ändern.

## Nächster Nachweis

Candidate-SHA einfrieren, Preview mit bestehenden serverseitigen Secrets und zentralem Runtime-Fix deployen und vollständige Hosted-Mitgliedschafts-/Privacy-Gates prüfen. Redigierte CLI-Werte sind kein Beleg fehlender Secrets. Kurzlebige CLI-Logins nicht deployen. Provider-, reale Geräte-, Residenten- und Recovery-Nachweise bleiben separate offene Release-Gates.

## Implementierung 2026-09-20 19:28 CEST

- CI-Preview-Gate implementiert: Der Vercel-Commit wird in secrets-bearing Jobs nicht ausgecheckt oder ausgeführt. Nach `git fetch` wird nur sein Tree gegen den vertrauenswürdigen `main`-Tree verglichen; der Merge-Commit-Fall `44554575` → `cae9b0b` ist damit abgedeckt.
- Verifiziert: Release-Gate-Tests 11/11, Lint, Typecheck, Analytics, Feature-Boundaries, Build, Bundle 102/120 kB, Fixture-E2E Exit 0, Diff-Check 0. Preview: 26/26 Relationen RLS aktiv, `rls_disabled=0`; Vercel Health `status=ok,database=ok`.
- Release bleibt blockiert, bis `SUPABASE_PREVIEW_DATABASE_MIGRATION_URL` und `SUPABASE_AUTH_TEST_*` als geschützte GitHub-Secrets vorhanden sind. Production wurde nicht verändert.
