import { parseTimestamp } from '@/core/utils/time';
import { validateSplits } from '@/features/expenses/split-math';

interface RecurringExpenseInput {
	id: string;
	description: string;
	amountCents: number;
	currency: string;
	nextDueAt: string;
}

interface RecurringCreationWindowInput {
	nextDueAt: string;
	lastCreatedAt: string | null;
}

export interface RecurringSplit {
	debtorMemberId: string;
	amountCents: number;
}

export function getRecurringExpenseHref(shareCode: string, id: string): string {
	return `/wg/${encodeURIComponent(shareCode)}/ausgaben?recurring=${encodeURIComponent(id)}`;
}

export function parseRecurringSplits(splitsJson: string): RecurringSplit[] {
	try {
		const parsed = JSON.parse(splitsJson) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((split) => {
			if (!split || typeof split !== 'object' || Array.isArray(split)) return [];
			const candidate = split as Record<string, unknown>;
			if (
				typeof candidate.debtorMemberId !== 'string' ||
				typeof candidate.amountCents !== 'number'
			) {
				return [];
			}
			return [{ debtorMemberId: candidate.debtorMemberId, amountCents: candidate.amountCents }];
		});
	} catch {
		return [];
	}
}

export function recurringSplitsMatchAmount(splits: RecurringSplit[], amountCents: number): boolean {
	return validateSplits(amountCents, splits).ok;
}

export function getDueRecurringExpenses(
	items: RecurringExpenseInput[],
	now = Date.now(),
): RecurringExpenseInput[] {
	return items
		.filter((item) => {
			const nextDueAt = parseTimestamp(item.nextDueAt);
			return nextDueAt !== null && nextDueAt <= now;
		})
		.sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

export function addMonths(date: Date, months: number): Date {
	const next = new Date(date);
	const day = next.getUTCDate();
	next.setUTCMonth(next.getUTCMonth() + months, 1);
	const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
	next.setUTCDate(Math.min(day, lastDay));
	return next;
}

/**
 * Advance `from` by `months` while keeping the ANCHOR's day-of-month, so a
 * month-end due date never drifts (anchor day 31: 31.01 → 28.02 → 31.03 →
 * 30.04 …). Chaining plain addMonths would clamp once and stay clamped.
 */
export function addMonthsFromAnchor(from: Date, anchorDay: number, months: number): Date {
	const next = new Date(from);
	next.setUTCMonth(next.getUTCMonth() + months, 1);
	const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
	next.setUTCDate(Math.min(anchorDay, lastDay));
	return next;
}

interface RecurringAdvanceInput {
	nextDueAt: string;
	intervalMonths: number;
	/** Original cadence anchor; null on legacy rows (adopted from nextDueAt). */
	anchorAt?: string | null;
}

export function buildRecurringAdvance(
	input: RecurringAdvanceInput,
	now = new Date(),
): { nextDueAt: Date; lastCreatedAt: Date; anchorAt: Date } {
	const previous = parseTimestamp(input.nextDueAt);
	const anchorMs = (input.anchorAt ? parseTimestamp(input.anchorAt) : null) ?? previous;
	const anchor = anchorMs !== null ? new Date(anchorMs) : new Date(input.nextDueAt);
	return {
		nextDueAt: addMonthsFromAnchor(
			new Date(input.nextDueAt),
			anchor.getUTCDate(),
			input.intervalMonths,
		),
		lastCreatedAt: now,
		anchorAt: anchor,
	};
}

export function wasRecurringExpenseAlreadyCreated(input: RecurringCreationWindowInput): boolean {
	if (!input.lastCreatedAt) return false;
	const lastCreatedAt = parseTimestamp(input.lastCreatedAt);
	const nextDueAt = parseTimestamp(input.nextDueAt);
	return lastCreatedAt !== null && nextDueAt !== null && lastCreatedAt >= nextDueAt;
}

export function recurringDueDateMatchesExpected(current: string, expected: string): boolean {
	const currentTime = parseTimestamp(current);
	const expectedTime = parseTimestamp(expected);
	return currentTime !== null && expectedTime !== null && currentTime === expectedTime;
}

interface RecurringPreviewInput {
	nextDueAt: string | Date;
	intervalMonths: number;
}

export function previewNextOccurrences(input: RecurringPreviewInput, count: number): Date[] {
	if (count <= 0) return [];
	const months = Math.max(1, Math.floor(input.intervalMonths));
	const start = new Date(input.nextDueAt);
	if (Number.isNaN(start.getTime())) return [];
	const occurrences: Date[] = [start];
	for (let i = 1; i < count; i += 1) {
		const previous = occurrences[i - 1];
		if (!previous) break;
		occurrences.push(addMonthsFromAnchor(previous, start.getUTCDate(), months));
	}
	return occurrences;
}

export function formatIntervalLabel(intervalMonths: number): string {
	const months = Math.max(1, Math.floor(intervalMonths));
	if (months === 1) return 'monatlich';
	if (months === 3) return 'quartalsweise';
	if (months === 6) return 'halbjährlich';
	if (months === 12) return 'jährlich';
	return `alle ${months} Monate`;
}
