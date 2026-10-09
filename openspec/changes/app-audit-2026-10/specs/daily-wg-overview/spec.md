## ADDED Requirements

### Requirement: Own later chores stay in the agenda

An own chore that is not in "Für dich" because it is four or more days away SHALL appear in "Anstehend", labelled "Du". Overdue status SHALL be derived from the Europe/Berlin calendar day.

#### Scenario: Own chore next week
- **WHEN** a member's chore is due in five days
- **THEN** the agenda SHALL list it under "Anstehend" with the label "Du" and not under "Für dich"
