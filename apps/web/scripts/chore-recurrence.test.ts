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

const { computeNextDueAt, isLateCompletion } = await import(
	'../src/features/chores/chore-recurrence.ts'
);
const { getChorePlanHealth } = await import('../src/features/chores/chore-status.ts');

const berlin = new Intl.DateTimeFormat('sv-SE', {
	timeZone: 'Europe/Berlin',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});
const inBerlin = (date: Date) => berlin.format(date);

test('monthly chores keep the month-end anchor across clamps (31.01 → 28.02 → 31.03 → 30.04)', () => {
	const created = new Date('2026-01-31T08:00:00.000Z'); // 31.01. 09:00 Berlin
	let due = computeNextDueAt(created, 1, created, 'months');
	const anchorAt = created;
	const seen = [inBerlin(due)];
	for (let cycle = 0; cycle < 3; cycle++) {
		// Complete on the due day, but hours after the due time.
		const completedAt = new Date(due.getTime() + 9 * 60 * 60 * 1000);
		assert.equal(isLateCompletion(due, completedAt), false);
		due = computeNextDueAt(due, 1, completedAt, 'months', anchorAt);
		seen.push(inBerlin(due));
	}
	assert.deepEqual(seen, [
		'2026-02-28 09:00',
		'2026-03-31 09:00',
		'2026-04-30 09:00',
		'2026-05-31 09:00',
	]);
});

test('a monthly chore due at Berlin midnight keeps its Berlin calendar day', () => {
	const due = new Date('2026-02-28T23:00:00.000Z'); // 01.03. 00:00 Berlin
	const next = computeNextDueAt(due, 1, due, 'months', due);
	assert.equal(inBerlin(next), '2026-04-01 00:00');
});

test('a late completion re-anchors the cycle on the completion day', () => {
	const due = new Date('2026-03-10T08:00:00.000Z');
	const completedAt = new Date('2026-03-13T17:30:00.000Z');
	assert.equal(isLateCompletion(due, completedAt), true);
	assert.equal(inBerlin(computeNextDueAt(due, 1, completedAt, 'months', due)), '2026-04-13 18:30');
	assert.equal(inBerlin(computeNextDueAt(due, 7, completedAt, 'days')), '2026-03-20 18:30');
});

test('early completions keep the cadence', () => {
	const due = new Date('2026-03-10T08:00:00.000Z');
	const completedAt = new Date('2026-03-08T08:00:00.000Z');
	assert.equal(inBerlin(computeNextDueAt(due, 7, completedAt, 'days')), '2026-03-17 09:00');
});

test('day intervals step Berlin calendar days across DST (no weekday shift)', () => {
	// 19.10.2026 00:00 CEST; Berlin switches to CET on 25.10.2026.
	const autumn = new Date('2026-10-18T22:00:00.000Z');
	const next = computeNextDueAt(autumn, 6, autumn, 'days');
	assert.equal(inBerlin(next), '2026-10-25 00:00');
	assert.equal(next.toISOString(), '2026-10-24T22:00:00.000Z');

	// 23.03.2026 23:30 CET; Berlin switches to CEST on 29.03.2026.
	const spring = new Date('2026-03-23T22:30:00.000Z');
	assert.equal(inBerlin(computeNextDueAt(spring, 7, spring, 'days')), '2026-03-30 23:30');
});

test('a wall time inside the spring-forward gap moves to the next valid hour', () => {
	const due = new Date('2026-03-28T01:30:00.000Z'); // 28.03. 02:30 CET
	assert.equal(inBerlin(computeNextDueAt(due, 1, due, 'days')), '2026-03-29 03:30');
});

test('interval 0 keeps the previous due date', () => {
	const due = new Date('2026-03-10T08:00:00.000Z');
	assert.equal(computeNextDueAt(due, 0, new Date(), 'days').getTime(), due.getTime());
});

test('getChorePlanHealth counts gaps, due-today and escalations on Berlin days', () => {
	const now = Date.parse('2026-09-23T10:00:00.000Z');
	assert.deepEqual(getChorePlanHealth([], now), {
		total: 0,
		gaps: 0,
		dueToday: 0,
		escalated: 0,
		nextLabel: 'keine',
	});
	const health = getChorePlanHealth(
		[
			{ nextDueAt: '2026-09-20T10:00:00.000Z' },
			{ nextDueAt: '2026-09-22T10:00:00.000Z' },
			{ nextDueAt: '2026-09-23T21:30:00.000Z' },
			{ nextDueAt: '2026-09-23T22:30:00.000Z' },
		],
		now,
	);
	assert.deepEqual(health, {
		total: 4,
		gaps: 2,
		dueToday: 1,
		escalated: 1,
		nextLabel: 'seit 3 T. offen',
	});
});
