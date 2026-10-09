import assert from 'node:assert/strict';
import test from 'node:test';
import {
	boughtRestockMatches,
	buildShoppingPushPayload,
	quickRestockCandidates,
	restockAmount,
} from './inventory';

test('shopping payload asks for enough to get back above the threshold', () => {
	assert.deepEqual(
		buildShoppingPushPayload({ name: 'Klopapier', unit: 'Rolle', quantity: 1, threshold: 3 }),
		{
			name: 'Klopapier',
			quantity: '3 Rollen',
			note: 'Auto: Vorrat unter Schwelle',
		},
	);
	assert.equal(
		buildShoppingPushPayload({ name: 'Salz', unit: 'kg', quantity: 5, threshold: 2 }).quantity,
		'1 kg',
	);
});

const stock = (name: string, quantity: number, threshold: number, decrementCount30d = 0) => ({
	name,
	quantity,
	threshold,
	decrementCount30d,
});

test('restockAmount lifts a scarce item above its threshold, otherwise adds one', () => {
	assert.equal(restockAmount(stock('Klopapier', 0, 2)), 3);
	assert.equal(restockAmount(stock('Salz', 5, 2)), 1);
});

test('quick restock lists scarce items first and skips idle full ones', () => {
	const result = quickRestockCandidates([
		stock('Reis', 5, 1, 4),
		stock('Salz', 5, 1, 0),
		stock('Seife', 1, 2),
		stock('Klopapier', 0, 2),
	]);
	assert.deepEqual(
		result.map((item) => item.name),
		['Klopapier', 'Seife', 'Reis'],
	);
});

test('bought names match scarce items case-insensitively', () => {
	const items = [stock('Klopapier', 0, 2), stock('Salz', 5, 1)];
	assert.deepEqual(boughtRestockMatches(items, [' klopapier ', 'Salz']), [items[0]]);
});
