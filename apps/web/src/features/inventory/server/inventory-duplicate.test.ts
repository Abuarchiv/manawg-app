import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const wgInventoryItems = { id: 'id', wgId: 'wgId', name: 'name' };
mock.module('@/core/db', { namedExports: { wgInventoryItems, db: {}, wgInventoryLog: {} } });
mock.module('drizzle-orm', {
	namedExports: {
		and: (...parts: unknown[]) => parts,
		eq: (column: unknown, value: unknown) => [column, value],
		sql: () => null,
		inArray: () => null,
		gte: () => null,
		lt: () => null,
	},
});

const { isInventoryNameTaken } = await import('./inventory-duplicate');

/** Answers the own-row lookup first, then the same-name lookup. */
function fakeTx(answers: unknown[][]) {
	let call = 0;
	return {
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => answers[call++] ?? [] }) }),
		}),
	};
}

test('a create with an existing name in other case is a duplicate', async () => {
	assert.equal(
		await isInventoryNameTaken(fakeTx([[{ id: 'x' }]]) as never, 'wg', ' KLOPAPIER '),
		true,
	);
	assert.equal(await isInventoryNameTaken(fakeTx([[]]) as never, 'wg', 'Salz'), false);
});

test('an item keeping its own name is not a duplicate of itself or of old twins', async () => {
	const tx = fakeTx([[{ name: 'klopapier' }], [{ id: 'twin' }]]);
	assert.equal(await isInventoryNameTaken(tx as never, 'wg', 'Klopapier', 'own'), false);
});

test('renaming onto another item is a duplicate', async () => {
	const tx = fakeTx([[{ name: 'Salz' }], [{ id: 'other' }]]);
	assert.equal(await isInventoryNameTaken(tx as never, 'wg', 'Klopapier', 'own'), true);
});
