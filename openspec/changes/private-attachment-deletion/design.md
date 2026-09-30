## Context and completion criteria

Deleting a published image currently leaves a copied private URL readable. `ImageUploader` also uses that URL before a record exists and persists it in unsaved drafts. Requiring a live reference on every read would break that workflow.

This change has two distinct outcomes: removing the last published reference immediately revokes application reads; the existing maintenance cron later removes provider bytes and retries failures. A successful domain deletion does not claim immediate physical erasure. Scope is discoverable private Supabase images, including WG/account cascades, not an upload registry or general object lifecycle.

## 1. One permanent revocation record

Add server-only `private_image_deletions`:

- `object_key text PRIMARY KEY`: existence permanently denies private reads and new attachment of that key.
- `requested_at timestamptz NOT NULL DEFAULT now()`: original revocation time and cleanup eligibility.
- `last_attempt_at timestamptz NULL`: fair bounded retry ordering.
- `storage_deleted_at timestamptz NULL`: last observed successful provider removal, not a revocation flag or guarantee against later upload completion.

These are the only state fields. No owner, lease, attempt counter, status enum, foreign key or new scheduler. Records survive WG/Auth deletion and provider success. Enable RLS, revoke direct Data API privileges and index cleanup selection. Expiring idempotency rows cannot serve as revocations.

## 2. Canonical keys and complete reference checks

Reuse the strict private key grammar from `core/validators/image-url.ts`. Extract the decoded object key from private read URLs; compare keys rather than raw URL bytes. For stored deployment URLs, accept the same private path/query/key grammar and require the row's WG to match the key's WG. Preserve current-origin validation for new client writes. AWS/external URLs never enter Supabase cleanup.

Live references are `expenses.image_url`, `announcements.image_url`, and `wg_chat_messages.image_url WHERE deleted_at IS NULL`. All three can share a key. A complete per-WG scan of non-null image URLs is sufficient; no result cap may hide a remaining reference. Mark its linear-history cost with a `ponytail:` comment; defer normalized reference storage until measured need.

## 3. Reuse the existing per-WG transaction lock

Every transaction creating, replacing or removing a private reference acquires `lockExpensePayments(tx, wgId)` before reading the mutable reference, replay-row locking, or parent/member/domain row mutation. This existing per-WG lock already serializes expenses, WG deletion and account cascades. Extend chat/announcement attachment transactions to participate. WG-scoped keys make per-object locks, sorted key sets and discovery retries unnecessary.

Keep the established order: account lock when present → existing WG payment locks in WG-ID order → replay/parent/member/domain rows. Account deletion already acquires all affected WG payment locks before parent/member locks; reuse that path. If a replay helper locks its replay row before entering the mutation callback, acquire the WG lock at its transaction entry, not inside that callback. Audit each changed path for this order.

Under the lock, recheck relevant authorization/current rows. Reject a revoked new key with stable `409 image_removed`; remove/replace the reference; check all remaining live references; insert revocation only when none remain. Preserve the original requested time on retries. The domain change and revocation commit together. Provider calls run outside these transactions. Cached successful POST replies remain replay-only and never recreate a deleted reference.

The deliberate ceiling is serializing attachment mutations with financial writes within one household. Keep transactions short and free of provider calls. Separate locks require measured contention, not anticipated scale.

## 4. Actual reference writers and removers

Paths below `apps/web/src`:

| Path | Required treatment |
| --- | --- |
| `app/api/upload/sign/route.ts` | Preserve fresh immutable keys, `upsert: false`, and current response. No registry or re-signing caller-selected keys. |
| `app/api/upload/read/route.ts` | After membership authorization, deny revoked keys with 404/no-store before download. Already streaming reads cannot be retracted. DB failures fail closed. |
| `app/api/wg/[code]/expenses/route.ts`, `features/expenses/expenses.ts` | Check new private references in the existing financial/replay transaction. Image-free callers retain behavior. |
| `app/api/wg/[code]/expenses/[id]/route.ts` | PATCH/DELETE read current old key and revoke the last removed reference atomically; preserve financial checks and CAS. |
| `app/api/wg/[code]/announcements/route.ts`, `features/pinnwand/announcement-replay.ts` | POST joins the WG lock before replay-row locking and validates new references. |
| `app/api/wg/[code]/announcements/[id]/route.ts` | DELETE removes/revokes atomically; current PATCH changes no image. |
| `app/api/wg/[code]/chat/messages/route.ts` | POST joins the WG lock before replay-row locking and validates new references. |
| `app/api/wg/[code]/chat/messages/[id]/route.ts` | Soft DELETE removes the live reference and may revoke the key; retries remain idempotent. Body-only PATCH stays unchanged. |
| `core/db/delete-wg.ts`, `core/db/delete-account.ts` | Collect discoverable keys before cascade, including stored soft-deleted chat image keys. Revocations survive WG deletion. Shared-WG departures retain history and references. Reuse existing lock order. |
| `app/api/cron/maintenance/route.ts`, `core/infra/supabase-storage.ts` | Add bounded cleanup below; preserve existing maintenance results/failure semantics. |

Imports, recurring expenses and system notices currently create no images: prove compatibility without adding lifecycle branches. In form/offline callers, `image_removed` must explain re-upload and stop automatic retry; never silently drop a receipt. A draft reusing a subsequently revoked published key must re-upload; a never-published upload remains unaffected.

## 5. Separate best-effort provider cleanup

The installed Supabase SDK documents two-hour signed-upload validity. Signing always creates a new key and never re-signs an existing one. Start cleanup at `requested_at + 2 hours + 5 minutes`, retaining the original timestamp. This reduces recreation through valid tokens; it is not needed for read denial and does not bound completion of an already accepted PUT.

Use the existing maintenance cron and SDK. Claim at most 50 eligible records in a short `FOR UPDATE SKIP LOCKED` transaction by updating `last_attempt_at`; commit before provider calls. Prefer never-attempted records, then oldest attempts. Failures remain eligible on later runs. Completed records may re-enter this same bounded rotation after one day so late recreated bytes can be removed; no separate sweep framework or promise of immediate or permanently final erasure.

Before removal, defensively check for unexpected live references. Fail closed and report an invariant failure rather than deleting still-referenced bytes; read revocation remains. Configuration failure, timeout and generic provider errors remain pending and visible in maintenance results. Only observed success or specifically verified not-found semantics update `storage_deleted_at`. Lost acknowledgement safely causes repeat removal. Bound provider-call duration.

Cleanup of existing private Supabase keys remains available when the upload selector returns to AWS. The Supabase project/bucket must remain stable, as already required for reads; relocation is separate. Historical orphans, never-submitted drafts and legacy public AWS images stay outside scope.

## 6. Migration, cutover and verification

Recheck the shared journal before generating the next additive migration: `0016_revoke_data_api_table_select` is reserved by the database-grants change, so this is currently 0017. Preserve historical hashes, update explicit catalog/checker expectations, and prove fresh replay plus upgrade in disposable PostgreSQL.

Deploy schema first. Activate revocation only with compatible readers and all image writers: old readers ignore the fence; old writers can successfully attach revoked keys. Delaying physical cleanup alone solves neither race. Before claiming the contract, verify incompatible instances/deployment URLs with access to the same database are drained or inaccessible; stage schema/application/cleanup accordingly. Rollback must retain fence-aware readers/writers, not merely the table. These artifacts authorize no Production deployment.

Separate evidence for atomic revoke/shared-reference/draft compatibility, observed provider removal/retry, and exact-SHA Preview execution. Test real PostgreSQL attachment-versus-delete, simultaneous last deletions across tables, replacement and WG/account cascade races. Report unknown in-flight PUT completion time and historical-orphan limits rather than claiming whole-bucket erasure.
