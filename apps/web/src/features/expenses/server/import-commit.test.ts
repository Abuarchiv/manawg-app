import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TransactionAbort } from '@/core/db/transaction-abort';
import type { ParsedExpense } from '../import-parsers';

const wgId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';
const bobId = '44444444-4444-4444-8444-444444444444';
const charlieId = '55555555-5555-4555-8555-555555555555';
const expenseFields = {
	wgId: 'expenses.wgId',
	paidByMemberId: 'expenses.paidByMemberId',
	description: 'expenses.description',
	amountCents: 'expenses.amountCents',
	currency: 'expenses.currency',
	occurredAt: 'expenses.occurredAt',
	importDuplicateKey: 'expenses.importDuplicateKey',
};

const expenseImports = { id: 'expenseImports.id' };
const expenseSplits = {};
const wgMembers = { id: 'wgMembers.id' };
const expenses = expenseFields;

// Each runCommit installs its own fake database and transaction here; the mocked modules below
// delegate to whatever is current.
let current: { db: unknown; tx: unknown } = { db: null, tx: null };

mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => {} } });
mock.module('@/core/db', {
	namedExports: {
		db: {
			select: (...args: unknown[]) =>
				(current.db as { select: (...a: unknown[]) => unknown }).select(...args),
		},
		expenseImports,
		expenseSplits,
		expenses,
		idempotencyResponses: {},
		wgMembers,
	},
});
mock.module('@/core/db/transaction', {
	namedExports: {
		TransactionAbort,
		withTransaction: () => assert.fail('the import opens its own transaction'),
	},
});
// The import runs without an Idempotency-Key, so the real withIdempotentWrite never reaches the
// response store behind these.
mock.module('@/core/idempotency-store', {
	namedExports: { claimResponseSlot: async () => true, getCachedResponse: async () => null },
});
mock.module('@/core/infra/observability', { namedExports: { logApiError: () => undefined } });
mock.module('@/core/notifications/notification-dispatch', {
	namedExports: { dispatchNotificationSafely: async () => ({ warning: null }) },
});
mock.module('@/core/utils/money', { namedExports: { formatEuroCents: () => '12,00 €' } });
mock.module('@/features/expenses/server/expense-payments', {
	namedExports: {
		hasCapturingExpensePayment: async () => false,
		withExpensePaymentLock: async (_id: string, operation: (tx: unknown) => unknown) =>
			operation(current.tx),
	},
});
mock.module('@/features/expenses/split-math', {
	namedExports: { settledAtForOwnShare: () => null },
});
mock.module('drizzle-orm', {
	namedExports: {
		and: (...conditions: unknown[]) => conditions,
		eq: (field: unknown, value: unknown) => ({ field, value }),
		inArray: (field: unknown, values: unknown) => ({ field, values }),
		isNull: (field: unknown) => ({ field, isNull: true }),
		sql: (parts: unknown, ...values: unknown[]) => ({ parts, values }),
	},
});

const { commitImport } = await import('./import-commit');

type ExistingExpense = Record<string, unknown>;
type Row = Record<string, unknown>;

function runCommit(
	existingExpenses: ExistingExpense[],
	{
		rows,
		mapping,
		mayRecordForOthers = false,
	}: {
		rows?: ParsedExpense[];
		mapping?: Record<string, string>;
		mayRecordForOthers?: boolean;
	} = {},
) {
	const state = { inserted: [] as Row[], splits: [] as unknown[] };
	const tx = {
		select(fields: Record<string, unknown>) {
			let table: unknown;
			const query = {
				from(selectedTable: unknown) {
					table = selectedTable;
					return query;
				},
				where: async () => {
					assert.equal(table, expenses);
					return existingExpenses.map((row) =>
						Object.fromEntries(
							Object.entries(fields).map(([key, field]) => [
								key,
								Object.values(expenseFields).includes(field as string) ? row[key] : undefined,
							]),
						),
					);
				},
			};
			return query;
		},
		insert(table: unknown) {
			return {
				values(value: Row & Row[]) {
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
		update(table: unknown) {
			assert.equal(table, expenseImports);
			return { set: () => ({ where: async () => [] }) };
		},
	};
	const db = {
		select: () => ({
			from: (table: unknown) => {
				assert.equal(table, wgMembers);
				return {
					where: async () => Object.values(mapping ?? { Alice: memberId }).map((id) => ({ id })),
				};
			},
		}),
	};
	current = { db, tx };
	return {
		state,
		commit: async () => {
			const input = {
				wg: { id: wgId, name: 'WG', shareCode: 'MTE8PZAT' },
				source: 'manual' as const,
				importedByMemberId: memberId,
				importedByName: 'Alice',
				mayRecordForOthers,
				expenses: (
					rows ?? [
						{
							date: '2025-01-15',
							description: 'Dinner',
							amountCents: 1200,
							currency: 'EUR',
							paidByName: 'Alice',
							splits: [{ memberName: 'Alice', amountCents: 1200 }],
							warnings: [],
						},
					]
				).map((parsed) => ({ skip: false, parsed })),
				mapping: mapping ?? { Alice: memberId },
				skipDuplicates: true,
				rawPayloadHash: 'payload-hash',
			};
			const outcome = await commitImport({ scope: 'import-commit', key: null }, async () => ({
				input,
			}));
			assert.ok(outcome.kind !== 'stopped');
			return outcome.result;
		},
	};
}

test('duplicate checks distinguish currencies and keep the legacy EUR import key', async () => {
	const existing = (currency: string) => ({
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
		differentCurrency.state.inserted[0]?.importDuplicateKey,
		'2025-01-15|dinner|1200|33333333-3333-4333-8333-333333333333',
	);

	const sameCurrency = runCommit([existing('EUR')]);
	const skipped = await sameCurrency.commit();
	assert.deepEqual([skipped.inserted, skipped.skipped], [0, 1]);
});

const foreignRow: ParsedExpense = {
	date: '2025-02-01',
	description: 'Strom',
	amountCents: 5000,
	currency: 'EUR',
	paidByName: 'Bob',
	splits: [{ memberName: 'Charlie', amountCents: 5000 }],
	warnings: [],
};
const threeMembers = { Alice: memberId, Bob: bobId, Charlie: charlieId };

test('a regular member cannot import a debt between two other members', async () => {
	const run = runCommit([], { rows: [foreignRow], mapping: threeMembers });
	const result = await run.commit();
	assert.equal(result.inserted, 0);
	assert.deepEqual(result.errors, [{ index: 0, reason: 'paid_by_must_include_caller' }]);
	assert.equal(run.state.inserted.length, 0);
});

test('a WG admin may import a shared history that includes other members', async () => {
	const run = runCommit([], {
		rows: [foreignRow],
		mapping: threeMembers,
		mayRecordForOthers: true,
	});
	const result = await run.commit();
	assert.equal(result.inserted, 1);
	assert.deepEqual(result.errors, []);
});
