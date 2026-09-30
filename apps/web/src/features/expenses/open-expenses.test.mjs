import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const modulePath = path.join(process.cwd(), 'src/features/expenses/open-expenses.ts');
const wgId = '11111111-1111-4111-8111-111111111111';
const expenses = {
	id: 'expenses.id',
	wgId: 'expenses.wgId',
	paidByMemberId: 'expenses.paidByMemberId',
	currency: 'expenses.currency',
	occurredAt: 'expenses.occurredAt',
};
const expenseSplits = {
	expenseId: 'expenseSplits.expenseId',
	debtorMemberId: 'expenseSplits.debtorMemberId',
	amountCents: 'expenseSplits.amountCents',
	settledAt: 'expenseSplits.settledAt',
};
const eq = (field, value) => ({ operator: 'eq', field, value });

function load() {
	const source = transpileModule(readFileSync(modulePath, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const mocks = {
		'@/core/db': { db: null, expenseSplits, expenses },
		'drizzle-orm': {
			eq,
			inArray: () => assert.fail('splits must not be loaded by an id list'),
		},
	};
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (Object.hasOwn(mocks, name) ? mocks[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

test('loadOpenExpenses joins splits by WG instead of binding every expense id', async () => {
	const { loadOpenExpenses } = load();
	const splitQueries = [];
	const client = {
		select() {
			const query = {
				table: null,
				join: null,
				from(table) {
					query.table = table;
					return query;
				},
				innerJoin(table, on) {
					query.join = { table, on };
					return query;
				},
				where: async (predicate) => {
					if (query.table === expenses) {
						assert.deepEqual(predicate, eq(expenses.wgId, wgId));
						return [
							{
								id: 'e1',
								paidByMemberId: 'a',
								currency: 'EUR',
								occurredAt: new Date('2026-09-01T00:00:00.000Z'),
							},
							{ id: 'e2', paidByMemberId: 'b', currency: null, occurredAt: '2026-09-02' },
						];
					}
					splitQueries.push({ join: query.join, predicate });
					return [
						{ expenseId: 'e1', debtorMemberId: 'b', amountCents: 500, settledAt: null },
						{
							expenseId: 'e2',
							debtorMemberId: 'a',
							amountCents: 300,
							settledAt: new Date('2026-09-03T00:00:00.000Z'),
						},
					];
				},
			};
			return query;
		},
	};

	const result = await loadOpenExpenses(wgId, client);

	assert.deepEqual(splitQueries, [
		{
			join: { table: expenses, on: eq(expenseSplits.expenseId, expenses.id) },
			predicate: eq(expenses.wgId, wgId),
		},
	]);
	assert.deepEqual(result, [
		{
			paidByMemberId: 'a',
			currency: 'EUR',
			occurredAt: '2026-09-01T00:00:00.000Z',
			splits: [{ debtorMemberId: 'b', amountCents: 500, settledAt: null }],
		},
		{
			paidByMemberId: 'b',
			occurredAt: '2026-09-02',
			splits: [{ debtorMemberId: 'a', amountCents: 300, settledAt: '2026-09-03T00:00:00.000Z' }],
		},
	]);
});
