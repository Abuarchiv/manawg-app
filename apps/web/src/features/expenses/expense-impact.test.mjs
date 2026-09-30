import assert from 'node:assert/strict';
import test from 'node:test';
import { getExpenseImpact } from './expense-impact.ts';

const split = (debtorMemberId, amountCents, settledAt = null) => ({
	debtorMemberId,
	amountCents,
	settledAt,
});

test('shows what an expense means for the viewer', () => {
	const paidByMe = {
		paidByMemberId: 'me',
		amountCents: 3000,
		splits: [split('me', 1000), split('a', 1000), split('b', 1000, '2026-09-01')],
	};
	assert.deepEqual(getExpenseImpact(paidByMe, 'me'), { kind: 'lent', cents: 1000 });
	assert.deepEqual(getExpenseImpact(paidByMe, 'a'), { kind: 'owe', cents: 1000 });
	assert.deepEqual(getExpenseImpact(paidByMe, 'b'), { kind: 'settled', cents: 1000 });
	assert.deepEqual(getExpenseImpact(paidByMe, 'c'), { kind: 'none', cents: 3000 });

	const allSettled = { ...paidByMe, splits: [split('a', 1500, '2026-09-01'), split('me', 1500)] };
	assert.deepEqual(getExpenseImpact(allSettled, 'me'), { kind: 'settled', cents: 1500 });

	const onlyMine = { paidByMemberId: 'me', amountCents: 500, splits: [] };
	assert.deepEqual(getExpenseImpact(onlyMine, 'me'), { kind: 'own', cents: 500 });

	const zeroShare = { paidByMemberId: 'a', amountCents: 500, splits: [split('me', 0)] };
	assert.deepEqual(getExpenseImpact(zeroShare, 'me'), { kind: 'none', cents: 500 });
});
