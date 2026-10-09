import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
	CALLER_ID,
	WG_ID,
	installWgRouteMocks,
	jsonRequest,
	routeContext,
	tables,
} from './support/expense-route-fakes.ts';

// Import commit route and helper [suite "expense integrity regressions"]:
// rows the user skipped never take part in member-mapping validation.

const env = installWgRouteMocks();
mock.module('@/core/notifications/notification-dispatch', {
	namedExports: { dispatchNotificationSafely: async () => ({ warning: null }) },
});
mock.module('@/core/idempotency-store', {
	namedExports: {
		claimResponseSlot: async () => new Date(),
		getCachedResponse: async () => null,
		readIdempotencyKey: () => null,
		setReplayWarning: async () => undefined,
	},
});

const parsedExpense = {
	date: '2026-09-01T00:00:00.000Z',
	description: 'Alte Ausgabe',
	amountCents: 500,
	currency: 'EUR' as const,
	paidByName: 'Ausgetretene Person',
	splits: [{ memberName: 'Ausgetretene Person', amountCents: 500 }],
	warnings: [],
};
const parsers = await import('../src/features/expenses/import-parsers.ts');
mock.module('@/features/expenses/import-parsers', {
	namedExports: {
		...parsers,
		parseSplitwiseCsv: () => [parsedExpense],
		parseSplidCsv: () => [parsedExpense],
	},
});
const { commitImport } = await import('../src/features/expenses/server/import-commit.ts');
const { hashPayload } = await import('../src/features/expenses/server/import-hash.ts');
let committed: Record<string, unknown> | undefined;
mock.module('@/features/expenses/server/import-commit', {
	namedExports: {
		commitImport: async (
			_replay: unknown,
			prepare: () => Promise<{ stop: Response } | { input: Record<string, unknown> }>,
		) => {
			const prepared = await prepare();
			if ('stop' in prepared) return { kind: 'stopped', response: prepared.stop };
			committed = prepared.input;
			return {
				kind: 'committed',
				result: { importId: 'import-1', inserted: 0, skipped: 1, errors: [], warning: null },
			};
		},
	},
});
const { POST } = await import('../src/app/api/wg/[code]/imports/commit/route.ts');

test('import route ignores mapping conflicts on skipped rows', async () => {
	const payload = 'ignored row';
	const response = await POST(
		jsonRequest('POST', {
			source: 'splitwise_csv',
			payload,
			memberMapping: {},
			previewPayloadHash: hashPayload(payload),
			skipIndexes: [0],
		}),
		routeContext(),
	);

	assert.equal(response.status, 200);
	assert.deepEqual(committed?.expenses, [{ parsed: parsedExpense, skip: true }]);
});

test('import helper does not validate member mappings for skipped rows', async () => {
	let memberLookups = 0;
	const tx = {
		insert: (table: unknown) => ({
			values: () => ({
				returning: async () => (table === tables.expenseImports ? [{ id: 'import-1' }] : []),
			}),
		}),
		update: () => ({ set: () => ({ where: async () => undefined }) }),
	};
	env.db = {
		select: () => {
			memberLookups += 1;
			return { from: () => ({ where: async () => [] }) };
		},
	} as never;
	env.payments = {
		...env.payments,
		withExpensePaymentLock: async (
			_wgId: string,
			operation: (value: typeof tx) => Promise<unknown>,
		) => operation(tx),
	};
	const foreignMemberId = '24ba761e-a429-45c3-a311-18e9a44b9be8';
	const outcome = await commitImport({ scope: 'import', key: null }, async () => ({
		input: {
			wg: { id: WG_ID, name: 'WG', shareCode: 'MTE8PZAT' },
			source: 'splitwise_csv',
			importedByMemberId: CALLER_ID,
			importedByName: 'Mina',
			mayRecordForOthers: false,
			expenses: [{ parsed: parsedExpense, skip: true }],
			mapping: { 'Ausgetretene Person': foreignMemberId },
			skipDuplicates: false,
			rawPayloadHash: 'hash',
		},
	}));

	assert.equal((outcome as unknown as { result: { skipped: number } }).result.skipped, 1);
	assert.equal(memberLookups, 0);
});
