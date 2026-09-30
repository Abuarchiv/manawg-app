import { formatEuroInput, parseEuroAmount } from '@/core/utils/amount';
import { CENTS_PER_EURO } from '@/core/utils/money';

/**
 * "Rest aufteilen": moves the open remainder of the manual split rows.
 *
 * The arithmetic lives here instead of the `setManualSplits` updater because
 * React updaters must be pure — StrictMode invokes them twice, and a leftover
 * counter mutated across the two runs silently drops cents. Callers compute
 * the result from the `manualSplits` they read at click time and hand the
 * finished record to the state setter.
 *
 * Every written value goes through `formatEuroInput`, so it parses again with
 * `parseEuroAmount` (which rejects a leading minus): an over-allocation is
 * taken back from rows that still hold a positive amount and never drives a
 * row negative.
 */

export interface RemainderMember {
	id: string;
}

function centsOf(manualSplits: Record<string, string>, id: string): number {
	const value = parseEuroAmount(manualSplits[id] ?? '');
	return value === null ? 0 : Math.round(value * CENTS_PER_EURO);
}

/**
 * Returns a new `manualSplits` with `remainderCents` redistributed, or `null`
 * when there is nothing (or nothing possible) to distribute.
 */
export function distributeRemainderSplits(
	members: readonly RemainderMember[],
	manualSplits: Record<string, string>,
	remainderCents: number,
): Record<string, string> | null {
	if (remainderCents === 0 || members.length === 0) return null;

	if (remainderCents > 0) {
		// Open remainder: fill the rows that are still empty first, otherwise
		// spread it over every candidate row.
		const emptyMembers = members.filter((member) => centsOf(manualSplits, member.id) === 0);
		const targets = emptyMembers.length > 0 ? emptyMembers : members;
		const perCent = Math.floor(remainderCents / targets.length);
		let leftover = remainderCents - perCent * targets.length;
		const next = { ...manualSplits };
		for (const target of targets) {
			const addCents = perCent + (leftover > 0 ? 1 : 0);
			if (leftover > 0) leftover--;
			const nextCents = centsOf(manualSplits, target.id) + addCents;
			next[target.id] = formatEuroInput(nextCents / CENTS_PER_EURO);
		}
		return next;
	}

	// Over-allocation: take cents back from the rows that hold a positive
	// amount, clamped at zero, until the sum fits the expense amount again.
	const pool = members.filter((member) => centsOf(manualSplits, member.id) > 0);
	const remaining = new Map(pool.map((member) => [member.id, centsOf(manualSplits, member.id)]));
	let toRemove = -remainderCents;
	let candidates = pool;
	while (toRemove > 0 && candidates.length > 0) {
		const share = Math.floor(toRemove / candidates.length);
		const leftover = toRemove - share * candidates.length;
		let removed = 0;
		const stillPositive: RemainderMember[] = [];
		for (const [index, member] of candidates.entries()) {
			const want = share + (index < leftover ? 1 : 0);
			const available = remaining.get(member.id) ?? 0;
			const take = Math.min(available, want);
			remaining.set(member.id, available - take);
			removed += take;
			if (available - take > 0) stillPositive.push(member);
		}
		toRemove -= removed;
		candidates = stillPositive;
	}
	// Unreachable while the positive rows hold at least the overage — the
	// caller only distributes when the expense amount itself is positive —
	// but a `null` keeps the form untouched instead of writing a partial fix.
	if (toRemove > 0) return null;

	const next = { ...manualSplits };
	for (const [id, cents] of remaining) {
		next[id] = formatEuroInput(cents / CENTS_PER_EURO);
	}
	return next;
}
