import { berlinDayKey, berlinWallMinutes, instantAtBerlinWallTime } from '@/core/utils/berlin-day';
import { parseValidDate } from '@/core/utils/time';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** Noon keeps a freshly chosen day away from midnight and DST gaps. */
const DEFAULT_DUE_MINUTES = 12 * 60;

/**
 * ISO instant for a day picked in a date input. The wall time stays that of `previousDueAt`
 * (editing keeps a chore's usual hour), or noon for a new chore. Null for an invalid day.
 */
export function dueAtForDay(dayKey: string, previousDueAt?: string): string | null {
	if (!DAY_KEY.test(dayKey)) return null;
	const previous = previousDueAt ? parseValidDate(previousDueAt) : null;
	const minutes = previous ? berlinWallMinutes(previous) : DEFAULT_DUE_MINUTES;
	return instantAtBerlinWallTime(dayKey, minutes)?.toISOString() ?? null;
}

/** Berlin day of a stored due date for a date input; empty when the date is unusable. */
export function dueDayKey(iso: string): string {
	const date = parseValidDate(iso);
	return date ? berlinDayKey(date) : '';
}
