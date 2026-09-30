import type { ExpensePaymentInput } from './expense-payments';

export interface SimplifiedDebt {
	fromId: string;
	fromName: string;
	toId: string;
	toName: string;
	cents: number;
	currency?: string;
}

export interface SettlementSummary {
	directCount: number;
	simplifiedCount: number;
	savedTransfers: number;
	totalOpenCents: number;
	simplified: SimplifiedDebt[];
	totalOpenByCurrency?: Record<string, number>;
}

interface BalanceEntry {
	memberId: string;
	memberName: string;
	color: string | null;
	cents: number;
	currency: string;
}

interface ExpenseInput {
	paidByMemberId: string;
	currency?: string;
	splits: Array<{
		debtorMemberId: string;
		amountCents: number;
		settledAt: string | null;
	}>;
}

interface MemberInput {
	id: string;
	name: string;
	color: string | null;
}

function normalizeCurrency(currency: string | undefined): string {
	return currency?.trim().toUpperCase() || 'EUR';
}

function currencyKey(currency: string, memberId: string): string {
	return `${currency}:${memberId}`;
}

function currenciesFor(
	expenses: readonly ExpenseInput[],
	payments: readonly ExpensePaymentInput[],
): string[] {
	const currencies = new Set<string>();
	for (const expense of expenses) currencies.add(normalizeCurrency(expense.currency));
	for (const payment of payments) currencies.add(normalizeCurrency(payment.currency));
	if (currencies.size === 0) currencies.add('EUR');
	return [...currencies].sort();
}

export function computeDirectDebts(
	expenses: ExpenseInput[],
	members: MemberInput[],
	payments: readonly ExpensePaymentInput[] = [],
): SimplifiedDebt[] {
	const memberNames = new Map(members.map((m) => [m.id, m.name]));
	const totals = new Map<string, SimplifiedDebt>();

	for (const expense of expenses) {
		const currency = normalizeCurrency(expense.currency);
		const toId = expense.paidByMemberId;
		const toName = memberNames.get(toId);
		if (!toName) continue;

		for (const split of expense.splits) {
			if (split.settledAt !== null) continue;
			if (split.amountCents <= 0) continue;
			if (split.debtorMemberId === toId) continue;

			const fromName = memberNames.get(split.debtorMemberId);
			if (!fromName) continue;

			const key = currencyKey(currency, `${split.debtorMemberId}:${toId}`);
			const current = totals.get(key);
			if (current) {
				current.cents += split.amountCents;
			} else {
				totals.set(key, {
					fromId: split.debtorMemberId,
					fromName,
					toId,
					toName,
					cents: split.amountCents,
					currency,
				});
			}
		}
	}
	for (const payment of payments) {
		if (payment.amountCents <= 0 || payment.fromMemberId === payment.toMemberId) continue;
		const currency = normalizeCurrency(payment.currency);
		const fromName = memberNames.get(payment.fromMemberId);
		const toName = memberNames.get(payment.toMemberId);
		if (!fromName || !toName) continue;
		const key = currencyKey(currency, `${payment.fromMemberId}:${payment.toMemberId}`);
		const current = totals.get(key);
		if (current) {
			current.cents -= payment.amountCents;
		} else {
			totals.set(key, {
				fromId: payment.fromMemberId,
				fromName,
				toId: payment.toMemberId,
				toName,
				cents: -payment.amountCents,
				currency,
			});
		}
	}

	// Negative payment residuals are refunds owed in reverse; keep positive gross pairs separate.
	for (const debt of totals.values()) {
		if (debt.cents >= 0) continue;
		const currency = normalizeCurrency(debt.currency);
		const key = currencyKey(currency, `${debt.toId}:${debt.fromId}`);
		const reverse = totals.get(key);
		if (reverse) {
			reverse.cents -= debt.cents;
		} else {
			totals.set(key, {
				fromId: debt.toId,
				fromName: debt.toName,
				toId: debt.fromId,
				toName: debt.fromName,
				cents: -debt.cents,
				currency,
			});
		}
		debt.cents = 0;
	}

	return Array.from(totals.values())
		.filter((debt) => debt.cents > 0)
		.sort(
			(a, b) =>
				normalizeCurrency(a.currency).localeCompare(normalizeCurrency(b.currency)) ||
				b.cents - a.cents ||
				a.fromName.localeCompare(b.fromName),
		);
}

export function computeNetBalances(
	expenses: ExpenseInput[],
	members: MemberInput[],
	payments: readonly ExpensePaymentInput[] = [],
): BalanceEntry[] {
	const known = new Set(members.map((m) => m.id));
	const currencies = currenciesFor(expenses, payments);
	const cents = new Map<string, number>();
	for (const currency of currencies) {
		for (const member of members) cents.set(currencyKey(currency, member.id), 0);
	}

	for (const e of expenses) {
		const currency = normalizeCurrency(e.currency);
		// Skip expenses paid by a departed member — their balance is dropped from
		// the returned roster, so counting it would unbalance the net sum.
		if (!known.has(e.paidByMemberId)) continue;
		for (const s of e.splits) {
			if (s.settledAt !== null) continue;
			if (s.amountCents <= 0) continue;
			// Skip the payer's own share — it's already accounted for in paidCents
			if (s.debtorMemberId === e.paidByMemberId) continue;
			// Skip splits owed by a departed member (mirror computeDirectDebts).
			if (!known.has(s.debtorMemberId)) continue;
			const payerKey = currencyKey(currency, e.paidByMemberId);
			const debtorKey = currencyKey(currency, s.debtorMemberId);
			cents.set(payerKey, (cents.get(payerKey) ?? 0) + s.amountCents);
			cents.set(debtorKey, (cents.get(debtorKey) ?? 0) - s.amountCents);
		}
	}
	for (const payment of payments) {
		if (payment.amountCents <= 0 || payment.fromMemberId === payment.toMemberId) continue;
		if (!known.has(payment.fromMemberId) || !known.has(payment.toMemberId)) continue;
		const currency = normalizeCurrency(payment.currency);
		const fromKey = currencyKey(currency, payment.fromMemberId);
		const toKey = currencyKey(currency, payment.toMemberId);
		cents.set(fromKey, (cents.get(fromKey) ?? 0) + payment.amountCents);
		cents.set(toKey, (cents.get(toKey) ?? 0) - payment.amountCents);
	}

	return currencies.flatMap((currency) =>
		members.map((m) => ({
			memberId: m.id,
			memberName: m.name,
			color: m.color,
			cents: cents.get(currencyKey(currency, m.id)) ?? 0,
			currency,
		})),
	);
}

function simplifyCurrencyDebts(balances: BalanceEntry[], currency: string): SimplifiedDebt[] {
	const compareMemberId = (a: BalanceEntry, b: BalanceEntry): number =>
		a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0;
	const creditors = balances
		.filter((b) => b.cents > 0)
		.map((b) => ({ ...b }))
		.sort((a, b) => b.cents - a.cents || compareMemberId(a, b));
	const debtors = balances
		.filter((b) => b.cents < 0)
		.map((b) => ({ ...b }))
		.sort((a, b) => a.cents - b.cents || compareMemberId(a, b));

	const result: SimplifiedDebt[] = [];
	let i = 0;
	let j = 0;
	while (i < debtors.length && j < creditors.length) {
		const debtor = debtors[i];
		const creditor = creditors[j];
		if (!debtor || !creditor) break;
		const amount = Math.min(-debtor.cents, creditor.cents);
		if (amount > 0) {
			result.push({
				fromId: debtor.memberId,
				fromName: debtor.memberName,
				toId: creditor.memberId,
				toName: creditor.memberName,
				cents: amount,
				currency,
			});
		}
		debtor.cents += amount;
		creditor.cents -= amount;
		if (debtor.cents === 0) i++;
		if (creditor.cents === 0) j++;
	}
	return result;
}

export function simplifyDebts(balances: BalanceEntry[]): SimplifiedDebt[] {
	const currencies = [
		...new Set(balances.map((balance) => normalizeCurrency(balance.currency))),
	].sort();
	return currencies.flatMap((currency) =>
		simplifyCurrencyDebts(
			balances.filter((balance) => normalizeCurrency(balance.currency) === currency),
			currency,
		),
	);
}

export function buildSettlementSummary(
	expenses: ExpenseInput[],
	members: MemberInput[],
	payments: readonly ExpensePaymentInput[] = [],
): SettlementSummary {
	const direct = computeDirectDebts(expenses, members, payments);
	const simplified = simplifyDebts(computeNetBalances(expenses, members, payments));
	const totalOpenByCurrency = Object.fromEntries(
		[...new Set(direct.map((debt) => normalizeCurrency(debt.currency)))].map((currency) => [
			currency,
			direct
				.filter((debt) => normalizeCurrency(debt.currency) === currency)
				.reduce((sum, debt) => sum + debt.cents, 0),
		]),
	);
	return {
		directCount: direct.length,
		simplifiedCount: simplified.length,
		savedTransfers: Math.max(0, direct.length - simplified.length),
		// Kept for backwards-compatible callers; never use this value to offset
		// balances. Use totalOpenByCurrency when displaying totals.
		totalOpenCents: direct.reduce((sum, debt) => sum + debt.cents, 0),
		simplified,
		totalOpenByCurrency,
	};
}
