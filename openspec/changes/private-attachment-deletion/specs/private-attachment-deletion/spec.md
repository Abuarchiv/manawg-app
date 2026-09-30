## Purpose

Revoke private household attachments when their last stored use is removed, while preserving drafts, shared images and recoverable cleanup after provider failures.

## ADDED Requirements

### Requirement: Preview and shared-reference compatibility
The system SHALL preserve authorized previews of newly uploaded, never-committed images and SHALL preserve a private image while any live expense, announcement or chat reference remains.

#### Scenario: Unsaved upload preview survives reload
- **WHEN** an active member uploads an image and reloads its saved local draft before submitting a record
- **THEN** the image remains readable through the existing private URL without requiring a committed reference

#### Scenario: One of two references is removed
- **WHEN** an image is referenced by an expense and a live chat message and the expense is deleted
- **THEN** the image remains readable and is not physically removed

### Requirement: Durable last-reference revocation
The system SHALL revoke a private image atomically with removal of its last committed live reference and SHALL reject later attachment of that revoked key. Membership authorization and private no-store responses MUST remain enforced.

#### Scenario: Last reference is deleted or replaced
- **WHEN** the last reference is removed by record deletion, receipt replacement or chat soft deletion
- **THEN** subsequent private reads return no image bytes and new writes using the revoked key fail with an actionable re-upload error

#### Scenario: Domain mutation fails
- **WHEN** the database transaction removing the last reference fails
- **THEN** neither the reference nor image access is lost and no provider deletion is scheduled

#### Scenario: Concurrent attachment and deletion
- **WHEN** one request creates a shared reference while another removes the previously last reference
- **THEN** either the new reference commits and preserves the image or revocation commits first and rejects the new reference; no successful new reference points to an image deleted by this race

### Requirement: Recoverable provider cleanup
The system SHALL delay physical removal until outstanding signed-upload authorizations have expired, SHALL retry failed cleanup fairly, and SHALL keep logical revocation independent of provider availability. Late completion of previously accepted uploads MUST NOT restore application read access and SHALL remain subject to the same bounded cleanup rotation. A provider removal acknowledgement SHALL mean observed byte removal, not immediate or permanently final erasure under an unbounded in-flight upload.

#### Scenario: Provider removal fails and later recovers
- **WHEN** provider removal fails after a successful domain deletion
- **THEN** the private URL stays denied, durable cleanup remains pending and a later maintenance run retries without restoring the domain record

#### Scenario: A late upload recreates bytes
- **WHEN** a previously accepted upload finishes after an earlier cleanup attempt
- **THEN** private reads remain denied and subsequent maintenance can remove the recreated object

### Requirement: Whole-WG deletion preserves cleanup recovery
The system SHALL preserve revocation and cleanup records for discoverable private attachments after whole-WG deletion, including deletion reached through a sole-member account deletion. Shared-WG account departure MUST preserve retained shared references.

#### Scenario: Last account removes its WG
- **WHEN** account deletion removes a WG containing private image references and the storage provider is unavailable
- **THEN** WG deletion can commit with durable cleanup records that survive the cascade and are retried after recovery

#### Scenario: Account departs a shared WG
- **WHEN** account deletion retains a WG's existing expense and announcement history for other members
- **THEN** those members retain authorized access to its still-referenced images

### Requirement: Honest scope and compatibility
The system SHALL preserve attachment-free imports and existing AWS behavior, and SHALL distinguish observed provider removal from complete historical bucket cleanup.

#### Scenario: Incompatible application instances remain
- **WHEN** an old reader or writer that ignores revocations can still reach the same database
- **THEN** rollout is not complete and the new deletion contract is not claimed; delaying provider cleanup alone does not satisfy this gate

#### Scenario: Existing historical orphan or never-submitted draft
- **WHEN** a private object has no discoverable committed reference or revocation history
- **THEN** this change does not classify it as abandoned or claim it was deleted
