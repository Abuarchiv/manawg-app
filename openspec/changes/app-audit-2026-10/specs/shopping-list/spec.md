## Purpose

Keep the shared shopping list editable, consistent offline and quiet.

## ADDED Requirements

### Requirement: Items can be renamed and re-quantified

The update endpoint SHALL accept `name` and `quantity` in addition to `bought`, require at least one field, apply the existing version check, and answer `409 duplicate` when the new name equals an open item. A successful edit SHALL be audited as `shopping.updated`.

#### Scenario: Rename to an open name
- **WHEN** a member renames an item to the name of another open item
- **THEN** the server SHALL answer `409 duplicate`

### Requirement: Offline actions stay visible

Unsynced offline creates and ticks SHALL be overlaid on any server state without duplicate rows. Rejected updates and entries of another WG or member SHALL be ignored. After a server delete, queued follow-up actions for that item SHALL be removed.

#### Scenario: Create queued offline
- **WHEN** a member adds an item offline and the list reloads before sync
- **THEN** the item SHALL still be shown once

### Requirement: Ticking is idempotent and quiet

Marking an item bought SHALL NOT create a bulletin entry. A request that already matches the stored state SHALL answer 200 with the row, without audit entry.

#### Scenario: Double tick
- **WHEN** two clients mark the same item bought
- **THEN** both SHALL receive 200 and one audit entry SHALL exist

### Requirement: The list does not wait for inventory

The list SHALL render without waiting for inventory suggestions and SHALL reserve space for them. Items added from the input SHALL scroll into view without a toast.

#### Scenario: Inventory request times out
- **WHEN** the inventory request is slow or fails
- **THEN** the shopping list SHALL remain usable
