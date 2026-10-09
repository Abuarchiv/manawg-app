## Purpose

Make the WG chat reliable for text, images, mentions and orientation.

## ADDED Requirements

### Requirement: Images can be sent

The composer SHALL attach an image, allow image-only messages, and block sending while an upload is pending.

#### Scenario: Image only
- **WHEN** a member sends an image without text
- **THEN** the message SHALL be posted

### Requirement: Mentions are exact

Mention detection SHALL prefer the longest member name, SHALL require a boundary before `@`, and SHALL NOT treat part of an e-mail address as a mention.

#### Scenario: Name prefix
- **WHEN** members "Anna" and "Anna Lena" exist and a message mentions "@Anna Lena"
- **THEN** only "Anna Lena" SHALL be mentioned

### Requirement: Edits and reactions are guarded

Editing a message SHALL require the sender, a text message and no deletion, otherwise `409 message_deleted`. New reactions SHALL require a pictograph, flag or keycap emoji, while removal SHALL stay lenient so old reactions can be removed.

#### Scenario: Edit after deletion
- **WHEN** a sender edits a deleted message
- **THEN** the server SHALL answer `409 message_deleted`

### Requirement: Orientation aids

The list SHALL show a "Neue Nachrichten" separator at the first unread message, "Heute"/"Gestern" day labels (with year for earlier years), a quote header for replies to older messages, reactor names, a "Link öffnen" action for http(s) links, and a link from expense system messages to the expense.

#### Scenario: Unread messages on entry
- **WHEN** a member opens a chat with unread messages
- **THEN** a "Neue Nachrichten" separator SHALL precede the first unread message
