import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const { ModuleKind, ScriptTarget, transpileModule } = requireFromWeb('typescript');
const routePath = path.join(process.cwd(), 'src/app/api/calendar/[id]/[token]/route.ts');
const srcPath = path.join(process.cwd(), 'src');
const id = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const calendarSubscriptions = {
	id: 'id',
	wgId: 'wgId',
	memberId: 'memberId',
	revokedAt: 'revokedAt',
};
const wgMembers = { id: 'id', authUserId: 'authUserId', deactivatedAt: 'deactivatedAt' };
const wgs = { id: 'id' };
const wgEvents = {
	id: 'id',
	wgId: 'wgId',
	startsAt: 'startsAt',
	endsAt: 'endsAt',
	allDay: 'allDay',
	recurrence: 'recurrence',
};
const drizzle = {
	and: (...parts) => ({ kind: 'and', parts }),
	asc: (value) => ({ kind: 'asc', value }),
	eq: (...parts) => ({ kind: 'eq', parts }),
	gt: (...parts) => ({ kind: 'gt', parts }),
	gte: (...parts) => ({ kind: 'gte', parts }),
	isNotNull: (value) => ({ kind: 'isNotNull', value }),
	isNull: (value) => ({ kind: 'isNull', value }),
	lte: (...parts) => ({ kind: 'lte', parts }),
	or: (...parts) => ({ kind: 'or', parts }),
};

/** Evaluates the drizzle stubs above against an event row, like the SQL WHERE would. */
function matchesEventFilter(filter, row) {
	if (filter === undefined) return true;
	// Duck-typed: withFrozenTime swaps the global Date class mid-test.
	const operand = (raw) => (typeof raw?.getTime === 'function' ? raw.getTime() : raw);
	const value = (field) => operand(row[field] ?? null);
	switch (filter.kind) {
		case 'and':
			return filter.parts.every((part) => matchesEventFilter(part, row));
		case 'or':
			return filter.parts.some((part) => matchesEventFilter(part, row));
		case 'eq':
			return value(filter.parts[0]) === operand(filter.parts[1]);
		case 'gt':
			return value(filter.parts[0]) !== null && value(filter.parts[0]) > operand(filter.parts[1]);
		case 'gte':
			return value(filter.parts[0]) !== null && value(filter.parts[0]) >= operand(filter.parts[1]);
		case 'lte':
			return value(filter.parts[0]) !== null && value(filter.parts[0]) <= operand(filter.parts[1]);
		case 'isNull':
			return value(filter.value) === null;
		case 'isNotNull':
			return value(filter.value) !== null;
		default:
			throw new Error(`unexpected filter: ${filter.kind}`);
	}
}

function loadTypeScriptModule(filePath, dependencies = {}) {
	const source = readFileSync(filePath, 'utf8');
	const compiled = transpileModule(source, {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(
		(name) => (Object.hasOwn(dependencies, name) ? dependencies[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return module.exports;
}

const berlinDay = loadTypeScriptModule(path.join(srcPath, 'core/utils/berlin-day.ts'));
const timeUtils = loadTypeScriptModule(path.join(srcPath, 'core/utils/time.ts'));
const eventUtils = loadTypeScriptModule(path.join(srcPath, 'features/events/events.ts'), {
	'@/core/utils/berlin-day': berlinDay,
	'@/core/utils/time': timeUtils,
});
const eventWindow = loadTypeScriptModule(
	path.join(srcPath, 'features/events/event-reminder-window.ts'),
	{
		'@/core/utils/berlin-day': berlinDay,
		'../../core/db/schema': { wgEvents },
		'./events': eventUtils,
		'drizzle-orm': drizzle,
	},
);

function harness({
	authUserId = 'auth-user',
	deactivatedAt = null,
	revokedAt = null,
	events = [
		{
			id: 'event-1',
			title: 'Other member event',
			description: null,
			startsAt: new Date('2026-10-01T10:00:00.000Z'),
			endsAt: null,
			allDay: false,
			location: null,
			recurrence: null,
			createdAt: new Date('2026-09-25T00:00:00.000Z'),
			updatedAt: new Date('2026-09-25T00:00:00.000Z'),
		},
	],
} = {}) {
	const state = {
		authUserId,
		deactivatedAt,
		revokedAt,
		wgExists: true,
		steps: [],
		events,
		expansionWindows: [],
		eventQueries: [],
		expandedEventIds: [],
	};
	const subscription = { id, wgId, tokenSeed: 'seed', memberId: 'member-1', revokedAt };
	const tx = {
		select: () => {
			let table;
			let joined = false;
			let whereFilter;
			const query = {
				from(value) {
					table = value;
					return query;
				},
				innerJoin() {
					joined = true;
					return query;
				},
				where(filter) {
					whereFilter = filter;
					return query;
				},
				limit: async (count) => {
					if (table === wgEvents) {
						state.steps.push('events');
						state.eventQueries.push(count);
						return state.events
							.map((event) => ({ wgId, ...event }))
							.filter((event) => matchesEventFilter(whereFilter, event))
							.sort(
								(a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id),
							)
							.slice(0, count);
					}
					if (table === calendarSubscriptions && joined) {
						state.steps.push('member-check');
						return state.authUserId && !state.deactivatedAt && !state.revokedAt
							? [subscription]
							: [];
					}
					if (table === calendarSubscriptions) {
						return state.revokedAt ? [] : [{ wgId }];
					}
					throw new Error(`unexpected limit query: ${String(table)}`);
				},
				for: async (lock) => {
					assert.equal(table, wgs);
					assert.equal(lock, 'update');
					state.steps.push('wg-lock');
					return state.wgExists ? [{ id: wgId }] : [];
				},
				orderBy() {
					assert.equal(table, wgEvents);
					return query;
				},
			};
			return query;
		},
	};
	const mocks = {
		'@/core/db': { calendarSubscriptions, wgEvents, wgMembers, wgs },
		'@/core/db/transaction': { withTransaction: async (operation) => operation(tx) },
		'@/core/errors': {
			notFound: (code) => Response.json({ error: code }, { status: 404 }),
			serverError: (code) => Response.json({ error: code }, { status: 500 }),
			tooMany: (code) => Response.json({ error: code }, { status: 429 }),
		},
		'@/core/guards/api-auth': { isUuid: () => true },
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/rate-limit': {
			checkRateLimit: async () => ({ success: true }),
			clientIpKey: () => 'ip',
			wgReadLimiter: {},
		},
		'@/core/utils/time': { MS_PER_DAY: 86_400_000 },
		'@/core/utils/berlin-day': berlinDay,
		'@/features/events/calendar-subscription': {
			isCalendarFeedToken: () => true,
			verifyCalendarFeedToken: (_id, seed, token) => seed === 'seed' && token === 'valid',
		},
		'@/features/events/event-reminder-window': eventWindow,
		'@/features/events/events': {
			expandRecurrence: (event, from, to) => {
				state.expansionWindows.push({ from: from.toISOString(), to: to.toISOString() });
				state.expandedEventIds.push(event.id);
				return eventUtils.expandRecurrence(event, from, to);
			},
		},
		'@/features/events/ics': {
			calendarFeedToIcs: (events) => events.map((event) => event.title).join('\n'),
		},
		'drizzle-orm': drizzle,
		'next/server': { NextResponse: Response },
	};
	const route = loadTypeScriptModule(routePath, mocks);
	const request = new Request(`https://example.test/api/calendar/${id}/valid`);
	return {
		state,
		get: () => route.GET(request, { params: Promise.resolve({ id, token: 'valid' }) }),
	};
}

async function withFrozenTime(value, operation) {
	const RealDate = globalThis.Date;
	const now = RealDate.parse(value);
	globalThis.Date = class FrozenDate extends RealDate {
		constructor(...args) {
			super(...(args.length === 0 ? [now] : args));
		}
		static now() {
			return now;
		}
	};
	try {
		return await operation();
	} finally {
		globalThis.Date = RealDate;
	}
}

test('active Auth-linked calendar feed returns events after locking the WG', async () => {
	const { state, get } = harness();
	const response = await get();
	assert.equal(response.status, 200);
	assert.match(await response.text(), /Other member event/);
	assert.deepEqual(state.steps, ['wg-lock', 'member-check', 'events']);
});

test('detached or deactivated membership cannot use its old calendar URL', async () => {
	for (const state of [
		{ authUserId: null },
		{ deactivatedAt: new Date() },
		{ revokedAt: new Date() },
	]) {
		const { get } = harness(state);
		const response = await get();
		assert.equal(response.status, 404);
		assert.deepEqual(await response.json(), { error: 'calendar_feed_not_found' });
	}
});

test('calendar feed keeps all-day events through their final Berlin day across DST', async () => {
	for (const { now, dayStart } of [
		{ now: '2026-03-29T10:00:00.000Z', dayStart: '2026-03-28T23:00:00.000Z' },
		{ now: '2026-10-25T12:00:00.000Z', dayStart: '2026-10-24T22:00:00.000Z' },
	]) {
		const dayStartDate = new Date(dayStart);
		const previousDay = new Date(dayStartDate.getTime() - 24 * 60 * 60 * 1000);
		const { state, get } = harness({
			events: [
				{
					id: `single-${dayStart}`,
					title: 'All-day today',
					description: null,
					startsAt: dayStartDate,
					endsAt: dayStartDate,
					allDay: true,
					location: null,
					recurrence: null,
					createdAt: dayStartDate,
					updatedAt: dayStartDate,
				},
				{
					id: `span-${dayStart}`,
					title: 'All-day span ending today',
					description: null,
					startsAt: previousDay,
					endsAt: dayStartDate,
					allDay: true,
					location: null,
					recurrence: null,
					createdAt: previousDay,
					updatedAt: previousDay,
				},
			],
		});

		await withFrozenTime(now, async () => {
			const response = await get();
			assert.equal(response.status, 200);
			const body = await response.text();
			assert.match(body, /All-day today/);
			assert.match(body, /All-day span ending today/);
		});
		assert.equal(state.expansionWindows[0]?.from, dayStart);
	}
});

function eventRow(id, startsAt, overrides = {}) {
	const start = new Date(startsAt);
	return {
		id,
		title: id,
		description: null,
		startsAt: start,
		endsAt: null,
		allDay: false,
		location: null,
		recurrence: null,
		createdAt: start,
		updatedAt: start,
		...overrides,
	};
}

test('calendar feed loads only events that can occur in the feed window', async () => {
	const { state, get } = harness({
		events: [
			eventRow('past-single', '2024-01-10T10:00:00.000Z'),
			eventRow('past-ended-series', '2024-01-01T10:00:00.000Z', {
				recurrence: 'FREQ=WEEKLY;COUNT=3',
			}),
			eventRow('old-weekly-series', '2024-01-01T10:00:00.000Z', { recurrence: 'FREQ=WEEKLY' }),
			eventRow('upcoming-single', '2026-10-01T10:00:00.000Z'),
			eventRow('beyond-horizon', '2028-01-01T10:00:00.000Z'),
		],
	});

	await withFrozenTime('2026-09-25T12:00:00.000Z', async () => {
		const response = await get();
		assert.equal(response.status, 200);
		const body = await response.text();
		assert.match(body, /old-weekly-series/);
		assert.match(body, /upcoming-single/);
		assert.doesNotMatch(body, /past-single|past-ended-series|beyond-horizon/);
	});
	assert.deepEqual([...new Set(state.expandedEventIds)].sort(), [
		'old-weekly-series',
		'upcoming-single',
	]);
	assert.ok(state.eventQueries.every((count) => count <= 500));
});

test('calendar feed refuses an event window above the candidate cap', async () => {
	const events = Array.from({ length: 5001 }, (_, index) =>
		eventRow(`event-${String(index).padStart(4, '0')}`, '2026-10-01T10:00:00.000Z'),
	);
	const { state, get } = harness({ events });

	await withFrozenTime('2026-09-25T12:00:00.000Z', async () => {
		const response = await get();
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), { error: 'events_window_too_large' });
	});
	assert.equal(state.expandedEventIds.length, 0);
});
