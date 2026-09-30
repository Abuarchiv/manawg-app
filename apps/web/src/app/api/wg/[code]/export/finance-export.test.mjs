import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));

function loadTs(file, overrides = {}) {
	const source = transpileModule(readFileSync(path.join(process.cwd(), file), 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return module.exports;
}

const members = [
	{ id: 'alice', wgId: 'wg', name: 'Alice', createdAt: new Date('2026-01-01T00:00:00Z') },
	{ id: 'bob', wgId: 'wg', name: 'Bob', createdAt: new Date('2026-01-02T00:00:00Z') },
	{ id: 'carol', wgId: 'wg', name: 'Carol', createdAt: new Date('2026-01-03T00:00:00Z') },
];

const expenses = [
	{
		id: 'expense-eur',
		wgId: 'wg',
		description: 'EUR dinner',
		amountCents: 8000,
		currency: 'EUR',
		paidByMemberId: 'alice',
		imageUrl: null,
		occurredAt: new Date('2026-02-01T00:00:00Z'),
	},
	{
		id: 'expense-usd',
		wgId: 'wg',
		description: 'USD groceries',
		amountCents: 10000,
		currency: 'USD',
		paidByMemberId: 'carol',
		imageUrl: null,
		occurredAt: new Date('2026-02-02T00:00:00Z'),
	},
];

const splits = [
	{ expenseId: 'expense-eur', debtorMemberId: 'bob', amountCents: 4000, settledAt: null },
	{ expenseId: 'expense-usd', debtorMemberId: 'alice', amountCents: 5000, settledAt: null },
	{ expenseId: 'expense-usd', debtorMemberId: 'bob', amountCents: 5000, settledAt: null },
];

const completedPayments = [
	{
		id: 'payment-usd',
		wgId: 'wg',
		fromMemberId: 'alice',
		toMemberId: 'carol',
		amountCents: 2000,
		currency: 'USD',
		status: 'completed',
		completedAt: new Date('2026-02-04T12:00:00Z'),
	},
	{
		id: 'payment-eur',
		wgId: 'wg',
		fromMemberId: 'bob',
		toMemberId: 'alice',
		amountCents: 2500,
		currency: 'EUR',
		status: 'completed',
		completedAt: new Date('2026-02-03T12:00:00Z'),
	},
	{
		id: 'payment-pending',
		wgId: 'wg',
		fromMemberId: 'bob',
		toMemberId: 'alice',
		amountCents: 4000,
		currency: 'EUR',
		status: 'created',
		completedAt: null,
	},
];

function createExportRoute({ failedTable } = {}) {
	const columns = {
		announcements: ['wgId'],
		auditEvents: ['wgId'],
		chores: ['wgId'],
		expensePayments: ['wgId', 'status'],
		expenseSplits: ['expenseId'],
		expenses: ['wgId'],
		memberAbsences: ['wgId'],
		recurringExpenses: ['wgId'],
		shoppingItems: ['wgId'],
		wgMembers: ['wgId'],
	};
	const tables = Object.fromEntries(
		Object.entries(columns).map(([name, keys]) => [
			name,
			Object.assign(Object.fromEntries(keys.map((key) => [key, key])), { __name: name }),
		]),
	);
	const rowsByTable = {
		announcements: [],
		auditEvents: [],
		chores: [],
		expensePayments: completedPayments,
		expenseSplits: splits,
		expenses,
		memberAbsences: [],
		recurringExpenses: [],
		shoppingItems: [],
		wgMembers: members,
	};

	function matches(row, condition) {
		if (!condition) return true;
		if (condition.op === 'and') return condition.items.every((item) => matches(row, item));
		if (condition.op === 'eq') return row[condition.column] === condition.value;
		if (condition.op === 'inArray') return condition.values.includes(row[condition.column]);
		return false;
	}

	const db = {
		select: () => ({
			from: (table) => {
				const name = table.__name;
				let limit = Number.MAX_SAFE_INTEGER;
				let offset = 0;
				let rows = rowsByTable[name] ?? [];
				const query = Object.assign(
					Promise.resolve().then(() => {
						if (name === failedTable) throw new Error('privateDbPassword123');
						return rows.slice(offset, offset + limit);
					}),
					{
						where: (condition) => {
							rows = rows.filter((row) => matches(row, condition));
							return query;
						},
						orderBy: () => query,
						limit: (value) => {
							limit = value;
							return query;
						},
						offset: (value) => {
							offset = value;
							return query;
						},
					},
				);
				return query;
			},
		}),
	};
	const logged = [];
	const { GET } = loadTs('src/app/api/wg/[code]/export/route.ts', {
		'@/core/db': { db, ...tables },
		'@/core/errors': {
			badRequest: (error) => Response.json({ error }, { status: 400 }),
			serverError: (_error, message) =>
				Response.json({ error: message ?? 'server_error' }, { status: 500 }),
			tooMany: () => new Response(null, { status: 429 }),
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: 'wg', name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId: 'alice' },
			}),
		},
		'@/core/guards/route-preamble': {
			readShareCode: async () => ({ ok: true, code: 'MTE8PZAT' }),
			resolveE2EFixture: async () => ({ mode: 'real' }),
		},
		'@/core/infra/observability': { logApiError: (...args) => logged.push(args) },
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }) },
		'@/core/reads/export': loadTs('src/core/reads/export.ts'),
		'drizzle-orm': {
			and: (...items) => ({ op: 'and', items }),
			asc: () => null,
			desc: () => null,
			eq: (column, value) => ({ op: 'eq', column, value }),
			inArray: (column, values) => ({ op: 'inArray', column, values }),
		},
		'next/server': { NextResponse: Response },
	});
	return {
		logged,
		get: (search = '') => GET({ nextUrl: new URL(`https://example.invalid/export${search}`) }, {}),
	};
}

function appBalancesFromSource(computeNetBalances) {
	return computeNetBalances(
		expenses.map((expense) => ({
			paidByMemberId: expense.paidByMemberId,
			currency: expense.currency,
			splits: splits
				.filter((split) => split.expenseId === expense.id)
				.map(({ debtorMemberId, amountCents, settledAt }) => ({
					debtorMemberId,
					amountCents,
					settledAt,
				})),
		})),
		members.map(({ id, name }) => ({ id, name, color: null })),
		completedPayments
			.filter((payment) => payment.status === 'completed')
			.map(({ fromMemberId, toMemberId, amountCents, currency }) => ({
				fromMemberId,
				toMemberId,
				amountCents,
				currency,
			})),
	);
}

test('exported expenses and completed payments reconstruct the app balances by currency', async () => {
	const { computeNetBalances } = loadTs('src/features/expenses/debt-reduction.ts');
	const response = await createExportRoute().get();
	assert.equal(response.status, 200);
	const exported = await response.json();

	assert.deepEqual(exported.sections.expensePayments, [
		{
			id: 'payment-usd',
			fromMemberId: 'alice',
			toMemberId: 'carol',
			amountCents: 2000,
			currency: 'USD',
			completedAt: '2026-02-04T12:00:00.000Z',
		},
		{
			id: 'payment-eur',
			fromMemberId: 'bob',
			toMemberId: 'alice',
			amountCents: 2500,
			currency: 'EUR',
			completedAt: '2026-02-03T12:00:00.000Z',
		},
	]);
	assert.equal(JSON.stringify(exported).includes('privateDbPassword123'), false);
	assert.equal(JSON.stringify(exported).includes('providerOrderId'), false);
	assert.equal(JSON.stringify(exported).includes('payeeMerchantId'), false);
	assert.equal(
		loadTs('src/core/reads/export.ts')
			.buildExportSummary(exported)
			.find(({ key }) => key === 'expensePayments')?.count,
		2,
	);

	const exportedBalances = computeNetBalances(
		exported.sections.expenses.map((expense) => ({
			paidByMemberId: expense.paidByMemberId,
			currency: expense.currency,
			splits: expense.splits,
		})),
		exported.sections.members.map(({ id, name }) => ({ id, name, color: null })),
		exported.sections.expensePayments,
	);
	assert.deepEqual(exportedBalances, appBalancesFromSource(computeNetBalances));
	assert.deepEqual(
		exportedBalances.map(({ memberId, cents, currency }) => [memberId, cents, currency]),
		[
			['alice', 1500, 'EUR'],
			['bob', -1500, 'EUR'],
			['carol', 0, 'EUR'],
			['alice', -3000, 'USD'],
			['bob', -5000, 'USD'],
			['carol', 8000, 'USD'],
		],
	);
});

test('completed payments support optional JSON sections and paged CSV', async () => {
	const optionalResponse = await createExportRoute().get('?sections=expensePayments');
	assert.equal(optionalResponse.status, 200);
	const optionalExport = await optionalResponse.json();
	assert.equal(optionalExport.sections.expensePayments.length, 2);
	assert.deepEqual(optionalExport.sections.expenses, []);
	assert.deepEqual(optionalExport.sections.members, []);

	const response = await createExportRoute().get(
		'?format=csv&section=expensePayments&limit=1&offset=1',
	);
	assert.equal(response.status, 200);
	assert.equal(
		await response.text(),
		'id,fromMemberId,toMemberId,amountCents,currency,completedAt\npayment-eur,bob,alice,2500,EUR,2026-02-03T12:00:00.000Z',
	);
});

test('a failed completed payment query fails the full export closed', async () => {
	const route = createExportRoute({ failedTable: 'expensePayments' });
	const response = await route.get();
	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: 'export_incomplete' });
	assert.equal(JSON.stringify(route.logged).includes('privateDbPassword123'), false);

	const csvResponse = await createExportRoute({ failedTable: 'expensePayments' }).get(
		'?format=csv&section=expensePayments',
	);
	assert.equal(csvResponse.status, 500);
});
