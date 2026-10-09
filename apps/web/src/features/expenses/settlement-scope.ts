import { isRecord } from '@/core/utils/is-record';
import { currencySchema } from '@/core/validators/currency';
import { z } from 'zod';
import { computeNetBalances, simplifyDebts } from './debt-reduction';
import type { ExpensePaymentInput } from './expense-payment-input';

const MAX_SETTLEMENT_SPLITS = 50;
const MAX_REVIEW_CENTS = Number.MAX_SAFE_INTEGER;

export interface SettlementMemberInput {
	id: string;
	name: string;
	color: string | null;
}

export interface SettlementExpenseInput {
	id: string;
	paidByMemberId: string;
	currency?: string;
	occurredAt: string | Date;
	splits: readonly SettlementSplitInput[];
}

export interface SettlementSplitInput {
	id: string;
	expenseId: string;
	debtorMemberId: string;
	amountCents: number;
	settledAt: string | Date | null;
}

export interface SettlementPreview {
	currency: string;
	netCents: number;
	settleableCents: number;
	remainingCents: number;
	/** `offset` marks a counter-claim (to -> from) that is cancelled together with the debt. */
	splits: Array<{ id: string; expenseId: string; amountCents: number; offset?: boolean }>;
	reason?: 'no_direct_splits';
}

export interface SettlementReview {
	currency?: string;
	netCents: number;
	settleableCents: number;
	splits: Array<{ id: string; amountCents: number; offset?: boolean }>;
}

export interface SettlementConfirmation {
	fromMemberId: string;
	toMemberId: string;
	currency: string;
	expected: SettlementReview;
}

type SettlementConfirmationParseResult =
	| { ok: true; value: SettlementConfirmation }
	| { ok: false; reason: 'required' | 'invalid' };

const centsSchema = z.number().finite().int().min(0).max(MAX_REVIEW_CENTS);

const settlementSplitSchema = z
	.object({
		id: z.string().uuid(),
		amountCents: centsSchema,
		offset: z.boolean().default(false),
	})
	.strict();

const settlementExpectedSchema = z
	.object({
		currency: currencySchema.default('EUR'),
		netCents: centsSchema,
		settleableCents: centsSchema,
		splits: z.array(settlementSplitSchema).max(MAX_SETTLEMENT_SPLITS),
	})
	.strict()
	.superRefine((value, ctx) => {
		const ids = new Set<string>();
		let total = 0;
		for (const [index, split] of value.splits.entries()) {
			if (ids.has(split.id)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['splits', index, 'id'],
					message: 'duplicate split id',
				});
			}
			ids.add(split.id);
			total += split.offset ? -split.amountCents : split.amountCents;
		}
		if (value.settleableCents > value.netCents || total !== value.settleableCents) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['splits'],
				message: 'settlement scope total is invalid',
			});
		}
	});

const settlementConfirmationSchema = z
	.object({
		fromMemberId: z.string().uuid(),
		toMemberId: z.string().uuid(),
		currency: currencySchema.default('EUR'),
		expected: settlementExpectedSchema,
	})
	.strict();

export function parseSettlementConfirmation(raw: unknown): SettlementConfirmationParseResult {
	if (
		!isRecord(raw) ||
		!('fromMemberId' in raw) ||
		!('toMemberId' in raw) ||
		!('expected' in raw)
	) {
		return { ok: false, reason: 'required' };
	}
	const expected = raw.expected;
	if (
		!isRecord(expected) ||
		!('netCents' in expected) ||
		!('settleableCents' in expected) ||
		!('splits' in expected)
	) {
		return { ok: false, reason: 'required' };
	}
	const parsed = settlementConfirmationSchema.safeParse(raw);
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid' };
}

export function settlementScopeMatches(
	review: SettlementReview,
	actual: SettlementPreview,
): boolean {
	if (
		(review.currency ?? 'EUR') !== actual.currency ||
		review.netCents !== actual.netCents ||
		review.settleableCents !== actual.settleableCents ||
		review.splits.length !== actual.splits.length
	) {
		return false;
	}
	return review.splits.every(
		(split, index) =>
			split.id === actual.splits[index]?.id &&
			split.amountCents === actual.splits[index]?.amountCents &&
			!!split.offset === !!actual.splits[index]?.offset,
	);
}

function settledAtToString(value: string | Date | null): string | null {
	if (value === null) return null;
	return value instanceof Date ? value.toISOString() : value;
}

export function selectSettlementScope(
	expenses: readonly SettlementExpenseInput[],
	members: readonly SettlementMemberInput[],
	payments: readonly ExpensePaymentInput[],
	fromMemberId: string,
	toMemberId: string,
	currency = 'EUR',
): SettlementPreview {
	const normalizedCurrency = currency.trim().toUpperCase();
	const balanceExpenses = expenses.map((expense) => ({
		paidByMemberId: expense.paidByMemberId,
		currency: expense.currency ?? 'EUR',
		splits: expense.splits.map((split) => ({
			debtorMemberId: split.debtorMemberId,
			amountCents: split.amountCents,
			settledAt: settledAtToString(split.settledAt),
		})),
	}));
	const netDebt = simplifyDebts(computeNetBalances(balanceExpenses, [...members], payments)).find(
		(debt) =>
			debt.fromId === fromMemberId &&
			debt.toId === toMemberId &&
			(debt.currency ?? 'EUR') === normalizedCurrency,
	);
	const netCents = netDebt?.cents ?? 0;
	if (netCents <= 0) {
		return {
			currency: normalizedCurrency,
			netCents: 0,
			settleableCents: 0,
			remainingCents: 0,
			splits: [],
		};
	}

	const orderedSplits = expenses
		.flatMap((expense) =>
			expense.splits.map((split) => ({
				...split,
				paidByMemberId: expense.paidByMemberId,
				currency: expense.currency,
				occurredAt: expense.occurredAt,
			})),
		)
		.sort((a, b) => {
			const diff = new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();
			return diff !== 0 ? diff : a.id.localeCompare(b.id);
		});

	const inCurrency = orderedSplits.filter(
		(split) =>
			split.settledAt === null &&
			split.amountCents > 0 &&
			(split.currency ?? 'EUR').trim().toUpperCase() === normalizedCurrency,
	);
	const selected: SettlementPreview['splits'] = [];
	let remainingCents = netCents;
	for (const split of inCurrency) {
		if (remainingCents <= 0 || selected.length >= MAX_SETTLEMENT_SPLITS) break;
		if (split.debtorMemberId !== fromMemberId) continue;
		if (split.paidByMemberId !== toMemberId) continue;
		if (split.amountCents > remainingCents) continue;
		selected.push({ id: split.id, expenseId: split.expenseId, amountCents: split.amountCents });
		remainingCents -= split.amountCents;
	}

	// Mutual expenses: when no single split fits the netted amount, cancel both directions
	// of the pair at once. Only valid while no payment sits beside the open splits.
	const pair = inCurrency.filter(
		(split) =>
			(split.debtorMemberId === fromMemberId && split.paidByMemberId === toMemberId) ||
			(split.debtorMemberId === toMemberId && split.paidByMemberId === fromMemberId),
	);
	const counterCents = pair
		.filter((split) => split.debtorMemberId === toMemberId)
		.reduce((sum, split) => sum + split.amountCents, 0);
	const pairCents =
		pair.reduce(
			(sum, split) => sum + (split.debtorMemberId === fromMemberId ? split.amountCents : 0),
			0,
		) - counterCents;
	if (
		counterCents > 0 &&
		pairCents > 0 &&
		pairCents <= netCents &&
		pairCents > netCents - remainingCents &&
		pair.length <= MAX_SETTLEMENT_SPLITS
	) {
		return {
			currency: normalizedCurrency,
			netCents,
			settleableCents: pairCents,
			remainingCents: netCents - pairCents,
			splits: pair.map((split) => ({
				id: split.id,
				expenseId: split.expenseId,
				amountCents: split.amountCents,
				...(split.debtorMemberId === toMemberId ? { offset: true } : {}),
			})),
		};
	}

	return {
		currency: normalizedCurrency,
		netCents,
		settleableCents: netCents - remainingCents,
		remainingCents,
		splits: selected,
		...(selected.length === 0 ? { reason: 'no_direct_splits' as const } : {}),
	};
}
