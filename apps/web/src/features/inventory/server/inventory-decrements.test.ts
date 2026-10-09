import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const groupedRows = [{ itemId: 'a', count: 3 }];
const chain = { from: () => chain, where: () => chain, groupBy: async () => groupedRows };
mock.module('@/core/db', {
	namedExports: {
		db: { select: () => chain },
		wgInventoryLog: { itemId: 'itemId', kind: 'kind', createdAt: 'createdAt', delta: 'delta' },
	},
});
mock.module('drizzle-orm', {
	namedExports: {
		and: () => null,
		eq: () => null,
		gte: () => null,
		inArray: () => null,
		lt: () => null,
		sql: () => null,
	},
});

const { getRecentDecrementCounts } = await import('./inventory-decrements');

test('decrement counts come from grouped rows, unlisted ids stay 0', async () => {
	const counts = await getRecentDecrementCounts(['a', 'b']);
	assert.equal(counts.get('a'), 3);
	assert.equal(counts.get('b'), 0);
});
