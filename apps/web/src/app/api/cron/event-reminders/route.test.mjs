import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const { ModuleKind, ScriptTarget, transpileModule } = requireFromWeb('typescript');
const srcPath = path.join(process.cwd(), 'src');
const routePath = path.join(srcPath, 'app/api/cron/event-reminders/route.ts');

function loadTypeScriptModule(filePath, dependencies = {}) {
	const compiled = transpileModule(readFileSync(filePath, 'utf8'), {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(
		(name) => (Object.hasOwn(dependencies, name) ? dependencies[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

const berlinDay = loadTypeScriptModule(path.join(srcPath, 'core/utils/berlin-day.ts'));
const timeUtils = loadTypeScriptModule(path.join(srcPath, 'core/utils/time.ts'));
const eventUtils = loadTypeScriptModule(path.join(srcPath, 'features/events/events.ts'), {
	'@/core/utils/berlin-day': berlinDay,
	'@/core/utils/time': timeUtils,
});
const reminderUtils = loadTypeScriptModule(
	path.join(srcPath, 'features/events/event-reminder-dispatch.ts'),
	{ '@/core/utils/berlin-day': berlinDay },
);

const wgEvents = {
	id: 'events.id',
	startsAt: 'events.startsAt',
	endsAt: 'events.endsAt',
	allDay: 'events.allDay',
	recurrence: 'events.recurrence',
	wgId: 'events.wgId',
};
const wgMembers = {
	id: 'members.id',
	wgId: 'members.wgId',
	deactivatedAt: 'members.deactivatedAt',
};
const wgs = { id: 'wgs.id', name: 'wgs.name', shareCode: 'wgs.shareCode' };
const idempotencyResponses = {
	scope: 'idempotency.scope',
	key: 'idempotency.key',
	expiresAt: 'idempotency.expiresAt',
	responseBody: 'idempotency.responseBody',
};

function condition(op, column, value) {
	return { op, column, value };
}

function findCondition(filter, op, column) {
	if (!filter || typeof filter !== 'object') return undefined;
	if (filter.op === op && filter.column === column) return filter;
	for (const child of filter.conditions ?? []) {
		const found = findCondition(child, op, column);
		if (found) return found;
	}
	return undefined;
}

function makeHarness({ failureMode = 'partial', eventEndsAt = '2026-10-26T11:00:00.000Z' } = {}) {
	const event = {
		id: 'event-1',
		title: 'Treffen',
		description: null,
		startsAt: new Date('2026-10-26T10:00:00.000Z'),
		endsAt: new Date(eventEndsAt),
		allDay: false,
		location: null,
		recurrence: null,
		wgId: 'wg-1',
		wgName: 'WG',
		shareCode: 'ABCDEFGH',
	};
	const state = {
		events: [event],
		members: [
			{ id: 'member-A', wgId: 'wg-1', deactivatedAt: null },
			{ id: 'member-B', wgId: 'wg-1', deactivatedAt: null },
		],
		claims: new Map(),
		dispatches: [],
	};

	function selectedRows(table, filter) {
		if (table === wgEvents) return state.events;
		if (table === wgMembers) return state.members;
		if (table === idempotencyResponses) {
			const scope = findCondition(filter, 'eq', idempotencyResponses.scope)?.value;
			const keys = findCondition(filter, 'inArray', idempotencyResponses.key)?.value ?? [];
			return [...state.claims.values()]
				.filter((row) => row.scope === scope && row.expiresAt > new Date())
				.filter((row) => keys.includes(row.key))
				.map((row) => ({ key: row.key }));
		}
		throw new Error('unexpected selected table');
	}

	const db = {
		select: () => {
			let table;
			let filter;
			const query = {
				from(value) {
					table = value;
					return query;
				},
				innerJoin() {
					return query;
				},
				where(value) {
					filter = value;
					if (table === wgMembers || table === idempotencyResponses) {
						return Promise.resolve(selectedRows(table, filter));
					}
					return query;
				},
				orderBy() {
					return query;
				},
				limit: async () => selectedRows(table, filter),
			};
			return query;
		},
		insert: () => {
			let values;
			const query = {
				values(value) {
					values = value;
					return query;
				},
				onConflictDoUpdate() {
					return query;
				},
				returning: async () => {
					const key = `${values.scope}:${values.key}`;
					const existing = state.claims.get(key);
					if (existing && existing.expiresAt > new Date()) return [];
					state.claims.set(key, values);
					return [{ key: values.key }];
				},
			};
			return query;
		},
		update: () => {
			let values;
			let filter;
			const query = {
				set(value) {
					values = value;
					return query;
				},
				where(value) {
					filter = value;
					const scope = findCondition(filter, 'eq', idempotencyResponses.scope)?.value;
					const key = findCondition(filter, 'eq', idempotencyResponses.key)?.value;
					const row = state.claims.get(`${scope}:${key}`);
					if (row) Object.assign(row, values);
					return Promise.resolve();
				},
			};
			return query;
		},
		delete: () => ({
			where(filter) {
				const scope = findCondition(filter, 'eq', idempotencyResponses.scope)?.value;
				const key = findCondition(filter, 'eq', idempotencyResponses.key)?.value;
				state.claims.delete(`${scope}:${key}`);
				return Promise.resolve();
			},
		}),
	};

	const { startOfBerlinDay, nextBerlinDayStart } = berlinDay;
	const route = loadTypeScriptModule(routePath, {
		'@/core/db': { db, idempotencyResponses, wgEvents, wgMembers, wgs },
		'@/core/infra/cron-auth': { verifyCronSecret: () => true },
		'@/core/infra/observability': { withCronLogging: (_name, handler) => handler },
		'@/core/notifications/notification-dispatch': {
			dispatchNotification: async (input) => {
				const memberId = input.targetMemberIds[0];
				state.dispatches.push({ memberId, event: input.event, allDay: input.payload.allDay });
				if (failureMode === 'all') return { sent: 0, failures: ['provider failed'] };
				if (failureMode === 'none') return { sent: 0, failures: [] };
				if (memberId === 'member-B' && input.event === 'event.upcoming') {
					return { sent: 1, failures: ['one device failed'] };
				}
				return { sent: 1, failures: [] };
			},
		},
		'@/core/utils/berlin-day': berlinDay,
		'@/core/utils/time': timeUtils,
		'@/features/events/event-reminder-dispatch': reminderUtils,
		'@/features/events/event-reminder-window': {
			buildEventsWindowFilter: () => ({}),
			computeTomorrowUtcWindow: (now) => {
				const start = nextBerlinDayStart(startOfBerlinDay(now));
				const end = new Date(nextBerlinDayStart(start).getTime() - 1);
				return { start, end };
			},
			withEventWindowCandidates: async (_from, fetchPage, _overflow, processRows) =>
				processRows(await fetchPage(null, 500)),
		},
		'@/features/events/events': eventUtils,
		'drizzle-orm': {
			and: (...conditions) => ({ op: 'and', conditions }),
			asc: (column) => ({ op: 'asc', column }),
			eq: (column, value) => condition('eq', column, value),
			gt: (column, value) => condition('gt', column, value),
			inArray: (column, value) => condition('inArray', column, value),
			isNull: (column) => condition('isNull', column),
			lte: (column, value) => condition('lte', column, value),
			or: (...conditions) => ({ op: 'or', conditions }),
		},
		'next/server': { NextResponse: Response },
	});
	return { state, get: (request) => route.GET(request) };
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

test('a partial delivery retries only the failed member with today copy', async () => {
	const previousSecret = process.env.CRON_SECRET;
	process.env.CRON_SECRET = 'cron-secret';
	const { state, get } = makeHarness();
	const request = new Request('https://example.test/api/cron/event-reminders', {
		headers: { authorization: 'Bearer cron-secret' },
	});
	try {
		const tomorrow = await withFrozenTime('2026-10-25T09:00:00.000Z', () => get(request));
		assert.equal(tomorrow.status, 503);
		assert.deepEqual(await tomorrow.json(), { ok: false, sent: 1, failed: 1 });

		const today = await withFrozenTime('2026-10-26T09:00:00.000Z', () => get(request));
		assert.equal(today.status, 200);
		assert.deepEqual(await today.json(), { ok: true, sent: 1, failed: 0 });

		const afterToday = await withFrozenTime('2026-10-27T09:00:00.000Z', () => get(request));
		assert.equal(afterToday.status, 200);
		assert.equal((await afterToday.json()).sent, 0);
	} finally {
		if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'CRON_SECRET');
		else process.env.CRON_SECRET = previousSecret;
	}

	assert.deepEqual(
		state.dispatches.map(({ memberId, event }) => `${memberId}:${event}`).sort(),
		['member-A:event.upcoming', 'member-B:event.today', 'member-B:event.upcoming'].sort(),
	);
});

test('all provider failures are reported with an unavailable response', async () => {
	const previousSecret = process.env.CRON_SECRET;
	process.env.CRON_SECRET = 'cron-secret';
	const { get } = makeHarness({ failureMode: 'all' });
	try {
		const response = await withFrozenTime('2026-10-25T09:00:00.000Z', () =>
			get(new Request('https://example.test/api/cron/event-reminders')),
		);
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), { ok: false, sent: 0, failed: 2 });
	} finally {
		if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'CRON_SECRET');
		else process.env.CRON_SECRET = previousSecret;
	}
});

test('no applicable push subscriptions are not reported as a provider failure', async () => {
	const previousSecret = process.env.CRON_SECRET;
	process.env.CRON_SECRET = 'cron-secret';
	const { get } = makeHarness({ failureMode: 'none' });
	try {
		const response = await withFrozenTime('2026-10-25T09:00:00.000Z', () =>
			get(new Request('https://example.test/api/cron/event-reminders')),
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, sent: 0, failed: 0 });
	} finally {
		if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'CRON_SECRET');
		else process.env.CRON_SECRET = previousSecret;
	}
});

test('successful claims cover long occurrences while failed members remain retryable', async () => {
	const previousSecret = process.env.CRON_SECRET;
	process.env.CRON_SECRET = 'cron-secret';
	const { state, get } = makeHarness({ eventEndsAt: '2026-12-01T10:00:00.000Z' });
	try {
		const tomorrow = await withFrozenTime('2026-10-25T09:00:00.000Z', () =>
			get(new Request('https://example.test/api/cron/event-reminders')),
		);
		assert.equal(tomorrow.status, 503);
		assert.deepEqual(await tomorrow.json(), { ok: false, sent: 1, failed: 1 });

		const ongoing = await withFrozenTime('2026-11-27T09:00:00.000Z', () =>
			get(new Request('https://example.test/api/cron/event-reminders')),
		);
		assert.equal(ongoing.status, 200);
		assert.deepEqual(await ongoing.json(), { ok: true, sent: 1, failed: 0 });
	} finally {
		if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'CRON_SECRET');
		else process.env.CRON_SECRET = previousSecret;
	}

	assert.deepEqual(
		state.dispatches.map(({ memberId, event }) => `${memberId}:${event}`).sort(),
		['member-A:event.upcoming', 'member-B:event.today', 'member-B:event.upcoming'].sort(),
	);
});
