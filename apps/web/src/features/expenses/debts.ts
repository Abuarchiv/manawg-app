import { MS_PER_DAY } from '@/core/utils/time';
import type { ExpensePaymentInput } from './expense-payments';

export interface DebtExpenseInput {
	paidByMemberId: string;
	currency?: string;
	occurredAt: string;
	splits: Array<{
		debtorMemberId: string;
		amountCents: number;
		settledAt: string | null;
	}>;
}

export interface PairBalance {
	creditorId: string;
	debtorId: string;
	amountCents: number;
	currency: string;
}

function normalizeCurrency(currency: string | undefined): string {
	return currency?.trim().toUpperCase() || 'EUR';
}

/**
 * Aggregate unsettled debts per (debtor, creditor) pair.
 *
 * The result is reduced — if Alice paid for Ben twice (10€ + 5€) and Ben never
 * paid Alice back, we return a single { debtor: Ben, creditor: Alice, 15€ } row.
 * Pairs with zero balance are omitted.
 */
export function computeBalances(
	expenses: ReadonlyArray<DebtExpenseInput>,
	payments: ReadonlyArray<ExpensePaymentInput> = [],
): PairBalance[] {
	const totals = new Map<string, PairBalance>();

	for (const expense of expenses) {
		const creditorId = expense.paidByMemberId;
		for (const split of expense.splits) {
			if (split.settledAt !== null) continue;
			if (split.debtorMemberId === creditorId) continue;
			if (split.amountCents <= 0) continue;

			const currency = normalizeCurrency(expense.currency);
			const key = `${currency}:${split.debtorMemberId}:${creditorId}`;
			const current = totals.get(key);
			if (current) {
				totals.set(key, { ...current, amountCents: current.amountCents + split.amountCents });
			} else {
				totals.set(key, {
					creditorId,
					debtorId: split.debtorMemberId,
					amountCents: split.amountCents,
					currency,
				});
			}
		}
	}
	for (const payment of payments) {
		if (payment.amountCents <= 0 || payment.fromMemberId === payment.toMemberId) continue;
		const currency = normalizeCurrency(payment.currency);
		const key = `${currency}:${payment.fromMemberId}:${payment.toMemberId}`;
		const current = totals.get(key);
		if (current) {
			current.amountCents -= payment.amountCents;
		} else {
			totals.set(key, {
				creditorId: payment.toMemberId,
				debtorId: payment.fromMemberId,
				amountCents: -payment.amountCents,
				currency,
			});
		}
	}
	for (const pair of totals.values()) {
		if (pair.amountCents >= 0) continue;
		const key = `${pair.currency}:${pair.creditorId}:${pair.debtorId}`;
		const reverse = totals.get(key);
		if (reverse) {
			reverse.amountCents -= pair.amountCents;
		} else {
			totals.set(key, {
				creditorId: pair.debtorId,
				debtorId: pair.creditorId,
				amountCents: -pair.amountCents,
				currency: pair.currency,
			});
		}
		pair.amountCents = 0;
	}

	// Net opposite directions per pair: A owes B 42,95 € and B owes A 38,52 €
	// is a single 4,43 € debt from A to B, never two remindable rows.
	for (const pair of totals.values()) {
		const reverse = totals.get(`${pair.currency}:${pair.creditorId}:${pair.debtorId}`);
		if (!reverse || pair.amountCents <= 0 || reverse.amountCents <= 0) continue;
		const offset = Math.min(pair.amountCents, reverse.amountCents);
		pair.amountCents -= offset;
		reverse.amountCents -= offset;
	}

	return Array.from(totals.values()).filter((pair) => pair.amountCents > 0);
}

/**
 * Age (in whole days) of the oldest unsettled split between two members.
 *
 * Used to render "seit X Tagen" copy in reminders. Direction matters: the debtor
 * owes the creditor, so we only consider splits where the creditor paid and the
 * debtor is the listed debtor.
 */
export function computeOldestDebtAgeDays(
	debtorId: string,
	creditorId: string,
	expenses: ReadonlyArray<DebtExpenseInput>,
	now: Date = new Date(),
	currency?: string,
): number {
	let oldestTs: number | null = null;
	for (const expense of expenses) {
		if (expense.paidByMemberId !== creditorId) continue;
		if (
			currency !== undefined &&
			normalizeCurrency(expense.currency) !== normalizeCurrency(currency)
		) {
			continue;
		}
		const ts = Date.parse(expense.occurredAt);
		if (Number.isNaN(ts)) continue;
		for (const split of expense.splits) {
			if (split.debtorMemberId !== debtorId) continue;
			if (split.settledAt !== null) continue;
			if (split.amountCents <= 0) continue;
			if (oldestTs === null || ts < oldestTs) oldestTs = ts;
		}
	}

	if (oldestTs === null) return 0;
	const diffMs = now.getTime() - oldestTs;
	if (diffMs <= 0) return 0;
	return Math.floor(diffMs / MS_PER_DAY);
}

/**
 * Batch form of `computeOldestDebtAgeDays` for rendering a whole balances
 * list: a single pass over `expenses` builds the oldest-unsettled-split
 * timestamp for every (debtor, creditor) pair, instead of rescanning all
 * expenses once per pair (O(expenses × splits) instead of
 * O(pairs × expenses × splits)). Returns ages in the same order as `pairs`.
 */
export function computeOldestDebtAges(
	pairs: ReadonlyArray<{ debtorId: string; creditorId: string; currency?: string }>,
	expenses: ReadonlyArray<DebtExpenseInput>,
	now: Date = new Date(),
): number[] {
	const oldestTsByPair = new Map<string, number>();

	for (const expense of expenses) {
		const ts = Date.parse(expense.occurredAt);
		if (Number.isNaN(ts)) continue;
		const creditorId = expense.paidByMemberId;
		for (const split of expense.splits) {
			if (split.settledAt !== null) continue;
			if (split.amountCents <= 0) continue;
			const currency = normalizeCurrency(expense.currency);
			const key = `${currency}:${split.debtorMemberId}:${creditorId}`;
			const current = oldestTsByPair.get(key);
			if (current === undefined || ts < current) oldestTsByPair.set(key, ts);
		}
	}

	const nowMs = now.getTime();
	return pairs.map((pair) => {
		const oldestTs = oldestTsByPair.get(
			`${normalizeCurrency(pair.currency)}:${pair.debtorId}:${pair.creditorId}`,
		);
		if (oldestTs === undefined) return 0;
		const diffMs = nowMs - oldestTs;
		return diffMs <= 0 ? 0 : Math.floor(diffMs / MS_PER_DAY);
	});
}

export function findPairBalance(
	balances: ReadonlyArray<PairBalance>,
	debtorId: string,
	creditorId: string,
	currency?: string,
): PairBalance | null {
	const normalizedCurrency = currency === undefined ? undefined : normalizeCurrency(currency);
	return (
		balances.find(
			(b) =>
				b.debtorId === debtorId &&
				b.creditorId === creditorId &&
				(normalizedCurrency === undefined || b.currency === normalizedCurrency),
		) ?? null
	);
}
