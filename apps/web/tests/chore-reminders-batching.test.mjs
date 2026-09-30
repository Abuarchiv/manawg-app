import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const srcRoot = path.join(process.cwd(), 'src');

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWebModule(request, parent, isMain, options) {
	const resolved = request.startsWith('@/') ? path.join(srcRoot, request.slice(2)) : request;
	return resolveFilename.call(this, resolved, parent, isMain, options);
};
Module._extensions['.ts'] = (loadedModule, filename) => {
	const source = fs.readFileSync(filename, 'utf8');
	const compiled = transpileModule(source, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
		fileName: filename,
	}).outputText;
	loadedModule._compile(compiled, filename);
};

const tables = {
	choreCompletions: {},
	chores: {},
	pushSubscriptions: { memberId: {} },
	wgMembers: {},
	wgs: {},
};
const state = {
	candidates: [],
	completions: [],
	gteCalls: [],
	orders: [],
	limits: [],
	updates: [],
	dispatched: [],
	inFlight: 0,
	maxInFlight: 0,
	dispatchDelayMs: 5,
};

function makeQuery() {
	const query = {
		table: null,
		from(table) {
			query.table = table;
			return query;
		},
		innerJoin() {
			return query;
		},
		where() {
			if (query.table === tables.choreCompletions) return Promise.resolve(state.completions);
			return query;
		},
		orderBy(...specs) {
			state.orders.push(...specs);
			return query;
		},
		limit(value) {
			state.limits.push(value);
			return Promise.resolve(query.table === tables.chores ? state.candidates : state.completions);
		},
	};
	return query;
}

const db = {
	select: () => makeQuery(),
	update: () => ({
		set: (values) => ({
			where: () => {
				state.updates.push(values);
				return Promise.resolve();
			},
		}),
	}),
};

const mocks = new Map([
	[
		'@/core/db',
		{
			db,
			choreCompletions: tables.choreCompletions,
			chores: tables.chores,
			pushSubscriptions: tables.pushSubscriptions,
			wgMembers: tables.wgMembers,
			wgs: tables.wgs,
		},
	],
	['@/core/infra/cron-auth', { verifyCronSecret: () => true }],
	[
		'@/core/infra/observability',
		{ logApiError: () => undefined, withCronLogging: (_label, handler) => handler },
	],
	[
		'@/core/notifications/notification-dispatch',
		{
			dispatchNotification: async (input) => {
				state.inFlight += 1;
				state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
				state.dispatched.push(input.payload.choreId);
				await new Promise((resolve) => setTimeout(resolve, state.dispatchDelayMs));
				state.inFlight -= 1;
				return { sent: 1, failures: [] };
			},
		},
	],
	[
		'drizzle-orm',
		{
			and: (...parts) => ({ kind: 'and', parts }),
			or: (...parts) => ({ kind: 'or', parts }),
			asc: (column) => ({ kind: 'asc', column }),
			eq: (column, value) => ({ kind: 'eq', column, value }),
			gte: (column, value) => {
				state.gteCalls.push({ column, value });
				return { kind: 'gte', column, value };
			},
			inArray: (column) => ({ kind: 'inArray', column }),
			isNotNull: (column) => ({ kind: 'isNotNull', column }),
			isNull: (column) => ({ kind: 'isNull', column }),
			lte: (column, value) => ({ kind: 'lte', column, value }),
			sql: (strings, ...values) => ({ kind: 'sql', strings, values }),
		},
	],
	['next/server', { NextResponse: Response }],
]);
const originalLoad = Module._load;
Module._load = function loadWithMocks(request, parent, isMain) {
	if (mocks.has(request)) return mocks.get(request);
	return originalLoad.call(this, request, parent, isMain);
};

const { GET } = requireFromWeb(path.join(srcRoot, 'app/api/cron/chore-reminders/route.ts'));

function choreRow(index, overrides = {}) {
	return {
		id: `chore-${index}`,
		title: `Chore ${index}`,
		nextDueAt: new Date(Date.now() - 7 * 86_400_000),
		assignedMemberId: `member-${index % 5}`,
		lastReminderAt: null,
		wgId: 'wg-1',
		wgName: 'WG',
		shareCode: 'MTE8PZAT',
		...overrides,
	};
}

async function runCron() {
	const response = await GET(
		new Request('https://example.invalid/api/cron/chore-reminders', {
			headers: { authorization: 'Bearer test' },
		}),
	);
	assert.equal(response.status, 200);
	return response.json();
}

test('a large overdue backlog is bounded in SQL and dispatched in blocks of 10', async () => {
	process.env.CRON_SECRET = 'test-secret';
	const backlog = Array.from({ length: 95 }, (_, index) => choreRow(index));
	state.candidates = backlog;
	state.completions = [];
	state.gteCalls = [];
	state.orders = [];
	state.limits = [];
	state.updates = [];
	state.dispatched = [];
	state.inFlight = 0;
	state.maxInFlight = 0;

	const body = await runCron();

	assert.equal(body.ok, true);
	assert.equal(body.sent, backlog.length, 'every candidate in the cap is dispatched');
	assert.equal(state.dispatched.length, backlog.length);
	assert.equal(state.maxInFlight, 10, 'dispatch fan-out never exceeds one block');
	assert.ok(
		state.maxInFlight <= 10,
		`concurrency peaked at ${state.maxInFlight}, expected at most 10`,
	);

	const lowerBound = state.gteCalls.find((call) => call.column === tables.chores.nextDueAt);
	assert.ok(lowerBound, 'candidate query must carry a lower bound on nextDueAt');
	assert.ok(lowerBound.value instanceof Date, 'lower bound must be a date');
	const ageDays = (Date.now() - lowerBound.value.getTime()) / 86_400_000;
	assert.ok(ageDays >= 6 && ageDays <= 8, `lookback window was ${ageDays.toFixed(1)} days`);

	assert.equal(state.limits.length, 1, 'candidate query must be limited');
	assert.ok(
		state.limits[0] > 0 && state.limits[0] <= 1000,
		`limit must be a bounded positive number, got ${state.limits[0]}`,
	);
	assert.ok(
		state.orders.some((order) => order.kind === 'asc' && order.column === tables.chores.nextDueAt),
		'most overdue chores survive the cap',
	);

	assert.equal(state.updates.length, 1, 'lastReminderAt is stamped once for the whole run');
	assert.equal(state.updates[0].lastReminderAt instanceof Date, true);
});

test('chores already reminded inside the throttle window are not re-dispatched', async () => {
	process.env.CRON_SECRET = 'test-secret';
	state.candidates = [choreRow(1001, { lastReminderAt: new Date() }), choreRow(1002)];
	state.completions = [];
	state.dispatched = [];
	state.updates = [];
	state.maxInFlight = 0;

	const body = await runCron();

	assert.equal(body.sent, 1);
	assert.deepEqual(state.dispatched, ['chore-1002']);
	assert.equal(state.updates.length, 1);
});
