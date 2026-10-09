import type { recurringExpenses } from '@/core/db';
import { addMonthsFromAnchor, parseTimestamp } from '@/core/utils/time';

export { addMonthsFromAnchor };

/** A due date may lie at most a year back, so a monthly template catches up 13 times at most. */
const MAX_CATCH_UP_OCCURRENCES = 13;
import { checkPaidByGuard } from '@/features/expenses/paid-by-guard';
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

/** API shape of a template row: ISO timestamps and parsed splits. */
export function serializeRecurringExpense(row: typeof recurringExpenses.$inferSelect) {
	return {
		...row,
		currency: 'EUR',
		nextDueAt: row.nextDueAt.toISOString(),
		lastCreatedAt: row.lastCreatedAt?.toISOString() ?? null,
		pausedAt: row.pausedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		splits: parseRecurringSplits(row.splitsJson),
	};
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
	/** Original cadence anchor; its day keeps month-end templates on their day (31st, 30th). */
	anchorAt?: string | Date | null | undefined;
}

/** Whether a template can be changed, paused or deleted by this member: its creator or an admin. */
export function canManageRecurringTemplate(
	template: { createdByMemberId?: string | undefined },
	memberId: string,
	isAdmin: boolean,
): boolean {
	return isAdmin || !template.createdByMemberId || template.createdByMemberId === memberId;
}

/** Whether this member may book a template: when someone else pays, they need a share in it. */
export function canBookRecurringTemplate(
	template: { paidByMemberId: string; splits: RecurringSplit[] },
	memberId: string,
): boolean {
	return checkPaidByGuard(template.paidByMemberId, memberId, template.splits).ok;
}

export function previewNextOccurrences(input: RecurringPreviewInput, count: number): Date[] {
	if (count <= 0) return [];
	const months = Math.max(1, Math.floor(input.intervalMonths));
	const start = new Date(input.nextDueAt);
	if (Number.isNaN(start.getTime())) return [];
	const anchor = input.anchorAt ? new Date(input.anchorAt) : start;
	const anchorDay = (Number.isNaN(anchor.getTime()) ? start : anchor).getUTCDate();
	const occurrences: Date[] = [start];
	for (let i = 1; i < count; i += 1) {
		const previous = occurrences[i - 1];
		if (!previous) break;
		occurrences.push(addMonthsFromAnchor(previous, anchorDay, months));
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

/**
 * How many bookings the next daily run catches up for a template whose due date lies in the
 * past; 0 when the date is today or later.
 */
export function countMissedOccurrences(
	nextDueAtIso: string,
	intervalMonths: number,
	now = new Date(),
	anchorAt?: string | null,
): number {
	const start = new Date(nextDueAtIso);
	if (Number.isNaN(start.getTime())) return 0;
	const months = Math.max(1, Math.floor(intervalMonths));
	const anchorDay = new Date(anchorAt ?? nextDueAtIso).getUTCDate();
	let missed = 0;
	let due = start;
	while (due.getTime() <= now.getTime() && missed < MAX_CATCH_UP_OCCURRENCES) {
		missed += 1;
		due = addMonthsFromAnchor(due, anchorDay, months);
	}
	return missed;
}
