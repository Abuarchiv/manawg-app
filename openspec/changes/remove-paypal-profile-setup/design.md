## Context

Existing Orders/Capture uses wgMembers.paypalMerchantId and records confirmed capture. User wants provider-hosted account connection instead of manually entering that ID. Payment choices remain with PayPal.

## Decisions

- Use Partner Referrals with PAYMENT and EXPRESS_CHECKOUT; Identity OAuth alone gives no payment authorization. PayPal hosts login/account/eligibility. Do not promise German personal-account support; country rules may require a business account.
- One connection API /api/wg/[code]/paypal/connect: GET status, POST start or confirm, plus a generic redirect-only /api/paypal/return callback with no database writes, Cache-Control:no-store and Referrer-Policy:no-referrer. Starting requires affirmative informed data-sharing consent through the labelled user action before sending SHARE_DATA_CONSENT.granted=true.
- HMAC-signed 30-minute HttpOnly cookie binds a stable opaque customer tracking ID (SHA256 of domain prefix, environment, platform client ID and authenticated user ID), random attempt nonce, WG/member/auth-user IDs, expected prior merchant ID, invite code and environment. PayPal gets only the generic /api/paypal/return URL with an opaque state nonce; this redirect-only callback verifies signed state and exact returned nonce, then redirects to the bound settings page with paypal=return. The browser makes authenticated confirm POST. Cookie Path=/api covers both callback and connection route. The WG share code is an invite capability and MUST NOT be transmitted to PayPal. Stable tracking follows PayPal's customer-ID semantics and permits the same user to reuse one account in another WG without relying on undocumented per-attempt tracking updates.
- merchantIdInPayPal is only an untrusted lookup hint. Fetch provider merchant integration and require matching merchant_id AND signed tracking_id, payments_receivable, primary_email_confirmed, active EXPRESS_CHECKOUT, and payment scopes for our exact partner_client_id. Return hints alone never establish connection or payment.
- Provider requests outside database transaction. Persist with payment lock then lockActiveAccountMember. Same saved ID is idempotent. For legacy/manual account correction, sign the expected previous ID into the attempt at start; replace only the provider-verified account under the payment lock when the current ID is unchanged and no payment is active. Reject concurrent changes. No separate relinking/disconnect subsystem.
- Keep the existing member field and payment records. Remove the manual member PATCH setter. Verify provider readiness for legacy IDs and before each new order, covering revoked consent without a webhook subsystem. Provider integration-not-found means not ready; authentication/network/5xx errors remain unknown instead of blocking recovery from a genuinely missing legacy integration.
- Configured trusted app origin generates return URLs. Exact environment-specific PayPal action URL host is required. Do not send WG session credentials, user password or email to PayPal.
- Payer uses existing PayPal SDK window. Only backend-confirmed completed capture changes balances; connection return, approval, cancel and refresh never imply payment.

## API contract

GET: {available:boolean,connected:boolean}, no-store. POST start: {action:'start',consent:true} returns {url:string} plus signed cookie. POST confirm: {action:'confirm',merchantId:string} returns {connected:true}. Pending provider readiness: paypal_onboarding_pending. Invalid/expired/mismatched cookie: paypal_connection_expired. Existing different account: paypal_account_already_connected. Authenticate and rate-limit mutations; member identifiers come only from existing guards.

## UI

PayPal verbinden with adjacent explicit data-sharing explanation, then PayPal verbunden after server confirmation. Settings loads own status, verifies returns and removes hints from URL. Debt flow retains manual settlement and PayPal checkout; unconnected recipients get a clear connection requirement. Missing configuration gets a plain unavailable state.

## Verification

Unit/route tests: consent, host validation, cookie tampering/expiry/identity/environment mismatch, provider readiness/client scopes, forged return, deactivation and concurrent persistence. Fixture browser tests: no typed ID, start/return/pending, unchanged manual settlement, payment only after capture. Type/lint/build, payment regressions, independent review and graph update.

## Deployment prerequisites

PayPal approved platform partner, Platform REST app, existing client ID/secret/BN code plus PAYPAL_PARTNER_MERCHANT_ID and trusted NEXT_PUBLIC_APP_URL. No local PayPal credentials were found in inspected main env files; hosted config unverified. Fixture success does not prove real provider onboarding or payment.

## Sources

https://developer.paypal.com/platforms/seller-onboarding/before-payment
https://developer.paypal.com/api/partner-referrals/v2/schema.json
https://developer.paypal.com/platforms/seller-onboarding
https://developer.paypal.com/platforms/get-started
