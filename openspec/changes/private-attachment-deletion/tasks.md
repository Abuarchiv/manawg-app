## 1. Prove behavior and prepare the additive table

- [x] 1.1 Add helper/route tests for draft preview, shared references, copied-URL denial after last removal, and re-upload recovery for revoked keys. Focused Node 22 tests passed (56 total).
- [x] 1.2 Add migration 0017, schema, and snapshot for the four-field revocation/cleanup table, cleanup index, and revoked Data API privileges. Preserve historical migration hashes.
- [x] 1.3 Run the migration checker against fresh and upgraded disposable PostgreSQL, including catalog and grant assertions. The fresh-install/upgrade grants rehearsal passed.

## 2. Implement atomic read revocation

- [x] 2.1 Add canonical private-key extraction, complete three-table reference checks, permanent revocation insertion, and rejected-key lookup. Cover equivalent encodings, stored deployment origins, and wrong-WG AWS exclusion.
- [x] 2.2 Integrate expense POST/PATCH/DELETE under existing WG payment locks. Read mutable references inside the transaction and preserve financial, CAS, and replay behavior.
- [x] 2.3 Join announcement POST/DELETE and chat POST/soft-DELETE to the WG lock before replay/parent/domain row locks. Keep body-only edits unchanged and cached replies replay-only. Add visible `image_removed` re-upload recovery.
- [x] 2.4 Extend WG and sole-member account cascades to collect keys before deletion and preserve revocations, using sorted WG lock ordering. Shared-WG departure retains access; imports, recurring, and system writes stay attachment-free.
- [x] 2.5 Deny private reads after membership authorization with no-store closed failures. Preserve never-published previews, MIME/size checks, and authorization rules.
- [x] 2.6 Prove PostgreSQL races for attachment versus last deletion, cross-table last deletions, replacement, WG/account cascade versus writer, and rollback. PostgreSQL 17 integration passed for shared references, deletion/attachment races, WG and sole-member cascades, route mutations, cleanup timing, announcement replay lock order, and an injected failure after revocation that confirmed both the reference deletion and tombstone insert roll back.

## 3. Add separate provider cleanup

- [x] 3.1 Define the completed-row cleanup design in `design.md`.
- [x] 3.2 Implement bounded cleanup claims and provider-result handling for timeout/configuration, not-found, unexpected reference, pending, and failed outcomes. PostgreSQL cleanup-timing checks passed.

## 4. Review, browser checks, and rollout evidence

- [x] 4.1 Verify draft save/reload, shared references, deletion, and revoked-draft recovery across browser and database layers. PostgreSQL 17 proves shared-reference and cascade behavior, including both last-reference outcomes. With `NEXT_PUBLIC_E2E_FIXTURE_MODE=true`, explicit Node 22.23.2, and Playwright webServer disabled against rebuilt port 3379, the recovery spec passed Chromium 1/1 and WebKit 1/1 with zero skips. It asserts two same-origin upload PUTs, zero CSP violation events across reload, saved preview restoration, `image_removed` recovery, and re-upload with a new key. The earlier 25 passed/1 skipped focused result skipped this fixture-gated spec and is superseded. Private-browsing offline binary persistence remains unverified; browser/client and PostgreSQL evidence are complementary, not one combined browser scenario.
- [x] 4.2 Independently review writers/removers, WG lock order, migration safety, read denial, and provider-result classification. Three PostgreSQL test-safety findings were fixed; the corrected integration run passed. No runtime, migration, or lock-order finding remained.
- [ ] 4.3 Document schema-first deployment and compatible reader/writer cutover, including inaccessible/drained old deployments and fence-aware rollback. The design is documented; exact-SHA hosted Preview migration, create/read/revoke, and provider-removal proof remains unrun.
- [x] 4.4 Report read revocation separately from provider byte removal. Historical-orphan, draft, and AWS exclusions are recorded; upload completion timing and exact provider byte removal remain unobserved. No Production mutation belongs to this planning task.
