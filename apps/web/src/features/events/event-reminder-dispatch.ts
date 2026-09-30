import { berlinDayKey } from '@/core/utils/berlin-day';

export const EVENT_REMINDER_BUDGET = 10_000;
const DISPATCH_BATCH_SIZE = 10;
const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;

export type EventReminderCopy = 'today' | 'tomorrow';

export function startsInReminderWindow(
	occurrence: { startsAt: string },
	start: Date,
	end: Date,
): boolean {
	const startsAt = Date.parse(occurrence.startsAt);
	return startsAt >= start.getTime() && startsAt <= end.getTime();
}

export function reminderCopyForOccurrence(
	occurrence: { startsAt: string; endsAt: string | null; allDay: boolean },
	now: Date,
	todayStart: Date,
	tomorrowStart: Date,
	tomorrowEnd: Date,
): EventReminderCopy | null {
	if (startsInReminderWindow(occurrence, tomorrowStart, tomorrowEnd)) return 'tomorrow';

	const startMs = Date.parse(occurrence.startsAt);
	if (!Number.isFinite(startMs)) return null;
	if (occurrence.allDay) {
		const endMs = Date.parse(occurrence.endsAt ?? occurrence.startsAt);
		if (!Number.isFinite(endMs)) return null;
		const today = berlinDayKey(todayStart);
		return berlinDayKey(new Date(startMs)) <= today && berlinDayKey(new Date(endMs)) >= today
			? 'today'
			: null;
	}

	const endMs = occurrence.endsAt
		? Date.parse(occurrence.endsAt)
		: startMs + DEFAULT_EVENT_DURATION_MS;
	return startMs < tomorrowStart.getTime() && Number.isFinite(endMs) && endMs > now.getTime()
		? 'today'
		: null;
}

/** Complete occurrence preflight before the cron acquires any dispatch claims. */
export function collectReminderOccurrences<TRow, TOccurrence>(
	rows: readonly TRow[],
	expand: (row: TRow) => readonly TOccurrence[],
): TOccurrence[] | null {
	const due: TOccurrence[] = [];
	for (const row of rows) {
		for (const occurrence of expand(row)) {
			if (due.length === EVENT_REMINDER_BUDGET) return null;
			due.push(occurrence);
		}
	}
	return due;
}

export async function processReminderBatches<T>(
	items: readonly T[],
	claim: (item: T) => Promise<boolean>,
	dispatch: (item: T) => Promise<{ sent: number; failures?: readonly unknown[] }>,
	release: (item: T) => Promise<void>,
): Promise<{ sent: number; failed: number }> {
	let sent = 0;
	let failedCount = 0;
	for (let index = 0; index < items.length; index += DISPATCH_BATCH_SIZE) {
		const pending: T[] = [];
		try {
			for (const item of items.slice(index, index + DISPATCH_BATCH_SIZE)) {
				if (await claim(item)) pending.push(item);
			}
		} catch (error) {
			await Promise.all(pending.map(release));
			throw error;
		}
		const results = await Promise.allSettled(pending.map(dispatch));
		const retry: T[] = [];
		for (const [resultIndex, item] of pending.entries()) {
			const result = results[resultIndex];
			if (result?.status === 'rejected') {
				retry.push(item);
				failedCount += 1;
			} else if (result?.status === 'fulfilled') {
				if ((result.value.failures?.length ?? 0) > 0) {
					retry.push(item);
					failedCount += 1;
				} else if (result.value.sent === 0) {
					retry.push(item);
				} else {
					sent += 1;
				}
			}
		}
		await Promise.all(retry.map(release));
	}
	return { sent, failed: failedCount };
}
