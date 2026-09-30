/**
 * Pure helpers for recurring-chore due-date math.
 *
 * Bug history #1: an earlier implementation computed `nextDueAt` from
 * `Date.now()` only. For a monthly chore completed 5 days early, the next due
 * also slid 5 days earlier — across a year this drifts ~60 days off-cadence.
 *
 * Fix #1: anchor the next due on the previous due so the cadence stays stable,
 * but clamp to `completedAt` so a massively-overdue chore is not scheduled in
 * the past.
 *
 *   nextDueAt = max(prevDueAt, completedAt) + intervalDays * MS_PER_DAY
 *
 * Bug history #2: "monatlich" was encoded as `intervalDays = 30`, but 12×30
 * = 360 days, so a chore created Jan 1 fires Dec 27 by year end. Real users
 * notice this.
 *
 * Fix #2: introduce `recurrenceType: 'days' | 'months'`. The 'months' branch
 * uses `Date.setMonth(anchor.getMonth() + interval)` so 12 monthly cycles land
 * on the exact same calendar day each year. Month-end is clamped (Jan 31 + 1
 * month → Feb 28/29, NOT March 3) the same way JS clamps natively after the
 * overflow-detection step.
 *
 * Bug history #3: the 'days' branch advanced with `interval * MS_PER_DAY`, an
 * absolute duration. Across Berlin's DST transitions that shifts the wall clock
 * of the due date by an hour and — for due times near midnight — lands on the
 * wrong calendar day (due 00:00, interval 7 → 25.10 23:00 instead of 26.10
 * 00:00). It now adds calendar days in Europe/Berlin, the same wall-clock
 * re-alignment the events feature uses for recurrence occurrences.
 *
 * Bug history #4: lateness was measured against the due *timestamp*, so a
 * completion on the due day at 18:00 (due 09:00) counted as "late" and
 * re-anchored the monthly cycle on `completedAt` — the normal case, which made
 * the stored anchor unusable. Lateness is now a Berlin calendar-day comparison
 * (`isLateCompletion`): only a completion after the due *day* has passed
 * re-anchors the cycle.
 */

import type { ChoreRecurrenceType } from '@/core/db/schema';
import { addBerlinDays, berlinDayKey } from '@/core/utils/berlin-day';

/**
 * Compute the next due date for a recurring chore after completion.
 *
 * @param prevDueAt      the chore's current `nextDueAt` before completion
 * @param interval       cadence in days OR months (see `recurrenceType`);
 *                       `0` keeps the previous due (one-shot)
 * @param completedAt    timestamp at which the chore was completed
 * @param recurrenceType `'days'` (calendar days in Berlin, legacy default) or
 *                       `'months'` (calendar-accurate via `setMonth`)
 * @param anchorAt       original cadence anchor; keeps the month-end
 *                       day-of-month stable across clamps (31.01 → 28.02 →
 *                       31.03). Null on legacy rows — adopted from prevDueAt.
 *                       Store the *intended* day (the creation/requested date),
 *                       never a clamped first due date.
 */
export function computeNextDueAt(
	prevDueAt: Date,
	interval: number,
	completedAt: Date,
	recurrenceType: ChoreRecurrenceType = 'days',
	anchorAt?: Date | null,
): Date {
	if (!Number.isFinite(interval) || interval <= 0) {
		// One-shot / non-recurring chore: do not advance the cadence. The
		// route still rotates the assignee, so we return the existing due
		// date unchanged (acts as a no-op for the cadence stamp).
		return new Date(prevDueAt.getTime());
	}
	const anchorMs = Math.max(prevDueAt.getTime(), completedAt.getTime());
	if (recurrenceType === 'months') {
		// A genuinely late completion (after the due *day* in Berlin) re-anchors
		// the cycle on completedAt (documented behavior). Otherwise keep the
		// stored anchor so a month-end clamp (31.01 → 28.02) does not chain into
		// a permanent day-of-month drift.
		const late = isLateCompletion(prevDueAt, completedAt);
		const anchor = late ? completedAt : (anchorAt ?? prevDueAt);
		const anchorDay = anchor.getUTCDate();
		const next = addCalendarMonths(new Date(anchorMs), interval);
		const lastDay = new Date(
			Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
		).getUTCDate();
		next.setUTCDate(Math.min(anchorDay, lastDay));
		return next;
	}
	// Calendar days in Berlin: raw 24h arithmetic drifts by an hour across DST
	// and can move the due to the neighbouring Berlin day near midnight.
	return addBerlinDays(new Date(anchorMs), interval);
}

/**
 * Whether a completion belongs to a later Berlin day than the due date.
 *
 * Compared against the due *day* (Europe/Berlin), not the due timestamp: a
 * chore due 09:00 and completed the same day at 18:00 is on time, and must
 * not re-anchor the cadence — otherwise every normal completion throws the
 * stored anchor away and month-end days drift one step at a time.
 */
export function isLateCompletion(prevDueAt: Date, completedAt: Date): boolean {
	return berlinDayKey(completedAt) > berlinDayKey(prevDueAt);
}

/**
 * First due date and cadence anchor for a newly created chore (#507).
 *
 * The two are deliberately not the same value: an explicitly requested due
 * date is stored verbatim (the server never clamps it, so its day-of-month is
 * the day the member asked for), while the computed first due is the
 * *clamped* result — a monthly chore created on 31.01 is first due 28.02.
 * Storing that clamp as the anchor would freeze the day-of-month at 28
 * (28.02 → 28.03 → 28.04) instead of the intended 31.01 → 28.02 → 31.03, so
 * the anchor for a computed due is the un-clamped creation date.
 */
export function computeInitialDue(
	createdAt: Date,
	interval: number,
	recurrenceType: ChoreRecurrenceType,
	requestedDueAt: Date | null,
): { nextDueAt: Date; anchorAt: Date } {
	if (requestedDueAt) {
		return { nextDueAt: new Date(requestedDueAt), anchorAt: requestedDueAt };
	}
	return {
		nextDueAt: computeNextDueAt(createdAt, interval, createdAt, recurrenceType),
		anchorAt: createdAt,
	};
}

/**
 * Add `months` calendar months to `anchor`, clamping to the last day of the
 * target month when the anchor's day-of-month does not exist there.
 *
 * Native `Date.setMonth` overflows silently — e.g. Jan 31 + 1 month becomes
 * March 3 because Feb 31 → March 3. We detect the overflow by comparing the
 * resulting month to the expected month (modulo 12) and roll back to the
 * last valid day of the target month.
 *
 * Examples:
 *   addCalendarMonths(2026-01-31, 1)  → 2026-02-28
 *   addCalendarMonths(2024-01-31, 1)  → 2024-02-29 (leap year)
 *   addCalendarMonths(2026-01-15, 12) → 2027-01-15 (exact, no ms drift)
 *
 * All math is done in UTC to match how chore due dates are stored
 * (`timestamp with time zone`, server-anchored).
 */
function addCalendarMonths(anchor: Date, months: number): Date {
	const result = new Date(anchor.getTime());
	const originalDay = result.getUTCDate();
	const targetMonth = result.getUTCMonth() + months;
	// setUTCMonth handles year roll-over for us; we only need to detect the
	// day-overflow case afterwards.
	result.setUTCMonth(targetMonth);
	// Expected month after normalization, e.g. Jan(0) + 13 → Feb(1) of year+1.
	// JS Date already normalizes the year on us; we just need the modulo.
	const expectedMonth = ((targetMonth % 12) + 12) % 12;
	if (result.getUTCMonth() !== expectedMonth) {
		// Overflow happened: rewind to last day of the expected month by
		// setting the day to 0 of the month after `expectedMonth` (day 0 = last
		// day of previous month). Preserve the year that JS already advanced.
		result.setUTCDate(0);
	}
	// Preserve the original day-of-month when valid (idempotent re-set is a
	// no-op; only matters if we did NOT overflow but want to be defensive).
	// We do NOT re-set originalDay if we just clamped, because that would
	// re-introduce the overflow.
	if (result.getUTCDate() > originalDay) {
		// Should not happen with the above logic, but guard for safety.
		result.setUTCDate(originalDay);
	}
	return result;
}
