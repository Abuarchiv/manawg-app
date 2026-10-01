import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const path = resolve(appRoot, 'src', `${specifier.slice(2)}.ts`);
			return nextResolve(pathToFileURL(path).href, context);
		}
		return nextResolve(specifier, context);
	},
});

const { buildChoreFairness, chooseNextAvailableMember } = await import(
	'../src/features/chores/chore-fairness.ts'
);
const { formatAbsenceRange, isMemberAbsent } = await import('../src/features/chores/absence.ts');
const { buildChorePatchUpdate } = await import('../src/features/chores/chore-patch.ts');
const { computeNextDueAt } = await import('../src/features/chores/chore-recurrence.ts');

const now = Date.parse('2026-09-23T12:00:00.000Z');

test('fairness counts each assignee-wide overdue total once', () => {
	const fairness = buildChoreFairness({
		members: [
			{ id: 'alice', name: 'Alice' },
			{ id: 'bob', name: 'Bob' },
		],
		chores: [
			{
				assignedMemberId: 'alice',
				openGapCountForAssignee: 3,
				nextDueAt: '2026-09-20T12:00:00.000Z',
			},
			{
				assignedMemberId: 'alice',
				openGapCountForAssignee: 3,
				nextDueAt: '2026-09-21T12:00:00.000Z',
			},
			{
				assignedMemberId: 'alice',
				openGapCountForAssignee: 3,
				nextDueAt: '2026-09-22T12:00:00.000Z',
			},
		],
		now,
	});
	const alice = fairness.rows.find((row) => row.id === 'alice');

	assert.deepEqual(
		alice && {
			assignedCount: alice.assignedCount,
			openGapCount: alice.openGapCount,
			overdueCount: alice.overdueCount,
			score: alice.score,
		},
		{ assignedCount: 3, openGapCount: 3, overdueCount: 3, score: 21 },
	);
});

test('offline chores with zero gaps do not hide another chore gaps for that assignee', () => {
	const fairness = buildChoreFairness({
		members: [{ id: 'alice', name: 'Alice' }],
		chores: [
			{
				assignedMemberId: 'alice',
				openGapCountForAssignee: 0,
				nextDueAt: '2026-09-25T12:00:00.000Z',
			},
			{
				assignedMemberId: 'alice',
				openGapCountForAssignee: 3,
				nextDueAt: '2026-09-20T12:00:00.000Z',
			},
			{
				assignedMemberId: 'alice',
				openGapCountForAssignee: 3,
				nextDueAt: '2026-09-21T12:00:00.000Z',
			},
			{
				assignedMemberId: 'alice',
				openGapCountForAssignee: 3,
				nextDueAt: '2026-09-22T12:00:00.000Z',
			},
		],
		now,
	});

	assert.equal(fairness.rows[0]?.openGapCount, 3);
});

test('score-aware rotation skips the just-completed assignee when another member is available', () => {
	const nextMember = chooseNextAvailableMember({
		members: [
			{ id: 'alice', name: 'Alice' },
			{ id: 'bob', name: 'Bob' },
		],
		currentMemberId: 'alice',
		chores: [
			{
				assignedMemberId: 'alice',
				openGapCountForAssignee: 0,
				nextDueAt: '2026-09-24T12:00:00.000Z',
			},
			{
				assignedMemberId: 'bob',
				openGapCountForAssignee: 0,
				nextDueAt: '2026-09-24T12:00:00.000Z',
			},
			{
				assignedMemberId: 'bob',
				openGapCountForAssignee: 0,
				nextDueAt: '2026-09-25T12:00:00.000Z',
			},
		],
		now,
	});

	assert.equal(nextMember, 'bob');
});

test('explicit monthly due-date changes reset the cadence anchor', () => {
	const changedDate = new Date('2026-03-30T12:00:00.000Z');
	const result = buildChorePatchUpdate(
		{
			intervalDays: 1,
			recurrenceType: 'months',
			nextDueAt: new Date('2026-01-31T12:00:00.000Z'),
		},
		{ nextDueAt: changedDate.toISOString() },
	);

	assert.deepEqual(result, {
		update: { nextDueAt: changedDate, anchorAt: changedDate },
		validCadence: true,
	});
});

test('PATCH validates the interval against the resulting recurrence unit', () => {
	const result = buildChorePatchUpdate(
		{
			intervalDays: 365,
			recurrenceType: 'days',
			nextDueAt: new Date('2026-09-30T12:00:00.000Z'),
		},
		{ recurrenceType: 'months' },
	);

	assert.equal(result.validCadence, false);
});

test('switching from days to months anchors the month cycle at the current due date', () => {
	const currentDueAt = new Date('2026-09-30T12:00:00.000Z');
	const result = buildChorePatchUpdate(
		{ intervalDays: 7, recurrenceType: 'days', nextDueAt: currentDueAt },
		{ recurrenceType: 'months' },
	);

	assert.deepEqual(result, {
		update: { recurrenceType: 'months', anchorAt: currentDueAt },
		validCadence: true,
	});
});

test('absence end date includes the selected Berlin calendar day', () => {
	const absence = [{ memberId: 'alice', startDate: '2026-09-24', endDate: '2026-09-24' }];
	assert.equal(isMemberAbsent(absence, 'alice', Date.parse('2026-09-24T18:00:00+02:00')), true);
	assert.equal(isMemberAbsent(absence, 'alice', Date.parse('2026-09-25T00:00:00+02:00')), false);
});

test('absence dates use Berlin days across daylight saving and travel', () => {
	const startDate = '2026-03-29T00:00:00+01:00';
	const endDate = '2026-03-29T23:59:59+02:00';
	const absence = [
		{
			memberId: 'alice',
			startDate,
			endDate,
		},
	];
	assert.equal(isMemberAbsent(absence, 'alice', Date.parse('2026-03-29T00:00:00+01:00')), true);
	assert.equal(isMemberAbsent(absence, 'alice', Date.parse('2026-03-30T00:00:00+02:00')), false);
	assert.equal(formatAbsenceRange(startDate, endDate), '29.03. bis 29.03.');
});

test('monthly chore recurrence preserves Berlin month-end and seconds across time zones', () => {
	const monthly = computeNextDueAt(
		new Date('2026-01-31T00:30:12.345+01:00'),
		1,
		new Date('2026-01-31T00:30:12.345+01:00'),
		'months',
		new Date('2026-01-31T00:30:12.345+01:00'),
	);
	assert.equal(monthly.toISOString(), '2026-02-27T23:30:12.345Z');
});

test('daily chore recurrence advances the Berlin date across fall-back DST', () => {
	const daily = computeNextDueAt(
		new Date('2026-10-25T00:30:00+02:00'),
		1,
		new Date('2026-10-25T00:30:00+02:00'),
	);
	assert.equal(daily.toISOString(), '2026-10-25T23:30:00.000Z');
});

test('monthly recurrence shifts a missing Berlin spring wall time through the DST gap', () => {
	const next = computeNextDueAt(
		new Date('2026-03-28T02:30:12.345+01:00'),
		1,
		new Date('2026-03-28T02:30:12.345+01:00'),
		'days',
	);
	assert.equal(next.toISOString(), '2026-03-29T01:30:12.345Z');
});
