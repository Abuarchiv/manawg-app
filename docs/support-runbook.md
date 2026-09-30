# ManaWG support and incident triage

This is a diagnostic guide, not evidence that delivery, recovery, or a release has passed. The current release status is in [TASKS.md](../TASKS.md) and the dated [candidate record](releases/release-candidate.md). Database recovery and production changes follow the separate [recovery runbook](database-recovery.md).

## First response

1. Record the environment, UTC time, deployment ID and exact commit SHA, affected journey, visible error code, and whether a write or payment may have succeeded. Reproduce only with authorized test accounts and test WGs.
2. Check `https://app.manawg.com/api/health` for `status`, `database`, missing-required count and degraded feature names. HTTP 200 proves only this probe. Respect its rate limit.
3. With authorized Vercel access, inspect `vercel logs --project manawg-app --scope abditubes-projects --level error --since 1h --limit 100` and query HTTP 500 separately with `--query 'status:500'`. Retain only a restricted incident reference, time and trace ID in support records; raw logs may contain customer data.
4. If payment state, financial totals, membership/privacy, or deletion outcome is uncertain, stop retries and escalation-sensitive writes. Assign an incident owner before corrective action. Never repair balances, membership, Auth links, or migration ledgers directly from a support ticket.

Never ask a resident for a password, reset link, OTP, session cookie, member token, calendar feed URL, payment credential, browser-storage dump, or private export. Do not paste these into tickets or logs. No on-call recipient or alarm delivery has been verified yet; the release gate remains open.

## Journey checks

| Report | Safe check | Escalate or avoid |
| --- | --- | --- |
| Sign-in, signup or reset mail | `/neu` uses Supabase Auth; `/auth/callback` completes the session and `/auth/reset` needs the short-lived recovery session. Check Supabase Auth/SMTP logs, sender/redirect configuration and a controlled mailbox delivery test. | A successful reset request does not prove receipt. Do not reveal whether an address has an account, generate a resident link, or ask for the link. Provider configuration and actual mail receipt are still unverified. |
| Invite, joining or switching accounts | Invitations are share-code links, not email messages. Check the authenticated `POST /api/wg/[code]/members` result (`auth_required`, `wg_not_found`, `joining_disabled`, `member_limit_reached`, `already_joined`, `name_taken`). Account switch signs out locally and preserves the join intent. | Use two authorized test identities to distinguish a stale browser session from an actual WG permission problem. Do not join a resident to a WG by editing the database. |
| Member deactivation or unexpected access | Admins use `PATCH /api/wg/[code]/members/[id]`; deactivation retains financial history. Verify membership with the authenticated account and a revoked-member denial in Preview. | Treat cross-WG access or continued access after deactivation as a privacy incident. The current candidate has no completed hosted two-user/revocation acceptance. |
| Expense, debt or PayPal | Read the saved expense and split state before a retry. For a PayPal order, reconcile the order ID and provider capture status; settlement is accepted only after provider `COMPLETED`. | Never create a second payment, refund, mark a split paid, or retry an uncertain capture from a support ticket. PayPal test credentials and hosted settlement proof are still missing. |
| Calendar or Web Push | Manage feeds through `/api/wg/[code]/calendar-subscription`; treat `/api/calendar/[id]/[token]` as a credential and rotate/revoke if exposed. Check notification settings and `/api/health` degraded features; a push test needs visible receipt on the authorized device. | HTTP success alone does not prove a device received a notification. Do not paste feed URLs or push subscription data into logs. Live device, consumer calendar and cron delivery remain unverified. |
| Offline sync or export | Ask for the queue count and on-screen conflict/error from `/offline` or settings. Use “Server prüfen”, then the UI's edit/retry path. WG export is `GET /api/wg/[code]/export` (JSON or scoped CSV); `export_incomplete` means the result must not be used. | Offline payloads are stored in browser `localStorage`; never request a dump. A WG export omits Storage object bytes and is not a provider backup. |
| Account deletion | `DELETE /api/account` can return completed (200), pending (202), or an unconfirmed/unavailable result (503). The scheduled maintenance job retries pending work. | Do not manually invoke `/api/cron/maintenance` as a diagnostic: it performs deletion retries and cleanup. Preserve the incident reference and check the normal scheduled result. |

## Operations and ownership

The application writes redacted error types to Vercel runtime logs. A manual log query with zero matches is not proof that alerts are configured or received. Before release, record the named support/on-call owner, alarm destination, an authorized test signal and confirmed receipt for HTTP/Auth/DB/payment/upload/push/cron failures. On 2026-09-25, seven-day Vercel queries returned no error-level or HTTP 500 events; this did not verify an alert rule.

For data loss, a failed migration, or an uncertain restore, stop here and follow [database-recovery.md](database-recovery.md). The accepted no-cost local SQL export is one snapshot; its local import check does not establish hosted Auth login, object-byte recovery, or service RTO.
