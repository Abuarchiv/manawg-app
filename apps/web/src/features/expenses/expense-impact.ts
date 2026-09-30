/**
 * Was eine Ausgabe für mich bedeutet (wie Splitwise: „du bekommst“ / „du schuldest“),
 * statt nur die Gesamtsumme zu zeigen.
 */
export type ExpenseImpact =
	| { kind: 'lent'; cents: number }
	| { kind: 'owe'; cents: number }
	| { kind: 'settled'; cents: number }
	| { kind: 'own'; cents: number }
	| { kind: 'none'; cents: number };

interface ImpactExpense {
	paidByMemberId: string;
	amountCents: number;
	splits: ReadonlyArray<{ debtorMemberId: string; amountCents: number; settledAt: string | null }>;
}

export function getExpenseImpact(expense: ImpactExpense, memberId: string): ExpenseImpact {
	if (expense.paidByMemberId === memberId) {
		const others = expense.splits.filter(
			(split) => split.debtorMemberId !== memberId && split.amountCents > 0,
		);
		if (others.length === 0) return { kind: 'own', cents: expense.amountCents };
		const open = others
			.filter((split) => split.settledAt === null)
			.reduce((sum, split) => sum + split.amountCents, 0);
		if (open > 0) return { kind: 'lent', cents: open };
		return {
			kind: 'settled',
			cents: others.reduce((sum, split) => sum + split.amountCents, 0),
		};
	}
	const mine = expense.splits.find(
		(split) => split.debtorMemberId === memberId && split.amountCents > 0,
	);
	if (!mine) return { kind: 'none', cents: expense.amountCents };
	return mine.settledAt === null
		? { kind: 'owe', cents: mine.amountCents }
		: { kind: 'settled', cents: mine.amountCents };
}
