import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const ids = Array.from(
	{ length: 32 },
	(_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
);
const [wgId, payerId, debtorId, thirdId] = ids as [string, string, string, string];
const eid = (n: number) => ids[n + 4] as string;

const expensesTable = {
	id: 'expenses.id',
	wgId: 'expenses.wg_id',
	description: 'expenses.description',
	paidByMemberId: 'expenses.paid_by_member_id',
	currency: 'expenses.currency',
};
const splitsTable = {
	id: 'expense_splits.id',
	expenseId: 'expense_splits.expense_id',
	debtorMemberId: 'expense_splits.debtor_member_id',
	amountCents: 'expense_splits.amount_cents',
	settledAt: 'expense_splits.settled_at',
};
const membersTable = {
	id: 'wg_members.id',
	wgId: 'wg_members.wg_id',
	name: 'wg_members.name',
	color: 'wg_members.color',
};

interface SplitEntry {
	id: string;
	expenseId: string;
	debtorMemberId: string;
	amountCents: number;
	settledAt: Date | null;
}
interface ExpenseEntry {
	id: string;
	wgId: string;
	description: string;
	paidByMemberId: string;
	currency: string;
	splits: SplitEntry[];
}
interface Payment {
	fromMemberId: string;
	toMemberId: string;
	amountCents: number;
	currency: string;
}

function entry(
	expenseId: string,
	splitId: string,
	paidByMemberId: string,
	debtorMemberId: string,
	amountCents: number,
	currency = 'EUR',
	settledAt: Date | null = null,
): ExpenseEntry {
	return {
		id: expenseId,
		wgId,
		description: `Expense ${expenseId}`,
		paidByMemberId,
		currency,
		splits: [{ id: splitId, expenseId, debtorMemberId, amountCents, settledAt }],
	};
}

// Per-request scenario the fake database reads at call time.
const state = {
	expenses: [] as ExpenseEntry[],
	payments: [] as Payment[],
	currentMemberId: debtorId,
	target: null as unknown as ExpenseEntry,
	audits: [] as { eventType: string }[],
	updates: [] as Record<string, unknown>[],
	lockActive: false,
};

function rowsFor(table: unknown, join: unknown): unknown[] {
	const target = state.target;
	const targetSplit = target.splits[0] as SplitEntry;
	if (table === expensesTable && join === splitsTable) {
		assert.equal(
			state.lockActive,
			true,
			'the global balance snapshot must be read under the payment lock',
		);
		return state.expenses.flatMap((expense) =>
			expense.splits.map((split) => ({
				expenseId: expense.id,
				paidByMemberId: expense.paidByMemberId,
				currency: expense.currency,
				description: expense.description,
				splitId: split.id,
				debtorMemberId: split.debtorMemberId,
				amountCents: split.amountCents,
				settledAt: split.settledAt,
			})),
		);
	}
	if (table === expensesTable) return state.expenses.filter((expense) => expense.id === target.id);
	if (table === splitsTable) return target.splits.filter((split) => split.id === targetSplit.id);
	if (table === membersTable) {
		const memberIds = new Set(
			state.expenses.flatMap((expense) => [
				expense.paidByMemberId,
				...expense.splits.map((split) => split.debtorMemberId),
			]),
		);
		return [...memberIds].map((id) => ({ id, wgId, name: id, color: null }));
	}
	throw new Error(`Unexpected select table: ${String(table)}`);
}

const db = {
	select() {
		let table: unknown;
		let join: unknown;
		const query = {
			from(value: unknown) {
				table = value;
				return query;
			},
			innerJoin(value: unknown) {
				join = value;
				return query;
			},
			where() {
				const rows = rowsFor(table, join);
				return Object.assign(Promise.resolve(rows), {
					limit: (count: number) => Promise.resolve(rows.slice(0, count)),
				});
			},
		};
		return query;
	},
	update(table: unknown) {
		assert.equal(table, splitsTable);
		return {
			set(values: Record<string, unknown>) {
				state.updates.push(values);
				return {
					where() {
						return {
							returning: async () => {
								const split = state.target.splits[0] as SplitEntry;
								Object.assign(split, values);
								return [{ ...split }];
							},
						};
					},
				};
			},
		};
	},
};

mock.module('@/core/audit', {
	namedExports: {
		recordAuditEvent: async (event: { eventType: string }) => state.audits.push(event),
	},
});
mock.module('@/core/db', {
	namedExports: {
		db,
		expenses: expensesTable,
		expenseSplits: splitsTable,
		wgMembers: membersTable,
	},
});
mock.module('@/core/infra/observability', {
	namedExports: { captureException: () => undefined, logApiError: () => undefined },
});
mock.module('@/core/guards/api-auth', { namedExports: { UUID_PATTERN: /^[0-9a-f-]{36}$/i } });
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: wgId },
			member: { memberId: state.currentMemberId, name: 'Member' },
		}),
	},
});
mock.module('@/core/rate-limit', {
	namedExports: { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
});
mock.module('@/features/expenses/server/settle-notify', {
	namedExports: { notifySettlement: async () => undefined },
});
mock.module('@/features/expenses/server/expense-payments', {
	namedExports: {
		hasCapturingExpensePayment: async () => false,
		loadCompletedExpensePayments: async () => state.payments,
		withExpensePaymentLock: async (_wgId: string, run: (tx: unknown) => unknown) => {
			state.lockActive = true;
			try {
				return await run(db);
			} finally {
				state.lockActive = false;
			}
		},
	},
});
mock.module('drizzle-orm', {
	namedExports: {
		and: (...conditions: unknown[]) => conditions,
		eq: (column: unknown, value: unknown) => ({ column, value }),
		isNotNull: (column: unknown) => ({ op: 'not-null', column }),
		isNull: (column: unknown) => ({ op: 'null', column }),
	},
});

const { POST } = await import('./route');

async function post({
	expenses,
	payments = [],
	currentMemberId = debtorId,
	settled = true,
	rawBody,
	target = expenses[0] as ExpenseEntry,
}: {
	expenses: ExpenseEntry[];
	payments?: Payment[];
	currentMemberId?: string;
	settled?: boolean;
	rawBody?: string;
	target?: ExpenseEntry;
}) {
	Object.assign(state, {
		expenses,
		payments,
		currentMemberId,
		target,
		audits: [],
		updates: [],
		lockActive: false,
	});
	const split = target.splits[0] as SplitEntry;
	const response = await POST(
		new Request('https://example.invalid/settle', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: rawBody ?? JSON.stringify({ settled }),
		}) as never,
		{ params: Promise.resolve({ code: 'MTE8PZAT', id: target.id, splitId: split.id }) } as never,
	);
	return { response, state, split };
}

test('refuses to mark a split settled when a completed payment already covers it', async () => {
	const target = entry(eid(0), eid(1), payerId, debtorId, 1200);
	const result = await post({
		expenses: [target],
		payments: [{ fromMemberId: debtorId, toMemberId: payerId, amountCents: 1200, currency: 'EUR' }],
		target,
	});

	assert.equal(result.response.status, 409);
	assert.deepEqual(await result.response.json(), { error: 'split_already_offset' });
	assert.equal(result.split.settledAt, null);
	assert.equal(result.state.updates.length, 0);
	assert.equal(result.state.audits.length, 0);
});

test('uses all members and blocks a split whose settlement would reverse a network balance', async () => {
	const target = entry(eid(0), eid(1), payerId, debtorId, 1000);
	const expenses = [
		target,
		entry(eid(2), eid(3), thirdId, payerId, 1000),
		entry(eid(4), eid(5), debtorId, thirdId, 1000),
		entry(eid(6), eid(7), thirdId, debtorId, 1000),
	];
	const result = await post({
		expenses,
		payments: [{ fromMemberId: debtorId, toMemberId: thirdId, amountCents: 1000, currency: 'EUR' }],
		target,
	});

	assert.equal(result.response.status, 409);
	assert.equal(result.split.settledAt, null);
	assert.equal(result.state.updates.length, 0);
});

test('requires the payer to still have enough creditor balance for the whole split', async () => {
	const target = entry(eid(14), eid(15), payerId, debtorId, 1000);
	const expenses = [target, entry(eid(16), eid(17), thirdId, payerId, 500)];
	const result = await post({ expenses, target });

	assert.equal(result.response.status, 409);
	assert.equal(result.state.updates.length, 0);
});

test('refuses to record the whole split when a completed payment only partly offsets it', async () => {
	const target = entry(eid(8), eid(9), payerId, debtorId, 1000);
	const result = await post({
		expenses: [target],
		payments: [{ fromMemberId: debtorId, toMemberId: payerId, amountCents: 600, currency: 'EUR' }],
		target,
	});

	assert.equal(result.response.status, 409);
	assert.equal(result.state.updates.length, 0);
});

test('allows settling an uncredited expense while debtor and payer residuals cover it', async () => {
	const target = entry(eid(10), eid(11), payerId, debtorId, 1000, 'EUR');
	const result = await post({ expenses: [target], target });

	assert.equal(result.response.status, 200);
	assert.ok(result.split.settledAt);
	assert.equal(result.state.audits[0]?.eventType, 'expense.split.settled');
});

test('keeps residual balances independent by currency', async () => {
	const target = entry(eid(18), eid(19), payerId, debtorId, 1000, 'EUR');
	const result = await post({
		expenses: [target],
		payments: [{ fromMemberId: debtorId, toMemberId: payerId, amountCents: 1000, currency: 'USD' }],
		target,
	});

	assert.equal(result.response.status, 200);
	assert.ok(result.split.settledAt);
});

test('allows reopening a manually settled split even when no residual debt remains', async () => {
	const target = entry(
		eid(12),
		eid(13),
		payerId,
		debtorId,
		1000,
		'EUR',
		new Date('2026-09-01T00:00:00.000Z'),
	);
	const result = await post({ expenses: [target], settled: false, target });

	assert.equal(result.response.status, 200);
	assert.equal(result.split.settledAt, null);
	assert.equal(result.state.audits[0]?.eventType, 'expense.split.reopened');
});

test('rejects a JSON null body with 400 instead of a 500', async () => {
	const target = entry(eid(0), eid(1), payerId, debtorId, 1200);
	const result = await post({ expenses: [target], target, rawBody: 'null' });

	assert.equal(result.response.status, 400);
	assert.deepEqual(await result.response.json(), { error: 'invalid_body' });
	assert.equal(result.state.updates.length, 0);
});
