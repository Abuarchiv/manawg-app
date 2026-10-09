import assert from 'node:assert/strict';
import test from 'node:test';

const {
	buildSplitsFromForm,
	equalSplitParticipants,
	isEqualExpenseSplit,
	remainderCandidates,
	settledSharesAffectedByEdit,
} = await import('./expense-split-input');
const { distributeRemainderCents } = await import('./components/ausgaben/manual-split-distribute');

const members = [
	{ id: 'a', active: true },
	{ id: 'b', active: true },
	{ id: 'c', active: true },
];

test('an equal split saved with a rotation offset reopens as equal', () => {
	// 10,01 € over three people: one of them carries the extra cent. The
	// rotation seed moves that cent away from the first member.
	for (const rotationOffset of [0, 1, 2, 5]) {
		const result = buildSplitsFromForm({
			splitMode: 'equal',
			members,
			manualSplits: {},
			amountCents: 1001,
			rotationOffset,
		});
		assert.ok(result.ok);
		assert.equal(
			isEqualExpenseSplit(1001, result.splits, members),
			true,
			`offset ${rotationOffset}`,
		);
	}
});

test('an uneven manual split is not mistaken for an equal one', () => {
	const splits = [
		{ debtorMemberId: 'a', amountCents: 333 },
		{ debtorMemberId: 'b', amountCents: 333 },
		{ debtorMemberId: 'c', amountCents: 335 },
	];
	assert.equal(isEqualExpenseSplit(1001, splits, members), false);
});

test('a split missing an active member is not equal', () => {
	const splits = [
		{ debtorMemberId: 'a', amountCents: 334 },
		{ debtorMemberId: 'a', amountCents: 334 },
		{ debtorMemberId: 'b', amountCents: 333 },
	];
	assert.equal(isEqualExpenseSplit(1001, splits, members), false);
});

test('"Rest aufteilen" never assigns cents to a moved-out member when creating', () => {
	// Regression: create mode offered every member, moved-out ones included,
	// so the remainder landed on them and the POST failed with
	// member_not_in_wg.
	const wg = [...members, { id: 'gone', active: false }];
	const targets = remainderCandidates(wg);
	assert.deepEqual(
		targets.map((m) => m.id),
		['a', 'b', 'c'],
	);
	const next = distributeRemainderCents({}, targets, 3000);
	assert.equal(next.gone, undefined);
	const result = buildSplitsFromForm({
		splitMode: 'manual',
		members: wg,
		manualSplits: next,
		amountCents: 3000,
		rotationOffset: 0,
	});
	assert.ok(result.ok);
	assert.deepEqual(
		result.splits.map((split) => split.debtorMemberId),
		['a', 'b', 'c'],
	);
});

test('editing an equal split keeps each member share when amount and debtors are unchanged', () => {
	// Regression: a description-only edit re-rotated the leftover cent with
	// a new offset, moved it to another member and so changed a share the
	// server would then reopen even if it was already settled.
	const saved = buildSplitsFromForm({
		splitMode: 'equal',
		members,
		manualSplits: {},
		amountCents: 1001,
		rotationOffset: 1,
	});
	assert.ok(saved.ok);
	const savedByMember = Object.fromEntries(
		saved.splits.map((split) => [split.debtorMemberId, split.amountCents]),
	);
	for (const rotationOffset of [0, 1, 2, 7]) {
		const result = buildSplitsFromForm({
			splitMode: 'equal',
			members,
			manualSplits: {},
			amountCents: 1001,
			rotationOffset,
			previousSplits: saved.splits,
		});
		assert.ok(result.ok);
		assert.deepEqual(
			Object.fromEntries(result.splits.map((split) => [split.debtorMemberId, split.amountCents])),
			savedByMember,
		);
	}
});

test('editing an equal split re-splits when the amount or the debtors change', () => {
	const previousSplits = [
		{ debtorMemberId: 'a', amountCents: 333 },
		{ debtorMemberId: 'b', amountCents: 334 },
		{ debtorMemberId: 'c', amountCents: 334 },
	];
	const changedAmount = buildSplitsFromForm({
		splitMode: 'equal',
		members,
		manualSplits: {},
		amountCents: 1002,
		rotationOffset: 0,
		previousSplits,
	});
	assert.ok(changedAmount.ok);
	assert.deepEqual(
		changedAmount.splits.map((split) => split.amountCents),
		[334, 334, 334],
	);
	const changedMembers = buildSplitsFromForm({
		splitMode: 'equal',
		members: [...members, { id: 'd', active: true }],
		manualSplits: {},
		amountCents: 1001,
		rotationOffset: 0,
		previousSplits,
	});
	assert.ok(changedMembers.ok);
	assert.deepEqual(
		changedMembers.splits.map((split) => [split.debtorMemberId, split.amountCents]),
		[
			['a', 251],
			['b', 250],
			['c', 250],
			['d', 250],
		],
	);
});

test('an equal split can be limited to chosen participants', () => {
	const result = buildSplitsFromForm({
		splitMode: 'equal',
		members,
		manualSplits: {},
		amountCents: 1001,
		rotationOffset: 0,
		participantIds: ['b', 'c'],
	});
	assert.ok(result.ok);
	assert.deepEqual(result.splits.map((s) => s.debtorMemberId).sort(), ['b', 'c']);
	assert.equal(
		result.splits.reduce((sum, s) => sum + s.amountCents, 0),
		1001,
	);
});

test('an equal split without any usable participant is refused', () => {
	for (const participantIds of [[], ['gone']]) {
		const result = buildSplitsFromForm({
			splitMode: 'equal',
			members,
			manualSplits: {},
			amountCents: 1000,
			rotationOffset: 0,
			participantIds,
		});
		assert.deepEqual(result, { ok: false, reason: 'no_members' });
	}
});

test('a saved equal split among a subset reopens with that subset', () => {
	const subset = [
		{ debtorMemberId: 'a', amountCents: 500 },
		{ debtorMemberId: 'c', amountCents: 500 },
	];
	assert.deepEqual(equalSplitParticipants(1000, subset, members), ['a', 'c']);
	assert.equal(
		equalSplitParticipants(
			1000,
			[
				{ debtorMemberId: 'a', amountCents: 600 },
				{ debtorMemberId: 'c', amountCents: 400 },
			],
			members,
		),
		null,
	);
	assert.equal(
		equalSplitParticipants(1000, subset, [
			{ id: 'a', active: true },
			{ id: 'c', active: false },
		]),
		null,
	);
});

test('edits that reopen paid shares are reported, unchanged and own shares are not', () => {
	const paid = '2026-01-01T00:00:00.000Z';
	const previous = [
		{ debtorMemberId: 'payer', amountCents: 500, settledAt: paid },
		{ debtorMemberId: 'b', amountCents: 500, settledAt: paid },
		{ debtorMemberId: 'c', amountCents: 500, settledAt: paid },
		{ debtorMemberId: 'd', amountCents: 500, settledAt: null },
	];
	const next = [
		{ debtorMemberId: 'payer', amountCents: 600 },
		{ debtorMemberId: 'b', amountCents: 600 },
		{ debtorMemberId: 'c', amountCents: 500 },
		{ debtorMemberId: 'd', amountCents: 700 },
	];
	assert.deepEqual(settledSharesAffectedByEdit(previous, next, 'payer'), [
		{ debtorMemberId: 'b', previousCents: 500, nextCents: 600 },
	]);
	assert.deepEqual(
		settledSharesAffectedByEdit(previous, [{ debtorMemberId: 'c', amountCents: 500 }], 'payer'),
		[{ debtorMemberId: 'b', previousCents: 500, nextCents: null }],
	);
});
