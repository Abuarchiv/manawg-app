## Purpose

Let members record, correct, find and import shared expenses accurately, including when they are offline or when expenses repeat automatically.

## ADDED Requirements

### Requirement: Expense date is chosen and validated

The expense form SHALL let the member choose the expense day (default today, not after today, prefilled when editing). The client SHALL send `occurredAt` only when the chosen day differs from the default, and offline queue payloads SHALL carry it. The server SHALL validate `occurredAt` on create and update with one range: at most 2 days in the future and at most 5 years in the past, otherwise `occurred_at_invalid`.

#### Scenario: Backdated expense
- **WHEN** a member records an expense for an earlier day
- **THEN** the expense SHALL be stored and listed under that day

#### Scenario: Date out of range
- **WHEN** a request carries an `occurredAt` more than 2 days ahead or more than 5 years back
- **THEN** the server SHALL reject it with `occurred_at_invalid` and change nothing

#### Scenario: Recorded offline
- **WHEN** an expense with a chosen date is queued offline and later replayed
- **THEN** the stored expense SHALL keep the chosen date

### Requirement: Equal split can target selected participants

The equal-split mode SHALL offer one checkbox per active member, all preselected, and SHALL NOT allow deselecting the last participant. The selection SHALL be kept in the draft, and an existing expense or recurring template whose shares are equal among a subset SHALL reopen as an equal split of that subset.

#### Scenario: Subset split
- **WHEN** a member deselects one member and saves an equal split
- **THEN** only the selected members SHALL receive shares

### Requirement: Edits disclose reopened settlements

When an edit changes amount or split so that already paid shares are reopened or removed, the form SHALL show a notice before saving.

#### Scenario: Paid share affected
- **WHEN** a member edits the amount of an expense that has a paid share
- **THEN** the form SHALL state that paid shares will be reopened

### Requirement: Expense list can be searched and filtered

With six or more entries the list SHALL offer a text search over description and payer name and a segment "Alle", "Von mir bezahlt" and "Ich bin beteiligt". Filtering SHALL happen before week grouping and SHALL NOT change balances.

#### Scenario: No match
- **WHEN** a filter matches no expense
- **THEN** the list SHALL show "Keine passenden Ausgaben gefunden" and balances SHALL stay unchanged

### Requirement: Import de-duplicates against existing expenses only

Import SHALL skip a row only when an existing WG expense has the same key. Repeated rows inside the file SHALL be imported with a distinguishing `|#n` suffix. Member matching SHALL accept fuzzy matches only above a name-length dependent threshold, SHALL NOT reuse exactly matched members, and SHALL label fuzzy suggestions for review. Rows that cannot be read SHALL be listed with row, reason and description, and error messages SHALL name description, date and amount.

#### Scenario: Two identical rows in one file
- **WHEN** a file contains the same expense twice and the WG has none of them
- **THEN** both SHALL be imported

#### Scenario: Unreadable rows
- **WHEN** a Splitwise or Splid file contains unreadable rows
- **THEN** the preview SHALL list them, and a file with no readable row SHALL report `rows_unreadable`

### Requirement: Recurring expenses book once and stay controlled

Recording a recurring expense SHALL advance its template on the server within the booking transaction. Advancing without a booked expense for the current due date SHALL fail with `409 recurring_expense_not_booked` and no audit entry. Pause, edit and delete SHALL be limited to the creator or an admin. Booking SHALL be offered only to members the server accepts. A template skipped because its member moved out SHALL produce one bulletin notice on the first run within 25 hours of the due date. The form SHALL announce how many past bookings a past start date will create.

#### Scenario: Advance without booking
- **WHEN** a client asks to advance a template that has no expense for its current due date
- **THEN** the server SHALL respond `409 recurring_expense_not_booked`

#### Scenario: Another member edits
- **WHEN** a member who is neither creator nor admin opens a recurring expense
- **THEN** pause, edit and delete SHALL be hidden with an explanatory hint
