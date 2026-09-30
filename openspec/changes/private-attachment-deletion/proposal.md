## Why

Deleting a receipt, announcement or chat message removes its reference while its private image remains readable through a copied URL by an active WG member. Rejecting every unreferenced image would also reject immediate upload previews and persisted unsaved drafts.

## What Changes

- Permanently revoke a private key only when its last published live reference is removed; preserve never-published previews and remaining shared references.
- Commit reference changes and revocation together using the existing per-WG transaction lock. Reject new attachment of revoked keys and deny private reads immediately.
- Separately remove provider bytes through bounded, retryable work in existing maintenance. Record observed cleanup without promising immediate physical erasure or a bound on accepted uploads.
- Preserve revocation/cleanup records through WG and sole-member account deletion and provider outages.
- Verify drafts, shared references, retries and concurrency; activate only after incompatible readers and writers are drained.

## Capabilities

### New Capabilities

- `private-attachment-deletion`: Durable read revocation and recoverable provider cleanup for previously referenced private WG images.

### Modified Capabilities

None. Existing private storage remains a prerequisite; membership and upload contracts stay intact.

## Impact

One server-only revocation table with three cleanup timestamps; existing private-read/validation/storage helpers; actual image-bearing expense, announcement and chat transactions; WG/account cascade; existing maintenance and focused tests. Reuse the WG lock instead of per-object lock machinery. No upload registry, generic job framework, new dependency, provider changes or Production deployment.

Imports contain no images and need compatibility coverage only. Historical orphan uploads, never-submitted draft cleanup, legacy public AWS images, uploader ownership and provider relocation are excluded. A draft reusing a revoked published key must re-upload. Immediate application read denial and observed provider-byte deletion are separate verification claims.
