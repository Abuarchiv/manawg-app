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

const { addBerlinDays, berlinDayKey, berlinWallMinutes } = await import(
	'../src/core/utils/berlin-day.ts'
);
const { computeInitialDue, computeNextDueAt, isLateCompletion } = await import(
	'../src/features/chores/chore-recurrence.ts'
);
const { getChorePlanHealth, suggestChoreAssignee } = await import(
	'../src/features/chores/chore-status.ts'
);

const MS_PER_DAY = 86_400_000;

function assertWall(actual, dayKey, minutes) {
	assert.equal(berlinDayKey(actual), dayKey);
	assert.equal(berlinWallMinutes(actual), minutes);
}

// ---------------------------------------------------------------------------
// Monthly cadence (#507): the anchor is the intended day, not the clamp.
// ---------------------------------------------------------------------------

test('monthly cadence created on 31.01 runs 31.01 → 28.02 → 31.03 → 30.04 … 31.12', () => {
	const createdAt = new Date('2026-01-31T09:00:00+01:00');
	const initial = computeInitialDue(createdAt, 1, 'months', null);

	// The first due is clamped to the last day of February …
	assert.equal(berlinDayKey(initial.nextDueAt), '2026-02-28');
	// … but the stored anchor keeps the intended day-of-month.
	assert.equal(berlinDayKey(initial.anchorAt), '2026-01-31');

	const expected = [
		'2026-01-31',
		'2026-02-28',
		'2026-03-31',
		'2026-04-30',
		'2026-05-31',
		'2026-06-30',
		'2026-07-31',
		'2026-08-31',
		'2026-09-30',
		'2026-10-31',
		'2026-11-30',
		'2026-12-31',
		'2027-01-31',
	];
	const days = [berlinDayKey(createdAt)];
	// Complete every cycle on its due day, exactly at the due time.
	let due = initial.nextDueAt;
	while (days.length < expected.length) {
		days.push(berlinDayKey(due));
		due = computeNextDueAt(due, 1, due, 'months', initial.anchorAt);
	}
	assert.deepEqual(days, expected);
});

test('storing the clamped first due as anchor would freeze the day at 28 (#507)', () => {
	const createdAt = new Date('2026-01-31T09:00:00+01:00');
	const initial = computeInitialDue(createdAt, 1, 'months', null);
	const clampedAnchor = initial.nextDueAt; // what the route used to store
	const next = computeNextDueAt(initial.nextDueAt, 1, initial.nextDueAt, 'months', clampedAnchor);
	assert.equal(berlinDayKey(next), '2026-03-28');
	// With the intended anchor the same step lands on the 31st.
	const anchored = computeNextDueAt(
		initial.nextDueAt,
		1,
		initial.nextDueAt,
		'months',
		initial.anchorAt,
	);
	assert.equal(berlinDayKey(anchored), '2026-03-31');
});

test('completion later on the due day is on time and keeps the anchor (#507)', () => {
	const createdAt = new Date('2026-01-31T09:00:00+01:00');
	const initial = computeInitialDue(createdAt, 1, 'months', null);
	const due = initial.nextDueAt;
	assert.equal(berlinWallMinutes(due), 9 * 60);

	// Due 09:00 Berlin, completed 18:00 Berlin on the same day.
	const completedAt = new Date('2026-02-28T18:00:00+01:00');
	assert.equal(isLateCompletion(due, completedAt), false);

	const next = computeNextDueAt(due, 1, completedAt, 'months', initial.anchorAt);
	assert.equal(berlinDayKey(next), '2026-03-31');
	// The route persists the same decision, so a later cycle must agree.
	assert.equal(isLateCompletion(due, completedAt), false);
});

test('an early completion advances from the scheduled due, not from completion', () => {
	const createdAt = new Date('2026-01-31T09:00:00+01:00');
	const initial = computeInitialDue(createdAt, 1, 'months', null);
	const completedAt = new Date('2026-02-26T10:00:00+01:00');
	assert.equal(isLateCompletion(initial.nextDueAt, completedAt), false);
	const next = computeNextDueAt(initial.nextDueAt, 1, completedAt, 'months', initial.anchorAt);
	assert.equal(berlinDayKey(next), '2026-03-31');
});

test('a genuinely late completion re-anchors the cycle on completedAt (#507)', () => {
	const createdAt = new Date('2026-01-31T09:00:00+01:00');
	const initial = computeInitialDue(createdAt, 1, 'months', null);
	const completedAt = new Date('2026-03-05T10:00:00+01:00');
	assert.equal(isLateCompletion(initial.nextDueAt, completedAt), true);
	const next = computeNextDueAt(initial.nextDueAt, 1, completedAt, 'months', initial.anchorAt);
	assert.equal(berlinDayKey(next), '2026-04-05');
});

test('lateness follows the Berlin day, not the UTC day or the raw timestamp', () => {
	const due = new Date('2026-06-30T23:30:00+02:00');

	// 00:15 on 01.07 in Berlin, still 30.06 in UTC: late for members.
	const afterMidnight = new Date('2026-07-01T00:15:00+02:00');
	assert.equal(afterMidnight.getUTCDate(), 30);
	assert.equal(isLateCompletion(due, afterMidnight), true);

	// Same Berlin day, 29 minutes after the due time: on time.
	assert.equal(isLateCompletion(due, new Date('2026-06-30T23:59:00+02:00')), false);
	// Still the day before: early.
	assert.equal(isLateCompletion(due, new Date('2026-06-29T23:59:00+02:00')), false);
});

test('an explicitly requested due date is stored unchanged as due and anchor', () => {
	const createdAt = new Date('2026-01-15T09:00:00+01:00');
	const requested = new Date('2026-02-03T17:30:00+01:00');
	const initial = computeInitialDue(createdAt, 1, 'months', requested);
	assert.equal(initial.nextDueAt.toISOString(), requested.toISOString());
	assert.equal(initial.anchorAt.toISOString(), requested.toISOString());
});

test('a non-recurring chore never advances', () => {
	const due = new Date('2026-06-01T09:00:00+02:00');
	for (const interval of [0, -3, Number.NaN]) {
		const next = computeNextDueAt(due, interval, new Date('2026-06-09T09:00:00+02:00'), 'days');
		assert.equal(next.getTime(), due.getTime());
	}
});

// ---------------------------------------------------------------------------
// Day cadence across DST (#522): calendar days in Berlin, not 24h arithmetic.
// ---------------------------------------------------------------------------

test('days recurrence keeps the wall clock across the autumn DST change (#522)', () => {
	// Berlin midnight on the last Sunday of October 2026, CET switch at 03:00.
	const due = new Date('2026-10-25T00:00:00+02:00');
	const next = computeNextDueAt(due, 1, due, 'days');
	assertWall(next, '2026-10-26', 0);

	// Raw 24h arithmetic (the old implementation) crosses the 25-hour day and
	// lands on the previous calendar day at 23:00.
	const raw = new Date(due.getTime() + MS_PER_DAY);
	assert.equal(berlinDayKey(raw), '2026-10-25');
	assert.equal(berlinWallMinutes(raw), 23 * 60);
});

test('days recurrence keeps the wall clock across the spring DST change (#522)', () => {
	// Midnight on the transition day (02:00 → 03:00 at 03:00 CET).
	const due = new Date('2026-03-29T00:00:00+01:00');
	const next = computeNextDueAt(due, 1, due, 'days');
	assertWall(next, '2026-03-30', 0);

	// Raw 24h arithmetic arrives an hour late on the 23-hour day.
	const raw = new Date(due.getTime() + MS_PER_DAY);
	assert.equal(berlinWallMinutes(raw), 60);
});

test('a seven-day step across the autumn change keeps the weekday (#522)', () => {
	const due = new Date('2026-10-19T00:00:00+02:00'); // Monday
	const next = computeNextDueAt(due, 7, due, 'days');
	assertWall(next, '2026-10-26', 0);
	// 26.10.2026 is a Monday; raw arithmetic would have produced Sunday 25.10.
	assert.equal(new Date(Date.UTC(2026, 9, 26)).getUTCDay(), 1);
	const raw = new Date(due.getTime() + 7 * MS_PER_DAY);
	assert.equal(berlinDayKey(raw), '2026-10-25');
});

test('a due time inside the spring-forward gap fires after the gap, not never', () => {
	// 02:30 does not exist on 29.03.2026 (02:00 CET jumps to 03:00 CEST).
	const due = new Date('2026-03-28T02:30:00+01:00');
	const next = computeNextDueAt(due, 1, due, 'days');
	assertWall(next, '2026-03-29', 3 * 60 + 30);
});

test('days recurrence outside a transition is unchanged wall-clock arithmetic', () => {
	const due = new Date('2026-06-01T09:00:00+02:00');
	assertWall(computeNextDueAt(due, 7, due, 'days'), '2026-06-08', 9 * 60);
	assertWall(addBerlinDays(due, 7), '2026-06-08', 9 * 60);
});

test('multi-day steps land on the intended Berlin day through the change', () => {
	const due = new Date('2026-10-24T00:00:00+02:00');
	assertWall(addBerlinDays(due, 3), '2026-10-27', 0);
	assertWall(addBerlinDays(due, -3), '2026-10-21', 0);
});

test('a late day-cadence completion advances from completion time', () => {
	const due = new Date('2026-06-01T09:00:00+02:00');
	const completedAt = new Date('2026-06-03T09:00:00+02:00');
	const next = computeNextDueAt(due, 7, completedAt, 'days');
	assertWall(next, '2026-06-10', 9 * 60);
});

// ---------------------------------------------------------------------------
// Plan health and assignee suggestion (#523).
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-23T12:00:00+02:00'); // Berlin noon, a Wednesday

test('plan health of an empty plan is all zeros', () => {
	assert.deepEqual(getChorePlanHealth([], NOW), {
		total: 0,
		gaps: 0,
		dueToday: 0,
		escalated: 0,
		nextLabel: 'keine',
	});
});

test('plan health counts gaps, due-today chores and escalations', () => {
	const health = getChorePlanHealth(
		[
			{ nextDueAt: '2026-09-21T09:00:00+02:00' }, // open for 2 days → escalated
			{ nextDueAt: '2026-09-23T09:00:00+02:00' }, // due today
			{ nextDueAt: '2026-09-24T09:00:00+02:00' }, // tomorrow
			{ nextDueAt: '2026-09-20T09:00:00+02:00' }, // open for 3 days → escalated
			{ nextDueAt: 'not-a-date' }, // unknown, counted only in total
		],
		NOW,
	);
	assert.deepEqual(health, {
		total: 5,
		gaps: 2,
		dueToday: 1,
		escalated: 2,
		nextLabel: 'seit 2 T. offen',
	});
});

test('plan health labels the first chore in the list as next', () => {
	const health = getChorePlanHealth(
		[{ nextDueAt: '2026-09-24T09:00:00+02:00' }, { nextDueAt: '2026-09-21T09:00:00+02:00' }],
		NOW,
	);
	assert.equal(health.nextLabel, 'morgen');
	assert.equal(health.gaps, 1);
});

test('assignee suggestion returns null without members', () => {
	assert.equal(
		suggestChoreAssignee({
			members: [],
			chores: [{ assignedMemberId: null, nextDueAt: '2026-09-21T09:00:00+02:00' }],
			now: NOW,
		}),
		null,
	);
});

test('assignee suggestion prefers the member with the lowest weighted load', () => {
	const members = [
		{ id: 'alice', name: 'Alice' },
		{ id: 'bob', name: 'Bob' },
	];
	const suggestion = suggestChoreAssignee({
		members,
		now: NOW,
		chores: [
			// overdue counts 4
			{ assignedMemberId: 'alice', nextDueAt: '2026-09-21T09:00:00+02:00' },
			// due today 2 + planned 1 = 3
			{ assignedMemberId: 'bob', nextDueAt: '2026-09-23T09:00:00+02:00' },
			{ assignedMemberId: 'bob', nextDueAt: '2026-09-30T09:00:00+02:00' },
		],
	});
	assert.equal(suggestion?.id, 'bob');
});

test('assignee suggestion breaks score ties by name', () => {
	const members = [
		{ id: 'zoe', name: 'Zoe' },
		{ id: 'anna', name: 'Anna' },
	];
	assert.equal(suggestChoreAssignee({ members, chores: [], now: NOW })?.id, 'anna');
});

test('assignee suggestion ignores unknown and unassigned chores', () => {
	const members = [
		{ id: 'alice', name: 'Alice' },
		{ id: 'bob', name: 'Bob' },
	];
	const suggestion = suggestChoreAssignee({
		members,
		now: NOW,
		chores: [
			{ assignedMemberId: null, nextDueAt: '2026-09-21T09:00:00+02:00' },
			{ assignedMemberId: 'ghost', nextDueAt: '2026-09-21T09:00:00+02:00' },
		],
	});
	assert.equal(suggestion?.id, 'alice');
});
