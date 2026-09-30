import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const source = path.join(process.cwd(), 'src/core/offline/offline-queue.ts');
const module = { exports: {} };
const compiled = transpileModule(readFileSync(source, 'utf8'), {
	compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;
new Function('require', 'module', 'exports', compiled)(
	(name) =>
		name === '@/core/utils/time'
			? {
					parseTimestamp: (value) =>
						Number.isFinite(Date.parse(value)) ? Date.parse(value) : null,
				}
			: requireFromWeb(name),
	module,
	module.exports,
);

const {
	createQueuedAbsence,
	createQueuedChore,
	createQueuedChoreCompletion,
	createQueuedShoppingItem,
	createQueuedShoppingUpdate,
	getOfflineActionRequest,
	isQueuedCreateId,
	hasQueuedShoppingUpdate,
	withoutQueuedEntry,
} = module.exports;
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
	assert.deepEqual(getOfflineActionRequest(action).body, expected);

	const legacy = {
		id: 'legacy',
		type: 'chore.complete',
		shareCode,
		memberId,
		createdAt: expected.expectedNextDueAt,
		payload: { choreId: action.payload.choreId },
	};
	const legacyBody = getOfflineActionRequest(legacy).body;
	assert.deepEqual(JSON.parse(JSON.stringify(legacyBody)), {});
});

test('queued shopping PATCH preserves the version, expected state, and online idempotency key', () => {
	const expected = {
		bought: true,
		expectedUpdatedAt: '2026-09-27T10:00:00.000Z',
		expectedBoughtAt: null,
	};
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
	assert.deepEqual(getOfflineActionRequest(action).body, expected);
	assert.equal(hasQueuedShoppingUpdate([action], shareCode, memberId, action.payload.itemId), true);
	assert.equal(
		hasQueuedShoppingUpdate([action], shareCode, otherMemberId, action.payload.itemId),
		false,
	);
	assert.equal(
		hasQueuedShoppingUpdate([action], 'another-wg', memberId, action.payload.itemId),
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
	const legacyBody = getOfflineActionRequest(legacy).body;
	assert.deepEqual(JSON.parse(JSON.stringify(legacyBody)), { bought: true });
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
