import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

type Row = Record<string, unknown>;
type ExportedSections = {
	sections: Record<'expenses' | 'members' | 'expensePayments', Row[]>;
};
type Condition = {
	op: string;
	items?: Condition[];
	column?: string;
	value?: unknown;
	values?: unknown[];
};

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

const columns: Record<string, string[]> = {
	announcementComments: ['announcementId'],
	announcements: ['wgId'],
	auditEvents: ['wgId'],
	choreCompletions: ['choreId'],
	chores: ['wgId'],
	expensePayments: ['wgId', 'status'],
	expenseSplits: ['expenseId'],
	expenses: ['wgId'],
	memberAbsences: ['wgId'],
	recurringExpenses: ['wgId'],
	shoppingItems: ['wgId'],
	wgChatMessages: ['wgId'],
	wgEvents: ['wgId'],
	wgInventoryItems: ['wgId'],
	wgMembers: ['wgId'],
};
const tables = Object.fromEntries(
	Object.entries(columns).map(([name, keys]) => [
		name,
		Object.assign(Object.fromEntries(keys.map((key) => [key, key])), { __name: name }),
	]),
);
const rowsByTable: Record<string, Row[]> = {
	announcements: [],
	auditEvents: [],
	choreCompletions: [],
	chores: [],
	expensePayments: completedPayments,
	expenseSplits: splits,
	expenses,
	memberAbsences: [],
	recurringExpenses: [],
	shoppingItems: [],
	wgMembers: members,
};

const state = { failedTable: null as string | null, logged: [] as unknown[][] };

function matches(row: Row, condition: Condition | undefined): boolean {
	if (!condition) return true;
	if (condition.op === 'and') return (condition.items ?? []).every((item) => matches(row, item));
	if (condition.op === 'eq') return row[condition.column as string] === condition.value;
	if (condition.op === 'inArray')
		return (condition.values ?? []).includes(row[condition.column as string]);
	return false;
}

const db = {
	select: () => ({
		from: (table: { __name: string }) => {
			const name = table.__name;
			let limit = Number.MAX_SAFE_INTEGER;
			let offset = 0;
			let rows = rowsByTable[name] ?? [];
			const query: Promise<Row[]> & object = Object.assign(
				Promise.resolve().then(() => {
					if (name === state.failedTable) throw new Error('privateDbPassword123');
					return rows.slice(offset, offset + limit);
				}),
				{
					innerJoin: () => query,
					where: (condition: Condition) => {
						rows = rows.filter((row) => matches(row, condition));
						return query;
					},
					orderBy: () => query,
					limit: (value: number) => {
						limit = value;
						return query;
					},
					offset: (value: number) => {
						offset = value;
						return query;
					},
				},
			);
			return query;
		},
	}),
};

mock.module('@/core/db', { namedExports: { db, ...tables } });
mock.module('drizzle-orm', {
	namedExports: {
		and: (...items: Condition[]) => ({ op: 'and', items }),
		asc: () => null,
		count: () => null,
		desc: () => null,
		eq: (column: string, value: unknown) => ({ op: 'eq', column, value }),
		inArray: (column: string, values: unknown[]) => ({ op: 'inArray', column, values }),
	},
});
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: 'wg', name: 'WG', shareCode: 'MTE8PZAT' },
			member: { memberId: 'alice' },
		}),
	},
});
mock.module('@/core/infra/observability', {
	namedExports: {
		captureException: () => undefined,
		logApiError: (...args: unknown[]) => state.logged.push(args),
	},
});
mock.module('@/core/rate-limit', {
	namedExports: { wgExportLimiter: {}, checkRateLimit: async () => ({ success: true }) },
});

const { GET } = await import('./route');
const { computeNetBalances } = await import('@/features/expenses/debt-reduction');

function createExportRoute({ failedTable = null }: { failedTable?: string | null } = {}) {
	state.failedTable = failedTable;
	state.logged = [];
	return {
		get logged() {
			return state.logged;
		},
		get: (search = '') =>
			GET(
				{ nextUrl: new URL(`https://example.invalid/export${search}`) } as never,
				{ params: Promise.resolve({ code: 'MTE8PZAT' }) } as never,
			),
	};
}

function appBalancesFromSource() {
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
	const response = await createExportRoute().get();
	assert.equal(response.status, 200);
	const exported = (await response.json()) as ExportedSections;

	assert.deepEqual(exported.sections.expensePayments, [
		{
			id: 'payment-usd',
			fromName: 'Alice',
			toName: 'Carol',
			fromMemberId: 'alice',
			toMemberId: 'carol',
			amountCents: 2000,
			currency: 'USD',
			completedAt: '2026-02-04T12:00:00.000Z',
		},
		{
			id: 'payment-eur',
			fromName: 'Bob',
			toName: 'Alice',
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
	assert.equal(exported.sections.expensePayments.length, 2);

	const exportedBalances = computeNetBalances(
		exported.sections.expenses.map((expense) => ({
			paidByMemberId: expense.paidByMemberId,
			currency: expense.currency,
			splits: expense.splits,
		})) as never,
		exported.sections.members.map(({ id, name }) => ({ id, name, color: null })) as never,
		exported.sections.expensePayments as never,
	);
	assert.deepEqual(exportedBalances, appBalancesFromSource());
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
	const optionalExport = (await optionalResponse.json()) as ExportedSections;
	assert.equal(optionalExport.sections.expensePayments.length, 2);
	assert.deepEqual(optionalExport.sections.expenses, []);
	assert.deepEqual(optionalExport.sections.members, []);

	const response = await createExportRoute().get(
		'?format=csv&section=expensePayments&limit=1&offset=1',
	);
	assert.equal(response.status, 200);
	// Response.text() strips the BOM, so check the raw bytes for it.
	assert.deepEqual(
		[...new Uint8Array(await response.clone().arrayBuffer()).slice(0, 3)],
		[0xef, 0xbb, 0xbf],
	);
	assert.equal(
		await response.text(),
		'id;fromName;toName;fromMemberId;toMemberId;amount;currency;completedAt\npayment-eur;Bob;Alice;bob;alice;25,00;EUR;2026-02-03 13:00',
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
