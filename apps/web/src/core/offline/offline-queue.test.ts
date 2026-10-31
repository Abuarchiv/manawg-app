import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createQueuedAbsence,
	createQueuedAnnouncement,
	createQueuedChore,
	createQueuedChoreCompletion,
	createQueuedExpense,
	createQueuedShoppingItem,
	createQueuedShoppingUpdate,
	explainOfflineActionFailure,
	getOfflineActionRequest,
	hasQueuedShoppingUpdate,
	isQueuedCreateId,
	pendingChoreCompletions,
	withoutQueuedEntry,
} from './offline-queue';

const key = '55555555-5555-4555-8555-555555555555';
const shareCode = 'MTE8PZAT';
const memberId = '33333333-3333-4333-8333-333333333333';
const otherMemberId = '44444444-4444-4444-8444-444444444444';

test('queued chore completion preserves the original due and assignee occurrence', () => {
	const expected = {
		expectedNextDueAt: '2026-09-27T10:00:00.000Z',
		expectedAssignedMemberId: memberId,
	};
	const action = createQueuedChoreCompletion({
		shareCode,
		memberId,
		choreId: '11111111-1111-4111-8111-111111111111',
		idempotencyKey: key,
		...expected,
		now: Date.parse(expected.expectedNextDueAt),
	});
	assert.equal(action.idempotencyKey, key);
	assert.deepEqual(getOfflineActionRequest(action).body, {
		...expected,
		// The tap time is replayed so the server records when the chore was done.
		completedAt: expected.expectedNextDueAt,
	});

	const legacy = {
		id: 'legacy',
		type: 'chore.complete',
		shareCode,
		memberId,
		createdAt: expected.expectedNextDueAt,
		payload: { choreId: action.payload.choreId },
	};
	const legacyBody = getOfflineActionRequest(legacy as never).body;
	assert.deepEqual(JSON.parse(JSON.stringify(legacyBody)), {});
});

test('queued shopping PATCH preserves the version, expected state, and online idempotency key', () => {
	const expected = {
		bought: true,
		expectedUpdatedAt: '2026-09-27T10:00:00.000Z',
		expectedBoughtAt: null,
	};
	const tapTime = '2026-09-27T10:00:00.000Z';
	const action = createQueuedShoppingUpdate({
		shareCode,
		memberId,
		itemId: '11111111-1111-4111-8111-111111111111',
		name: 'Milch',
		idempotencyKey: key,
		...expected,
		now: Date.parse(expected.expectedUpdatedAt),
	});
	assert.equal(action.idempotencyKey, key);
	assert.deepEqual(getOfflineActionRequest(action).body, { ...expected, boughtAt: tapTime });
	assert.equal(
		hasQueuedShoppingUpdate([action], shareCode, memberId, action.payload.itemId as string),
		true,
	);
	assert.equal(
		hasQueuedShoppingUpdate([action], shareCode, otherMemberId, action.payload.itemId as string),
		false,
	);
	assert.equal(
		hasQueuedShoppingUpdate([action], 'another-wg', memberId, action.payload.itemId as string),
		false,
	);

	const legacy = {
		id: 'legacy-shopping-update',
		type: 'shopping.update',
		shareCode,
		memberId,
		createdAt: expected.expectedUpdatedAt,
		payload: { itemId: action.payload.itemId, name: 'Milch', bought: true },
	};
	const legacyBody = getOfflineActionRequest(legacy as never).body;
	assert.deepEqual(JSON.parse(JSON.stringify(legacyBody)), { bought: true, boughtAt: tapTime });
});

test('a queued chore carries the due date and cadence anchor fixed at creation', () => {
	const chore = createQueuedChore({
		shareCode,
		memberId,
		title: 'Bad putzen',
		intervalDays: 1,
		assignedMemberId: null,
		nextDueAt: '2026-10-27T21:00:00.000Z',
		anchorAt: '2026-10-26T21:00:00.000Z',
		now: 1,
	});
	const body = getOfflineActionRequest(chore).body as Record<string, unknown>;
	assert.equal(body.nextDueAt, '2026-10-27T21:00:00.000Z');
	assert.equal(body.anchorAt, '2026-10-26T21:00:00.000Z');
});

test('withoutQueuedEntry drops the queued create and follow-ups that target it', () => {
	const chore = createQueuedChore({
		shareCode,
		memberId,
		title: 'Bad putzen',
		intervalDays: 7,
		assignedMemberId: null,
		now: 1,
	});
	const completion = createQueuedChoreCompletion({
		shareCode,
		memberId,
		choreId: chore.id,
		expectedNextDueAt: '2026-10-01T10:00:00.000Z',
		expectedAssignedMemberId: null,
		now: 2,
	});
	const unrelated = createQueuedShoppingItem({
		shareCode,
		memberId,
		name: 'Brot',
		quantity: null,
		now: 3,
	});
	const otherWg = { ...chore, shareCode: 'OTHERWG1' };
	const queue = [chore, completion, unrelated, otherWg];

	assert.deepEqual(withoutQueuedEntry(queue, shareCode, chore.id), [unrelated, otherWg]);
	assert.equal(withoutQueuedEntry(queue, shareCode, memberId), null);
	assert.equal(withoutQueuedEntry(queue, 'NOWG0000', chore.id), null);
});

test('synthetic ids of offline creates are recognised, server ids are not', () => {
	const shopping = createQueuedShoppingItem({
		shareCode,
		memberId,
		name: 'Milch',
		quantity: null,
		now: 1,
	});
	const chore = createQueuedChore({
		shareCode,
		memberId,
		title: 'Bad putzen',
		intervalDays: 7,
		recurrenceType: 'days',
		assignedMemberId: memberId,
		now: 1,
	});
	const absence = createQueuedAbsence({
		shareCode,
		memberId,
		absenceMemberId: memberId,
		startDate: '2026-10-01',
		endDate: '2026-10-02',
		reason: null,
		now: 1,
	});
	for (const action of [shopping, chore, absence]) assert.equal(isQueuedCreateId(action.id), true);
	for (const serverId of [memberId, 'absence-holiday', 'chore-1']) {
		assert.equal(isQueuedCreateId(serverId), false);
	}
});

test('a rate-limited replay is explained as retried automatically, not as a failure', () => {
	for (const [status, error] of [
		[429, 'rate_limited'],
		[429, 'too_many_requests'],
	] as const) {
		assert.equal(
			explainOfflineActionFailure(status, error).title.key,
			'offline.failure.rateLimited.title',
		);
	}
});

test('a feature-specific rate-limit code is explained as an automatic retry too', () => {
	assert.equal(
		explainOfflineActionFailure(503, 'import_rate_limited').title.key,
		'offline.failure.rateLimited.title',
	);
});

test('known codes win over the status bucket; unknown codes fall back to it', () => {
	assert.equal(
		explainOfflineActionFailure(404, 'chore_not_found').title.key,
		'offline.failure.choreMissing.title',
	);
	assert.equal(
		explainOfflineActionFailure(400, 'title_invalid').title.key,
		'offline.failure.entryInvalid.title',
	);
	assert.equal(
		explainOfflineActionFailure(404, 'something_new').title.key,
		'offline.failure.targetGone.title',
	);
	assert.equal(
		explainOfflineActionFailure(400, 'constructor').title.key,
		'offline.failure.syncFailed.title',
	);
	assert.equal(explainOfflineActionFailure(500).title.key, 'offline.failure.serverNotReady.title');
	// A held answer is never resent, so it must not say "try again later".
	assert.equal(
		explainOfflineActionFailure(400, 'something_new', true).title.key,
		'offline.failure.rejected.title',
	);
});

test('401 reads as an expired session, 403 as missing access, a deactivated member as moved out', () => {
	assert.equal(explainOfflineActionFailure(401).title.key, 'offline.failure.sessionExpired.title');
	assert.equal(explainOfflineActionFailure(403).title.key, 'offline.failure.accessMissing.title');
	assert.equal(
		explainOfflineActionFailure(401, 'member_deactivated').title.key,
		'offline.failure.movedOut.title',
	);
});

test('a rejected chore completion is not pending; one waiting on the connection is', () => {
	const queued = createQueuedChoreCompletion({
		wgId: 'wg-1',
		shareCode,
		memberId,
		choreId: 'chore-1',
		expectedNextDueAt: '2026-10-27T08:00:00.000Z',
		expectedAssignedMemberId: memberId,
	});
	const offlineRetry = { ...queued, attempts: 2, lastError: 'Keine Verbindung: Netz fehlt' };
	const rejected = { ...queued, attempts: 1, lastError: 'Server prüfen: Konflikt: Schon erledigt' };
	const pending = [{ id: 'chore-1', nextDueAt: '2026-10-27T08:00:00.000Z' }];

	assert.deepEqual(pendingChoreCompletions([queued], shareCode), pending);
	assert.deepEqual(pendingChoreCompletions([offlineRetry], shareCode), pending);
	assert.deepEqual(pendingChoreCompletions([rejected], shareCode), []);
	assert.deepEqual(pendingChoreCompletions([queued], 'OTHER'), []);
});

test('queued shopping create and announcement carry the time they were written', () => {
	const now = Date.parse('2026-09-27T10:00:00.000Z');
	const item = createQueuedShoppingItem({
		shareCode,
		memberId,
		name: 'Milch',
		quantity: null,
		now,
	});
	assert.equal(getOfflineActionRequest(item).body.boughtAt, new Date(now).toISOString());
	const post = createQueuedAnnouncement({
		shareCode,
		memberId,
		content: 'Hallo',
		kind: 'info',
		now,
	});
	assert.equal(getOfflineActionRequest(post).body.createdAt, new Date(now).toISOString());
});

test('a queued fixed-cost booking sends the template version it was built from', () => {
	const action = createQueuedExpense({
		shareCode,
		memberId,
		description: 'Miete',
		amountCents: 90000,
		paidByMemberId: memberId,
		splits: [{ debtorMemberId: otherMemberId, amountCents: 90000 }],
		recurringExpenseId: '66666666-6666-4666-8666-666666666666',
		expectedRecurringNextDueAt: '2026-11-01T00:00:00.000Z',
		expectedRecurringUpdatedAt: '2026-10-20T08:00:00.000Z',
	});
	const body = getOfflineActionRequest(action).body;
	assert.equal(body.expectedRecurringNextDueAt, '2026-11-01T00:00:00.000Z');
	assert.equal(body.expectedRecurringUpdatedAt, '2026-10-20T08:00:00.000Z');
	assert.equal(
		explainOfflineActionFailure(409, 'recurring_expense_changed').title.key,
		'offline.failure.templateChanged.title',
	);
	assert.equal(
		explainOfflineActionFailure(409, 'expense_changed').title.key,
		'offline.failure.expenseChanged.title',
	);
	assert.equal(
		explainOfflineActionFailure(409, 'expense_has_settled_shares').title.key,
		'offline.failure.expenseSettled.title',
	);
	assert.equal(
		explainOfflineActionFailure(409, 'recurring_expense_already_advanced').title.key,
		'offline.failure.recurringAdvanced.title',
	);
});
