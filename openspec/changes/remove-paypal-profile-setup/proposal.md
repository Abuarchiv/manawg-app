## Why

The owner rejects manually typed PayPal IDs. The approved journey is recipient account connection via PayPal once, then payer login/payment at PayPal or manual settlement. PayPal owns account eligibility and payment choices.

## What Changes

- Replace the manual field with official hosted account connection and verified return handling.
- Reuse Orders/Capture and settlement; check recipient readiness before new payments.
- Remove arbitrary Merchant-ID writes from the member API.
- Preserve existing stored payments, account safeguards and profile controls.

## Capabilities

### New Capabilities
- `paypal-profile-free`: Provider-verified account connection and payment without typed PayPal data.

### Modified Capabilities
None.

## Impact

Profile/debt UI, provider helper, connection API, member PATCH, focused tests and environment documentation. No schema migration, new dependency or actual money movement by this development task.
