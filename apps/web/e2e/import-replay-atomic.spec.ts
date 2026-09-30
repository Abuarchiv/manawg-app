import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

type CommitResult = {
	importId: string;
	inserted: number;
	skipped: number;
	errors: Array<{ index: number; reason: string }>;
	warning: null | 'notification_delivery_failed' | 'notification_delivery_unknown';
};

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const importCommitPath = path.join(process.cwd(), 'src/features/expenses/import-commit.ts');
const expenseImports = { id: 'expense-import-id' };
const idempotencyResponses = { scope: 'scope', key: 'key', responseBody: 'response-body' };

function loadCommitImport(overrides: Record<string, unknown>) {
	const source = transpileModule(readFileSync(importCommitPath, 'utf8'), {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} as { commitImport: (input: unknown) => Promise<CommitResult> } };
	new Function('require', 'module', 'exports', source)(
		(name: string) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return module.exports.commitImport;
}

function harness(initialSlot: unknown) {
	const state = {
		slot: initialSlot,
		imports: 0,
		notices: 0,
		audits: 0,
		dispatches: 0,
		capturing: false,
		failReplayWrite: false,
	};
	let prior = Promise.resolve();
	const withExpensePaymentLock = async (
		_wgId: string,
		operation: (tx: unknown) => Promise<unknown>,
	) => {
		const waitFor = prior;
		let release = () => undefined;
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
							for: async () => (slotDraft === undefined ? [] : [{ body: slotDraft }]),
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
	const commitImport = loadCommitImport({
		'@/core/activity-feed': { postSystemNotice: async () => state.notices++ },
		'@/core/audit': { recordAuditEvent: async () => state.audits++ },
		'@/core/db': {
			db: {},
			expenseImports,
			expenseSplits: {},
			expenses: {},
			idempotencyResponses,
			wgMembers: {},
		},
		'@/core/idempotency': { RESPONSE_REPLAY_TTL_SECONDS: 7 * 24 * 60 * 60 },
		'@/core/notifications/notification-dispatch': {
			dispatchNotificationSafely: async () => {
				state.dispatches += 1;
				return { warning: 'notification_delivery_failed' };
			},
		},
		'@/core/utils/money': { formatEuroCents: () => '0,00 €' },
		'@/features/expenses/expense-payments': {
			hasCapturingExpensePayment: async () => state.capturing,
			withExpensePaymentLock,
		},
		'@/features/expenses/split-math': { settledAtForOwnShare: () => null },
		'drizzle-orm': {
			and: (...parts: unknown[]) => parts,
			eq: (...parts: unknown[]) => parts,
			inArray: (...parts: unknown[]) => parts,
			isNull: (part: unknown) => part,
			sql: () => null,
		},
	});
	return { state, commitImport };
}

function input(count = 1, skip = true) {
	return {
		wg: { id: 'wg', name: 'WG', shareCode: 'MTE8PZAT' },
		source: 'splitwise_csv',
		importedByMemberId: 'member',
		importedByName: 'Member',
		expenses: Array.from({ length: count }, () => ({
			parsed: {
				date: '2026-09-01T00:00:00.000Z',
				description: 'Expense',
				amountCents: 100,
				currency: 'EUR',
				paidByName: 'Unknown',
				splits: [],
				warnings: [],
			},
			skip,
		})),
		mapping: {},
		skipDuplicates: false,
		rawPayloadHash: 'hash',
		replay: { scope: 'import-commit:wg:member', key: 'key' },
	};
}

test('import waits for PayPal capture without writing an expense', async () => {
	const { state, commitImport } = harness({ _claimed: true });
	state.capturing = true;
	await expect(commitImport(input())).rejects.toThrow('paypal_payment_pending');
	expect(state.imports).toBe(0);
	expect(state.slot).toEqual({ _claimed: true });
});

test('lost response and notification failure replay the one committed import', async () => {
	const { state, commitImport } = harness({ _claimed: true });
	const first = await commitImport(input());
	const replay = await commitImport(input());
	expect(first.warning).toBe('notification_delivery_failed');
	expect(replay).toEqual({ ...first, warning: null });
	expect(state.imports).toBe(1);
	expect([state.notices, state.audits, state.dispatches]).toEqual([1, 1, 1]);
});

test('a concurrent retry after claim lease reclaim inserts only once', async () => {
	const { state, commitImport } = harness({ _claimed: true });
	const results = await Promise.all([commitImport(input()), commitImport(input())]);
	expect(results[0]?.importId).toBe(results[1]?.importId);
	expect(state.imports).toBe(1);
	expect(state.dispatches).toBe(1);
});

test('failed replay write rolls back import and allows a safe retry', async () => {
	const { state, commitImport } = harness({ _claimed: true });
	state.failReplayWrite = true;
	await expect(commitImport(input())).rejects.toThrow('cache_write_failed');
	expect(state.imports).toBe(0);
	expect(state.slot).toEqual({ _claimed: true });
	state.failReplayWrite = false;
	await commitImport(input());
	expect(state.imports).toBe(1);
});

test('claim cleanup before the transaction fails closed', async () => {
	const { state, commitImport } = harness(undefined);
	await expect(commitImport(input())).rejects.toThrow('idempotency_claim_missing');
	expect(state.imports).toBe(0);
});

test('null, malformed, and unavailable claims fail closed before writing', async () => {
	for (const slot of [null, { _replayUnavailable: true }, {}, { _claimed: true, extra: 1 }]) {
		const { state, commitImport } = harness(slot);
		await expect(commitImport(input())).rejects.toThrow(/idempotency_claim_(missing|invalid)/);
		expect(state.imports).toBe(0);
	}
});

test('a large replay result remains available without a post-commit cache update', async () => {
	const { state, commitImport } = harness({ _claimed: true });
	const body = input(1_500, false);
	const first = await commitImport(body);
	expect(JSON.stringify(first).length).toBeGreaterThan(32 * 1024);
	expect(await commitImport(body)).toEqual({ ...first, warning: null });
	expect(state.imports).toBe(1);
});
