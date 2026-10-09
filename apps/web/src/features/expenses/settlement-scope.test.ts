import assert from 'node:assert/strict';
import test from 'node:test';
import { computeNetBalances } from './debt-reduction';
import {
	type SettlementExpenseInput,
	parseSettlementConfirmation,
	selectSettlementScope,
	settlementScopeMatches,
} from './settlement-scope';

const ANNA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const members = [
	{ id: ANNA, name: 'Anna', color: null },
	{ id: BEN, name: 'Ben', color: null },
];

function expense(
	id: string,
	paidBy: string,
	debtor: string,
	amounts: number[],
	occurredAt: string,
): SettlementExpenseInput {
	return {
		id,
		paidByMemberId: paidBy,
		occurredAt,
		splits: amounts.map((amountCents, index) => ({
			id: `${id}-${index}`,
			expenseId: id,
			debtorMemberId: debtor,
			amountCents,
			settledAt: null,
		})),
	};
}

// Ben owes Anna 42,95 (Anna paid), Anna owes Ben 38,52 (Ben paid): nets to 4,43.
const mutual = [
	expense('e1', ANNA, BEN, [4295], '2026-09-01T10:00:00.000Z'),
	expense('e2', BEN, ANNA, [3852], '2026-09-02T10:00:00.000Z'),
];

test('mutual expenses settle as one pair when no single split fits the net amount', () => {
	const scope = selectSettlementScope(mutual, members, [], BEN, ANNA);
	assert.equal(scope.netCents, 443);
	assert.equal(scope.settleableCents, 443);
	assert.equal(scope.remainingCents, 0);
	assert.equal(scope.reason, undefined);
	assert.deepEqual(
		scope.splits.map((s) => [s.id, s.offset ?? false]),
		[
			['e1-0', false],
			['e2-0', true],
		],
	);
});

test('settling both directions brings the pair balance to zero', () => {
	const scope = selectSettlementScope(mutual, members, [], BEN, ANNA);
	const ids = new Set(scope.splits.map((s) => s.id));
	const after = mutual.map((e) => ({
		paidByMemberId: e.paidByMemberId,
		currency: 'EUR',
		splits: e.splits.map((s) => ({
			debtorMemberId: s.debtorMemberId,
			amountCents: s.amountCents,
			settledAt: ids.has(s.id) ? '2026-09-03T00:00:00.000Z' : null,
		})),
	}));
	assert.ok(computeNetBalances(after, members, []).every((b) => b.cents === 0));
});

test('pair settlement wins over a small greedy match', () => {
	const expenses = [
		expense('e1', ANNA, BEN, [100, 4295], '2026-09-01T10:00:00.000Z'),
		expense('e2', BEN, ANNA, [3852], '2026-09-02T10:00:00.000Z'),
	];
	const scope = selectSettlementScope(expenses, members, [], BEN, ANNA);
	assert.equal(scope.netCents, 543);
	assert.equal(scope.settleableCents, 543);
	assert.equal(scope.splits.length, 3);
});

test('a recorded payment keeps the pair settlement out', () => {
	const payments = [{ fromMemberId: BEN, toMemberId: ANNA, amountCents: 100, currency: 'EUR' }];
	const scope = selectSettlementScope(mutual, members, payments, BEN, ANNA);
	assert.equal(scope.netCents, 343);
	assert.equal(scope.settleableCents, 0);
	assert.equal(scope.reason, 'no_direct_splits');
});

test('the offset flag is part of the confirmation contract', () => {
	const scope = selectSettlementScope(mutual, members, [], BEN, ANNA);
	const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
	const review = {
		fromMemberId: BEN,
		toMemberId: ANNA,
		expected: {
			netCents: 443,
			settleableCents: 443,
			splits: [
				{ id: uuid(1), amountCents: 4295 },
				{ id: uuid(2), amountCents: 3852, offset: true },
			],
		},
	};
	const parsed = parseSettlementConfirmation(review);
	assert.ok(parsed.ok);
	if (parsed.ok) assert.equal(parsed.value.expected.splits[0]?.offset, false);
	// Counting the counter-claim as a normal split breaks the total.
	review.expected.splits[1] = { id: uuid(2), amountCents: 3852 };
	assert.equal(parseSettlementConfirmation(review).ok, false);

	const matching = {
		netCents: 443,
		settleableCents: 443,
		splits: scope.splits.map((s) => ({ id: s.id, amountCents: s.amountCents, offset: !!s.offset })),
	};
	assert.ok(settlementScopeMatches(matching, scope));
	matching.splits[1] = { ...matching.splits[1], offset: false } as (typeof matching.splits)[number];
	assert.equal(settlementScopeMatches(matching, scope), false);
});
