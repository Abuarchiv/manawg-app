## ADDED Requirements

### Requirement: Profile without PayPal setup
The application SHALL display profile and appearance settings without a manually editable PayPal account field, and SHALL offer provider-hosted connection when configured.

#### Scenario: Member opens profile
- **WHEN** a member opens profile settings
- **THEN** no Merchant-ID or PayPal.me field is displayed
- **AND** no manually typed Merchant-ID update is available
- **AND** the member identity and theme controls remain usable

### Requirement: Preserve payment integrity
Removing profile configuration SHALL NOT delete existing payment records or change automatic capture and manual settlement safeguards.

#### Scenario: Existing payment is pending
- **WHEN** the profile setup is removed
- **THEN** existing payment endpoints and pending-payment protections remain available

### Requirement: Provider-verified account connection
The application SHALL remember only a provider-verified recipient account after explicit informed data-sharing consent. PayPal SHALL own login and account eligibility. Completion MUST bind to the same authenticated member, WG, environment and unexpired attempt.

#### Scenario: Completed connection
- **WHEN** PayPal confirms the matching tracking and account identity, receiving eligibility and payment permissions
- **THEN** the account is stored and displayed connected without typed PayPal data

#### Scenario: Incomplete or forged return
- **WHEN** return hints are forged, binding expires or provider eligibility is incomplete
- **THEN** no connection or settlement is recorded

### Requirement: Confirmed PayPal payment
The application SHALL retain manual settlement and SHALL record PayPal settlement only after backend-confirmed completed capture. It MUST verify recipient readiness before a new order.

#### Scenario: Approved but not captured
- **WHEN** the payer approves or cancels a PayPal window without confirmed capture
- **THEN** the debt remains open

#### Scenario: Completed capture
- **WHEN** the backend confirms the matching completed capture
- **THEN** the existing payment record updates balances without an additional manual settlement
