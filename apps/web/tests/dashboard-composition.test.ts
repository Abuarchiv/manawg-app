import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { ActivityItem } from '../src/composition/dashboard-feed.ts';

// Dashboard feed / agenda regressions: attribution, ordering, calendar-day overdue.

const schema = await import('../src/core/db/schema.ts');
mock.module('@/core/db', { namedExports: { ...schema, db: {} } });
mock.module('@/core/infra/observability', {
	namedExports: { captureException: () => undefined, logApiError: () => undefined },
});

const { appendSecondaryActivity, buildPrimaryActivity } = await import(
	'../src/composition/dashboard-feed.ts'
);
const { buildDueChores } = await import('../src/composition/dashboard-data.ts');
const { getWeekAgenda } = await import('../src/composition/dashboard-week-agenda.ts');
const { activityItemKey, buildActivityTimeline } = await import('../src/composition/activity.ts');

const members = new Map([
	['anna', { name: 'Anna' }],
	['ben', { name: 'Ben' }],
]);

test('a bought item is attributed to the buyer, not to whoever added it', () => {
	const bought = new Date('2026-09-02T10:00:00Z');
	const created = new Date('2026-08-01T10:00:00Z');
	const { activity } = buildPrimaryActivity(
		[],
		[
			{
				id: 's1',
				name: 'Milch',
				addedByMemberId: 'anna',
				boughtByMemberId: 'ben',
				createdAt: created,
				boughtAt: bought,
			},
		] as never,
		[],
		members,
		'CODE',
	);
	assert.equal(activity[0]?.memberId, 'ben');
	assert.equal(activity[0]?.memberName, 'Ben');

	const timeline = buildActivityTimeline({
		members: [
			{ id: 'anna', name: 'Anna' },
			{ id: 'ben', name: 'Ben' },
		],
		expenses: [],
		shoppingItems: [
			{
				id: 's1',
				name: 'Milch',
				addedByMemberId: 'anna',
				boughtByMemberId: 'ben',
				createdAt: created.toISOString(),
				boughtAt: bought.toISOString(),
			},
		],
		announcements: [],
		choreCompletions: [],
		recurringExpenses: [],
		absences: [],
		auditEvents: [],
		limit: 10,
	} as never);
	assert.equal(timeline[0]?.memberId, 'ben');
});

test('a future absence sorts by entry time and the newest of many rows survives', () => {
	const day = 86_400_000;
	const base = Date.parse('2026-09-01T00:00:00Z');
	const absences = Array.from({ length: 8 }, (_, i) => ({
		id: `a${i}`,
		memberId: 'anna',
		startDate: new Date(base + (i === 0 ? 20 * day : 0)),
		endDate: new Date(base + 30 * day),
		createdAt: new Date(base + i * 1000),
	}));
	const activity: ActivityItem[] = [
		{
			kind: 'expense',
			timestamp: new Date(base + 10 * day).toISOString(),
			memberName: 'Ben',
			text: 'Strom',
		},
	];
	appendSecondaryActivity(activity, new Map(), absences as never, [], [], members, 'CODE');
	// The start date of a future absence must not pin its row above newer entries.
	assert.equal(activity[0]?.text, 'Strom');
	const hrefs = activity.filter((item) => item.kind === 'absence').map((item) => item.href);
	assert.equal(hrefs.length, 6);
	assert.ok(hrefs.some((href) => href?.includes('absence=a7')));
	assert.ok(!hrefs.some((href) => href?.includes('absence=a0')));
});

test('overdue follows the Berlin calendar day, not the instant', () => {
	// 2026-09-02 12:00 Berlin
	const now = new Date('2026-09-02T10:00:00Z');
	const row = (id: string, nextDueAt: string) => ({
		id,
		title: id,
		nextDueAt: new Date(nextDueAt),
		assignedMemberId: null,
	});
	const due = buildDueChores(
		[row('earlier-today', '2026-09-02T06:00:00Z'), row('yesterday', '2026-09-01T06:00:00Z')],
		new Map(),
		now,
	);
	assert.deepEqual(
		due.map((c) => [c.id, c.overdue]),
		[
			['yesterday', true],
			['earlier-today', false],
		],
	);
});

test('own chore 4+ days out shows in the week agenda, nearer own chores stay in "Für dich"', () => {
	// Tuesday 2026-09-01 12:00 Berlin
	const now = Date.parse('2026-09-01T10:00:00Z');
	const chore = (id: string, nextDueAt: string) => ({
		id,
		title: id,
		nextDueAt,
		overdue: false,
		assignedMemberId: 'me',
		assignedMemberName: 'Abu',
	});
	const agenda = getWeekAgenda({
		shareCode: 'C',
		currentMemberId: 'me',
		now,
		events: [],
		dueChores: [
			chore('own-saturday', '2026-09-05T09:00:00+02:00'),
			chore('own-tomorrow', '2026-09-02T09:00:00+02:00'),
		],
	});
	assert.deepEqual(
		agenda.upcoming.map((item) => item.key),
		['chore:own-saturday'],
	);
});

test('feed keys stay unique when items share an href', () => {
	const item = {
		kind: 'audit' as const,
		timestamp: 't',
		memberName: 'Anna',
		href: '/einkauf?highlight=1',
		text: 'x',
	};
	assert.notEqual(activityItemKey(item, 0), activityItemKey(item, 1));
});

test('rename audit summary starts with the current name so the actor prefix is stripped', async () => {
	const { formatAuditActivityText } = await import('../src/composition/activity-audit.ts');
	assert.equal(
		formatAuditActivityText('Bea hat sich umbenannt (vorher Anna).', 'Bea'),
		'hat sich umbenannt (vorher Anna).',
	);
});
