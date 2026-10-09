## Why

The 2026-10 app audit (round 1) inspected every WG module in `apps/web` and fixed 120 findings. Most were bugs, but a number changed what members can see or do: new editing paths, new filters, new notifications and new read-only rules. AGENTS.md requires an OpenSpec change for new behavior, so this change records the audit's user-visible behavior as specifications and lists every fix as a completed task.

## What Changes

- **Expenses:** selectable expense date with range validation, participant selection for equal splits, search and filter, offline date preservation, import de-duplication against existing expenses only, fuzzy member matching with review hints, and creator/admin-only changes to recurring expenses.
- **Settlement:** pair-wise offsetting of opposite debts, self-healing PayPal orders (stale orders replaced, hung captures released), specific PayPal error messages, a `expense.debt_settled` notification, and a "PayPal trennen" action.
- **Chores:** edit title, assignee, due date and rhythm; optional first due date; overdue filter; absence-aware reminders and plan hints; push to a newly assigned member.
- **Shopping and inventory:** edit shopping items, offline-aware list overlay, no bulletin notice per tick; consolidated inventory taps, restock prompt after a purchase, duplicate-name protection, threshold-only low-stock pushes.
- **Calendar, chat, bulletin board:** read-only events for non-owners, multi-day and webcal subscription support; image messages, mention and emoji fixes, unread marker, links and reactor names; editable posts, admin moderation, and `announcement_resolved` conflict handling.
- **Dashboard and export:** bounded, correctly attributed activity timeline with "Wer" filter and paging; richer CSV/JSON export.
- **Access and settings:** active-member-only member limit, moved-out hint, invite-code paste, phone normalization, member rename, push opt-out that survives sign-out, HEIC conversion, confirmed discard of queued actions.
- **Platform:** offline backoff only for real failures, controlled-state fix, offline-aware navigation, shared keyboard detection, queue shown newest first, error-page focus.

## Capabilities

### New Capabilities

- `expense-recording`: Create, edit, filter, import and automatically book expenses.
- `expense-settlement`: Debt offsetting, manual and PayPal settlement, and settlement notifications.
- `chore-planning`: Chore creation, editing, reminders, absences and reassignments.
- `shopping-list`: Shopping item editing, offline overlay and idempotent state changes.
- `household-inventory`: Stock quantity changes, restocking and duplicate protection.
- `wg-calendar`: Event permissions, multi-day display and external calendar subscription.
- `wg-chat`: Image messages, mentions, reactions, links and read marker.
- `pinnwand-announcements`: Editing, moderation, drafts and resolution of bulletin posts.
- `activity-timeline`: Dashboard feed, activity timeline filters and WG data export.
- `wg-access-entry`: Sign-in, join and recovery flows, member limit and invite codes.
- `member-settings`: Profile, member management, push preferences and offline queue.
- `offline-platform`: Offline queue behavior, shared UI state hooks and error pages.

### Modified Capabilities

- `paypal-profile-free`: Adds an explicit disconnect action.
- `daily-wg-overview`: Own chores that are four or more days away appear in the agenda under "Anstehend".

## Impact

- `apps/web/src/features/{expenses,chores,shopping,inventory,calendar,chat,pinnwand,dashboard,settings}`, `src/components`, `src/core/offline`, `src/core/infra` and the matching `src/app/api/wg/[code]/**` routes.
- Server behavior: `POST/PATCH` expenses accept a validated `occurredAt`; chores, shopping, pinnwand and member `PATCH` routes accept new fields; `consume`, `settle` and PayPal routes change responses (`409 recurring_expense_not_booked`, `409 paypal_payment_pending`, `409 message_deleted`, `409 announcement_resolved`, `409 inventory_item_duplicate`, `409 name_taken`).
- New notification event `expense.debt_settled`. No schema migration and no new dependency.
- Existing e2e expectations in `chores-regressions`, `pwa`, `settings-access`, `calendar-fixes` and `expense-ui-overlay` were adjusted but not executed.

## Non-goals

No redesign of navigation, no new database tables or columns, no change to the settlement ledger model, and no free-form chore intervals. Round 2 of the audit and hosted Preview verification are separate work.
