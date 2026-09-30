import { z } from 'zod';

// nextDueAt drives the cron's catch-up loop (one iteration per missed
// interval). An unbounded past date used to translate into an unbounded
// charge storm, and a nonsensical far-future date silently parked the
// template — both are rejected on create and whenever an edit moves the
// due date.
const MAX_PAST_DAYS = 366;
const MAX_FUTURE_DAYS = 3650;
const DAY_MS = 86_400_000;

export function isRecurringDueAtInRange(value: string): boolean {
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return false;
	const skew = Date.now() - parsed;
	return skew <= MAX_PAST_DAYS * DAY_MS && skew >= -MAX_FUTURE_DAYS * DAY_MS;
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
