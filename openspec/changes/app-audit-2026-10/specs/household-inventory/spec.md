## Purpose

Keep stock counts fast to change, restocking prompted and low-stock alerts meaningful.

## ADDED Requirements

### Requirement: Quantity taps are consolidated

Taps on plus and minus SHALL update the display immediately, taps during an in-flight request SHALL be summed into one follow-up delta, and an error SHALL discard pending taps and show server state.

#### Scenario: Rapid taps
- **WHEN** a member taps minus three times during one request
- **THEN** at most one further request carrying the summed delta SHALL be sent

### Requirement: Low-stock alerts fire on crossing

Consuming stock SHALL add the item to the shopping list and dispatch `inventory.low_stock` only when the quantity crosses the threshold. Name or threshold edits SHALL NOT require a quantity version check.

#### Scenario: Already low
- **WHEN** an item below its threshold is consumed further
- **THEN** no new push SHALL be sent

### Requirement: Restocking is suggested

When a low item's name has just been bought, the shopping page SHALL offer to raise the stock by the bought quantity, and "Nicht jetzt" SHALL be remembered locally. Quick restock SHALL list low items first, then the most consumed in the last 30 days, and SHALL raise to above the threshold.

#### Scenario: Declined suggestion
- **WHEN** a member chooses "Nicht jetzt"
- **THEN** the same suggestion SHALL NOT reappear

### Requirement: Duplicate names are rejected

Creating an item, or renaming it, SHALL fail with `409 inventory_item_duplicate` when `lower(btrim(name))` matches another item. An unchanged own name SHALL NOT be flagged.

#### Scenario: Case-insensitive duplicate
- **WHEN** a member adds "milch" while "Milch" exists
- **THEN** the server SHALL reject it with `inventory_item_duplicate`
