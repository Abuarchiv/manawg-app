import type { Expense } from '@/features/expenses/components/ausgaben/expense-types';

export type ExpenseScope = 'all' | 'paid' | 'involved';

/**
 * Narrows the loaded history by a free-text query (description or payer name) and by the
 * member's role: `paid` = they paid, `involved` = they paid or carry a share.
 */
export function filterExpenses(
	expenses: readonly Expense[],
	{ query, scope }: { query: string; scope: ExpenseScope },
	memberId: string,
	memberName: (id: string) => string,
): Expense[] {
	const needle = query.trim().toLocaleLowerCase('de');
	if (!needle && scope === 'all') return [...expenses];
	return expenses.filter((expense) => {
		const paid = expense.paidByMemberId === memberId;
		if (scope === 'paid' && !paid) return false;
		if (
			scope === 'involved' &&
			!paid &&
			!expense.splits.some((split) => split.debtorMemberId === memberId)
		) {
			return false;
		}
		if (!needle) return true;
		return (
			expense.description.toLocaleLowerCase('de').includes(needle) ||
			memberName(expense.paidByMemberId).toLocaleLowerCase('de').includes(needle)
		);
	});
}
