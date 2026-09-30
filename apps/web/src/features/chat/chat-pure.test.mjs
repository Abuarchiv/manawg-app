import assert from 'node:assert/strict';
import test from 'node:test';
import { canDeleteMessage, canEditMessage, reconcileChatMessages } from './chat-pure.ts';

const createdAt = '2026-09-23T10:00:00.000Z';
const own = { id: 'm1', senderMemberId: 'me', kind: 'text', createdAt };

test('only the sender can edit a live text message within the edit window', () => {
	const at = (minutes) => Date.parse(createdAt) + minutes * 60_000;
	assert.equal(canEditMessage(own, { id: 'me' }, at(15)), true);
	assert.equal(canEditMessage(own, { id: 'me' }, at(16)), false);
	assert.equal(canEditMessage(own, { id: 'bob', role: 'admin' }, at(1)), false);
	assert.equal(canEditMessage({ ...own, kind: 'system' }, { id: 'me' }, at(1)), false);
	assert.equal(canEditMessage({ ...own, deletedAt: createdAt }, { id: 'me' }, at(1)), false);
});

test('senders and admins can delete; system messages only admins', () => {
	assert.equal(canDeleteMessage(own, { id: 'me' }), true);
	assert.equal(canDeleteMessage(own, { id: 'bob' }), false);
	assert.equal(canDeleteMessage(own, { id: 'bob', role: 'admin' }), true);
	assert.equal(canDeleteMessage({ ...own, kind: 'system' }, { id: 'me' }), false);
});

test('a full latest page past the loaded history replaces it instead of leaving a gap', () => {
	const page = (from, to) =>
		Array.from({ length: to - from + 1 }, (_, index) => ({ id: `m${from + index}` }));
	// Loaded m1..m60 before the tab went to the background; m61..m200 arrived.
	const loaded = page(1, 60);
	const latest = page(151, 200);
	assert.deepEqual(reconcileChatMessages(loaded, latest, [], 50), latest);

	// Overlapping or partial latest pages still merge into the loaded history.
	assert.deepEqual(
		reconcileChatMessages(loaded, page(41, 90), [], 50).map((m) => m.id),
		page(1, 90).map((m) => m.id),
	);
	assert.deepEqual(
		reconcileChatMessages(loaded, page(61, 70), [], 50).map((m) => m.id),
		page(1, 70).map((m) => m.id),
	);
	assert.deepEqual(reconcileChatMessages([], latest, [], 50), latest);
});
