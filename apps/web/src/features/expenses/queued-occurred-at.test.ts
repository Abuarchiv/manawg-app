import assert from 'node:assert/strict';
import test from 'node:test';

const { createQueuedExpense, getOfflineActionRequest } = await import(
	'@/core/offline/offline-queue'
);
const { isOfflineAction } = await import('@/core/offline/offline-action-guard');
const { withQueuedOccurredAt } = await import('./queued-occurred-at');

test('a queued expense keeps the time it was captured, not the replay time', () => {
	const action = createQueuedExpense({
		wgId: 'wg',
		shareCode: 'MTE8PZAT',
		memberId: 'm',
		description: 'Einkauf',
		amountCents: 500,
		paidByMemberId: 'm',
		splits: [{ debtorMemberId: 'm', amountCents: 500 }],
		now: Date.parse('2026-10-05T10:00:00.000Z'),
	});
	const stamped = withQueuedOccurredAt(action, '2026-10-05T10:00:00.000Z');
	assert.equal(withQueuedOccurredAt(action, null), action);
	assert.equal(stamped.payload.occurredAt, '2026-10-05T10:00:00.000Z');
	assert.equal(stamped.payload.description, 'Einkauf');
	assert.equal('occurredAt' in action.payload, false);
	assert.equal(isOfflineAction(stamped), true);
	assert.equal(
		(getOfflineActionRequest(stamped).body as Record<string, unknown>).occurredAt,
		'2026-10-05T10:00:00.000Z',
	);
});
