## 1. Expenses

- [x] 1.1 Offline-recorded expenses (new, recurring booking, edit with changed date) carry `occurredAt` in the queue payload; server validates it with one shared range schema (max now + 2 days, max 5 years old, `occurred_at_invalid`) for POST and PATCH.
- [x] 1.2 Expense form gets a date field (default today, max today, prefilled on edit); `occurredAt` is only sent when the day differs from the default; optimistic list sorts by date.
- [x] 1.3 Equal-split mode with participant selection (all preselected, last person stays selected) in expense form and recurring form; selection persists in the draft and equal subsets are recognized again on edit.
- [x] 1.4 Edit form warns when already paid shares are reopened by an amount or split change (`settledSharesAffectedByEdit`).
- [x] 1.5 Expense list search (description, payer) and segment filter (all / paid by me / I participate), visible from 6 entries, applied before week grouping; balances stay unfiltered; empty state "Keine passenden Ausgaben gefunden".
- [x] 1.6 "Entfernen" on an expense row only for payer or participants.

## 2. Import

- [x] 2.1 Import de-duplicates only against existing WG expenses (counter per key); repeated rows in the file get an `|#n` suffix; key logic moved to `import-duplicate-keys.ts`.
- [x] 2.2 `matchMembers` uses a length-dependent fuzzy threshold, never reuses exactly assigned members, and the mapping view labels suggestions "Vorschlag, bitte prüfen".
- [x] 2.3 Splitwise and Splid parsers report rejected rows (row, reason, description); preview shows an alert with a list; all-unreadable files report `rows_unreadable`.
- [x] 2.4 Import errors name description, date and amount of the row instead of "Eintrag N".

## 3. Recurring expenses

- [x] 3.1 "Erfassen" shows the server error message and reloads on permanent 4xx; booking is offered only to members the server accepts (payer or own share > 0).
- [x] 3.2 Redundant client advance PATCH removed (server advances in the booking transaction); the PATCH endpoint stays for old clients and queues.
- [x] 3.3 `advanceRecurringTemplate` advances only when an expense exists for the current due date, otherwise `409 recurring_expense_not_booked` without audit entry.
- [x] 3.4 Start-date hint "beim nächsten täglichen Lauf werden N Buchungen nachgetragen" (`countMissedOccurrences`, cap 13); preview "Nächste Buchungen" uses `anchorAt`.
- [x] 3.5 Deleting a recurring expense that is already gone (404) reloads instead of restoring the row.
- [x] 3.6 Pause, edit and delete limited to creator or admin with an explanatory hint; legacy rows without `createdByMemberId` keep the old behavior.
- [x] 3.7 Cron posts one bulletin notice when a template is skipped because its member moved out (first run within 25 h of the due date).

## 4. Settlement and PayPal

- [x] 4.1 `selectSettlementScope` offsets both directions of a member pair together (`offset` flag); the dialog shows counter-claims with a minus sign and explains transitive rows.
- [x] 4.2 Hung `capturing` payments no longer block the WG: the capture route resets an unapproved order after a 202, and the reconcile run fails stale orders older than 1 h (also on lookup 404) unless a capture is pending.
- [x] 4.3 Order POST replaces a `created` order whose amount differs and reuses an order with the same amount without a new PayPal call.
- [x] 4.4 `paypal-errors.ts` maps error codes to specific messages; stale-order codes reload via `onStale`; "Prüfe den Zahlungsstatus" remains only for real pending cases.
- [x] 4.5 New event `expense.debt_settled` (`notifySettlement`) notifies the counterparty after manual batch settlement, single-split settlement and PayPal capture; the reconcile cron does not notify.
- [x] 4.6 `currency` is required in `ReminderMessageInput`; the EUR fallback is removed.
- [x] 4.7 `listedMemberBalances` hides zero rows (one "ausgeglichen" row per active member without balance; moved-out members only with a balance).
- [x] 4.8 `disconnect` action on the PayPal connect route under the payment lock (`409 paypal_payment_pending` while a payment is active) and a "PayPal trennen" button with confirmation.
- [x] 4.9 `PAYPAL_PAYMENT_PENDING_MESSAGE` shared by account deletion, member deactivation, reactivation and WG deletion.

## 5. Chores

- [x] 5.1 Chore PATCH accepts `title` (trimmed, 1-120, `title_invalid`); `ChoreEditDrawer` edits title, assignee, due date and rhythm and sends only changed fields (`chore_changed` reloads).
- [x] 5.2 Optional "Erste Fälligkeit" in the create form, carried through body, fingerprint, offline queue and local preview.
- [x] 5.3 Reminder cron excludes assignees with an absence today (Berlin day bounds).
- [x] 5.4 Chores of absent assignees are marked in the plan with "Ich übernehme" repair hint; the absence toast is worded honestly.
- [x] 5.5 Open `chore_swap` announcements are closed on reassignment and on delete (`resolveChoreSwapRequest`, best effort).
- [x] 5.6 Chore completion and removal distinguish `migration_read_only`, `auth_required` and admin-only errors.
- [x] 5.7 `?filter=overdue` filters the plan with a notice and "Alle anzeigen"; falls back to the full list when nothing is overdue.
- [x] 5.8 Reassignment sends a `chore.due` push to the new assignee when it is not a self-take and due within 24 h.

## 6. Shopping and inventory

- [x] 6.1 `overlayQueuedShopping` shows unsynced offline creates and ticks over any server state without duplicates; rejected updates and foreign WG entries are ignored.
- [x] 6.2 Shopping PATCH accepts `name` and `quantity` (at least one field required, rename to an open name gives `409 duplicate`, audit `shopping.updated`); `ShoppingEditForm` and `use-shopping-edit` added.
- [x] 6.3 No bulletin notice per bought tick; a PATCH that already matches the stored state answers 200 as an idempotent no-op.
- [x] 6.4 Focus keeps scroll position after delete; list no longer waits for the inventory request (suggestions skeleton instead); queued follow-ups of a deleted item are dropped; newly added items scroll into view.
- [x] 6.5 `consumeInventoryMutation` pushes into the shopping list and dispatches `inventory.low_stock` only on crossing the threshold.
- [x] 6.6 Inventory edit sends quantity and version checks only when the quantity changed; a 409 keeps typed fields.
- [x] 6.7 `use-inventory-quantity` sums taps during a running request into one delta and rolls back to the server state on error.
- [x] 6.8 `InventoryRestockPrompt` ("X gekauft. Vorrat um N erhöhen?") wired into the shopping page; "Nicht jetzt" is remembered locally.
- [x] 6.9 Quick restock lists low items first (largest shortfall), then most consumed in 30 days, restocking to above the threshold.
- [x] 6.10 Duplicate inventory names are rejected with `409 inventory_item_duplicate` on POST and name-changing PATCH (`isInventoryNameTaken`); the modal pre-checks.
- [x] 6.11 Recent-decrement counts aggregate in SQL; dashboard refresh only on threshold crossing.

## 7. Calendar

- [x] 7.1 `getMonthBounds` covers the visible grid; agenda chore list starts at the local day start; month view uses `monthChoreOccurrences`.
- [x] 7.2 Multi-day all-day events show "ganztägig · bis Fr 09.10."; running spans appear under "Heute".
- [x] 7.3 Event modal is read-only for non-creators and non-admins; optimistic rows are not editable.
- [x] 7.4 Timed events without an end export `DTEND` = start + 1 h; the feed sets `REFRESH-INTERVAL` and `X-PUBLISHED-TTL`; "In Kalender-App abonnieren" offers a `webcal://` link.
- [x] 7.5 Venue appears in the month-view day list.

## 8. Chat

- [x] 8.1 Quote block for a reply to an older message; poll success clears the bootstrap error.
- [x] 8.2 Composer attaches images (image-only messages allowed, pending-upload guard).
- [x] 8.3 `findMentions` resolves the longest member name and ignores e-mail addresses.
- [x] 8.4 Message PATCH requires sender, text kind and not deleted (`409 message_deleted`).
- [x] 8.5 Reaction validation requires a pictograph, flag or keycap; reaction removal stays lenient.
- [x] 8.6 `includeReadMarker=1` returns a read marker and the list shows a "Neue Nachrichten" separator.
- [x] 8.7 "Link öffnen" menu item; reactor names in labels and menu; "Heute"/"Gestern" day labels with year for earlier years.
- [x] 8.8 `expense.created` system messages link to `/ausgaben?highlight=<expenseId>`.

## 9. Pinnwand

- [x] 9.1 Cancel and save clear the draft; only non-empty drafts that differ from the original are restored.
- [x] 9.2 Amount detection accepts Euro/EUR/€ before or after the number, with thousands separator.
- [x] 9.3 Authors can edit manual posts (PATCH `content`, audit before/after, `AnnouncementEditDrawer`).
- [x] 9.4 Admins can remove foreign replies and resolve foreign posts (audit `moderated:true`).
- [x] 9.5 Delete dialog shows the concrete error; background reload after card actions; "Übernehmen" on a resolved post answers `409 announcement_resolved`.
- [x] 9.6 Reaction buttons have a fixed accessible name; empty PATCH gives `400 invalid_body`; push delivery warnings use `toast.info`.

## 10. Dashboard and export

- [x] 10.1 Chronicle reads only member-written announcements; chat and duplicate audits are filtered in SQL; bought items are attributed to the buyer and sorted by `coalesce(bought_at, created_at)`.
- [x] 10.2 Activity route accepts `?limit=` (default 80, clamp 80..320) with "Ältere Einträge laden" and a filter note; "Wer" select (Alle / Nur ich).
- [x] 10.3 Absences use `createdAt`; overdue and own-chore agenda logic uses the Berlin day (`getChoreStatus`, `choreUrgency`); shopping notices no longer duplicate the reminder.
- [x] 10.4 Unique activity keys; server-set `sentence` flag replaces the verb regex.
- [x] 10.5 Export adds chore completions and inventory sections, member names and extra fields; CSV timestamps in Europe/Berlin, splits as `Name: 12,34`.

## 11. Access and entry

- [x] 11.1 Member limit counts active members only, under the WG row lock.
- [x] 11.2 `error=auth_callback` banner removed for signed-in users and cleared from the URL.
- [x] 11.3 Password reset offers "Abmelden und neuen Link anfordern" to signed-in users.
- [x] 11.4 WG-create rate limit runs after body parse and auth; own 429 message.
- [x] 11.5 `normalizePhoneInput` for OTP sign-in; `publicModule` uses `Object.hasOwn` (404 for `constructor`, `__proto__`).
- [x] 11.6 "Altes Profil wiederherstellen" only with candidates; claim fetch has a timeout.
- [x] 11.7 `?code=X` redirects to `/wg/X` for existing members; moved-out members get `reason=moved_out`; `extractInviteCode` on paste.

## 12. Settings

- [x] 12.1 Local push opt-out flag (`manawg-push-optout:`) survives sign-out and blocks auto-resubscribe; `pushActive` and device hints in the notification section; `endpoint_owned` handling.
- [x] 12.2 `router.refresh()` after toggling joins; rotation keeps `joiningEnabled`.
- [x] 12.3 HEIC/HEIF and large photos convert to JPEG (max 2048 px); upload hook has a 60 s timeout and stops on permanent 4xx.
- [x] 12.4 Members list shows an admin badge; owners can rename members (`MemberNameForm`, `409 name_taken`, audit `member.renamed`).
- [x] 12.5 Discarding queued offline actions asks for confirmation and removes the pending image.
- [x] 12.6 Fixed accessible names "Web Push" and "Neue Beitritte erlauben"; quiet-hours hint, equal start and end rejected.

## 13. Platform

- [x] 13.1 Plain connection failures no longer grow the offline backoff; auto-sync waits while offline; regression test for upload timeouts.
- [x] 13.2 `useControlledState` follows the prop; Checkbox, Switch and Collapsible reflect rejected changes.
- [x] 13.3 Offline page disables the WG hero button and known-WG links with a hint.
- [x] 13.4 `useKeyboardOpen` shared by bottom nav and expense form; root layout drops the global canonical `/`.
- [x] 13.5 Offline queue card shows newest first; WG error page heading takes focus.

## 14. Verification and follow-up

- [x] 14.1 Create this change and run `openspec validate app-audit-2026-10 --strict`.
- [ ] 14.2 Run `node scripts/check-architecture.mjs`, lint, typecheck, unit tests and build on the audit branch.
- [ ] 14.3 Run the adjusted e2e specs (`chores-regressions`, `pwa`, `settings-access`, `calendar-fixes`, `expense-ui-overlay`), which were changed but not executed.
- [ ] 14.4 Check manually: HEIC conversion on iPhone, join toggle refresh, rename, rotation and push opt-out flows.
- [ ] 14.5 Add per-page canonicals and `/neu` noindex (files outside the platform area) and run `graphify update .`.
