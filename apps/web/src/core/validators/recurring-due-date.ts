import { z } from 'zod';
import { MS_PER_DAY } from '@/core/utils/time';

// nextDueAt drives the cron's catch-up loop (one iteration per missed
// interval). An unbounded past date would translate into an unbounded
// charge storm, and a nonsensical far-future date would silently park the
// template; both are rejected on create and whenever an edit moves the
// due date.
const MAX_PAST_DAYS = 366;
const MAX_FUTURE_DAYS = 3650;

export function isRecurringDueAtInRange(value: string): boolean {
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return false;
	const skew = Date.now() - parsed;
	return skew <= MAX_PAST_DAYS * MS_PER_DAY && skew >= -MAX_FUTURE_DAYS * MS_PER_DAY;
}

/**
 * Whether an edit may set the template's due date to `value`. The edit
 * form always resends the current due date, so an unchanged value is
 * accepted even when it has drifted out of range (e.g. a long-paused
 * template); only a moved due date has to be in range.
 */
export function isRecurringDueAtEditAllowed(value: string, currentDueAt: Date): boolean {
	return Date.parse(value) === currentDueAt.getTime() || isRecurringDueAtInRange(value);
}

export const recurringDueAtSchema = z
	.string()
	.datetime({ offset: true })
	.refine(isRecurringDueAtInRange, { message: 'due_date_out_of_range' });

/** Longest interval a template supports, plus slack for month-length clamping. */
const MAX_ANCHOR_LEAD_DAYS = 24 * 31 + 1;

/**
 * Whether `anchorAt` can be the start of a template first due at `nextDueAt`.
 * Only its day-of-month matters to later due dates, so it merely has to lie
 * shortly before the first due date.
 */
export function isRecurringAnchorAllowed(
	anchorAt: string,
	nextDueAt: string,
	maxLeadDays = MAX_ANCHOR_LEAD_DAYS,
): boolean {
	const anchor = Date.parse(anchorAt);
	const due = Date.parse(nextDueAt);
	if (Number.isNaN(anchor) || Number.isNaN(due)) return false;
	return anchor <= due && due - anchor <= maxLeadDays * MS_PER_DAY;
}
