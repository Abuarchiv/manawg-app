## Purpose

Show shared events and chores on the correct days and let members follow them in an external calendar.

## ADDED Requirements

### Requirement: Event changes are limited to owner and admins

The event modal SHALL be read-only for members who neither created the event nor are admins: fields locked, save and delete hidden, "In Kalender" kept. Optimistic rows SHALL NOT be editable.

#### Scenario: Foreign event
- **WHEN** a regular member opens another member's event
- **THEN** all fields SHALL be disabled and no save action SHALL be offered

### Requirement: Spans and venues are shown completely

The month grid SHALL query the visible range from Monday before the 1st to Sunday after the last day. Multi-day all-day events SHALL read "ganztägig · bis <day>", running spans SHALL appear under "Heute", and the venue SHALL appear in the month day list.

#### Scenario: Event spans several days
- **WHEN** an all-day event runs until Friday
- **THEN** its entry SHALL read "ganztägig · bis Fr" with the date

### Requirement: Calendar export is subscribable

Timed events without an end SHALL export a one-hour duration. The feed SHALL send `REFRESH-INTERVAL` and `X-PUBLISHED-TTL`, and the UI SHALL offer "In Kalender-App abonnieren" with a `webcal://` link.

#### Scenario: Event without end
- **WHEN** the feed contains a timed event without end
- **THEN** its `DTEND` SHALL be start plus one hour
