import assert from 'node:assert/strict';
import test from 'node:test';

const {
	dropShoppingItems,
	planShoppingPatch,
	replaceShoppingItem,
	overlayQueuedShopping,
	toggledShoppingItem,
	withQueuedCreateBought,
	withoutQueuedFollowUps,
} = await import('../src/features/shopping/shopping-toggle.ts');

const item = {
	id: 'item-1',
	addedByMemberId: 'member-a',
	name: 'Milch',
	quantity: null,
	boughtAt: null,
	boughtByMemberId: null,
	createdAt: '2026-10-01T10:00:00.000Z',
	updatedAt: '2026-10-01T10:00:00.000Z',
};

test('a toggle request carries the version it was based on', () => {
	const plan = planShoppingPatch(item, true, undefined, () => 'key-1');
	assert.deepEqual(plan, {
		ok: true,
		request: {
			expectedUpdatedAt: item.updatedAt,
			expectedBoughtAt: null,
			fingerprint: JSON.stringify({
				expectedUpdatedAt: item.updatedAt,
				expectedBoughtAt: null,
				bought: true,
			}),
			idempotencyKey: 'key-1',
		},
	});
});

test('retrying the same toggle on the same version reuses its idempotency key', () => {
	const first = planShoppingPatch(item, true, undefined, () => 'key-1');
	assert.ok(first.ok);
	const previous = { fingerprint: first.request.fingerprint, key: first.request.idempotencyKey };
	const retry = planShoppingPatch(item, true, previous, () => 'key-2');
	assert.ok(retry.ok);
	assert.equal(retry.request.idempotencyKey, 'key-1');
	const reopen = planShoppingPatch(item, false, previous, () => 'key-3');
	assert.ok(reopen.ok);
	assert.equal(reopen.request.idempotencyKey, 'key-3');
});

test('a toggle without a known version or key is refused', () => {
	const { updatedAt: _ignored, ...withoutVersion } = item;
	assert.deepEqual(
		planShoppingPatch(withoutVersion, true, undefined, () => 'key'),
		{
			ok: false,
			reason: 'version_missing',
		},
	);
	assert.deepEqual(
		planShoppingPatch(item, true, undefined, () => null),
		{
			ok: false,
			reason: 'key_unavailable',
		},
	);
});

test('the optimistic row records who checked it off and when', () => {
	const now = new Date('2026-10-02T08:00:00.000Z');
	assert.deepEqual(toggledShoppingItem(item, true, 'member-b', now), {
		...item,
		boughtAt: now.toISOString(),
		boughtByMemberId: 'member-b',
	});
	assert.deepEqual(
		toggledShoppingItem({ ...item, boughtAt: now.toISOString() }, false, 'member-b', now),
		{ ...item, boughtAt: null, boughtByMemberId: null },
	);
});

test('a queued create of this member is marked bought, other actions stay untouched', () => {
	const queued = {
		id: 'shopping:CODE:1:milch',
		type: 'shopping.create' as const,
		shareCode: 'CODE',
		memberId: 'member-a',
		createdAt: '2026-10-01T10:00:00.000Z',
		payload: { name: 'Milch', quantity: null },
	};
	const other = {
		...queued,
		id: 'shopping:CODE:2:brot',
		payload: { name: 'Brot', quantity: null },
	};
	const target = { itemId: queued.id, shareCode: 'CODE', memberId: 'member-a' };
	assert.deepEqual(withQueuedCreateBought([queued, other], target, true), [
		{ ...queued, payload: { ...queued.payload, bought: true } },
		other,
	]);
	assert.equal(withQueuedCreateBought([other], target, true), null);
	assert.equal(withQueuedCreateBought([queued], { ...target, memberId: 'member-b' }, true), null);
});

test('list edits keep the array identity when nothing changed', () => {
	const items = [item];
	assert.equal(replaceShoppingItem(items, 'item-1', item), items);
	assert.equal(
		dropShoppingItems(items, () => false),
		items,
	);
	const replacement = { ...item, name: 'Hafermilch' };
	assert.deepEqual(replaceShoppingItem(items, 'item-1', replacement), [replacement]);
	assert.deepEqual(
		dropShoppingItems(items, (row) => row.id === 'item-1'),
		[],
	);
});

const me = { shareCode: 'ABC', memberId: 'member-a' };
const queued = (
	over: Partial<{
		id: string;
		type: string;
		shareCode: string;
		memberId: string;
		payload: Record<string, unknown>;
		lastError: string;
	}>,
) => ({
	id: 'shopping:ABC:1:brot',
	type: 'shopping.create',
	shareCode: 'ABC',
	memberId: 'member-a',
	createdAt: '2026-10-02T09:00:00.000Z',
	payload: { name: 'Brot', quantity: '2' },
	...over,
});

test('a queued create stays on the list when the server answer lacks it', () => {
	const rows = overlayQueuedShopping([item], [queued({})] as never, me);
	assert.deepEqual(
		rows.map((row) => row.id),
		['shopping:ABC:1:brot', 'item-1'],
	);
	assert.equal(rows[0]?.quantity, '2');
	assert.deepEqual(overlayQueuedShopping([item], [], me), [item]);
});

test('a queued create is not shown twice when its name is already open', () => {
	const rows = overlayQueuedShopping(
		[item],
		[queued({ payload: { name: ' milch ', quantity: null } })] as never,
		me,
	);
	assert.deepEqual(rows, [item]);
});

test('a queued check-off keeps the row bought', () => {
	const update = queued({
		id: 'shopping-update:ABC:1:item-1',
		type: 'shopping.update',
		payload: { itemId: 'item-1', bought: true },
	});
	const [row] = overlayQueuedShopping([item], [update] as never, me);
	assert.equal(row?.boughtAt, '2026-10-02T09:00:00.000Z');
	assert.equal(row?.boughtByMemberId, 'member-a');
});

test('a rejected queued check-off and other WGs or members are ignored', () => {
	const update = queued({
		id: 'shopping-update:ABC:1:item-1',
		type: 'shopping.update',
		payload: { itemId: 'item-1', bought: true },
	});
	const unchanged = (actions: unknown[]) =>
		overlayQueuedShopping([item], actions as never, me).length === 1 &&
		overlayQueuedShopping([item], actions as never, me)[0] === item;
	assert.ok(unchanged([{ ...update, lastError: 'Einkaufsstatus geändert' }]));
	assert.ok(
		unchanged([
			{ ...update, shareCode: 'XYZ' },
			{ ...queued({}), memberId: 'member-b' },
		]),
	);
	const offline = { ...update, lastError: 'Noch keine Verbindung: später' };
	assert.notEqual(overlayQueuedShopping([item], [offline] as never, me)[0], item);
});

test('removing an item drops its queued follow-ups only', () => {
	const update = queued({
		id: 'shopping-update:ABC:1:item-1',
		type: 'shopping.update',
		payload: { itemId: 'item-1', bought: true },
	});
	const other = { ...update, id: 'u2', payload: { itemId: 'item-2', bought: true } };
	const otherWg = { ...update, id: 'u3', shareCode: 'XYZ' };
	assert.deepEqual(
		withoutQueuedFollowUps([update, other, otherWg] as never, 'ABC', 'item-1')?.map((a) => a.id),
		['u2', 'u3'],
	);
	assert.equal(withoutQueuedFollowUps([other] as never, 'ABC', 'item-1'), null);
});
