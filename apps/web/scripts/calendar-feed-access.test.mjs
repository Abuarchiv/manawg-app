import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const { ModuleKind, ScriptTarget, transpileModule } = requireFromWeb('typescript');
const srcRoot = path.join(process.cwd(), 'src');
const routePath = path.join(srcRoot, 'app/api/calendar/[id]/[token]/route.ts');
const windowPath = path.join(srcRoot, 'features/events/event-reminder-window.ts');

// The window helper is loaded for real (the route must actually be windowed),
// so resolve "@/..." aliases and transpile ".ts" on require.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWebModule(request, parent, isMain, options) {
	const resolved = request.startsWith('@/') ? path.join(srcRoot, request.slice(2)) : request;
	return resolveFilename.call(this, resolved, parent, isMain, options);
};
Module._extensions['.ts'] = (loadedModule, filename) => {
	const source = readFileSync(filename, 'utf8');
	const compiled = transpileModule(source, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true },
		fileName: filename,
	}).outputText;
	loadedModule._compile(compiled, filename);
};

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

function eventRow(index) {
	return {
		id: `event-${String(index).padStart(6, '0')}`,
		title: `Event ${index}`,
		description: null,
		startsAt: new Date('2026-10-01T10:00:00.000Z'),
		endsAt: null,
		allDay: false,
		location: null,
		recurrence: null,
		createdAt: new Date('2026-09-25T00:00:00.000Z'),
		updatedAt: new Date('2026-09-25T00:00:00.000Z'),
	};
}

function harness({ authUserId = 'auth-user', deactivatedAt = null, revokedAt = null, events } = {}) {
	const realWindow = requireFromWeb(windowPath);
	const state = {
		authUserId,
		deactivatedAt,
		revokedAt,
		wgExists: true,
		steps: [],
		whereConditions: [],
		eventPageLimits: [],
		eventOffset: 0,
		window: null,
		candidateLimit: null,
		events: events ?? [eventRow(1)],
	};
	state.events[0].title = 'Other member event';
	const subscription = { id, wgId, tokenSeed: 'seed', memberId: 'member-1', revokedAt };
	const tx = {
		select: () => {
			let table;
			let joined = false;
			const query = {
				from(value) {
					table = value;
					return query;
				},
				innerJoin() {
					joined = true;
					return query;
				},
				where(condition) {
					state.whereConditions.push({ table, condition });
					return query;
				},
				orderBy() {
					return query;
				},
				for: async (lock) => {
					assert.equal(table, wgs);
					assert.equal(lock, 'update');
					state.steps.push('wg-lock');
					return state.wgExists ? [{ id: wgId }] : [];
				},
				limit: async (value) => {
					if (table === calendarSubscriptions && joined) {
						state.steps.push('member-check');
						return state.authUserId && !state.deactivatedAt && !state.revokedAt
							? [subscription]
							: [];
					}
					if (table === calendarSubscriptions) {
						return state.revokedAt ? [] : [{ wgId }];
					}
					if (table === wgEvents) {
						state.eventPageLimits.push(value);
						const page = state.events.slice(state.eventOffset, state.eventOffset + value);
						state.eventOffset += value;
						state.steps.push('events');
						return page;
					}
					throw new Error(`unexpected limit query: ${String(table)}`);
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
		'@/features/events/calendar-subscription': {
			isCalendarFeedToken: () => true,
			verifyCalendarFeedToken: (_id, seed, token) => seed === 'seed' && token === 'valid',
		},
		'@/features/events/event-reminder-window': {
			buildEventsWindowFilter: (from, to) => {
				state.window = { from, to };
				return realWindow.buildEventsWindowFilter(from, to);
			},
			withEventWindowCandidates: (...args) => {
				state.candidateLimit = args[4];
				return realWindow.withEventWindowCandidates(...args);
			},
		},
		'@/features/events/events': {
			expandRecurrence: (event) => [event],
		},
		'@/features/events/ics': {
			calendarFeedToIcs: (rows) => rows.map((event) => event.title).join('\n'),
		},
		'drizzle-orm': {
			and: (...parts) => ({ kind: 'and', parts }),
			asc: (value) => ({ kind: 'asc', value }),
			eq: (...parts) => ({ kind: 'eq', parts }),
			gt: (...parts) => ({ kind: 'gt', parts }),
			isNotNull: (value) => ({ kind: 'isNotNull', value }),
			isNull: (value) => ({ kind: 'isNull', value }),
			or: (...parts) => ({ kind: 'or', parts }),
		},
		'next/server': { NextResponse: Response },
	};
	const source = readFileSync(routePath, 'utf8');
	const compiled = transpileModule(source, {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(
		(name) => (Object.hasOwn(mocks, name) ? mocks[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	const request = new Request(`https://example.test/api/calendar/${id}/valid`);
	return {
		state,
		get: () => module.exports.GET(request, { params: Promise.resolve({ id, token: 'valid' }) }),
	};
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

test('feed query is windowed to the render horizon instead of the full history', async () => {
	const { state, get } = harness();
	const startedAt = Date.now();
	await get();

	assert.ok(state.window, 'buildEventsWindowFilter must be applied in SQL');
	const spanDays = (state.window.to.getTime() - state.window.from.getTime()) / 86_400_000;
	assert.ok(Math.abs(spanDays - 365) < 1, `window span was ${spanDays} days, expected 365`);
	assert.ok(
		state.window.from.getTime() >= startedAt - 60_000,
		'window starts at the current feed start',
	);

	const eventsQuery = state.whereConditions.find((entry) => entry.table === wgEvents);
	assert.ok(eventsQuery, 'events must be filtered in SQL');
	assert.equal(eventsQuery.condition.kind, 'and');
	assert.equal(
		eventsQuery.condition.parts.length,
		2,
		'WG filter and window filter must both be part of the predicate',
	);

	assert.ok(Number.isFinite(state.candidateLimit) && state.candidateLimit > 0);
	assert.equal(state.eventPageLimits[0], 500, 'candidates are fetched in bounded pages');
});

test('a candidate set above the cap fails the feed instead of expanding everything', async () => {
	const events = Array.from({ length: 5_001 }, (_, index) => eventRow(index));
	const { state, get } = harness({ events });
	const response = await get();

	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: 'calendar_feed_window_too_large' });
	assert.ok(state.eventPageLimits.length > 1, 'the scan must be paged');
});
