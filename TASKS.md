# ManaWG Release Readiness

## Aktuelle Freigabelage — 2026-09-25

- **Nicht release-ready.** Production zeigt den READY-Deploy von Basis-SHA `1250ae3`; die lokalen Korrekturen sind noch uncommitted und haben keinen exakten Hosted-Preview-Nachweis. Push, Merge und Deploy bleiben bis zur ausdrücklichen Freigabe gestoppt.
- Lokal mit Node 22 bestanden: Lint, Typecheck, Produktions-Build, Bundle-Budget, Analytics-Check, 130 Unit-Tests und 311 Fixture-E2E-Tests; 38 Hosted-Fälle wurden übersprungen. Der Produktionsmodus-Mobilcheck prüfte 20 Kombinationen bei 320/390 px in Hell/Dunkel ohne horizontalen Überlauf oder CSP-Fehler. Das ersetzt keine echten Geräte oder Residenten.
- Push-CI `36120001487` für Basis-SHA `1250ae3` bestand einschließlich Preview-DB-Migration und Schema-Check; `e2e-preview` wurde übersprungen. Die ältere Preview-DDL-Blockade unten ist **historisch**, kein aktueller Befund für diesen CI-Lauf.
- T8 offen: Supabase Free zeigt keinen Provider-Backup-Punkt und kein PITR. Ein autorisierter kostenloser Production-Export liegt lokal mit privaten Dateirechten; ein RAM-basierter PostgreSQL-17-Import hat Datenzahlen, Finanzsummen, Ledger und ausgewählte Rechte geprüft. Externe verschlüsselte Aufbewahrung, wiederkehrende Exporte, **hosted** Restore, genehmigte RPO/RTO, Mailzustellung, Alert-Empfang und Support-Owner bleiben unbelegt. Leaked Password Protection ist deaktiviert und erfordert laut Provider Pro oder höher.
- T4–T7 offen: aktueller Patch ohne authentifizierte Preview-Privacy-/Mehrnutzer-Abnahme; PayPal-Variablen fehlen in Preview und Production; Push/Cron, Storage-Nutzerfluss, Kalender, Import/Export und iOS-/Android-Verhalten brauchen aktuelle Hosted- oder Gerätebelege. Der genaue Stand steht in [docs/releases/release-candidate.md](docs/releases/release-candidate.md).

## Lokale Entwicklungsrunde — 2026-09-24, Europe/Berlin

- Arbeitsbaum auf `fix/audit-20260922-app` beibehalten; vorhandene WIP-Änderungen nicht zurückgesetzt oder committed.
- Verifiziert mit Node `v22.23.2`: `lint` (502 Dateien + Feature-Grenzen), beide Typechecks, `test:unit` (79 Node- und 56 Playwright-Tests), Build mit `NEXT_DIST_DIR=.next-final-validation`, `bundle:check` gegen denselben Build und `analytics:check` bestanden.
- Isolierte Fixture-E2E-Suite: 275 bestanden, 30 übersprungen, auf `E2E_PORT=3240`. Fixture-Build, Next-Webserver und Worker leeren DB-, Supabase-, Upstash-, AWS- und S3-Werte; der Port-Override erzwingt eine lokale `BASE_URL`.
- Der erste Fixture-Versuch erbte noch lokale Upstash-Zugangsdaten und erhielt HTTP 429; dabei können kurzlebige gemeinsame Rate-Limit-Zähler beeinflusst worden sein. Danach wurde die Fixture-Umgebung isoliert. Es liefen keine DB-Migrationen oder DB-Schreibzugriffe; Redis-Zähler wurden nicht manuell verändert.
- Lokaler Server läuft mit Node `v22.23.2` auf `http://localhost:3000`; `/api/health` liefert HTTP 200, `database=ok`, `missingRequiredCount=0`. Upstash `/ping` liefert `PONG`; einzig `image-uploads` bleibt degradiert, S3 bleibt deaktiviert.
- Lokale Review-Runde mit 12 Agentenbereichen; keine Preview-Deployments, DB-Schreibzugriffe oder Migrationen.
- Fixes: WG-Auth-Reihenfolge/404-Orakel, Rate-Limit-Fehlerredaktion, atomare WG-/Expense-/Recurring-/Event-/Chat-/Chore-/Pinnwand-/Calendar-Replays, Expense-CAS/Split-Prüfung, Berliner Abwesenheitstage, Chat-Mikrosekunden-Cursor, Event-DST/Cron, Inventory/Shopping-Reconciliation und zugängliche Navigation. Alte Claims vor den atomaren Änderungen sind nicht sicher rekonstruierbar.
- Verbleibende Replay-Grenze: eine externe Testbenachrichtigung kann nach verlorenem Replay-Cache und Ablauf der 15-Minuten-Lease erneut zugestellt werden; genau-einmalige externe Zustellung braucht Outbox und Empfänger-Deduplizierung. Ein älterer Calendar-Key gibt seine ursprüngliche URL wieder, auch wenn eine spätere unabhängige Rotation sie ersetzt.
- Kalender-GET behält 1.000 Kandidaten. Cron hat ein eigenes 10.000er-Budget, vollständigen Preflight vor Claims/Versand und höchstens 10 parallele Zustellungen; Überlauf bleibt vor Nebenwirkungen bei HTTP 503. Laufzeit für 10.000 Erinnerungen gegen Hosting-Zeitlimit noch messen.
- Gehostete Freigabe bleibt offen: Preview-DDL-/Owner-Zugang (SQLSTATE `42501`), echte Mehr-WG-/Revoked-Membership-Abnahme, Residenten-/Geräteprüfungen, Backup/Restore/PITR sowie Production-RLS-Migration/Deployment/Rollback. Diese Nachweise sind keine lokalen Build- oder Fixture-Ergebnisse.

## Aktueller Implementierungsstand — 2026-09-22, Europe/Berlin

- Branch `fix/audit-158` enthält den geprüften Anwendungs-/Teststand `3abc5d9a1fefe55603067d872f476981289ee71f`; der aktuelle Dokumentations-Tip ergänzt nur diese Evidenz. PR #300 ist mergeable, aber wegen geschützter Preview-Gates noch nicht freigabefähig.
- Vercel Preview `https://manawg-eqqk2dsld-abditubes-projects.vercel.app` (`dpl_uwtuk6ewXfC1BdRXERmvXLxxjx2j`) ist mit Node 22 READY. GitHub Preview-/QA-Secrets sind vorhanden; keine Werte wurden ausgegeben.
- GitHub-Node-22-`validate` ist erfolgreich (`35663607827`); die exakte Fixture-Suite ist mit 180 bestanden und 28 übersprungen grün. Fixture-E2E und lokale Regressionen sind getrennte Evidenz und kein Hosted-Produktionsnachweis.
- Protected Preview run `35663737497` scheitert fail-closed in `db-supabase-preview`: SQLSTATE `42501` beim Anwenden von Migrationen. Supabase-Read-only-Katalogprüfung bestätigt `manawg_preview_ci.schema_create=false`, `db_create=false`; bestehende Tabellen gehören `postgres`.
- Nächste autorisierte Aktion: einen vorgesehenen direkten Preview-DDL-/Owner-Migrationszugang bereitstellen/freigeben. Keine zusätzlichen Grants, Rollenrotation oder manuelle Ledger-Manipulation als Umgehung. Production bleibt unverändert.
- Storage, Provider, Geräte, Recovery, authentifizierte Privacy-/Revocation-Abnahme und Production-Gates bleiben offen.

Stand: 2026-09-22, Europe/Berlin
Scope: `/Users/abu/Company/manawg-app`
HEAD: `4ebd685` (`fix/audit-20260922-app` incl. Merge von `origin/main`; vorher `3abc5d9a` auf `fix/audit-158`)
Arbeitsbaum: ca. 116 dirty Dateien durch laufende UI-/Refactor-WIP-Mehrerer; `apps/web/src/app/layout.tsx` ist clean; kein Production-Release.

## Lokaler Dev-Server — 2026-09-23

- Erstmeldung: `http://localhost:3000` antwortete mit HTTP 200; PID `13966`, Log `/tmp/manawg-dev.log`. Node `v26.7.0` war laut Projektvertrag (Node 22.x) nicht unterstützt.
- `NEXT_PUBLIC_SUPABASE_URL` und `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` sind in der ignorierten `apps/web/.env.local` für `manawg-preview` gesetzt; übrige Einträge blieben erhalten.
- Das Passwort der Supabase Preview-Datenbank wurde rotiert. `POSTGRES_URL` wurde in Vercel Preview als `sensitive` aktualisiert und lokal ersetzt. `.env.local` bleibt gitignored und ist nur für den Eigentümer lesbar (`0600`). Keine Zugangswerte dokumentiert.
- Dev-Server neu gestartet: Node `v22.23.2`, HTTP 200; Next-Prozess PID `45324`, Listener PID `45331`, Log `/tmp/manawg-dev.log`.
- `GET /auth/v1/settings` mit dem lokalen Publishable-Key: HTTP 200. `/api/health`: HTTP 200, `status=ok`, `database=ok`, `missingRequiredCount=0`.
- Supabase Management-API `SELECT 1` auf `manawg-preview` war ebenfalls erfolgreich.
- Upstash für Development aktiviert: Die Vercel-Development-Werte werden lokal unter den von der App erwarteten `UPSTASH_REDIS_REST_URL`- und `UPSTASH_REDIS_REST_TOKEN`-Namen verwendet. Redis `/ping` antwortet mit HTTP 200/PONG; `/api/health` meldet kein `rate-limiting`-Degrade.
- Die vorhandene Redis-Ressource ist für Development, Preview und Production geteilt; Rate-Limit-Zähler sind gemeinsam. S3-Image-Uploads bleiben deaktiviert; `/api/health` meldet nur noch `image-uploads` als degradiert.
- Bestehende Vercel Preview-Deployments wurden nicht neu erstellt; sie übernehmen die aktualisierte Datenbank-URL erst bei einem neuen Preview-Deployment.

## Historischer Implementierungsstand — 2026-09-20 20:10 CEST

- Frühere Claims über fehlende Preview-Secrets und Tree-Gleichheit sind überholt: dedizierte QA-/DB-Secrets liegen im geschützten GitHub-Environment `Preview`; finale Release-Gates bleiben an exakte Commit-SHAs gebunden.
- Private Storage-Implementierung committed (`0fa9755`), sauberes Preview `7640b0c` / `dpl_AMnZJJnwwTRtzKMdJPcUwThdpYob` READY. Echt bestanden: 8-MiB-Upload/Hash-Readback, Browser-Dekodierung, Fremd-/Gast-/Revocation-Denials, Provider-Größen-/MIME-/Overwrite-Schutz. Offline-UI-Replay bleibt offen.
- 14 gezielte Release-/Limiter-Tests, Lint und Typecheck bestanden. Gesamter Hosted-Lauf zuletzt 22/27: temporärer Codegenerator enthielt verbotene Zeichen; `/api/wg/mine` wurde irrtümlich dem 20/min-Code-Limiter zugeordnet. Generator korrigiert, Middleware-Fix lokal geprüft; erneuter Hosted-Nachweis ausstehend.
- Recovery: Schema und Daten lokal identisch; ACL-Differenz noch nicht erklärt. Provider-PITR/Retention, echte Geräte und Residenten-Abnahme bleiben offene Pflichtnachweise. Kein Production-Release.

Statuswerte: `offen` · `in Arbeit` · `erledigt` · `blockiert`

## Definition of Done

- Jede Aufgabe ist erledigt oder mit Owner, Entscheidung und aktuellem Nachweis blockiert dokumentiert.
- Lokale Gates beziehen sich auf denselben geprüften Arbeitsstand.
- Kernflüsse haben sichtbare Erfolgs-, Fehler-, Offline- und Recovery-Zustände.
- Preview/Auth/RLS, Provider, Geräte, Recovery und Produktion sind nur mit echtem Nachweis geschlossen.

## Priorisierte Aufgaben

### T1 — Bestandsaufnahme und Scope

Status: erledigt

Abnahme: Checkout, Branch/Dirty-State, Projektregeln, Scripts, OpenSpec, Playwright-Konfiguration, TODO-/Placeholder-Signale und Release-Dokumente geprüft. Node 22 und pnpm 9 sind der Projektvertrag.

### T2 — Aufgabenboard und 30-Minuten-Kontrolllauf

Status: in Arbeit

Abnahme: genau ein aktiver Job, keine Doppelstarts, read-only Prüfung und kein Dateischreibzugriff.

- [x] Job `manawg-release-control-2026-09-19` aktiv: `8f73b5b4-543a-4a98-864c-253f24558265`.
- [x] `*/30 * * * *`, Europe/Berlin, isoliert, Astra High, keine Zustellung.
- [x] Payload am 2026-09-20 auf read-only umgestellt; keine Python-/Shell-Append-Skripte mehr.
- [ ] Nach T9 deaktivieren.

### T3 — Lokale Qualitäts- und Reproduzierbarkeitsgates

Status: erledigt

Abnahme: lokale Gates wurden nach dem aktuellen HEAD `cae9b0b` und den dirty Änderungen erneut ausgeführt.

- [x] Historischer Lauf: Typecheck, Lint, Build, Bundle, Analytics, OpenSpec 5/5, Fixture-E2E 80/24/0, Chat 2/2, Workflow-Gates 9/9, Audit ohne High-Schwachstellen.
- [x] Finaler Readback: Typecheck, Lint, Build, Bundle, Analytics, OpenSpec 5/5, Release-Workflow-Gates 9/9 und Fixture-E2E Exit 0; exact-tree CI fixture run `35663607827` meldet 180 bestanden und 28 übersprungen.

### T4 — Backend, Auth und Datenintegrität

Status: blockiert

Abnahme: Auth, WG-Mitgliedschaft, Idempotenz, JSON-Limits, Offline-Reconciliation, Inventory-Consume, Settlement und Benachrichtigungen sind fail-closed, retry-sicher und gegen echte Preview-DB/Auth belegt.

- [x] Fixture-Auth, Settlement-Cache, Idempotenz-, Push-, JSON-Body-, Inventory- und Member-Regressionen lokal grün.
- [x] Fire-and-forget-Fehler beim Auszug und PayPal-Profil werden sichtbar behandelt.
- [x] Chat-Lesestatus bleibt bei Fehlern sichtbar und retrybar.
- [ ] Cross-WG-/Parent-Kombinationen mit authentifizierten Preview-Nutzern.
- [ ] Revoked-membership und Zwei-Nutzer-Privacy im Preview.

Blocker: Der geschützte Preview-Migrationszugang `manawg_preview_ci` darf keine DDL ausführen (`schema_create=false`, `db_create=false`); der Hosted-Auth-Lauf bleibt bis zum erfolgreichen Migration-/Check-Gate downstream.

### T5 — UX, Accessibility und Kernflüsse

Status: blockiert

Abnahme: initial, leer, loading, success, failure, offline und recovery bei 320/390px, Light/Dark, Tastatur und reduzierter Bewegung plus Residenten-Usability.

- [x] Lokale UI-/Offline-/PWA-/Account-Wechsel-Regressionen und frühere Browserreviews dokumentiert.
- [x] Fixture-Suite deckt Fehler-, Retry-, Offline- und Recovery-Pfade ab.
- [ ] Fünf Residenten testen den Candidate-SHA.
- [ ] Echter Safari/iOS-/Android-Gerätenachweis.

### T6 — Geschützte Preview-Abnahme: Migration, Auth und Privacy

Status: blockiert

Abnahme: gleicher Candidate-SHA, Preview-Migration/db:check, Vercel-Event, QA-Auth, RLS-Denial, revoked membership, Zwei-Nutzer-Privacy und Cleanup.

- [x] Preview-Projekt `sthiwjebcwwiphashgla` reaktiviert; Status `ACTIVE_HEALTHY`.
- [x] Repo-Migrationen `0010_enable_public_rls.sql`, `0011_explicit_member_roles.sql` und `0012_pale_drax.sql` nach ACTIVE-Readback angewendet.
- [x] Preview-Katalog: 26 Tabellen, `disabled_count=0`; `anon` und `authenticated` erhalten auf `public.wgs` erwartungsgemäß `permission denied`.
- [x] Keine Preview-Policies/Grants ergänzt; das entspricht dem server-owned Access-Modell.
- [x] Supabase CLI `db query --linked`: `rls_disabled=0`; `anon`-Abfrage wird mit `permission denied` abgewiesen.
- [x] Vercel CLI `curl /api/health`: `status=ok`, `database=ok`, `missingRequiredCount=0`.
- [x] Exaktes `db:check` am 2026-09-20 16:40 CEST bestanden: autorisierte direkte CLI-Verbindung, Rolle wie CLI-Dump, TLS verify-full mit Supabase-CA; 13 kanonische Ledger-Einträge.
- [x] Fehlende Ledger-Einträge 0010–0012 nach bytegenauem Vergleich mit bereits angewendeter Supabase-Historie ergänzt; Rollback vorher bewiesen. Keine Schema-/App-Datenänderung.
- [x] Sechs echte Hosted-Auth-/Guest-/Reset-Checks bestanden; synthetischer Account und isolierte Test-WG jeweils entfernt.
- [x] Zentraler Runtime-Fix: App-Transaktionen ignorieren Migrations-Credentials; sechs Resolver-/Ledger-Regressionen und echter Preview-Schreib-/Rollback-Test in derselben DB-Sitzung bestanden.
- [ ] Current protected run `35663737497`: Migration reaches the pending migrations but fails with SQLSTATE `42501`; `e2e-preview` fails closed.
- [ ] Authorize the intended direct Preview DDL/owner migration credential, then rerun migration, `db:check`, authenticated browser, revoked membership, Privacy and cleanup gates for the exact candidate tree.
- [ ] Authentifizierter Browserlauf, revoked membership, Privacy und Cleanup.

### T7 — Externe Provider und Geräte

Status: blockiert

Abnahme: S3, Rate-Limit, Push, Kalender, PayPal, Import/Export, PWA sowie iOS-/Android-Pfade mit sicheren Testdaten.

Blocker: Providerzugänge, QA-Testdaten und echte Geräteprüfungen fehlen.

### T8 — Recovery, Monitoring und Produktionsbetrieb

Status: blockiert

Abnahme: Backup/PITR, RPO/RTO, Restore-Drill, Monitoring/Alerting, Support-Ownership, Rollback und kontrollierte Produktionsfreigabe für denselben SHA.

- [x] Recovery-Runbook und Stop-Bedingungen dokumentiert.
- [ ] Provider-Backup/PITR, isolierter Restore-Drill, RPO/RTO und Monitoring.
- [ ] Production-RLS-Migration, Deployment und Rollback nach Preview-Freigabe.

### T9 — Abschluss und Release-Entscheidung

Status: blockiert

Abnahme: T2–T8 aktuell belegt, Candidate-SHA eingefroren, alle P0/P1-Gates erledigt oder begründet blockiert.

Blocker: neuer Candidate mit dauerhafter Preview-Konfiguration, T4/T5 QA, vollständige T6-Mitgliedschaft/Privacy, T7 und T8. Lokaler T3-Readback und Testdaten-Cleanup sind belegt.

## Externer Live-Readback — 2026-09-20

- Preview `sthiwjebcwwiphashgla`: `ACTIVE_HEALTHY`; 26 öffentliche App-Tabellen mit RLS aktiv; direkte Rollenabfrage als `anon` und `authenticated` auf `public.wgs` wird abgewiesen.
- Preview-Migrationsreadback 16:40 CEST: Drizzle-Ledger enthält jetzt das kanonische Präfix `0000`–`0012`; die drei Ergänzungen sind durch bytegleiche Supabase-Ausführungshistorie belegt. Exaktes `db:check` bestanden.
- Preview Security Advisor: RLS-ohne-Policy als INFO für 26 Tabellen (beabsichtigtes server-owned Modell) und `auth_leaked_password_protection` als WARN.
- Production `bwsvsvfgbrsonepffqff`: `ACTIVE_HEALTHY`, aber die 26 App-Tabellen hatten im letzten direkten Readback `RLS=false`; Production wurde nicht verändert.
- Vercel CLI: neuer Preview-Deploy `https://manawg-qhpaco526-abditubes-projects.vercel.app` aus clean `main`-HEAD, `Ready`; `vercel curl /api/health` meldet Datenbank `ok`.
- GitHub CI: letzter Preview-Lauf scheiterte am Source-SHA-Mismatch nach dem Merge; Main-Lauf scheiterte an der geschützten direkten Preview-DB-URL.
- GitHub-Repo-Secrets vorhanden: E2E-URL/Key/E-Mail/Passwort und Vercel-Bypass. Fehlend für den Workflow: `SUPABASE_PREVIEW_DATABASE_MIGRATION_URL` und `SUPABASE_AUTH_TEST_*`.
- Keine Production-Migration, kein Push und kein Deployment ausgeführt. Preview-Migrationen wurden ausschließlich im Preview-Projekt angewendet.

## Nächste autorisierte Aktion

Candidate-SHA einfrieren und nativen Preview-Deploy mit den bestehenden Vercel-Secrets prüfen. Danach Mitgliedschafts-409, revoked membership, Zwei-Nutzer-Privacy sowie Provider-/Geräte-/Recovery-Gates schließen. Keine Credential-Rotation auf Grundlage redigierter env-pull-Werte.

## Kontrolllauf

- Zeitpunkt: 2026-09-23 21:19 CEST; Lock erfolgreich, aktueller SHA `4ebd685`, 120 WIP-Pfade unverändert erhalten.
- Statuszähler: 2 erledigt, 1 in Arbeit, 6 blockiert, 0 offen.
- Ergebnis: `/api/health` HTTP 200 mit Datenbank `ok`; Lint, Typecheck und `git diff --check` grün, Image-Uploads degradiert; Preview/Auth/RLS, Provider, Geräte und Recovery bleiben blockiert.
- Nächster Schritt: autorisierten Preview-DDL-/Owner-Zugang bereitstellen und denselben Candidate-SHA durch `db:check`, Auth, Privacy und Cleanup führen.
