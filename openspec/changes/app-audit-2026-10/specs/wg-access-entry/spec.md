## Purpose

Make creating, joining and recovering access to a WG predictable.

## ADDED Requirements

### Requirement: Member limit counts active members

The member limit SHALL count only active members, evaluated under the WG row lock.

#### Scenario: Moved-out members
- **WHEN** a WG is at its limit including moved-out members
- **THEN** a new member SHALL be able to join if active members are below the limit

### Requirement: Sign-in and recovery are consistent

Signed-in users SHALL NOT see the sign-in callback error, and the parameter SHALL be removed from the URL. Signed-in users on an unusable reset link SHALL be offered to sign out and request a new link. Phone numbers SHALL be normalized (spaces, dashes, brackets, slashes and dots removed, `00` read as `+`). "Altes Profil wiederherstellen" SHALL appear only when candidates exist, and its request SHALL time out.

#### Scenario: Phone with separators
- **WHEN** a user enters "+49 (0) 151-123/456"
- **THEN** the OTP request SHALL use the normalized number

### Requirement: Rate limit and routes behave honestly

The WG-create rate limit SHALL be consumed only after the body and authentication are valid, with its own message. Public module routes SHALL return 404 for names such as `constructor` and `__proto__`.

#### Scenario: Invalid body
- **WHEN** a create request has an invalid body
- **THEN** no rate-limit budget SHALL be consumed

### Requirement: Invite codes and moved-out members are handled

Opening `?code=X` for a WG the account already belongs to SHALL redirect to that WG. A moved-out member opening a WG SHALL be sent to `/neu` with `reason=moved_out` and an explanation. Pasting text containing "Code XXXXXXXX" or a `?code=` link SHALL fill the code field.

#### Scenario: Moved-out member
- **WHEN** a deactivated member opens the WG
- **THEN** the member SHALL see the moved-out notice instead of "no access"
