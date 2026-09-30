const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const appRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(appRoot, 'src');
const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveEventsModule(request, parent, isMain, options) {
	const resolvedRequest = request.startsWith('@/') ? path.join(srcRoot, request.slice(2)) : request;
	return resolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

for (const extension of ['.ts', '.tsx']) {
	Module._extensions[extension] = (loadedModule, filename) => {
		const source = require('node:fs').readFileSync(filename, 'utf8');
		const transpiled = ts.transpileModule(source, {
			compilerOptions: {
				esModuleInterop: true,
				jsx: ts.JsxEmit.ReactJSX,
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
			},
			fileName: filename,
		});
		loadedModule._compile(transpiled.outputText, filename);
	};
}

const { PgDialect } = require('drizzle-orm/pg-core');
const {
	EVENTS_LIST_LIMIT,
	eventOverlapsCalendarDay,
	expandRecurrence,
	parseRecurrenceRule,
} = require('../src/features/events/events.ts');
const {
	buildEventsWindowFilter,
	withEventWindowCandidates,
} = require('../src/features/events/event-reminder-window.ts');
const {
	collectReminderOccurrences,
	EVENT_REMINDER_BUDGET,
	processReminderBatches,
	reminderCopyForOccurrence,
	startsInReminderWindow,
} = require('../src/features/events/event-reminder-dispatch.ts');
const { startOfBerlinDay } = require('../src/core/utils/berlin-day.ts');
const { computeTomorrowUtcWindow } = require('../src/features/events/event-reminder-window.ts');

function eventCandidate(id, startsAt, recurrence, { allDay = false, endsAt = null } = {}) {
	return {
		id,
		startsAt: new Date(startsAt),
		endsAt: endsAt ? new Date(endsAt) : null,
		allDay,
		recurrence,
	};
}

function eventCandidatePages(rows, pageSizes = []) {
	const ordered = [...rows].sort(
		(a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id),
	);
	return async (cursor, limit) => {
		pageSizes.push(limit);
		const afterCursor = cursor
			? ordered.filter(
					(row) =>
						row.startsAt.getTime() > cursor.startsAt.getTime() ||
						(row.startsAt.getTime() === cursor.startsAt.getTime() && row.id > cursor.id),
				)
			: ordered;
		return afterCursor.slice(0, limit);
	};
}

test('timed event end is exclusive at midnight; all-day end date stays inclusive', () => {
	const previousTimezone = process.env.TZ;
	process.env.TZ = 'Europe/Berlin';
	try {
		const nextDay = new Date(2026, 8, 23);
		const allDay = {
			startsAt: '2026-09-22T00:00:00.000Z',
			endsAt: '2026-09-23T00:00:00.000Z',
			allDay: true,
		};
		const timedAtMidnight = {
			startsAt: '2026-09-22T10:00:00.000Z',
			endsAt: '2026-09-22T22:00:00.000Z',
			allDay: false,
		};
		const timedPastMidnight = { ...timedAtMidnight, endsAt: '2026-09-22T22:01:00.000Z' };

		assert.equal(eventOverlapsCalendarDay(allDay, nextDay), true, 'all-day end date is inclusive');
		assert.equal(eventOverlapsCalendarDay(timedPastMidnight, nextDay), true);
		assert.equal(
			eventOverlapsCalendarDay(timedAtMidnight, nextDay),
			false,
			'timed event ending at local midnight does not occupy the following day',
		);
	} finally {
		if (previousTimezone === undefined) Reflect.deleteProperty(process.env, 'TZ');
		else process.env.TZ = previousTimezone;
	}
});

test('API window keeps all-day end boundary but excludes timed end at from', () => {
	const from = new Date('2026-09-23T00:00:00.000Z');
	const to = new Date('2026-09-26T00:00:00.000Z');
	const filter = buildEventsWindowFilter(from, to);
	assert.ok(filter);
	const query = new PgDialect().sqlToQuery(filter);

	const allDayBoundary = query.sql.match(
		/"wg_events"\."all_day"\s*=\s*\$(\d+)\s+and\s+"wg_events"\."ends_at"\s*>=\s*\$(\d+)/,
	);
	assert.ok(allDayBoundary, 'all-day end at from is inclusive');
	assert.equal(query.params[Number(allDayBoundary[1]) - 1], true);
	assert.equal(query.params[Number(allDayBoundary[2]) - 1], from.toISOString());

	const timedBoundary = query.sql.match(
		/"wg_events"\."all_day"\s*=\s*\$(\d+)\s+and\s+"wg_events"\."ends_at"\s*>\s*\$(\d+)/,
	);
	assert.ok(timedBoundary, 'timed end at from is exclusive');
	assert.equal(query.params[Number(timedBoundary[1]) - 1], false);
	assert.equal(query.params[Number(timedBoundary[2]) - 1], from.toISOString());
});

test('API window includes timed null-end rows only when their default hour overlaps', () => {
	const from = new Date('2026-09-30T22:00:00.000Z');
	const to = new Date('2026-10-01T23:59:59.999Z');
	const query = new PgDialect().sqlToQuery(buildEventsWindowFilter(from, to));
	const defaultHourOverlap = query.sql.match(
		/"wg_events"\."all_day"\s*=\s*\$(\d+)\s+and\s+"wg_events"\."ends_at"\s+is\s+null\s+and\s+"wg_events"\."starts_at"\s*>\s*\$(\d+)/,
	);
	assert.ok(defaultHourOverlap, 'timed rows without an end get the default-hour overlap branch');
	assert.equal(query.params[Number(defaultHourOverlap[1]) - 1], false);
	assert.equal(
		query.params[Number(defaultHourOverlap[2]) - 1],
		new Date(from.getTime() - 60 * 60 * 1000).toISOString(),
	);
	assert.ok(Date.parse('2026-09-30T21:30:00.000Z') > from.getTime() - 60 * 60 * 1000);
	assert.equal(Date.parse('2026-09-30T21:00:00.000Z') > from.getTime() - 60 * 60 * 1000, false);
});

test('an unbounded 2020 daily series contributes to a 2026 query window', () => {
	const event = {
		id: 'old-daily-series',
		title: 'Daily series',
		description: null,
		startsAt: '2020-01-01T12:00:00.000Z',
		endsAt: null,
		allDay: false,
		location: null,
		recurrence: 'FREQ=DAILY',
	};
	const from = new Date('2026-09-22T00:00:00.000Z');
	const to = new Date('2026-09-22T23:59:59.999Z');
	const occurrences = expandRecurrence(event, from, to);

	assert.deepEqual(
		occurrences.map(({ startsAt }) => startsAt),
		['2026-09-22T11:00:00.000Z'],
	);
	assert.ok(new Date(event.startsAt) < from);

	const query = new PgDialect().sqlToQuery(buildEventsWindowFilter(from, to));
	assert.equal(query.sql.includes('"wg_events"."recurrence" is not null'), true);
	assert.equal(query.params.includes('2024-09-22T00:00:00.000Z'), false);
});

test('daily timed recurrence advances Berlin dates across the autumn DST change', () => {
	const event = {
		id: 'daily-autumn-dst',
		title: 'Daily series',
		description: null,
		startsAt: '2026-10-23T22:30:00.000Z',
		endsAt: null,
		allDay: false,
		location: null,
		recurrence: 'FREQ=DAILY',
	};
	const occurrences = expandRecurrence(event, '2026-10-23', '2026-10-28');

	assert.deepEqual(
		occurrences.map(({ startsAt }) => startsAt),
		[
			'2026-10-23T22:30:00.000Z',
			'2026-10-24T22:30:00.000Z',
			'2026-10-25T23:30:00.000Z',
			'2026-10-26T23:30:00.000Z',
			'2026-10-27T23:30:00.000Z',
		],
	);
});

test('weekly timed recurrence keeps its Berlin weekday across the autumn DST change', () => {
	const event = {
		id: 'weekly-autumn-dst',
		title: 'Weekly series',
		description: null,
		startsAt: '2026-10-23T22:30:00.000Z',
		endsAt: null,
		allDay: false,
		location: null,
		recurrence: 'FREQ=WEEKLY',
	};
	const occurrences = expandRecurrence(event, '2026-10-23', '2026-11-10');

	assert.deepEqual(
		occurrences.map(({ startsAt }) => startsAt),
		['2026-10-23T22:30:00.000Z', '2026-10-30T23:30:00.000Z', '2026-11-06T23:30:00.000Z'],
	);
});

test('weekly timed recurrence applies UNTIL to the Berlin wall-time instant', () => {
	const event = {
		id: 'weekly-autumn-until',
		title: 'Weekly series',
		description: null,
		startsAt: '2026-10-23T22:30:00.000Z',
		endsAt: null,
		allDay: false,
		location: null,
		recurrence: 'FREQ=WEEKLY;UNTIL=2026-11-06T23:00:00.000Z',
	};
	const occurrences = expandRecurrence(event, '2026-10-23', '2026-11-10');

	assert.deepEqual(
		occurrences.map(({ startsAt }) => startsAt),
		['2026-10-23T22:30:00.000Z', '2026-10-30T23:30:00.000Z'],
	);
});

test('monthly timed recurrence clamps the Berlin day of month at 00:30 and 20:00', () => {
	const event = {
		id: 'monthly-clamp-at-midnight',
		title: 'Monthly series',
		description: null,
		startsAt: '2026-01-30T23:30:00.000Z',
		endsAt: null,
		allDay: false,
		location: null,
		recurrence: 'FREQ=MONTHLY;COUNT=3',
	};
	const occurrences = expandRecurrence(event, '2026-01-30', '2026-04-01');

	assert.deepEqual(
		occurrences.map(({ startsAt }) => startsAt),
		['2026-01-30T23:30:00.000Z', '2026-02-27T23:30:00.000Z', '2026-03-30T22:30:00.000Z'],
	);
	const eveningOccurrences = expandRecurrence(
		{ ...event, startsAt: '2026-01-31T19:00:00.000Z' },
		'2026-01-31',
		'2026-03-01',
	);
	assert.deepEqual(
		eveningOccurrences.map(({ startsAt }) => startsAt),
		['2026-01-31T19:00:00.000Z', '2026-02-28T19:00:00.000Z'],
	);
});

test('all-day recurrence keeps advancing by UTC calendar dates across DST', () => {
	const event = {
		id: 'all-day-autumn-dst',
		title: 'All-day series',
		description: null,
		startsAt: '2026-10-23T00:00:00.000Z',
		endsAt: null,
		allDay: true,
		location: null,
		recurrence: 'FREQ=WEEKLY;COUNT=3',
	};
	const occurrences = expandRecurrence(event, '2026-10-23', '2026-11-10');

	assert.deepEqual(
		occurrences.map(({ startsAt }) => startsAt),
		['2026-10-23T00:00:00.000Z', '2026-10-30T00:00:00.000Z', '2026-11-06T00:00:00.000Z'],
	);
});

test('finite multi-day recurrence keeps an older occurrence overlapping the query', () => {
	const event = {
		id: 'multi-day-series',
		title: 'Multi-day series',
		description: null,
		startsAt: '2026-09-20T00:00:00.000Z',
		endsAt: '2026-09-22T00:00:00.000Z',
		allDay: true,
		location: null,
		recurrence: 'FREQ=DAILY;COUNT=3',
	};
	const occurrences = expandRecurrence(
		event,
		new Date('2026-09-23T12:00:00.000Z'),
		new Date('2026-09-23T23:59:59.999Z'),
	);
	assert.deepEqual(
		occurrences.map(({ startsAt }) => startsAt),
		['2026-09-22T00:00:00.000Z'],
	);
});

test('timed recurrence ending exactly at window start is not due again', () => {
	const event = {
		id: 'midnight-series',
		title: 'Evening event',
		description: null,
		startsAt: '2026-09-22T20:00:00.000Z',
		endsAt: '2026-09-22T22:00:00.000Z',
		allDay: false,
		location: null,
		recurrence: 'FREQ=DAILY;COUNT=2',
	};
	const occurrences = expandRecurrence(
		event,
		new Date('2026-09-22T22:00:00.000Z'),
		new Date('2026-09-23T21:59:59.999Z'),
	);
	assert.deepEqual(
		occurrences.map(({ startsAt }) => startsAt),
		['2026-09-23T20:00:00.000Z'],
	);
});

test('reminders include only occurrences that start tomorrow', () => {
	const from = new Date('2026-09-22T22:00:00.000Z');
	const to = new Date('2026-09-23T21:59:59.999Z');
	const ongoing = {
		id: 'ongoing',
		title: 'Ongoing',
		description: null,
		startsAt: '2026-09-22T00:00:00.000Z',
		endsAt: '2026-09-24T00:00:00.000Z',
		allDay: true,
		location: null,
		recurrence: null,
	};
	const tomorrow = { ...ongoing, id: 'tomorrow', startsAt: '2026-09-23T00:00:00.000Z' };
	const due = collectReminderOccurrences([ongoing, tomorrow], (event) =>
		expandRecurrence(event, from, to).filter((occ) => startsInReminderWindow(occ, from, to)),
	);
	assert.deepEqual(
		due?.map(({ eventId }) => eventId),
		['tomorrow'],
	);
});

test('spring DST wall time is included when its raw UTC recurrence is beyond window end', () => {
	const event = {
		id: 'spring-dst-series',
		title: 'Spring DST series',
		description: null,
		startsAt: '2026-03-22T02:30:00.000Z',
		endsAt: null,
		allDay: false,
		location: null,
		recurrence: 'FREQ=WEEKLY;COUNT=2',
	};
	const occurrences = expandRecurrence(
		event,
		new Date('2026-03-29T01:00:00.000Z'),
		new Date('2026-03-29T02:00:00.000Z'),
	);
	assert.deepEqual(
		occurrences.map(({ startsAt }) => startsAt),
		['2026-03-29T01:30:00.000Z'],
	);
});

test('spring-gap recurrence keeps the existing raw-instant fallback', () => {
	const event = {
		id: 'spring-gap-series',
		title: 'Spring-gap series',
		description: null,
		startsAt: '2026-03-22T01:30:00.000Z',
		endsAt: null,
		allDay: false,
		location: null,
		recurrence: 'FREQ=WEEKLY;COUNT=2',
	};
	const occurrences = expandRecurrence(
		event,
		new Date('2026-03-29T00:00:00.000Z'),
		new Date('2026-03-29T02:00:00.000Z'),
	);

	assert.deepEqual(
		occurrences.map(({ startsAt }) => startsAt),
		['2026-03-29T01:30:00.000Z'],
	);
});

test('prunes old finite COUNT and UNTIL roots but retains long BYDAY and unknown rules', async () => {
	const from = new Date('2026-03-29T12:00:00.000Z');
	const rows = [
		eventCandidate('expired-count', '2020-01-01T12:00:00.000Z', 'FREQ=DAILY;COUNT=5'),
		eventCandidate(
			'expired-until',
			'2020-01-01T12:00:00.000Z',
			'FREQ=DAILY;UNTIL=2020-01-10T12:00:00.000Z',
		),
		eventCandidate(
			'long-weekly-count',
			'2020-01-01T12:00:00.000Z',
			'FREQ=WEEKLY;BYDAY=MO;COUNT=365',
		),
		eventCandidate(
			'sparse-weekly-count',
			'2020-01-01T12:00:00.000Z',
			'FREQ=WEEKLY;INTERVAL=365;BYDAY=MO;COUNT=2',
		),
		eventCandidate(
			'expired-count-before-until',
			'2026-03-20T12:00:00.000Z',
			'FREQ=DAILY;COUNT=2;UNTIL=2026-04-01T12:00:00.000Z',
		),
		eventCandidate(
			'expired-until-before-count',
			'2026-03-20T12:00:00.000Z',
			'FREQ=DAILY;COUNT=10;UNTIL=2026-03-22T12:00:00.000Z',
		),
		eventCandidate('unknown-rule', '2020-01-01T12:00:00.000Z', 'NOT-A-RRULE'),
		eventCandidate('year-135245', '2020-01-01T12:00:00.000Z', 'FREQ=YEARLY;INTERVAL=365;COUNT=366'),
		eventCandidate('timed-end-at-from', '2026-03-28T23:00:00.000Z', 'FREQ=DAILY;COUNT=1', {
			endsAt: '2026-03-29T12:00:00.000Z',
		}),
		eventCandidate('all-day-end-date-from', '2026-03-28T00:00:00.000Z', 'FREQ=DAILY;COUNT=1', {
			allDay: true,
			endsAt: '2026-03-29T00:00:00.000Z',
		}),
	];
	const pageSizes = [];
	const overflowResult = { status: 503, body: 'events_window_too_large' };
	const result = await withEventWindowCandidates(
		from,
		eventCandidatePages(rows, pageSizes),
		() => overflowResult,
		(candidates) => candidates.map(({ id }) => id),
	);

	assert.deepEqual(result, [
		'long-weekly-count',
		'sparse-weekly-count',
		'unknown-rule',
		'year-135245',
		'all-day-end-date-from',
	]);
	assert.ok(parseRecurrenceRule('FREQ=YEARLY;INTERVAL=365;COUNT=366'));
	assert.deepEqual(pageSizes, [500]);
});

test('prunes 1001 expired finite roots before applying the active candidate cap', async () => {
	const from = new Date('2026-09-22T00:00:00.000Z');
	const rows = [
		...Array.from({ length: 1001 }, (_, index) =>
			eventCandidate(
				`expired-${String(index).padStart(4, '0')}`,
				'2020-01-01T12:00:00.000Z',
				'FREQ=DAILY;COUNT=1',
			),
		),
		eventCandidate('active-infinite', '2020-01-01T12:00:00.000Z', 'FREQ=DAILY'),
	];
	const overflowResult = { status: 503, body: 'events_window_too_large' };
	const result = await withEventWindowCandidates(
		from,
		eventCandidatePages(rows),
		() => overflowResult,
		(candidates) => candidates.map(({ id }) => id),
	);
	assert.deepEqual(result, ['active-infinite']);
});

test('retains a yearly series whose Berlin wall date reaches year 10000', async () => {
	const rule = 'FREQ=YEARLY;INTERVAL=101;COUNT=80';
	assert.ok(parseRecurrenceRule(rule));
	const row = eventCandidate('year-10000-wall-date', '2020-12-31T23:30:00.000Z', rule);
	const result = await withEventWindowCandidates(
		new Date('2026-01-01T00:00:00.000Z'),
		eventCandidatePages([row]),
		() => ({ status: 503, body: 'events_window_too_large' }),
		(candidates) => candidates.map(({ id }) => id),
	);

	assert.deepEqual(result, ['year-10000-wall-date']);
});

test('weekly BYDAY UNTIL last start uses Berlin DST wall time and timed-end boundary', async () => {
	const series = eventCandidate(
		'dst-weekly-until',
		'2026-03-22T01:30:00.000Z',
		'FREQ=WEEKLY;BYDAY=SU;UNTIL=2026-03-29T01:30:00.000Z',
	);
	const overflowResult = { status: 503, body: 'events_window_too_large' };
	const active = await withEventWindowCandidates(
		new Date('2026-03-29T01:45:00.000Z'),
		eventCandidatePages([series]),
		() => overflowResult,
		(candidates) => candidates.map(({ id }) => id),
	);
	const expired = await withEventWindowCandidates(
		new Date('2026-03-29T02:30:00.000Z'),
		eventCandidatePages([series]),
		() => overflowResult,
		(candidates) => candidates.map(({ id }) => id),
	);
	assert.deepEqual(active, ['dst-weekly-until']);
	assert.deepEqual(expired, []);
});

test('finite UNTIL pruning uses the last Berlin wall-time occurrence', async () => {
	const series = eventCandidate(
		'finite-weekly-until-after-dst',
		'2026-10-23T22:30:00.000Z',
		'FREQ=WEEKLY;UNTIL=2026-11-06T23:00:00.000Z',
	);
	const result = await withEventWindowCandidates(
		new Date('2026-11-06T00:15:00.000Z'),
		eventCandidatePages([series]),
		() => ({ status: 503, body: 'events_window_too_large' }),
		(candidates) => candidates.map(({ id }) => id),
	);

	assert.deepEqual(result, []);
});

test('finite COUNT pruning keeps the final Berlin wall-time occurrence through its end', async () => {
	const series = eventCandidate(
		'finite-weekly-count-after-dst',
		'2026-10-23T22:30:00.000Z',
		'FREQ=WEEKLY;COUNT=3',
	);
	const active = await withEventWindowCandidates(
		new Date('2026-11-06T23:45:00.000Z'),
		eventCandidatePages([series]),
		() => ({ status: 503, body: 'events_window_too_large' }),
		(candidates) => candidates.map(({ id }) => id),
	);
	const expired = await withEventWindowCandidates(
		new Date('2026-11-07T00:30:00.000Z'),
		eventCandidatePages([series]),
		() => ({ status: 503, body: 'events_window_too_large' }),
		(candidates) => candidates.map(({ id }) => id),
	);

	assert.deepEqual(active, ['finite-weekly-count-after-dst']);
	assert.deepEqual(expired, []);
});

test('paged 1001 active candidates overflow before cron claim or send callbacks', async () => {
	const from = new Date('2026-09-22T00:00:00.000Z');
	const rows = Array.from({ length: EVENTS_LIST_LIMIT + 1 }, (_, index) =>
		eventCandidate(
			`unbounded-${String(index).padStart(4, '0')}`,
			'2020-01-01T12:00:00.000Z',
			'FREQ=DAILY',
		),
	);
	const pageSizes = [];
	let claims = 0;
	let sends = 0;
	const overflowResult = { status: 503, body: 'events_window_too_large' };
	const result = await withEventWindowCandidates(
		from,
		eventCandidatePages(rows, pageSizes),
		() => overflowResult,
		async (candidates) => {
			for (const _candidate of candidates) {
				claims += 1;
				sends += 1;
			}
			return { status: 200 };
		},
	);

	assert.deepEqual(result, overflowResult);
	assert.equal(claims, 0);
	assert.equal(sends, 0);
	assert.deepEqual(pageSizes, [500, 500, 500]);

	const expiredRows = Array.from({ length: 10000 }, (_, index) =>
		eventCandidate(
			`expired-${String(index).padStart(5, '0')}`,
			'2020-01-01T12:00:00.000Z',
			'FREQ=DAILY;COUNT=1',
		),
	);
	const exactScanPageSizes = [];
	let processedAtScanLimit = false;
	const exactScanResult = await withEventWindowCandidates(
		from,
		eventCandidatePages(expiredRows, exactScanPageSizes),
		() => overflowResult,
		() => {
			processedAtScanLimit = true;
			return { status: 200 };
		},
	);
	assert.deepEqual(exactScanResult, { status: 200 });
	assert.equal(processedAtScanLimit, true);
	assert.equal(exactScanPageSizes.length, 21);
	assert.ok(exactScanPageSizes.slice(0, 20).every((size) => size === 500));
	assert.equal(exactScanPageSizes[20], 1);

	const overScanPageSizes = [];
	let processedOverScanLimit = false;
	const overScanResult = await withEventWindowCandidates(
		from,
		eventCandidatePages(
			[
				...expiredRows,
				eventCandidate('sentinel', '2020-01-01T12:00:00.000Z', 'FREQ=DAILY;COUNT=1'),
			],
			overScanPageSizes,
		),
		() => overflowResult,
		() => {
			processedOverScanLimit = true;
			return { status: 200 };
		},
	);
	assert.deepEqual(overScanResult, overflowResult);
	assert.equal(processedOverScanLimit, false);
	assert.equal(overScanPageSizes.length, 21);
	assert.ok(overScanPageSizes.slice(0, 20).every((size) => size === 500));
	assert.equal(overScanPageSizes[20], 1);
});

test('calendar rejects 1001 candidates while cron accepts 1001 across WGs', async () => {
	const from = new Date('2026-09-22T00:00:00.000Z');
	const rows = Array.from({ length: EVENTS_LIST_LIMIT + 1 }, (_, index) => ({
		...eventCandidate(
			`event-${String(index).padStart(4, '0')}`,
			'2020-01-01T12:00:00.000Z',
			'FREQ=DAILY',
		),
		wgId: `wg-${index % 2}`,
	}));
	const overflow = { status: 503 };
	const calendar = await withEventWindowCandidates(
		from,
		eventCandidatePages(rows),
		() => overflow,
		(candidates) => candidates.length,
	);
	const cron = await withEventWindowCandidates(
		from,
		eventCandidatePages(rows),
		() => overflow,
		(candidates) => candidates.length,
		EVENT_REMINDER_BUDGET,
	);
	assert.deepEqual(calendar, overflow);
	assert.equal(cron, 1001);
});

test('cron sentinel overflow rejects 10001 roots before any claim or send', async () => {
	const rows = Array.from({ length: EVENT_REMINDER_BUDGET + 1 }, (_, index) =>
		eventCandidate(
			`event-${String(index).padStart(5, '0')}`,
			'2020-01-01T12:00:00.000Z',
			'FREQ=DAILY',
		),
	);
	const pageSizes = [];
	const overflow = { status: 503 };
	let claims = 0;
	let sends = 0;
	const result = await withEventWindowCandidates(
		new Date('2026-09-22T00:00:00.000Z'),
		eventCandidatePages(rows, pageSizes),
		() => overflow,
		() => {
			claims += 1;
			sends += 1;
			return { status: 200 };
		},
		EVENT_REMINDER_BUDGET,
	);
	assert.deepEqual(result, overflow);
	assert.equal(claims, 0);
	assert.equal(sends, 0);
	assert.equal(pageSizes.length, 21);
	assert.equal(pageSizes[20], 1);
});

test('cron occurrence preflight rejects 10001 before claims and accepts exactly 10000', () => {
	const roots = Array.from({ length: 1000 }, (_, index) => index);
	let claims = 0;
	let sends = 0;
	const exact = collectReminderOccurrences(roots, (root) =>
		Array.from({ length: 10 }, (_, index) => `${root}:${index}`),
	);
	const overflow = collectReminderOccurrences(roots, (root) =>
		Array.from({ length: root === 999 ? 11 : 10 }, (_, index) => `${root}:${index}`),
	);
	if (overflow !== null) {
		claims += overflow.length;
		sends += overflow.length;
	}
	assert.equal(exact?.length, EVENT_REMINDER_BUDGET);
	assert.equal(overflow, null);
	assert.equal(claims, 0);
	assert.equal(sends, 0);
});

test('reminder batches claim only the current batch, limit concurrency, and release failures', async () => {
	let active = 0;
	let peak = 0;
	let claims = 0;
	let firstBatchDone = 0;
	let claimedFutureEarly = false;
	const released = [];
	const result = await processReminderBatches(
		Array.from({ length: 23 }, (_, index) => index),
		async (index) => {
			claims += 1;
			if (index >= 10 && firstBatchDone < 10) claimedFutureEarly = true;
			return true;
		},
		async (index) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setImmediate(resolve));
			active -= 1;
			if (index < 10) firstBatchDone += 1;
			if (index === 11) throw new Error('mock failure');
			return { sent: index === 20 ? 0 : 1 };
		},
		async (index) => {
			released.push(index);
		},
	);
	assert.equal(peak, 10);
	assert.equal(active, 0);
	assert.equal(claims, 23);
	assert.equal(claimedFutureEarly, false);
	assert.deepEqual(result, { sent: 21, failed: 1 });
	assert.deepEqual(released, [11, 20]);
});

test('reminder batch releases earlier claims when a later claim fails', async () => {
	const released = [];
	let sends = 0;
	await assert.rejects(
		processReminderBatches(
			[0, 1, 2],
			async (index) => {
				if (index === 1) throw new Error('claim failed');
				return true;
			},
			async () => {
				sends += 1;
				return { sent: 1 };
			},
			async (index) => {
				released.push(index);
			},
		),
		/claim failed/,
	);
	assert.equal(sends, 0);
	assert.deepEqual(released, [0]);
});

test('member occurrence partial failure retries only the failed member', async () => {
	const items = [
		{ eventId: 'event-1', occurrenceStartsAt: '2026-10-26T18:00:00.000Z', memberId: 'A' },
		{ eventId: 'event-1', occurrenceStartsAt: '2026-10-26T18:00:00.000Z', memberId: 'B' },
	];
	const claims = new Set();
	const attempts = new Map();
	const dispatches = [];
	const run = () =>
		processReminderBatches(
			items,
			async ({ memberId }) => {
				if (claims.has(memberId)) return false;
				claims.add(memberId);
				return true;
			},
			async ({ memberId }) => {
				dispatches.push(memberId);
				const attempt = attempts.get(memberId) ?? 0;
				attempts.set(memberId, attempt + 1);
				return memberId === 'B' && attempt === 0
					? { sent: 1, failures: ['one B device failed'] }
					: { sent: 1, failures: [] };
			},
			async ({ memberId }) => claims.delete(memberId),
		);

	assert.deepEqual(await run(), { sent: 1, failed: 1 });
	assert.deepEqual([...claims], ['A']);
	assert.deepEqual(await run(), { sent: 1, failed: 0 });
	assert.deepEqual(dispatches, ['A', 'B', 'B']);
	assert.deepEqual([...claims], ['A', 'B']);
});

test('today reminder selection keeps current all-day spans and excludes stale events', () => {
	const now = new Date('2026-03-29T10:00:00.000Z');
	const todayStart = startOfBerlinDay(now);
	const { start: tomorrowStart, end: tomorrowEnd } = computeTomorrowUtcWindow(now);
	const occurrence = (startsAt, endsAt, allDay = false) => ({ startsAt, endsAt, allDay });
	const classify = (value) =>
		reminderCopyForOccurrence(value, now, todayStart, tomorrowStart, tomorrowEnd);

	assert.equal(
		classify(occurrence('2026-03-29T11:00:00.000Z', '2026-03-29T12:00:00.000Z')),
		'today',
	);
	assert.equal(classify(occurrence('2026-03-29T08:00:00.000Z', '2026-03-29T09:00:00.000Z')), null);
	assert.equal(
		classify(occurrence('2026-03-28T22:00:00.000Z', '2026-03-29T11:00:00.000Z')),
		'today',
	);
	assert.equal(
		classify(occurrence('2026-03-27T23:00:00.000Z', '2026-03-28T23:00:00.000Z', true)),
		'today',
	);
	assert.equal(
		classify(occurrence('2026-03-26T23:00:00.000Z', '2026-03-27T23:00:00.000Z', true)),
		null,
	);
	assert.equal(
		classify(occurrence('2026-03-29T22:30:00.000Z', '2026-03-29T23:30:00.000Z')),
		'tomorrow',
	);
});
