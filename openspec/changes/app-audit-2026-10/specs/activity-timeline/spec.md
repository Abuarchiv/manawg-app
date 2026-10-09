## Purpose

Give members an accurate activity history and a complete data export.

## ADDED Requirements

### Requirement: Feed shows member activity truthfully

The dashboard feed and chronicle SHALL include only member-written announcements, SHALL attribute bought items to the buyer (falling back to the adder), and SHALL sort them by purchase time. Chat and duplicate audit rows SHALL be excluded in the query so they do not consume the row limit. Absences SHALL use their creation time.

#### Scenario: Chat noise
- **WHEN** many chat audit rows exist
- **THEN** they SHALL NOT crowd out other activity

### Requirement: Timeline can page and filter by person

The activity endpoint SHALL accept `limit` (default 80, clamped to 80..320). The page SHALL offer to load older entries, note that filters apply to the loaded entries only, and offer a "Wer" filter (Alle / Nur ich).

#### Scenario: Older entries
- **WHEN** a member loads older entries
- **THEN** the timeline SHALL request a larger limit up to 320

### Requirement: Export is complete and readable

The export SHALL include chore completions and inventory, member names for references, and extra fields (recurrence, buyer, purchase time, pause time, payment parties). CSV timestamps SHALL be written as `YYYY-MM-DD HH:mm` in Europe/Berlin and splits as `Name: 12,34; Name2: 5,00`. JSON SHALL stay unchanged.

#### Scenario: CSV timestamp
- **WHEN** a timestamp column is exported as CSV
- **THEN** it SHALL be in Berlin time with minute precision
