## Purpose

Keep offline behavior and shared UI primitives honest.

## ADDED Requirements

### Requirement: Backoff reflects real failures

Plain connection failures (no status, fetch error, timeout) SHALL NOT increase attempts or the backoff of a queued action, and automatic sync SHALL wait while the browser is offline. HTTP and sign/upload errors SHALL keep the backoff.

#### Scenario: Offline for a long time
- **WHEN** a queued action fails only because the device is offline
- **THEN** its attempt count SHALL NOT grow

### Requirement: Offline pages do not offer dead links

On the offline page the "Zurück zu" button and known-WG links SHALL be disabled with a hint while the browser is offline. The queue card SHALL list the newest actions first.

#### Scenario: Offline hero button
- **WHEN** the browser is offline
- **THEN** the WG button SHALL be disabled and a hint SHALL be shown

### Requirement: Controlled components follow their parent

Checkbox, Switch and Collapsible SHALL show the value of a provided prop, so a rejected change does not leave the control out of sync.

#### Scenario: Parent rejects a change
- **WHEN** a parent keeps a controlled value unchanged after a toggle
- **THEN** the control SHALL display the unchanged value

### Requirement: Keyboard and error pages are accessible

On-screen keyboard detection SHALL be one shared hook used by the bottom navigation and the expense form. The WG error page heading SHALL receive focus on mount. The root layout SHALL NOT set a global canonical URL.

#### Scenario: Error page opens
- **WHEN** the WG error page renders
- **THEN** its heading SHALL be focused
