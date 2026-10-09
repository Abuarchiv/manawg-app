import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TransactionAbort } from '../src/core/db/transaction-abort.ts';

// Import commit replay safety: a retried import must not double-book expenses. The real
// commitImport, idempotent-write and claim helpers run against an in-memory claim slot; the
// transaction snapshots the slot and restores it on throw.

type CommitResult = {
	importId: string;
	inserted: number;
	skipped: number;
	errors: Array<{ index: number; reason: string }>;
	warning: null | 'notification_delivery_failed' | 'notification_delivery_unknown';
};

const expenseImports = { id: 'expense-import-id' };
const idempotencyResponses = {
	scope: 'scope',
	key: 'key',
	responseBody: 'response-body',
	expiresAt: 'expires-at',
};

function createState(initialSlot: unknown) {
	return {
		slot: initialSlot,
		claimExpiresAt: new Date(Date.now() + 15 * 60_000),
		imports: 0,
		audits: 0,
		dispatches: 0,
		capturing: false,
		failReplayWrite: false,
	};
}

let state = createState(undefined);
let prior: Promise<void> = Promise.resolve();

const withExpensePaymentLock = async (
	_wgId: string,
	operation: (tx: unknown) => Promise<unknown>,
) => {
	const waitFor = prior;
	let release: () => void = () => undefined;
	prior = new Promise<void>((resolve) => {
		release = resolve;
	});
	await waitFor;
	let slotDraft = state.slot;
	let importsDraft = 0;
	const tx = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => ({
						for: async () =>
							slotDraft === undefined ? [] : [{ body: slotDraft, expiresAt: state.claimExpiresAt }],
					}),
				}),
			}),
		}),
		insert: (table: unknown) => ({
			values: () => ({
				returning: async () => {
					if (table !== expenseImports) throw new Error('unexpected insert');
					importsDraft += 1;
					return [{ id: 'import-1' }];
				},
			}),
		}),
		update: (table: unknown) => ({
			set: (value: { responseBody?: unknown }) => ({
				where: () => ({
					returning: async () => {
						if (table !== idempotencyResponses) throw new Error('unexpected replay update');
						if (state.failReplayWrite) throw new Error('cache_write_failed');
						slotDraft = value.responseBody;
						return [{ scope: 'import-commit:wg:member' }];
					},
				}),
			}),
		}),
	};
	try {
		const result = await operation(tx);
		state.slot = slotDraft;
		state.imports += importsDraft;
		return result;
	} finally {
		release();
	}
};

mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => state.audits++ } });
mock.module('@/core/db', {
	namedExports: {
		db: {},
		expenseImports,
		expenseSplits: {},
		expenses: {},
		idempotencyResponses,
		wgMembers: {},
	},
});
mock.module('@/core/db/transaction', {
	namedExports: {
		TransactionAbort,
		withTransaction: async () => {
			throw new Error('the import opens its own locked transaction');
		},
	},
});
mock.module('@/core/idempotency-store', {
	namedExports: {
		claimResponseSlot: async () => true,
		getCachedResponse: async () => null,
	},
});
mock.module('@/core/infra/observability', { namedExports: { logApiError: () => undefined } });
mock.module('@/core/notifications/notification-dispatch', {
	namedExports: {
		dispatchNotificationSafely: async () => {
			state.dispatches += 1;
			return { warning: 'notification_delivery_failed' };
		},
	},
});
mock.module('@/core/utils/money', { namedExports: { formatEuroCents: () => '0,00 €' } });
mock.module('@/features/expenses/server/expense-payments', {
	namedExports: {
		hasCapturingExpensePayment: async () => state.capturing,
		withExpensePaymentLock,
	},
});
mock.module('@/features/expenses/split-math', {
	namedExports: { settledAtForOwnShare: () => null },
});
mock.module('@/features/expenses/paid-by-guard', {
	namedExports: { checkPaidByGuard: () => ({ ok: true }) },
});
mock.module('drizzle-orm', {
	namedExports: {
		and: (...parts: unknown[]) => parts,
		eq: (...parts: unknown[]) => parts,
		inArray: (...parts: unknown[]) => parts,
		isNull: (part: unknown) => part,
		sql: () => null,
	},
});

const { commitImport: commit } = await import('../src/features/expenses/server/import-commit.ts');

function input(count = 1, skip = true) {
	return {
		wg: { id: 'wg', name: 'WG', shareCode: 'MTE8PZAT' },
		source: 'splitwise_csv' as const,
		importedByMemberId: 'member',
		importedByName: 'Member',
		mayRecordForOthers: false,
		expenses: Array.from({ length: count }, () => ({
			parsed: {
				date: '2026-09-01T00:00:00.000Z',
				description: 'Expense',
				amountCents: 100,
				currency: 'EUR' as const,
				paidByName: 'Unknown',
				splits: [],
				warnings: [],
			},
			skip,
		})),
		mapping: {},
		skipDuplicates: false,
		rawPayloadHash: 'hash',
	};
}

const replay = { scope: 'import-commit:wg:member', key: 'key' };

/** Starts a fresh scenario with the given claim slot. */
function harness(initialSlot: unknown) {
	state = createState(initialSlot);
	prior = Promise.resolve();
	const commitImport = async (body: ReturnType<typeof input>): Promise<CommitResult> => {
		const outcome = await commit(replay, async () => ({ input: body }));
		if (outcome.kind === 'stopped') throw new Error('unexpected stop');
		return outcome.result;
	};
	return { state, commitImport };
}

test('import waits for PayPal capture without writing an expense', async () => {
	const { state, commitImport } = harness({ _claimed: true });
	state.capturing = true;
	await assert.rejects(commitImport(input()), /paypal_payment_pending/);
	assert.equal(state.imports, 0);
	assert.deepEqual(state.slot, { _claimed: true });
});

test('lost response and notification failure replay the one committed import', async () => {
	const { state, commitImport } = harness({ _claimed: true });
	const first = await commitImport(input());
	const replayed = await commitImport(input());
	assert.equal(first.warning, 'notification_delivery_failed');
	assert.deepEqual(replayed, { ...first, warning: null });
	assert.equal(state.imports, 1);
	assert.deepEqual([state.audits, state.dispatches], [1, 1]);
});

test('a concurrent retry after claim lease reclaim inserts only once', async () => {
	const { state, commitImport } = harness({ _claimed: true });
	const results = await Promise.all([commitImport(input()), commitImport(input())]);
	assert.equal(results[0]?.importId, results[1]?.importId);
	assert.equal(state.imports, 1);
	assert.equal(state.dispatches, 1);
});

test('failed replay write rolls back import and allows a safe retry', async () => {
	const { state, commitImport } = harness({ _claimed: true });
	state.failReplayWrite = true;
	await assert.rejects(commitImport(input()), /cache_write_failed/);
	assert.equal(state.imports, 0);
	assert.deepEqual(state.slot, { _claimed: true });
	state.failReplayWrite = false;
	await commitImport(input());
	assert.equal(state.imports, 1);
});

test('claim cleanup before the transaction fails closed', async () => {
	const { state, commitImport } = harness(undefined);
	await assert.rejects(commitImport(input()), /idempotency_claim_missing/);
	assert.equal(state.imports, 0);
});

test('null, malformed, and unavailable claims fail closed before writing', async () => {
	for (const slot of [null, { _replayUnavailable: true }, {}, { _claimed: true, extra: 1 }]) {
		const { state, commitImport } = harness(slot);
		await assert.rejects(commitImport(input()), /idempotency_claim_(missing|invalid)/);
		assert.equal(state.imports, 0);
	}
});

test('a large replay result remains available without a post-commit cache update', async () => {
	const { state, commitImport } = harness({ _claimed: true });
	const body = input(1_500, false);
	const first = await commitImport(body);
	assert.ok(JSON.stringify(first).length > 32 * 1024);
	assert.deepEqual(await commitImport(body), { ...first, warning: null });
	assert.equal(state.imports, 1);
});
