import type { Expense } from '@/features/expenses/components/ausgaben/expense-types';
import type { DebtorShare } from '@/features/expenses/split-math';

/**
 * Expense shown in the list while its request is in flight. When editing, a
 * share keeps its id and settled state unless its amount changed, so a
 * settled share is not shown as reopened before the server answers.
 */
export function buildOptimisticExpense({
	id,
	description,
	amountCents,
	paidByMemberId,
	imageUrl,
	splits,
	occurredAt,
	previous,
}: {
	id: string;
	description: string;
	amountCents: number;
	paidByMemberId: string;
	imageUrl: string | null;
	splits: DebtorShare[];
	/** The day chosen in the form; omitted keeps the previous date or means now. */
	occurredAt?: string;
	previous?: Expense;
}): Expense {
	const now = new Date().toISOString();
	return {
		id,
		paidByMemberId,
		amountCents,
		currency: previous?.currency ?? 'EUR',
		description,
		imageUrl,
		occurredAt: occurredAt ?? previous?.occurredAt ?? now,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
		splits: splits.map((split, index) => {
			const existing = previous?.splits.find(
				(current) => current.debtorMemberId === split.debtorMemberId,
			);
			return {
				id: existing?.id ?? `${id}:split:${index}`,
				debtorMemberId: split.debtorMemberId,
				amountCents: split.amountCents,
				settledAt: existing?.amountCents === split.amountCents ? existing.settledAt : null,
			};
		}),
	};
}

/** The list is shown newest first; a stable sort keeps entries of the same moment in place. */
export function sortExpensesNewestFirst(expenses: Expense[]): Expense[] {
	const time = (expense: Expense) => Date.parse(expense.occurredAt) || 0;
	return [...expenses].sort((a, b) => time(b) - time(a));
}
