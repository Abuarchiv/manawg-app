import { parseEuroAmount } from '@/core/utils/amount';
import { CENTS_PER_EURO } from '@/core/utils/money';
import {
	type DebtorShare,
	buildEqualSplits,
	distributeCentsEqually,
} from '@/features/expenses/split-math';

/**
 * Turns the expense form's state into the splits array the API expects.
 *
 * The counterpart to `split-math.ts`: that module owns the arithmetic, this
 * one owns the step before it — reading euro strings out of the form, deciding
 * who takes part, and reporting why an input cannot become a valid split.
 *
 * Extracted from `ausgaben/page.tsx`, where it could only be exercised by
 * rendering the whole page and driving the form.
 */

export interface SplitMemberLike {
	id: string;
	active?: boolean;
}

export type SplitMode = 'equal' | 'manual';

export type SplitInputResult =
	| { ok: true; splits: DebtorShare[] }
	| { ok: false; reason: 'invalid_share' | 'splits_empty' | 'splits_mismatch' | 'no_members' };

interface BuildSplitsInput {
	splitMode: SplitMode;
	/** Every member of the WG, moved-out ones included. */
	members: readonly SplitMemberLike[];
	/** Raw euro strings keyed by member id, as typed into the manual rows. */
	manualSplits: Record<string, string>;
	amountCents: number;
	/**
	 * Cycles which debtor receives the leftover cent on uneven equal splits.
	 * The page passes its current expense count.
	 */
	rotationOffset: number;
	/**
	 * Ids of the members an equal split is shared between; null or omitted means every active
	 * member. Ids of moved-out members are ignored.
	 */
	participantIds?: readonly string[] | null | undefined;
	/**
	 * The saved splits of the expense being edited. When the amount and the
	 * set of debtors are unchanged, an equal split resends these per-member
	 * amounts instead of re-rotating the leftover cent: moving that cent to
	 * another member would change their share and reopen it if it was
	 * already settled.
	 */
	previousSplits?: readonly DebtorShare[] | undefined;
}

export function isEqualExpenseSplit(
	amountCents: number,
	splits: readonly DebtorShare[],
	members: readonly SplitMemberLike[],
): boolean {
	if (splits.length === 0) return true;
	const inactiveIds = new Set(
		members.filter((member) => member.active === false).map((member) => member.id),
	);
	if (splits.some((split) => inactiveIds.has(split.debtorMemberId))) return false;

	const activeIds = members.filter((member) => member.active !== false).map((member) => member.id);
	if (splits.length !== activeIds.length) return false;
	const splitIds = new Set(splits.map((split) => split.debtorMemberId));
	if (!activeIds.every((id) => splitIds.has(id))) return false;
	// Equal splits rotate who receives the leftover cent (see
	// buildSplitsFromForm's rotationOffset), so compare the cent values as a
	// multiset instead of per member.
	const byAmount = (a: number, b: number) => a - b;
	const expected = distributeCentsEqually(amountCents, activeIds).sort(byAmount);
	const actual = splits.map((split) => split.amountCents).sort(byAmount);
	return actual.every((cents, index) => cents === expected[index]);
}

/**
 * The members an equal split is shared between, when `splits` is an equal split of `amountCents`
 * among active members (all of them or a subset); null otherwise.
 */
export function equalSplitParticipants(
	amountCents: number,
	splits: readonly DebtorShare[],
	members: readonly SplitMemberLike[],
): string[] | null {
	if (splits.length === 0) return null;
	const activeIds = new Set(members.filter((m) => m.active !== false).map((m) => m.id));
	const ids = splits.map((split) => split.debtorMemberId);
	if (new Set(ids).size !== ids.length || ids.some((id) => !activeIds.has(id))) return null;
	const byAmount = (a: number, b: number) => a - b;
	const expected = distributeCentsEqually(amountCents, ids).sort(byAmount);
	const actual = splits.map((split) => split.amountCents).sort(byAmount);
	return actual.every((cents, index) => cents === expected[index]) ? ids : null;
}

export interface ReopenedShare {
	debtorMemberId: string;
	previousCents: number;
	/** Null when the share is removed by the edit. */
	nextCents: number | null;
}

/**
 * Shares already marked as paid that an edit reopens: the server only keeps the paid state of a
 * share whose amount stays the same, and drops it when the share changes or disappears. The
 * payer's own share never counts, it is settled by definition.
 */
export function settledSharesAffectedByEdit(
	previousSplits: ReadonlyArray<DebtorShare & { settledAt: string | null }>,
	nextSplits: readonly DebtorShare[],
	paidByMemberId: string,
): ReopenedShare[] {
	const nextById = new Map(nextSplits.map((split) => [split.debtorMemberId, split.amountCents]));
	return previousSplits.flatMap((split) => {
		if (split.settledAt === null || split.debtorMemberId === paidByMemberId) return [];
		const nextCents = nextById.get(split.debtorMemberId) ?? null;
		return nextCents === split.amountCents
			? []
			: [{ debtorMemberId: split.debtorMemberId, previousCents: split.amountCents, nextCents }];
	});
}

export function buildSplitsFromForm(input: BuildSplitsInput): SplitInputResult {
	const { splitMode, members, manualSplits, amountCents, rotationOffset, previousSplits } = input;

	if (splitMode === 'equal') {
		const chosen = input.participantIds ? new Set(input.participantIds) : null;
		const activeIds = members
			.filter((m) => m.active && (!chosen || chosen.has(m.id)))
			.map((m) => m.id);
		if (activeIds.length === 0) return { ok: false, reason: 'no_members' };
		const kept = keepPreviousEqualSplits(amountCents, activeIds, previousSplits);
		if (kept) return { ok: true, splits: kept };
		return { ok: true, splits: buildEqualSplits(amountCents, activeIds, rotationOffset) };
	}

	// Manual mode reads every member, not just active ones: editing an old
	// expense must keep the share of someone who has since moved out.
	const splits: DebtorShare[] = [];
	let sum = 0;
	for (const member of members) {
		const raw = manualSplits[member.id] ?? '';
		if (raw.trim().length === 0) continue;
		const value = parseEuroAmount(raw);
		if (value === null || value < 0) return { ok: false, reason: 'invalid_share' };
		const cents = Math.round(value * CENTS_PER_EURO);
		splits.push({ debtorMemberId: member.id, amountCents: cents });
		sum += cents;
	}

	if (splits.length === 0) return { ok: false, reason: 'splits_empty' };
	if (sum !== amountCents) return { ok: false, reason: 'splits_mismatch' };
	return { ok: true, splits };
}

function keepPreviousEqualSplits(
	amountCents: number,
	activeIds: readonly string[],
	previousSplits: readonly DebtorShare[] | undefined,
): DebtorShare[] | null {
	if (!previousSplits || previousSplits.length !== activeIds.length) return null;
	const previousById = new Map(
		previousSplits.map((split) => [split.debtorMemberId, split.amountCents]),
	);
	if (previousById.size !== activeIds.length) return null;
	let sum = 0;
	const splits: DebtorShare[] = [];
	for (const id of activeIds) {
		const cents = previousById.get(id);
		if (cents === undefined) return null;
		splits.push({ debtorMemberId: id, amountCents: cents });
		sum += cents;
	}
	if (sum !== amountCents) return null;
	// Only reuse a split that still is an equal split of this amount.
	const byAmount = (a: number, b: number) => a - b;
	const expected = distributeCentsEqually(amountCents, activeIds).sort(byAmount);
	const actual = splits.map((split) => split.amountCents).sort(byAmount);
	return actual.every((cents, index) => cents === expected[index]) ? splits : null;
}

/**
 * Who to offer in the payer select.
 *
 * A member who moved out drops out of every picker, but the currently selected
 * payer is added back when they are one — otherwise the select would show no
 * option matching its own value. That happens when editing an old expense, or
 * on a moved-out device that still has write access.
 */
export function payerOptions<T extends SplitMemberLike>(
	members: readonly T[],
	selectedPayerId: string,
): T[] {
	const active = members.filter((m) => m.active);
	if (active.some((m) => m.id === selectedPayerId)) return active;
	return [...active, ...members.filter((m) => m.id === selectedPayerId)];
}

/**
 * Who to offer as split rows: active members, plus any moved-out member who
 * still carries an amount in the form being edited.
 */
export function splitCandidates<T extends SplitMemberLike>(
	members: readonly T[],
	splitMode: SplitMode,
	manualSplits: Record<string, string>,
): T[] {
	if (splitMode !== 'manual') return members.filter((m) => m.active);
	return members.filter((m) => m.active || (manualSplits[m.id] ?? '').trim().length > 0);
}

/**
 * Who "Rest aufteilen" may assign cents to: active members only, in every
 * form mode. A moved-out member keeps a historical share they already carry,
 * but must never receive new cents — the API rejects that with
 * `member_not_in_wg`.
 */
export function remainderCandidates<T extends SplitMemberLike>(members: readonly T[]): T[] {
	return members.filter((m) => m.active);
}

/** Stable form of the manual split inputs for request fingerprints. */
export function manualSplitsFingerprint(
	splitMode: SplitMode,
	manualSplits: Record<string, string>,
): Array<[string, string]> | null {
	return splitMode === 'manual'
		? Object.entries(manualSplits).sort(([left], [right]) => left.localeCompare(right))
		: null;
}
