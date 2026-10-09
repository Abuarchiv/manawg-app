## Purpose

Let members plan, change and complete chores with reminders that respect absences and a plan that stays truthful.

## ADDED Requirements

### Requirement: Chores can be edited after creation

Any member SHALL be able to edit a chore's title (trimmed, 1-120 characters, otherwise `title_invalid`), assignee (including "Niemand"), due date and rhythm. The client SHALL send only changed fields and SHALL reload on `chore_changed`. The create form SHALL offer an optional first due date that flows into the request, the offline queue and the local preview.

#### Scenario: Only the title changes
- **WHEN** a member renames a chore
- **THEN** the request SHALL contain only the title

### Requirement: Absences are respected

Reminders SHALL NOT be sent to an assignee with an absence on the current Berlin day. The plan SHALL mark chores of absent assignees and offer "Ich übernehme".

#### Scenario: Assignee is absent today
- **WHEN** the reminder run finds a due chore whose assignee is absent today
- **THEN** that assignee SHALL receive no reminder and the plan SHALL show "Name ist abwesend"

### Requirement: Reassignment updates related state

Changing the assignee SHALL close open swap requests for the chore and, when it is not a self-take and the chore is due within 24 hours, send a `chore.due` push to the new assignee. Deleting a chore SHALL close its swap requests.

#### Scenario: Assigned to another member
- **WHEN** an admin assigns a chore due tomorrow to another member
- **THEN** that member SHALL receive a `chore.due` push

### Requirement: Failures are explained and overdue is filterable

Completing or removing a chore SHALL distinguish read-only maintenance, expired session, admin-only and network errors. `?filter=overdue` SHALL show only overdue chores with a notice and "Alle anzeigen", and SHALL show the full list when nothing is overdue.

#### Scenario: Maintenance mode
- **WHEN** completion fails with `migration_read_only`
- **THEN** the dialog SHALL stay open with a maintenance message
