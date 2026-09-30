import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const path = resolve(appRoot, 'src', `${specifier.slice(2)}.ts`);
			return nextResolve(pathToFileURL(path).href, context);
		}
		return nextResolve(specifier, context);
	},
});

const { buildSplitsFromForm, isEqualExpenseSplit, remainderCandidates } = await import(
	'./expense-split-input.ts'
);
const { distributeRemainderSplits } = await import('./manual-split-remainder.ts');
const { buildEqualSplits } = await import('./split-math.ts');
const { parseEuroAmount } = await import('../../core/utils/amount.ts');

const MEMBERS = [
	{ id: 'alice', active: true },
	{ id: 'ben', active: false },
];
const ACTIVE_MEMBERS = [
	{ id: 'alice', active: true },
	{ id: 'bob', active: true },
	{ id: 'cara', active: true },
];
const ACTIVE_IDS = ACTIVE_MEMBERS.map((member) => member.id);

test('#490 create-mode remainder never assigns cents to a moved-out member', () => {
	const candidates = remainderCandidates(MEMBERS, 'manual', {}, false);
	assert.deepEqual(
		candidates.map((member) => member.id),
		['alice'],
	);

	const next = distributeRemainderSplits(candidates, {}, 100);
	assert.deepEqual(next, { alice: '1,00' });

	const result = buildSplitsFromForm({
		splitMode: 'manual',
		members: MEMBERS,
		manualSplits: next,
		amountCents: 100,
		rotationOffset: 0,
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.splits, [{ debtorMemberId: 'alice', amountCents: 100 }]);
});

test('#490 create-mode remainder candidates match the visible split rows', () => {
	const withDepartedValue = remainderCandidates(MEMBERS, 'manual', { ben: '2,50' }, false);
	assert.deepEqual(
		withDepartedValue.map((member) => member.id),
		['alice'],
	);
});

test('#490 editing keeps a departed share locked out of the remainder', () => {
	const manualSplits = { alice: '', ben: '2,50' };
	const candidates = remainderCandidates(MEMBERS, 'manual', manualSplits, true);
	assert.deepEqual(
		candidates.map((member) => member.id),
		['alice'],
	);

	const next = distributeRemainderSplits(candidates, manualSplits, 100);
	assert.deepEqual(next, { alice: '1,00', ben: '2,50' });
});

test('#494 a rotated uneven equal split is still detected as equal', () => {
	const amountCents = 1001;
	for (const rotationOffset of [0, 1, 2]) {
		const splits = buildEqualSplits(amountCents, ACTIVE_IDS, rotationOffset);
		assert.equal(
			isEqualExpenseSplit(amountCents, splits, ACTIVE_MEMBERS),
			true,
			`rotation offset ${rotationOffset}`,
		);
	}
});

test('#494 unequal splits and incomplete debtor sets stay manual', () => {
	const amountCents = 1001;
	const uneven = [
		{ debtorMemberId: 'alice', amountCents: 1001 },
		{ debtorMemberId: 'bob', amountCents: 0 },
		{ debtorMemberId: 'cara', amountCents: 0 },
	];
	assert.equal(isEqualExpenseSplit(amountCents, uneven, ACTIVE_MEMBERS), false);

	const duplicateDebtor = [
		{ debtorMemberId: 'alice', amountCents: 334 },
		{ debtorMemberId: 'bob', amountCents: 334 },
		{ debtorMemberId: 'bob', amountCents: 333 },
	];
	assert.equal(isEqualExpenseSplit(amountCents, duplicateDebtor, ACTIVE_MEMBERS), false);

	const departedSplit = buildEqualSplits(amountCents, ['alice', 'bob', 'ben'], 0);
	assert.equal(
		isEqualExpenseSplit(amountCents, departedSplit, [
			...ACTIVE_MEMBERS,
			{ id: 'ben', active: false },
		]),
		false,
	);
});

test('#492 an over-allocation is taken back from positive rows, never below zero', () => {
	const members = [{ id: 'alice' }, { id: 'bob' }];
	const manualSplits = { alice: '6,00', bob: '6,00' };
	const balanced = distributeRemainderSplits(members, manualSplits, -200);
	assert.deepEqual(balanced, { alice: '5,00', bob: '5,00' });

	const clamped = distributeRemainderSplits(members, { alice: '1,00', bob: '10,00' }, -600);
	assert.deepEqual(clamped, { alice: '0,00', bob: '5,00' });

	for (const value of [...Object.values(balanced ?? {}), ...Object.values(clamped ?? {})]) {
		assert.notEqual(parseEuroAmount(value), null, `expected a parseable amount, got ${value}`);
	}
});

test('#493 the remainder distribution is pure and repeatable', () => {
	const members = [{ id: 'alice' }, { id: 'bob' }];
	const manualSplits = { alice: '1,00', bob: '' };
	const snapshot = { ...manualSplits };

	const first = distributeRemainderSplits(members, manualSplits, 100);
	const second = distributeRemainderSplits(members, manualSplits, 100);

	assert.deepEqual(manualSplits, snapshot);
	assert.deepEqual(first, second);
	assert.deepEqual(first, { alice: '1,00', bob: '1,00' });
});
