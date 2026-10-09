import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TransactionAbort } from '@/core/db/transaction-abort';
import { PgDialect, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { z } from 'zod';

// biome-ignore lint/suspicious/noExplicitAny: loose row shapes for the in-memory database fakes
type Loose = any;

const schema = await import('@/core/db/schema');

const wgId = '11111111-1111-4111-8111-111111111111';
const foreignWgId = '99999999-9999-4999-8999-999999999999';
const recurringExpenseId = '22222222-2222-4222-8222-222222222222';
const firstMemberId = '33333333-3333-4333-8333-333333333333';
const secondMemberId = '44444444-4444-4444-8444-444444444444';
const dueAt = '2026-10-01T00:00:00.000Z';

const expenses = pgTable('expenses', {
	id: uuid('id'),
	wgId: uuid('wg_id'),
	paidByMemberId: uuid('paid_by_member_id'),
	amountCents: integer('amount_cents'),
	currency: text('currency'),
	description: text('description'),
	imageUrl: text('image_url'),
	occurredAt: timestamp('occurred_at', { withTimezone: true }),
	recurringExpenseId: uuid('recurring_expense_id'),
	recurringDueAt: timestamp('recurring_due_at', { withTimezone: true }),
});
const expenseSplits = pgTable('expense_splits', {
	id: uuid('id'),
	expenseId: uuid('expense_id'),
	debtorMemberId: uuid('debtor_member_id'),
	amountCents: integer('amount_cents'),
	settledAt: timestamp('settled_at', { withTimezone: true }),
});
const idempotencyResponses = pgTable('idempotency_responses', {
	scope: text('scope'),
	key: text('key'),
	responseBody: jsonb('response_body'),
	expiresAt: timestamp('expires_at', { withTimezone: true }),
});
const recurringExpenses = pgTable('recurring_expenses', {
	id: uuid('id'),
	wgId: uuid('wg_id'),
	nextDueAt: timestamp('next_due_at', { withTimezone: true }),
	pausedAt: timestamp('paused_at', { withTimezone: true }),
});
const wgMembers = pgTable('wg_members', {
	id: uuid('id'),
	wgId: uuid('wg_id'),
	deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
});
const expensesReadLimiter = { name: 'expenses-read' };

function defaultBody(overrides: Loose = {}) {
	return {
		paidByMemberId: firstMemberId,
		amountCents: 100,
		currency: 'EUR',
		description: 'Rent',
		imageUrl: null,
		occurredAt: dueAt,
		splits: [
			{ debtorMemberId: firstMemberId, amountCents: 50 },
			{ debtorMemberId: secondMemberId, amountCents: 50 },
		],
		recurringExpenseId,
		expectedRecurringNextDueAt: dueAt,
		...overrides,
	};
}

function freshState(templateWgId: string, templateDueAt: string, pausedAt: Date | null) {
	return {
		capturing: false,
		memberId: firstMemberId,
		body: defaultBody() as Loose,
		template: {
			id: recurringExpenseId,
			wgId: templateWgId,
			nextDueAt: new Date(templateDueAt),
			pausedAt,
		} as Loose,
		members: [
			{ id: firstMemberId, wgId },
			{ id: secondMemberId, wgId },
		] as Loose[],
		expenses: [] as Loose[],
		splits: [] as Loose[],
		idempotency: new Map<string, Loose>(),
		idempotencyClaims: [] as Loose[],
		currentClaimId: null as string | null,
		templateLocks: 0,
		expenseInsertAttempts: 0,
		sideEffects: 0,
		errors: [] as string[],
		rejectImageAttachment: false,
		failCommit: false,
		reclaimOnRollback: false,
		trace: false,
		traceConstraint: null as string | null,
		traceWinner: null as Loose,
	};
}

// The fakes read the current state at call time; each harness installs a fresh one.
let state = freshState(wgId, dueAt, null);
// Set by the list harness; the create harness leaves it null.
let listMode: {
	readLimited: boolean;
	rows: Loose[];
	splitRows: Loose[];
	rateLimitKeys: string[];
	splitQueries: Loose[];
} | null = null;

const claimId = (scope: string, key: string) => `${scope}\u0000${key}`;

function selectRows(table: unknown, local: Loose): Loose[] {
	if (table === idempotencyResponses) {
		const row = local.idempotency.get(state.currentClaimId);
		return row ? [{ body: row.body, expiresAt: row.expiresAt }] : [];
	}
	if (table === wgMembers) {
		return state.members.filter((member) => member.wgId === wgId && !member.deactivatedAt);
	}
	if (table === expenses) {
		const existing = local.expenses.find(
			(expense: Loose) =>
				expense.wgId === wgId &&
				expense.recurringExpenseId === state.body.recurringExpenseId &&
				expense.recurringDueAt?.getTime() === Date.parse(state.body.expectedRecurringNextDueAt),
		);
		local.lastFoundExpense = existing ?? null;
		return existing ? [existing] : [];
	}
	if (table === expenseSplits) {
		return local.lastFoundExpense
			? local.splits.filter((split: Loose) => split.expenseId === local.lastFoundExpense.id)
			: [];
	}
	if (table === recurringExpenses) {
		return local.template?.id === state.body.recurringExpenseId && local.template.wgId === wgId
			? [local.template]
			: [];
	}
	return [];
}

function selectQuery(local: Loose, baseDb = false) {
	const query: Loose = {
		table: null,
		from(table: unknown) {
			this.table = table;
			return this;
		},
		where() {
			if (baseDb || this.table === expenseSplits) {
				return Promise.resolve(selectRows(this.table, local));
			}
			return this;
		},
		limit() {
			if (this.table === expenses) return Promise.resolve(selectRows(this.table, local));
			return this;
		},
		for() {
			if (this.table === recurringExpenses) state.templateLocks++;
			return Promise.resolve(selectRows(this.table, local));
		},
	};
	return query;
}

/** Expense list reads: expenses ordered, then the WG's splits joined to them. */
function listSelect(columns: unknown) {
	const mode = listMode as NonNullable<typeof listMode>;
	const query: Loose = {
		table: null,
		joined: null,
		from(table: unknown) {
			this.table = table;
			return this;
		},
		innerJoin(table: unknown) {
			this.joined = table;
			return this;
		},
		where(predicate: unknown) {
			if (this.table === expenseSplits) {
				mode.splitQueries.push({ columns, joined: this.joined, predicate });
				return Promise.resolve(mode.splitRows);
			}
			assert.equal(this.table, expenses);
			return this;
		},
		orderBy: async () => mode.rows,
	};
	return query;
}

const db = {
	select: (columns?: unknown) =>
		listMode
			? listSelect(columns)
			: selectQuery(
					{
						idempotency: state.idempotency,
						expenses: state.expenses,
						splits: state.splits,
						template: state.template,
					},
					true,
				),
	update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
	delete: (table: unknown) => ({
		where: (condition: Loose) => ({
			returning: async () => {
				assert.equal(table, idempotencyResponses);
				const [scope, key, lease] = new PgDialect().sqlToQuery(condition).params as string[];
				const row = state.idempotency.get(claimId(scope as string, key as string));
				if (
					JSON.stringify(row?.body) !== '{"_claimed":true}' ||
					row.expiresAt.getTime() !== Date.parse(lease as string)
				) {
					return [];
				}
				state.idempotency.delete(claimId(scope as string, key as string));
				return [{ scope }];
			},
		}),
	}),
};

const txFor = (local: Loose) => ({
	select: () => selectQuery(local),
	insert: (table: unknown) => ({
		values: (values: Loose) => ({
			returning: async () => {
				if (table === expenses) {
					state.expenseInsertAttempts++;
					if (state.traceConstraint && !state.trace) {
						state.trace = true;
						if (state.traceWinner) {
							state.expenses.push(state.traceWinner.expense);
							state.splits.push(...state.traceWinner.splits);
						}
						const error = new Error('duplicate key');
						error.cause = { code: '23505', constraint_name: state.traceConstraint };
						throw error;
					}
					const expense = {
						...values,
						id: '55555555-5555-4555-8555-555555555555',
						createdAt: new Date(),
						updatedAt: new Date(),
					};
					local.expenses.push(expense);
					return [expense];
				}
				assert.equal(table, expenseSplits);
				const splits = values.map((value: Loose, index: number) => ({
					...value,
					id: `66666666-6666-4666-8666-${String(index + 1).padStart(12, '0')}`,
				}));
				local.splits.push(...splits);
				return splits;
			},
		}),
	}),
	update: (table: unknown) => ({
		set: (values: Loose) => ({
			where: () => ({
				returning: async () => {
					assert.equal(table, idempotencyResponses);
					const claim = local.idempotency.get(state.currentClaimId);
					if (!claim || claim.body?._claimed !== true) return [];
					claim.body = values.responseBody;
					claim.expiresAt = values.expiresAt;
					return [{ scope: claim.scope }];
				},
			}),
		}),
	}),
	delete: (table: unknown) => ({
		where: () => {
			assert.equal(table, idempotencyResponses);
			return Promise.resolve(local.idempotency.delete(state.currentClaimId));
		},
	}),
});

mock.module('@/core/db', {
	namedExports: {
		...schema,
		db,
		expenseSplits,
		expenses,
		idempotencyResponses,
		recurringExpenses,
		wgMembers,
	},
});
mock.module('@/core/db/transaction', {
	namedExports: {
		TransactionAbort,
		withTransaction: async () => assert.fail('writes run through withExpensePaymentLock'),
	},
});
mock.module('@/core/activity-feed', {
	namedExports: {
		// Called once per created expense by recordExpenseCreatedSideEffects.
		postChatSystemMessage: async () => {
			state.sideEffects++;
		},
	},
});
mock.module('@/core/guards/api-auth', {
	namedExports: {
		isUuid: (value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
	},
});
mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => undefined } });
mock.module('@/core/notifications/notification-dispatch', {
	namedExports: { dispatchNotificationSafely: async () => ({ warning: null }) },
});
mock.module('@/core/db/private-image-deletions', {
	namedExports: {
		assertPrivateImageCanBeAttached: async () => {
			if (state.rejectImageAttachment) throw new TransactionAbort('image_removed');
		},
	},
});
mock.module('@/core/guards/replay-slot', {
	namedExports: {
		claimReplaySlot: async (scope: string, key: string) => {
			const id = claimId(scope, key);
			state.currentClaimId = id;
			state.idempotencyClaims.push({ scope, key, memberId: state.memberId });
			if (!state.idempotency.has(id)) {
				state.idempotency.set(id, {
					scope,
					key,
					body: { _claimed: true },
					expiresAt: new Date(Date.now() + 300_000),
				});
			}
			return { won: true };
		},
	},
});
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: wgId, name: 'WG', shareCode: 'MTE8PZAT' },
			member: {
				memberId: state.memberId,
				name: state.memberId === firstMemberId ? 'First' : 'Second',
			},
		}),
	},
});
mock.module('@/core/idempotency-store', {
	namedExports: {
		claimResponseSlot: async () => true,
		getCachedResponse: async (scope: string, key: string) => {
			const row = state.idempotency.get(claimId(scope, key));
			return row && !row.body?._claimed ? row.body : null;
		},
		readIdempotencyKey: (request: Request) => request.headers.get('Idempotency-Key'),
		setReplayWarning: async () => true,
	},
});
mock.module('@/core/infra/observability', {
	namedExports: {
		captureException: () => undefined,
		logApiError: (label: string, error: unknown) => state.errors.push(`${label}: ${error}`),
	},
});
mock.module('@/core/rate-limit', {
	namedExports: {
		checkRateLimit: async (limiter: unknown, key: string) => {
			if (limiter !== expensesReadLimiter) return { success: true };
			const mode = listMode as NonNullable<typeof listMode>;
			mode.rateLimitKeys.push(key);
			return { success: !mode.readLimited };
		},
		expensesReadLimiter,
		wgWriteLimiter: {},
	},
});
mock.module('@/core/validators/currency', { namedExports: { currencySchema: z.string() } });
mock.module('@/core/validators/image-url', {
	namedExports: {
		imageUrlSchema: z.string().nullable().optional(),
		isAllowedImageUrlForWg: () => true,
	},
});
mock.module('@/features/expenses/server/expense-payments', {
	namedExports: {
		hasCapturingExpensePayment: async () => state.capturing,
		loadCompletedExpensePayments: async () => [],
		withExpensePaymentLock: async (_id: string, operation: (tx: unknown) => Promise<unknown>) => {
			const local = {
				idempotency: new Map(
					[...state.idempotency].map(([key, value]) => [key, structuredClone(value)]),
				),
				expenses: structuredClone(state.expenses),
				splits: structuredClone(state.splits),
				template: structuredClone(state.template),
				lastFoundExpense: null,
			};
			let result: unknown;
			try {
				result = await operation(txFor(local));
			} catch (err) {
				if (state.reclaimOnRollback) {
					// Another request took the key over with a fresh lease meanwhile.
					for (const row of state.idempotency.values()) {
						row.expiresAt = new Date(row.expiresAt.getTime() + 60_000);
					}
				}
				throw err;
			}
			if (state.failCommit) throw new Error('commit_outcome_unknown');
			state.idempotency = local.idempotency;
			state.expenses = local.expenses;
			state.splits = local.splits;
			state.template = local.template;
			return result;
		},
	},
});
mock.module('@/features/expenses/server/recurring-booking', {
	namedExports: {
		advanceRecurringDue: async (_tx: unknown, template: Loose) => ({ ...template, advanced: true }),
		recordRecurringAdvanced: async () => undefined,
	},
});
mock.module('@/features/expenses/split-math', {
	namedExports: {
		settledAtForOwnShare: () => null,
		splitValidationErrorCode: (reason: string) => reason,
		validateSplits: (amount: number, splits: { amountCents: number }[]) =>
			splits.reduce((sum, split) => sum + split.amountCents, 0) === amount
				? { ok: true }
				: { ok: false, reason: 'splits_sum_mismatch' },
	},
});

const { GET, POST } = await import('./route');

function harness({
	templateWgId = wgId,
	templateDueAt = dueAt,
	pausedAt = null as Date | null,
} = {}) {
	listMode = null;
	state = freshState(templateWgId, templateDueAt, pausedAt);
	return {
		state,
		post: async ({ memberId = firstMemberId, key = 'create-1', body = defaultBody() } = {}) => {
			state.memberId = memberId;
			state.body = body;
			return POST(
				new Request('https://example.invalid/api/wg/MTE8PZAT/expenses', {
					method: 'POST',
					headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}) as never,
				{ params: Promise.resolve({ code: 'MTE8PZAT' }) } as never,
			);
		},
	};
}

test('different members and idempotency keys replay one recurring due after its template advances', async () => {
	const { state, post } = harness();
	const firstResponse = await post({ memberId: firstMemberId, key: 'first-member-key' });
	assert.equal(firstResponse.status, 200);
	const canonical = await firstResponse.json();

	state.template.nextDueAt = new Date('2026-11-01T00:00:00.000Z');
	const secondResponse = await post({ memberId: secondMemberId, key: 'second-member-key' });
	assert.equal(secondResponse.status, 200);
	assert.deepEqual(await secondResponse.json(), canonical);
	assert.equal(state.expenses.length, 1);
	assert.equal(state.splits.length, 2);
	assert.equal(state.expenses[0].recurringExpenseId, recurringExpenseId);
	assert.equal(state.expenses[0].recurringDueAt.toISOString(), dueAt);
	assert.equal(state.sideEffects, 1);
	assert.equal(state.templateLocks, 1, 'the existing due is checked before the advanced template');
	assert.deepEqual(
		state.idempotencyClaims.map(({ memberId, key }) => [memberId, key]),
		[
			[firstMemberId, 'first-member-key'],
			[secondMemberId, 'second-member-key'],
		],
	);
	assert.ok(
		[...state.idempotency.values()].every((row) => row.body.expense?.id === canonical.expense.id),
		'both durable claims resolve to the canonical expense',
	);
});

test('rejects a one-sided recurring reference', async () => {
	for (const body of [
		defaultBody({ expectedRecurringNextDueAt: undefined }),
		defaultBody({ recurringExpenseId: undefined }),
	]) {
		const { state, post } = harness();
		const response = await post({ body });
		assert.equal(response.status, 400);
		assert.equal(state.expenseInsertAttempts, 0);
		assert.equal(state.idempotencyClaims.length, 0);
	}
});

test('rejects foreign, stale, and paused recurring templates without creating an expense', async () => {
	const cases = [
		{ options: { templateWgId: foreignWgId }, status: 404, error: 'recurring_expense_not_found' },
		{
			options: { templateDueAt: '2026-10-02T00:00:00.000Z' },
			status: 409,
			error: 'recurring_expense_already_advanced',
		},
		{
			options: { pausedAt: new Date('2026-09-01T00:00:00.000Z') },
			status: 400,
			error: 'abo_paused',
		},
	];
	for (const { options, status, error } of cases) {
		const { state, post } = harness(options);
		const response = await post();
		assert.equal(response.status, status);
		assert.equal((await response.json()).error, error);
		assert.equal(state.expenses.length, 0);
		assert.equal(state.sideEffects, 0);
		assert.equal(
			state.idempotency.size,
			0,
			'invalid recurrence attempts release their durable claim',
		);
	}
});

test('expense creation waits for capture without leaving an idempotency claim', async () => {
	const { state, post } = harness();
	const body = defaultBody({
		recurringExpenseId: undefined,
		expectedRecurringNextDueAt: undefined,
	});
	state.capturing = true;
	const blocked = await post({ body });
	assert.equal(blocked.status, 409);
	assert.equal((await blocked.json()).error, 'paypal_payment_pending');
	assert.equal(state.expenses.length, 0);
	assert.equal(state.idempotency.size, 0);
	state.capturing = false;
	const retried = await post({ body });
	assert.equal(retried.status, 200);
	assert.equal(state.expenses.length, 1);
});

test('ordinary expenses remain unlinked to recurring templates', async () => {
	const { state, post } = harness();
	const response = await post({
		body: defaultBody({ recurringExpenseId: undefined, expectedRecurringNextDueAt: undefined }),
	});
	assert.equal(response.status, 200);
	assert.equal(state.expenses.length, 1);
	assert.equal(state.expenses[0].recurringExpenseId, undefined);
	assert.equal(state.expenses[0].recurringDueAt, undefined);
	assert.equal(state.templateLocks, 0);
	assert.equal(state.sideEffects, 1);
});

test('recovers only the recurring due unique-index race with the winning canonical expense', async () => {
	const { state, post } = harness();
	const winner = {
		expense: {
			id: '77777777-7777-4777-8777-777777777777',
			wgId,
			paidByMemberId: firstMemberId,
			amountCents: 100,
			currency: 'EUR',
			description: 'Rent',
			imageUrl: null,
			occurredAt: new Date(dueAt),
			recurringExpenseId,
			recurringDueAt: new Date(dueAt),
		},
		splits: [
			{
				id: '88888888-8888-4888-8888-888888888888',
				expenseId: '77777777-7777-4777-8777-777777777777',
				debtorMemberId: firstMemberId,
				amountCents: 50,
				settledAt: null,
			},
			{
				id: '99999999-9999-4999-8999-999999999998',
				expenseId: '77777777-7777-4777-8777-777777777777',
				debtorMemberId: secondMemberId,
				amountCents: 50,
				settledAt: null,
			},
		],
	};
	state.traceWinner = winner;
	state.traceConstraint = 'expenses_recurring_due_unique_idx';

	const response = await post({ key: 'race-member-key' });
	assert.equal(response.status, 200);
	assert.equal((await response.json()).expense.id, winner.expense.id);
	assert.equal(state.expenses.length, 1);
	assert.equal(state.expenses[0].amountCents, 100);
	assert.equal(state.splits.length, 2);
	assert.equal(state.sideEffects, 0);
	assert.equal([...state.idempotency.values()][0].body.expense.id, winner.expense.id);
});

test('does not treat a different PostgreSQL unique constraint as a recurring replay', async () => {
	const { state, post } = harness();
	state.traceConstraint = 'expenses_some_other_unique_idx';
	const response = await post({ key: 'other-unique-key' });
	assert.equal(response.status, 500);
	assert.equal(state.expenses.length, 0);
	assert.equal(state.sideEffects, 0);
	assert.equal(state.idempotency.size, 0, 'the rolled-back write frees its claim');
});

test('an uncertain COMMIT keeps the expense claim fail-closed', async () => {
	const { state, post } = harness();
	state.failCommit = true;
	const response = await post({
		key: 'uncertain-commit-key',
		body: defaultBody({ recurringExpenseId: undefined, expectedRecurringNextDueAt: undefined }),
	});
	assert.equal(response.status, 500);
	assert.deepEqual(
		[...state.idempotency.values()].map((row) => row.body),
		[{ _claimed: true }],
	);
});

test('a rolled-back expense keeps a claim that another request took over', async () => {
	const { state, post } = harness();
	state.capturing = true;
	state.reclaimOnRollback = true;
	const response = await post({
		key: 'reclaimed-key',
		body: defaultBody({ recurringExpenseId: undefined, expectedRecurringNextDueAt: undefined }),
	});
	assert.equal(response.status, 409);
	assert.deepEqual(
		[...state.idempotency.values()].map((row) => row.body),
		[{ _claimed: true }],
	);
});

test('revoked private image attachment returns 409 without creating an expense', async () => {
	const { state, post } = harness();
	state.rejectImageAttachment = true;
	const response = await post({
		key: 'revoked-image-key',
		body: defaultBody({
			imageUrl:
				'https://app.example/api/upload/read?key=manawg%2F11111111-1111-4111-8111-111111111111%2Fexpense%2F22222222-2222-4222-8222-222222222222.jpg',
		}),
	});
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: 'image_removed', code: 'image_removed' });
	assert.equal(state.expenses.length, 0);
	assert.equal(state.sideEffects, 0);
});

function getHarness({
	expenseCount,
	readLimited = false,
}: { expenseCount: number; readLimited?: boolean }) {
	state = freshState(wgId, dueAt, null);
	const rows = Array.from({ length: expenseCount }, (_, index) => ({
		id: `expense-${index}`,
		wgId,
		amountCents: 100,
		occurredAt: new Date(Date.UTC(2026, 0, 1) + index * 1000),
	}));
	const splitRows = rows.map((row) => ({
		id: `split-${row.id}`,
		expenseId: row.id,
		debtorMemberId: secondMemberId,
		amountCents: 100,
		settledAt: null,
	}));
	const mode = {
		readLimited,
		rows,
		splitRows,
		rateLimitKeys: [] as string[],
		splitQueries: [] as Loose[],
	};
	listMode = mode;
	return {
		state: mode,
		get: () =>
			GET(
				new Request('https://example.invalid/api/wg/MTE8PZAT/expenses') as never,
				{ params: Promise.resolve({ code: 'MTE8PZAT' }) } as never,
			),
	};
}

test('expense list is throttled per member before touching the database', async () => {
	const { state, get } = getHarness({ expenseCount: 1, readLimited: true });
	const response = await get();
	assert.equal(response.status, 429);
	assert.deepEqual(state.rateLimitKeys, [`expenses:${wgId}:${firstMemberId}`]);
	assert.equal(state.splitQueries.length, 0);
});

test('expense list loads splits for more than 65,535 expenses without a bind parameter per id', async () => {
	const { state, get } = getHarness({ expenseCount: 70_000 });
	const response = await get();
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.expenses.length, 70_000);
	assert.ok(body.expenses.every((expense: Loose) => expense.splits.length === 1));
	assert.equal(state.splitQueries.length, 1);
	const [query] = state.splitQueries;
	assert.equal(query.joined, expenses);
	assert.deepEqual(Object.keys(query.columns).sort(), [
		'amountCents',
		'debtorMemberId',
		'expenseId',
		'id',
		'settledAt',
	]);
	const compiled = new PgDialect().sqlToQuery(query.predicate);
	assert.deepEqual(compiled.params, [wgId]);
});
