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
	expenses: {},
	expenseSplits: {},
	recurringExpenses: {},
	wgMembers: {},
	wgs: {},
};
const state = { template: null, charges: [] };

function dueTemplates() {
	const template = state.template;
	if (!template || template.pausedAt !== null) return [];
	return template.nextDueAt <= new Date() ? [template] : [];
}

const db = {
	select: () => ({
		from: () => ({
			innerJoin: () => ({ where: async () => dueTemplates() }),
			where: async () => dueTemplates(),
		}),
	}),
	update: () => ({
		set: (values) => ({
			where: () => ({
				returning: async () => {
					Object.assign(state.template, values);
					return [{ id: state.template.id }];
				},
			}),
		}),
	}),
};

const tx = {
	select: () => ({
		from: (table) => ({
			where: () => {
				if (table === tables.wgs) {
					return { for: async () => [{ id: state.template.wgId }] };
				}
				if (table === tables.recurringExpenses) {
					return { for: async () => [state.template] };
				}
				if (table === tables.wgMembers) return Promise.resolve([{ id: 'member-1' }]);
				return Promise.resolve([]);
			},
		}),
	}),
	insert: (table) => ({
		values: (rows) =>
			Object.assign(Promise.resolve(undefined), {
				returning: async () => {
					assert.equal(table, tables.expenses);
					const dueAt = rows.recurringDueAt.toISOString();
					const duplicate = state.charges.some(
						(charge) =>
							charge.recurringExpenseId === rows.recurringExpenseId && charge.dueAt === dueAt,
					);
					if (duplicate) throw Object.assign(new Error('duplicate'), { code: '23505' });
					const id = `expense-${state.charges.length + 1}`;
					state.charges.push({
						id,
						recurringExpenseId: rows.recurringExpenseId,
						dueAt,
						occurredAt: rows.occurredAt.toISOString(),
					});
					return [{ id }];
				},
			}),
	}),
};

const mocks = new Map([
	[
		'@/core/db',
		{
			db,
			expenses: tables.expenses,
			expenseSplits: tables.expenseSplits,
			recurringExpenses: tables.recurringExpenses,
			wgMembers: tables.wgMembers,
			wgs: tables.wgs,
		},
	],
	[
		'@/core/db/transaction',
		{
			TransactionAbort: class TransactionAbort extends Error {
				constructor(code) {
					super(code);
					this.code = code;
				}
			},
		},
	],
	['@/core/audit', { recordAuditEvent: async () => undefined }],
	['@/core/infra/cron-auth', { verifyCronSecret: () => true }],
	[
		'@/core/infra/observability',
		{
			logApiError: () => undefined,
			withCronLogging: (_label, handler) => handler,
		},
	],
	[
		'@/core/notifications/notification-dispatch',
		{ dispatchNotificationSafely: async () => ({ sent: 0, warning: null }) },
	],
	[
		'@/features/expenses/expense-payments',
		{
			hasCapturingExpensePayment: async () => false,
			withExpensePaymentLock: (_wgId, run) => run(tx),
		},
	],
	[
		'drizzle-orm',
		{
			and: (...parts) => ({ kind: 'and', parts }),
			eq: () => ({}),
			inArray: () => ({}),
			isNull: () => ({}),
			lte: () => ({}),
		},
	],
	['next/server', { NextResponse: Response }],
]);
const originalLoad = Module._load;
Module._load = function loadWithMocks(request, parent, isMain) {
	if (mocks.has(request)) return mocks.get(request);
	return originalLoad.call(this, request, parent, isMain);
};

const { GET } = requireFromWeb(path.join(srcRoot, 'app/api/cron/recurring-advance/route.ts'));

/** Drive the cron with a frozen clock so each run advances one month at a time. */
async function runCronAt(isoInstant) {
	const RealDate = globalThis.Date;
	class FakeDate extends RealDate {
		constructor(...args) {
			if (args.length === 0) super(isoInstant);
			else super(...args);
		}
		static now() {
			return new RealDate(isoInstant).getTime();
		}
	}
	globalThis.Date = FakeDate;
	try {
		const response = await GET(
			new Request('https://example.invalid/api/cron/recurring-advance', {
				headers: { authorization: 'Bearer test' },
			}),
		);
		assert.equal(response.status, 200, `cron run at ${isoInstant} must succeed`);
		return response.json();
	} finally {
		globalThis.Date = RealDate;
	}
}

test('legacy template keeps the 31st as anchor across clamped month ends', async () => {
	process.env.CRON_SECRET = 'test-secret';
	state.template = {
		id: 'recurring-1',
		wgId: 'wg-1',
		paidByMemberId: 'member-1',
		description: 'Internet',
		amountCents: 1000,
		intervalMonths: 1,
		nextDueAt: new Date(Date.UTC(2026, 0, 31)),
		anchorAt: null,
		pausedAt: null,
		lastCreatedAt: null,
		splitsJson: JSON.stringify([{ debtorMemberId: 'member-1', amountCents: 1000 }]),
		wgName: 'WG',
		shareCode: 'MTE8PZAT',
	};
	state.charges = [];

	await runCronAt('2026-02-15T12:00:00.000Z');
	await runCronAt('2026-03-15T12:00:00.000Z');
	await runCronAt('2026-04-15T12:00:00.000Z');
	await runCronAt('2026-05-01T12:00:00.000Z');

	assert.deepEqual(
		state.charges.map((charge) => charge.dueAt.slice(0, 10)),
		['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'],
		'occurrences must stay on the month-end anchor, never drift to the 28th',
	);
	assert.equal(
		state.template.anchorAt.toISOString().slice(0, 10),
		'2026-01-31',
		'the adopted anchor is the pre-advance due date',
	);
	assert.equal(state.template.anchorAt.getUTCDate(), 31);
	assert.equal(state.template.nextDueAt.toISOString().slice(0, 10), '2026-05-31');
});
