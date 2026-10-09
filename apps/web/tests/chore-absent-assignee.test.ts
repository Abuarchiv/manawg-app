import assert from 'node:assert/strict';
import test from 'node:test';

const { getAbsentAssigneeChoreIds } = await import('../src/features/chores/absence.ts');
const { filterOverdueGroups, getChoreRepairHint, groupChoresForPlan } = await import(
	'../src/features/chores/chore-status.ts'
);

const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const day = (offset: number) => new Date(NOW + offset * 86_400_000).toISOString();
// Anna is away from 12.10. to 14.10.
const absences = [
	{ memberId: 'anna', startDate: '2026-10-11T22:00:00.000Z', endDate: '2026-10-13T22:00:00.000Z' },
];

test('a chore due while the assignee is away is flagged, even when planned days ahead', () => {
	const chores = [
		{ id: 'during', assignedMemberId: 'anna', nextDueAt: day(4) },
		{ id: 'before', assignedMemberId: 'anna', nextDueAt: day(1) },
		{ id: 'other', assignedMemberId: 'ben', nextDueAt: day(4) },
		{ id: 'nobody', assignedMemberId: null, nextDueAt: day(4) },
	];
	assert.deepEqual([...getAbsentAssigneeChoreIds(chores, absences, NOW)], ['during']);
});

test('an overdue chore is judged by today, not by its past due day', () => {
	const chores = [{ id: 'late', assignedMemberId: 'anna', nextDueAt: day(-3) }];
	const awayToday = [{ memberId: 'anna', startDate: day(-1), endDate: day(2) }];
	assert.equal(getAbsentAssigneeChoreIds(chores, absences, NOW).size, 0);
	assert.equal(getAbsentAssigneeChoreIds(chores, awayToday, NOW).size, 1);
});

test('an absent assignee gets a take-over hint before the chore is escalated', () => {
	const chore = { assignedMemberId: 'anna', nextDueAt: day(1), assigneeAbsent: true };
	assert.deepEqual(getChoreRepairHint(chore, NOW), {
		tone: 'danger',
		title: 'Zuständig ist abwesend',
		action: 'Ich übernehme',
	});
	assert.equal(getChoreRepairHint({ ...chore, assigneeAbsent: false }, NOW), null);
});

test('chores with an absent assignee sort ahead within their group', () => {
	const groups = groupChoresForPlan(
		[
			{ id: 'a', assignedMemberId: 'ben', nextDueAt: day(3), assigneeAbsent: false },
			{ id: 'b', assignedMemberId: 'anna', nextDueAt: day(3), assigneeAbsent: true },
		],
		'me',
	);
	assert.deepEqual(
		groups[0]?.chores.map((chore) => chore.id),
		['b', 'a'],
	);
});

test('the overdue filter keeps only overdue chores and drops empty groups', () => {
	const groups = groupChoresForPlan(
		[
			{ id: 'late', assignedMemberId: 'ben', nextDueAt: day(-3) },
			{ id: 'soon', assignedMemberId: 'ben', nextDueAt: day(3) },
			{ id: 'mine-late', assignedMemberId: 'me', nextDueAt: day(-1) },
		],
		'me',
	);
	const filtered = filterOverdueGroups(groups);
	assert.deepEqual(filtered.flatMap((group) => group.chores.map((chore) => chore.id)).sort(), [
		'late',
		'mine-late',
	]);
	assert.equal(
		filtered.every((group) => group.chores.length > 0),
		true,
	);
});
