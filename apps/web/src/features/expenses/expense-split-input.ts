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
	| { ok: false; reason: 'splits_empty' | 'splits_mismatch' | 'no_members' };

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
	const expected = distributeCentsEqually(amountCents, activeIds);
	const byId = new Map(splits.map((split) => [split.debtorMemberId, split.amountCents]));
	return activeIds.every((id, index) => byId.get(id) === expected[index]);
}

export function buildSplitsFromForm(input: BuildSplitsInput): SplitInputResult {
	const { splitMode, members, manualSplits, amountCents, rotationOffset } = input;

	if (splitMode === 'equal') {
		const activeIds = members.filter((m) => m.active).map((m) => m.id);
		if (activeIds.length === 0) return { ok: false, reason: 'no_members' };
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
		if (value === null || value < 0) continue;
		const cents = Math.round(value * CENTS_PER_EURO);
		splits.push({ debtorMemberId: member.id, amountCents: cents });
		sum += cents;
	}

	if (splits.length === 0) return { ok: false, reason: 'splits_empty' };
	if (sum !== amountCents) return { ok: false, reason: 'splits_mismatch' };
	return { ok: true, splits };
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
