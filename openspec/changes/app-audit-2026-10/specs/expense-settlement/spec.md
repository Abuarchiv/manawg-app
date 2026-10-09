## Purpose

Settle debts between members correctly by hand or through PayPal, never leave a WG blocked by an abandoned payment, and tell the counterparty.

## ADDED Requirements

### Requirement: Opposite debts offset as a pair

When a settlement scope includes both directions between two members and no payment is pending for the pair, the system SHALL settle both directions together and the dialog SHALL show counter-claims with a minus sign.

#### Scenario: Mutual debts
- **WHEN** A owes B 20 EUR and B owes A 5 EUR and A settles
- **THEN** both directions SHALL be settled together and only the net amount SHALL be paid

### Requirement: Abandoned PayPal orders do not block the WG

An unapproved order SHALL be reset after an unconfirmed capture response. The reconcile run SHALL mark orders older than one hour as failed unless a capture is pending, including when the provider no longer knows the order. Creating an order SHALL replace an open order whose amount differs from the current debt and SHALL reuse an open order with the same amount without a provider call.

#### Scenario: Debt changed since the order
- **WHEN** a member starts payment and an earlier open order has a different amount
- **THEN** the earlier order SHALL be failed and a new order SHALL be created for the current debt

### Requirement: PayPal errors are explained

The payment UI SHALL show the specific message for known error codes. For `debt_changed`, `paypal_order_expired`, `paypal_order_unavailable` and `paypal_order_not_found` it SHALL reload the debt. The "Prüfe den Zahlungsstatus" warning SHALL appear only for genuinely pending or unclear states.

#### Scenario: Expired order
- **WHEN** capture fails with `paypal_order_expired`
- **THEN** the UI SHALL show the specific message and reload

### Requirement: Counterparty is notified of settlement

The system SHALL send the notification event `expense.debt_settled` to the counterparty after a manual batch settlement that settled at least one share, after a single-share settlement that completed, and after a PayPal capture. The reconcile cron SHALL NOT notify.

#### Scenario: Nothing settled
- **WHEN** a batch settlement settles no share
- **THEN** no notification SHALL be sent

### Requirement: Balances and reminders are unambiguous

Balance lists SHALL omit zero rows, showing one "ausgeglichen" entry per active member without balance and moved-out members only with a balance. Reminder messages SHALL always carry the debt currency.

#### Scenario: Moved-out member without balance
- **WHEN** a moved-out member has no open balance
- **THEN** the member SHALL NOT appear in the balance list
