## ADDED Requirements

### Requirement: Member can disconnect PayPal

A member SHALL be able to remove a stored PayPal recipient after confirmation. The disconnect SHALL run under the same payment lock as connect and capture, SHALL work without PayPal being configured, and SHALL be rejected with `409 paypal_payment_pending` while a payment is active. The same pending-payment message SHALL be used when account deletion, member deactivation or WG deletion is blocked by an active payment.

#### Scenario: Disconnect without active payment
- **WHEN** a member confirms "PayPal trennen" and no payment is active
- **THEN** the stored recipient SHALL be cleared and the profile SHALL show PayPal as not connected

#### Scenario: Disconnect during active payment
- **WHEN** a payment is pending
- **THEN** the system SHALL respond `409 paypal_payment_pending` and keep the recipient
