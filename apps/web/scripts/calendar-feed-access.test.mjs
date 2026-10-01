import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const { ModuleKind, ScriptTarget, transpileModule } = requireFromWeb('typescript');
registerHooks({
	resolve(specifier, context, nextResolve) {
		return specifier.startsWith('@/')
			? nextResolve(
					pathToFileURL(path.resolve(process.cwd(), 'src', `${specifier.slice(2)}.ts`)).href,
					context,
				)
			: nextResolve(specifier, context);
	},
});
const [{ expandRecurrence }, { calendarFeedToIcs }, berlinDays] = await Promise.all([
	import('../src/features/events/events.ts'),
	import('../src/features/events/ics.ts'),
	import('../src/core/utils/berlin-day.ts'),
]);
const routePath = path.join(process.cwd(), 'src/app/api/calendar/[id]/[token]/route.ts');
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
const wgEvents = { wgId: 'wgId', startsAt: 'startsAt' };

function harness({
	authUserId = 'auth-user',
	deactivatedAt = null,
	revokedAt = null,
	events,
	now = '2026-09-26T12:00:00.000Z',
} = {}) {
	const state = {
		authUserId,
		deactivatedAt,
		revokedAt,
		wgExists: true,
		steps: [],
		events: events ?? [
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
	};
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
				where() {
					return query;
				},
				limit: async () => {
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
				orderBy: async () => {
					assert.equal(table, wgEvents);
					state.steps.push('events');
					return state.events;
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
		'@/core/utils/berlin-day': berlinDays,
		'@/features/events/calendar-subscription': {
			isCalendarFeedToken: () => true,
			verifyCalendarFeedToken: (_id, seed, token) => seed === 'seed' && token === 'valid',
		},
		'@/features/events/events': {
			expandRecurrence,
		},
		'@/features/events/ics': {
			calendarFeedToIcs,
		},
		'drizzle-orm': {
			and: (...parts) => ({ kind: 'and', parts }),
			asc: (value) => ({ kind: 'asc', value }),
			eq: (...parts) => ({ kind: 'eq', parts }),
			isNotNull: (value) => ({ kind: 'isNotNull', value }),
			isNull: (value) => ({ kind: 'isNull', value }),
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
	const runtimeDate = now
		? class extends Date {
				constructor(...args) {
					super(...(args.length === 0 ? [now] : args));
				}
				static now() {
					return new Date(now).getTime();
				}
			}
		: Date;
	new Function('require', 'module', 'exports', 'Date', compiled)(
		(name) => (Object.hasOwn(mocks, name) ? mocks[name] : requireFromWeb(name)),
		module,
		module.exports,
		runtimeDate,
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

test("today's all-day event remains in the ICS feed after its start instant", async () => {
	const { get } = harness({
		now: '2026-09-26T12:00:00.000Z',
		events: [
			{
				id: 'today-all-day',
				title: 'Today all-day event',
				description: null,
				startsAt: new Date('2026-09-26T00:00:00.000Z'),
				endsAt: null,
				allDay: true,
				location: null,
				recurrence: null,
				createdAt: new Date('2026-09-25T00:00:00.000Z'),
				updatedAt: new Date('2026-09-25T00:00:00.000Z'),
			},
		],
	});

	const response = await get();
	const body = await response.text();
	assert.equal(response.status, 200);
	assert.match(body, /SUMMARY:Today all-day event/);
	assert.match(body, /DTSTART;VALUE=DATE:20260926/);
	assert.match(body, /DTEND;VALUE=DATE:20260927/);
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
