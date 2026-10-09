import assert from 'node:assert/strict';
import test from 'node:test';
import { listedMemberBalances } from './debt-overview';

const row = (memberId: string, currency: string, balanceCents: number, active = true) => ({
	memberId,
	currency,
	balanceCents,
	active,
});

test('a second currency does not duplicate balanced members', () => {
	const rows = [
		row('a', 'EUR', 500),
		row('a', 'CHF', 0),
		row('b', 'EUR', -500),
		row('b', 'CHF', 0),
	];
	assert.deepEqual(
		listedMemberBalances(rows, (r) => r.active).map((r) => `${r.memberId}-${r.currency}`),
		['a-EUR', 'b-EUR'],
	);
	const balanced = [row('a', 'EUR', 0), row('a', 'CHF', 0)];
	assert.equal(listedMemberBalances(balanced).length, 1);
});

test('moved-out members only show while they hold a balance', () => {
	const rows = [row('a', 'EUR', 0, false), row('b', 'EUR', 300, false), row('c', 'EUR', 0)];
	assert.deepEqual(
		listedMemberBalances(rows, (r) => r.active).map((r) => r.memberId),
		['b', 'c'],
	);
});
