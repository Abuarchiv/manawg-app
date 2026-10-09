## Purpose

Let members correct their bulletin posts and let admins moderate without surprises.

## ADDED Requirements

### Requirement: Authors can edit manual posts

The author of a manually written post SHALL be able to edit its text (1 to the content maximum); the edit SHALL be audited with before and after content. Other members SHALL NOT edit it.

#### Scenario: Foreign edit
- **WHEN** another member edits the post
- **THEN** the server SHALL reject the edit

### Requirement: Admins moderate

Admins SHALL be able to remove foreign replies and mark foreign posts resolved, audited with `moderated: true`. Editing SHALL stay with the author.

#### Scenario: Admin removes a reply
- **WHEN** an admin removes another member's reply
- **THEN** the reply SHALL be removed and the audit entry SHALL be flagged moderated

### Requirement: Resolved posts and empty updates are rejected

Accepting a resolved post SHALL answer `409 announcement_resolved` and the client SHALL show "Dieser Beitrag wurde inzwischen geklärt." and reload. An update with no field SHALL answer `400 invalid_body` without writing.

#### Scenario: Empty update
- **WHEN** an empty PATCH arrives
- **THEN** no `updatedAt` or audit entry SHALL be written

### Requirement: Drafts and reloads stay calm

Cancel and save SHALL clear drafts, and only non-empty drafts differing from the original SHALL be restored. Actions on existing cards SHALL reload in the background so the board does not jump. Euro amounts SHALL be detected before or after the number (€, Euro, EUR), not inside words such as "europäisch".

#### Scenario: Reload after cancel
- **WHEN** a member cancels an edit and reloads
- **THEN** the editor SHALL NOT reopen
