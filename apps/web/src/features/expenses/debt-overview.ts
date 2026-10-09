import type { SettlementSummary, SimplifiedDebt } from './debt-reduction';

export function getDebtOverview(
	debts: readonly SimplifiedDebt[],
	currentMemberId: string,
	summary?: SettlementSummary,
) {
	// An empty simplified result is authoritative: reciprocal debts can cancel out.
	const transfers = summary ? summary.simplified : debts;
	return {
		personal: transfers.filter(
			(debt) => debt.fromId === currentMemberId || debt.toId === currentMemberId,
		),
		others: transfers.filter(
			(debt) => debt.fromId !== currentMemberId && debt.toId !== currentMemberId,
		),
	};
}

/**
 * Balance rows worth listing: one row per currency with a balance, and a single "balanced" row
 * for active members without any. Moved-out members only show while they still hold a balance.
 */
export function listedMemberBalances<T extends { memberId: string; balanceCents: number }>(
	balances: readonly T[],
	isActive: (balance: T) => boolean = () => true,
): T[] {
	const withBalance = new Set(
		balances.filter((row) => row.balanceCents !== 0).map((row) => row.memberId),
	);
	const placeholderSeen = new Set<string>();
	return balances.filter((row) => {
		if (row.balanceCents !== 0) return true;
		if (withBalance.has(row.memberId) || !isActive(row)) return false;
		if (placeholderSeen.has(row.memberId)) return false;
		placeholderSeen.add(row.memberId);
		return true;
	});
}
