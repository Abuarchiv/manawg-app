import assert from 'node:assert/strict';
import test from 'node:test';

const { dueAtForDay, dueDayKey } = await import('../src/features/chores/chore-due-date.ts');

test('a new chore due on a picked day is due at noon Berlin time', () => {
	assert.equal(dueAtForDay('2026-10-12'), '2026-10-12T10:00:00.000Z');
	assert.equal(dueAtForDay('2026-01-12'), '2026-01-12T11:00:00.000Z');
});

test('editing keeps the wall time of the previous due date across DST', () => {
	// 18:30 Berlin in summer time, moved into winter time.
	assert.equal(dueAtForDay('2026-11-02', '2026-10-05T16:30:00.000Z'), '2026-11-02T17:30:00.000Z');
});

test('invalid day keys are rejected instead of throwing', () => {
	assert.equal(dueAtForDay(''), null);
	assert.equal(dueAtForDay('12.10.2026'), null);
});

test('dueDayKey shows the Berlin day, not the UTC day', () => {
	assert.equal(dueDayKey('2026-10-05T22:30:00.000Z'), '2026-10-06');
	assert.equal(dueDayKey('kaputt'), '');
});

const { diffChoreEdit } = await import('../src/features/chores/chore-edit.ts');

const stored = {
	id: 'c1',
	title: 'Bad putzen',
	intervalDays: 7,
	recurrenceType: 'days' as const,
	nextDueAt: '2026-10-05T16:30:00.000Z',
	assignedMemberId: 'anna' as string | null,
	lastCompletedAt: null,
	lastCompletedByName: null,
	openGapCountForAssignee: 0,
};
const untouched = {
	title: 'Bad putzen',
	assigned: 'anna',
	dueDay: '2026-10-05',
	interval: 7,
	recurrenceType: 'days' as const,
};

test('an untouched edit form changes nothing', () => {
	assert.deepEqual(diffChoreEdit(stored, untouched), {});
});

test('only changed fields are sent, the due day keeps the usual hour', () => {
	assert.deepEqual(
		diffChoreEdit(stored, { ...untouched, title: '  Bad wischen ', dueDay: '2026-10-06' }),
		{ title: 'Bad wischen', nextDueAt: '2026-10-06T16:30:00.000Z' },
	);
});

test('clearing the assignee and changing the rhythm are sent together with their unit', () => {
	assert.deepEqual(
		diffChoreEdit(stored, { ...untouched, assigned: '', interval: 1, recurrenceType: 'months' }),
		{ assignedMemberId: null, intervalDays: 1, recurrenceType: 'months' },
	);
});
