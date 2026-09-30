import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const sourcePath = path.join(process.cwd(), 'src/features/expenses/import-commit.ts');
const wgId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';
const expenseFields = {
	wgId: 'expenses.wgId',
	paidByMemberId: 'expenses.paidByMemberId',
	description: 'expenses.description',
	amountCents: 'expenses.amountCents',
	currency: 'expenses.currency',
	occurredAt: 'expenses.occurredAt',
	importDuplicateKey: 'expenses.importDuplicateKey',
};

function runCommit(existingExpenses) {
	const expenseImports = { id: 'expenseImports.id' };
	const expenseSplits = {};
	const wgMembers = { id: 'wgMembers.id' };
	const state = { inserted: [], splits: [] };
	const tx = {
		select(fields) {
			let table;
			const query = {
				from(selectedTable) {
					table = selectedTable;
					return query;
				},
				where: async () => {
					assert.equal(table, expenses);
					return existingExpenses.map((row) =>
						Object.fromEntries(
							Object.entries(fields).map(([key, field]) => [
								key,
								Object.values(expenseFields).includes(field) ? row[key] : undefined,
							]),
						),
					);
				},
			};
			return query;
		},
		insert(table) {
			return {
				values(value) {
					if (table === expenseImports) {
						return { returning: async () => [{ id: 'import-1' }] };
					}
					if (table === expenses) {
						const insert = {
							onConflictDoNothing: () => insert,
							returning: async () => {
								const row = { ...value, id: `expense-${state.inserted.length + 1}` };
								state.inserted.push(row);
								return [{ id: row.id }];
							},
						};
						return insert;
					}
					assert.equal(table, expenseSplits);
					state.splits.push(...value);
					return Promise.resolve();
				},
			};
		},
		update(table) {
			assert.equal(table, expenseImports);
			return { set: () => ({ where: async () => [] }) };
		},
	};
	const db = {
		select: () => ({
			from: (table) => {
				assert.equal(table, wgMembers);
				return { where: async () => [{ id: memberId }] };
			},
		}),
	};
	const expenses = expenseFields;
	const mocks = {
		'@/core/activity-feed': { postSystemNotice: async () => {} },
		'@/core/audit': { recordAuditEvent: async () => {} },
		'@/core/db': {
			db,
			expenseImports,
			expenseSplits,
			expenses,
			idempotencyResponses: {},
			wgMembers,
		},
		'@/core/db/transaction': { TransactionAbort: class TransactionAbort extends Error {} },
		'@/core/idempotency': { RESPONSE_REPLAY_TTL_SECONDS: 60 },
		'@/core/notifications/notification-dispatch': {
			dispatchNotificationSafely: async () => ({ warning: null }),
		},
		'@/core/utils/money': { formatEuroCents: () => '12,00 €' },
		'@/features/expenses/expense-payments': {
			hasCapturingExpensePayment: async () => false,
			withExpensePaymentLock: async (_id, operation) => operation(tx),
		},
		'@/features/expenses/split-math': { settledAtForOwnShare: () => null },
		'drizzle-orm': {
			and: (...conditions) => conditions,
			eq: (field, value) => ({ field, value }),
			inArray: (field, values) => ({ field, values }),
			isNull: (field) => ({ field, isNull: true }),
			sql: (parts, ...values) => ({ parts, values }),
		},
	};
	const source = transpileModule(readFileSync(sourcePath, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (Object.hasOwn(mocks, name) ? mocks[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	const module = loaded.exports;
	return {
		state,
		commit: () =>
			module.commitImport({
				wg: { id: wgId, name: 'WG', shareCode: 'MTE8PZAT' },
				source: 'manual',
				importedByMemberId: memberId,
				importedByName: 'Alice',
				expenses: [
					{
						skip: false,
						parsed: {
							date: '2025-01-15',
							description: 'Dinner',
							amountCents: 1200,
							currency: 'EUR',
							paidByName: 'Alice',
							splits: [{ memberName: 'Alice', amountCents: 1200 }],
							warnings: [],
						},
					},
				],
				mapping: { Alice: memberId },
				skipDuplicates: true,
				rawPayloadHash: 'payload-hash',
			}),
	};
}

test('duplicate checks distinguish currencies and keep the legacy EUR import key', async () => {
	const existing = (currency) => ({
		wgId,
		paidByMemberId: memberId,
		description: 'Dinner',
		amountCents: 1200,
		currency,
		occurredAt: new Date('2025-01-15T12:00:00.000Z'),
	});

	const differentCurrency = runCommit([existing('USD')]);
	const inserted = await differentCurrency.commit();
	assert.deepEqual([inserted.inserted, inserted.skipped], [1, 0]);
	assert.equal(
		differentCurrency.state.inserted[0].importDuplicateKey,
		'2025-01-15|dinner|1200|33333333-3333-4333-8333-333333333333',
	);

	const sameCurrency = runCommit([existing('EUR')]);
	const skipped = await sameCurrency.commit();
	assert.deepEqual([skipped.inserted, skipped.skipped], [0, 1]);
});
