import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMonthlyStatement, shiftMonthKey } from './monthly-statement';

const members = [
	{ id: 'L', name: 'Lina', active: true },
	{ id: 'J', name: 'Jonas', active: true },
	{ id: 'M', name: 'Mira', active: false },
];

function expense(
	id: string,
	paidBy: string,
	occurredAt: string,
	shares: Record<string, number>,
	settledAt: string | null = null,
) {
	const splits = Object.entries(shares).map(([debtorMemberId, amountCents]) => ({
		debtorMemberId,
		amountCents,
		settledAt,
	}));
	return {
		id,
		paidByMemberId: paidBy,
		amountCents: splits.reduce((sum, split) => sum + split.amountCents, 0),
		currency: 'EUR',
		description: id,
		occurredAt,
		splits,
	};
}

test('month balances, Berlin month edges and fewest transfers', () => {
	const statement = buildMonthlyStatement(
		[
			expense('a', 'L', '2026-09-02T10:00:00Z', { L: 1000, J: 1000 }),
			expense('b', 'J', '2026-09-03T10:00:00Z', { L: 300, J: 300 }, '2026-09-04T00:00:00Z'),
			// 30.09. 23:30 UTC is already 01.10. in Berlin.
			expense('c', 'L', '2026-09-30T23:30:00Z', { L: 500, J: 500 }),
			// 31.08. 22:30 UTC is 01.09. in Berlin.
			expense('d', 'J', '2026-08-31T22:30:00Z', { J: 200, L: 200 }),
		],
		members,
		'2026-09',
	);
	assert.deepEqual(
		statement.items.map((item) => item.id),
		['d', 'a', 'b'],
	);
	assert.equal(statement.totalCents, 2000 + 600 + 400);
	assert.deepEqual(
		statement.members.map(({ id, paidCents, shareCents, balanceCents }) => [
			id,
			paidCents,
			shareCents,
			balanceCents,
		]),
		[
			// L's settled 300 of "b" does not count as open.
			['L', 2000, 1500, 800],
			['J', 1000, 1500, -800],
		],
	);
	assert.deepEqual(
		statement.transfers.map(({ fromId, toId, cents }) => [fromId, toId, cents]),
		[['J', 'L', 800]],
	);
	assert.equal(statement.settled, false);
});

test('categories are summed per month, largest first, "other" last', () => {
	const withCategory = (category: string | undefined, id: string, cents: number) => ({
		...expense(id, 'L', '2026-09-10T10:00:00Z', { L: cents }),
		...(category ? { category } : {}),
	});
	const statement = buildMonthlyStatement(
		[
			withCategory('other', 'a', 10000),
			withCategory('leisure', 'b', 2000),
			withCategory('groceries', 'c', 5000),
			withCategory('groceries', 'd', 1000),
			// Missing or unknown categories count as "other".
			withCategory(undefined, 'e', 1000),
			withCategory('unbekannt', 'f', 1000),
		],
		members,
		'2026-09',
	);
	assert.deepEqual(
		statement.categories.map(({ category, cents, share }) => [category, cents, share]),
		[
			['groceries', 6000, 30],
			['leisure', 2000, 10],
			['other', 12000, 60],
		],
	);
});

test('a payer missing from the members list has no name', () => {
	const statement = buildMonthlyStatement(
		[expense('a', 'X', '2026-09-02T10:00:00Z', { L: 1000 })],
		members,
		'2026-09',
	);
	assert.equal(statement.items[0]?.payerName, null);
});

test('month key arithmetic crosses years', () => {
	assert.equal(shiftMonthKey('2026-01', -1), '2025-12');
	assert.equal(shiftMonthKey('2026-12', 1), '2027-01');
});

test('completed payments of the month offset open shares', () => {
	const expenses = [expense('a', 'L', '2026-09-02T10:00:00Z', { L: 2000, J: 1000 })];
	const payment = (completedAt: string, cents = 1000) => ({
		fromMemberId: 'J',
		toMemberId: 'L',
		amountCents: cents,
		currency: 'EUR',
		completedAt,
	});
	const paid = buildMonthlyStatement(expenses, members, '2026-09', [
		payment('2026-09-10T10:00:00Z'),
	]);
	assert.deepEqual(
		paid.members.map(({ id, balanceCents }) => [id, balanceCents]),
		[
			['L', 0],
			['J', 0],
		],
	);
	assert.deepEqual(paid.transfers, []);
	assert.equal(paid.settled, true);

	// A later payment settles this month too.
	const later = buildMonthlyStatement(expenses, members, '2026-09', [
		payment('2026-10-10T10:00:00Z'),
	]);
	assert.equal(later.settled, true);
	assert.deepEqual(later.transfers, []);

	// A partial payment keeps the month open with the remainder.
	const partial = buildMonthlyStatement(expenses, members, '2026-09', [
		payment('2026-09-10T10:00:00Z', 400),
	]);
	assert.equal(partial.settled, false);
	assert.equal(partial.transfers[0]?.cents, 600);
});

test('a payment for an older month never shows up as a reverse debt in its own month', () => {
	const expenses = [
		expense('sep', 'L', '2026-09-02T10:00:00Z', { L: 1000, J: 1000 }),
		expense('oct', 'L', '2026-10-05T10:00:00Z', { L: 500, J: 500 }),
	];
	const payments = [
		{
			fromMemberId: 'J',
			toMemberId: 'L',
			amountCents: 1200,
			currency: 'EUR',
			completedAt: '2026-10-20T10:00:00Z',
		},
	];
	const september = buildMonthlyStatement(expenses, members, '2026-09', payments);
	assert.equal(september.settled, true);
	assert.deepEqual(september.transfers, []);

	// 1000 of the payment went to September; October keeps 300 of its 500 open, same direction.
	const october = buildMonthlyStatement(expenses, members, '2026-10', payments);
	assert.equal(october.settled, false);
	assert.deepEqual(
		october.transfers.map(({ fromId, toId, cents }) => [fromId, toId, cents]),
		[['J', 'L', 300]],
	);
});

test('a month whose opposite debts cancel out exactly counts as settled', () => {
	const statement = buildMonthlyStatement(
		[
			expense('a', 'L', '2026-09-02T10:00:00Z', { L: 0, J: 1000 }),
			expense('b', 'J', '2026-09-03T10:00:00Z', { J: 0, L: 1000 }),
		],
		members,
		'2026-09',
	);
	assert.deepEqual(statement.transfers, []);
	assert.equal(statement.settled, true);
});

test('a month with two independent groups needs one transfer per debtor', () => {
	const statement = buildMonthlyStatement(
		[
			expense('a', 'L', '2026-09-02T10:00:00Z', { L: 200, J: 200 }),
			expense('b', 'A', '2026-09-03T10:00:00Z', { A: 200, B: 200, C: 100 }),
		],
		[
			...members,
			{ id: 'A', name: 'Anna', active: true },
			{ id: 'B', name: 'Ben', active: true },
			{ id: 'C', name: 'Cem', active: true },
		],
		'2026-09',
	);
	assert.deepEqual(
		statement.transfers.map(({ fromId, toId, cents }) => `${fromId}>${toId}:${cents}`).sort(),
		['B>A:200', 'C>A:100', 'J>L:200'],
	);
});
