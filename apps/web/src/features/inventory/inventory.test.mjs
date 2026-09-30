import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShoppingPushPayload } from './inventory.ts';

test('shopping payload asks for enough to get back above the threshold', () => {
	assert.deepEqual(
		buildShoppingPushPayload({ name: 'Klopapier', unit: 'Rolle', quantity: 1, threshold: 3 }),
		{
			name: 'Klopapier',
			quantity: '3 Rolle',
			note: 'Auto: Vorrat unter Schwelle',
		},
	);
	assert.equal(
		buildShoppingPushPayload({ name: 'Salz', unit: 'kg', quantity: 5, threshold: 2 }).quantity,
		'1 kg',
	);
});
