import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routePath = path.join(process.cwd(), 'src/app/api/wg/[code]/expenses/route.ts');
const helperPath = path.join(process.cwd(), 'src/features/expenses/expenses.ts');
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

class TransactionAbort extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

function loadTypeScript(file, overrides) {
	const source = transpileModule(readFileSync(file, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

class ReplayCache {
	constructor() {
		this.entries = new Map();
	}
	get(key) {
		const entry = this.entries.get(key);
		return entry?.value ?? null;
	}
	remember(key, value) {
		this.entries.set(key, { value, promise: Promise.resolve(value) });
	}
	reserve(key) {
		const existing = this.entries.get(key);
		if (existing) return { owned: false, promise: existing.promise };
		let resolve;
		let reject;
		const promise = new Promise((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		promise.catch(() => undefined);
		this.entries.set(key, { promise });
		return {
			owned: true,
			promise,
			resolve: (value) => {
				this.remember(key, value);
				resolve(value);
			},
			reject: (error) => {
				this.entries.delete(key);
				reject(error);
			},
		};
	}
}

function defaultBody(overrides = {}) {
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

function harness({ templateWgId = wgId, templateDueAt = dueAt, pausedAt = null } = {}) {
	const state = {
		capturing: false,
		memberId: firstMemberId,
		body: defaultBody(),
		template: {
			id: recurringExpenseId,
			wgId: templateWgId,
			nextDueAt: new Date(templateDueAt),
			pausedAt,
		},
		members: [
			{ id: firstMemberId, wgId },
			{ id: secondMemberId, wgId },
		],
		expenses: [],
		splits: [],
		idempotency: new Map(),
		idempotencyClaims: [],
		currentClaimId: null,
		lastFoundExpense: null,
		templateLocks: 0,
		existingExpenseLookups: 0,
		expenseInsertAttempts: 0,
		sideEffects: 0,
		errors: [],
		race: null,
		raceConstraint: null,
		raceWinner: null,
		rejectImageAttachment: false,
	};

	const claimId = (scope, key) => `${scope}\u0000${key}`;
	const selectRows = (table, local) => {
		if (table === idempotencyResponses) {
			const row = local.idempotency.get(state.currentClaimId);
			return row ? [{ body: row.body, expiresAt: row.expiresAt }] : [];
		}
		if (table === wgMembers) {
			return state.members.filter((member) => member.wgId === wgId && !member.deactivatedAt);
		}
		if (table === expenses) {
			state.existingExpenseLookups++;
			const existing = local.expenses.find(
				(expense) =>
					expense.wgId === wgId &&
					expense.recurringExpenseId === state.body.recurringExpenseId &&
					expense.recurringDueAt?.getTime() === Date.parse(state.body.expectedRecurringNextDueAt),
			);
			local.lastFoundExpense = existing ?? null;
			return existing ? [existing] : [];
		}
		if (table === expenseSplits) {
			return local.lastFoundExpense
				? local.splits.filter((split) => split.expenseId === local.lastFoundExpense.id)
				: [];
		}
		if (table === recurringExpenses) {
			return local.template?.id === state.body.recurringExpenseId && local.template.wgId === wgId
				? [local.template]
				: [];
		}
		return [];
	};
	const selectQuery = (local, baseDb = false) => {
		const query = {
			table: null,
			from(table) {
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
	};

	const db = {
		select: () =>
			selectQuery(
				{
					idempotency: state.idempotency,
					expenses: state.expenses,
					splits: state.splits,
					template: state.template,
				},
				true,
			),
		update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
	};
	const txFor = (local) => ({
		select: () => selectQuery(local),
		insert: (table) => ({
			values: (values) => ({
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
							error.cause = {
								code: '23505',
								constraint_name: state.traceConstraint,
							};
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
					const splits = values.map((value, index) => ({
						...value,
						id: `66666666-6666-4666-8666-${String(index + 1).padStart(12, '0')}`,
					}));
					local.splits.push(...splits);
					return splits;
				},
			}),
		}),
		update: (table) => ({
			set: (values) => ({
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
		delete: (table) => ({
			where: () => {
				assert.equal(table, idempotencyResponses);
				return Promise.resolve(local.idempotency.delete(state.currentClaimId));
			},
		}),
	});

	const expenseHelpers = loadTypeScript(helperPath, {
		'@/core/activity-feed': {
			postChatSystemMessage: async () => undefined,
			postSystemNotice: async () => undefined,
		},
		'@/core/audit': { recordAuditEvent: async () => undefined },
		'@/core/db': { db, expenseSplits, expenses, wgMembers },
		'@/core/db/transaction': { TransactionAbort },
		'@/core/guards/api-auth': {
			isUuid: (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
		},
		'@/core/notifications/notification-dispatch': {
			dispatchNotificationSafely: async () => ({ warning: null }),
		},
		'@/core/utils/money': { formatEuroCents: () => '1,00 €' },
		'@/features/expenses/split-math': { settledAtForOwnShare: () => null },
	});
	expenseHelpers.recordExpenseCreatedSideEffects = async () => {
		state.sideEffects++;
		return null;
	};

	const route = loadTypeScript(routePath, {
		'@/core/db/private-image-deletions': {
			assertPrivateImageCanBeAttached: async () => {
				if (state.rejectImageAttachment) throw new TransactionAbort('image_removed');
			},
		},
		'@/core/db/transaction': { TransactionAbort },
		'@/core/errors': {
			apiError: (message, status, code) =>
				Response.json({ error: message, ...(code ? { code } : {}) }, { status }),
			badRequest: (message = 'bad_request') => Response.json({ error: message }, { status: 400 }),
			conflict: (message = 'conflict', code = undefined) =>
				Response.json({ error: message, ...(code ? { code } : {}) }, { status: 409 }),
			notFound: (message = 'not_found') => Response.json({ error: message }, { status: 404 }),
			serverError: () => Response.json({ error: 'server_error' }, { status: 500 }),
			tooMany: () => Response.json({ error: 'too_many' }, { status: 429 }),
		},
		'@/core/guards/idempotency': {
			ReplayCache,
			claimReplaySlotWithRetry: async (scope, key) => {
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
			replayKey: (scope, key) => `${scope}:${key}`,
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId, name: 'WG', shareCode: 'MTE8PZAT' },
				member: {
					memberId: state.memberId,
					name: state.memberId === firstMemberId ? 'First' : 'Second',
				},
			}),
		},
		'@/core/guards/route-preamble': {
			readShareCode: async () => ({ ok: true, code: 'MTE8PZAT' }),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
		'@/core/idempotency': {
			RESPONSE_REPLAY_TTL_SECONDS: 604_800,
			getCachedResponse: async (scope, key) => {
				const row = state.idempotency.get(claimId(scope, key));
				return row && !row.body?._claimed ? row.body : null;
			},
			readIdempotencyKey: (request) => request.headers.get('Idempotency-Key'),
		},
		'@/core/infra/observability': {
			logApiError: (label, error) => state.errors.push(`${label}: ${error}`),
		},
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
		'@/core/validators/currency': { currencySchema: requireFromWeb('zod').z.string() },
		'@/core/validators/image-url': {
			imageUrlSchema: requireFromWeb('zod').z.string().nullable().optional(),
			isAllowedImageUrlForWg: () => true,
		},
		'@/features/expenses/expense-constants': {
			AMOUNT_MAX_CENTS: 100_000_000,
			AMOUNT_MIN_CENTS: 1,
		},
		'@/features/expenses/expense-payments': {
			hasCapturingExpensePayment: async () => state.capturing,
			loadCompletedExpensePayments: async () => [],
			withExpensePaymentLock: async (_id, operation) => {
				const local = {
					idempotency: new Map(
						[...state.idempotency].map(([key, value]) => [key, structuredClone(value)]),
					),
					expenses: structuredClone(state.expenses),
					splits: structuredClone(state.splits),
					template: structuredClone(state.template),
					lastFoundExpense: null,
				};
				const result = await operation(txFor(local));
				state.idempotency = local.idempotency;
				state.expenses = local.expenses;
				state.splits = local.splits;
				state.template = local.template;
				return result;
			},
		},
		'@/features/expenses/expenses': expenseHelpers,
		'@/features/expenses/split-math': {
			splitValidationErrorCode: (reason) => reason,
			validateSplits: (amount, splits) =>
				splits.reduce((sum, split) => sum + split.amountCents, 0) === amount
					? { ok: true }
					: { ok: false, reason: 'splits_sum_mismatch' },
		},
		'@/core/db': {
			db,
			expenseSplits,
			expenses,
			idempotencyResponses,
			recurringExpenses,
			wgMembers,
		},
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	});

	return {
		state,
		post: async ({ memberId = firstMemberId, key = 'create-1', body = defaultBody() } = {}) => {
			state.memberId = memberId;
			state.body = body;
			return route.POST(
				new Request('https://example.invalid/api/wg/MTE8PZAT/expenses', {
					method: 'POST',
					headers: { 'Idempotency-Key': key, 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
				{ params: Promise.resolve({ code: 'MTE8PZAT' }) },
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

function getHarness({ expenseCount, readLimited = false }) {
	const readLimiter = { name: 'expenses-read' };
	const state = { rateLimitKeys: [], splitQueries: [] };
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
	const db = {
		select: (columns) => {
			const query = {
				table: null,
				joined: null,
				from(table) {
					this.table = table;
					return this;
				},
				innerJoin(table) {
					this.joined = table;
					return this;
				},
				where(predicate) {
					if (this.table === expenseSplits) {
						state.splitQueries.push({ columns, joined: this.joined, predicate });
						return Promise.resolve(splitRows);
					}
					assert.equal(this.table, expenses);
					return this;
				},
				orderBy: async () => rows,
			};
			return query;
		},
	};
	const stub = new Proxy({}, { get: () => () => undefined });
	const route = loadTypeScript(routePath, {
		'@/core/db': { db, expenseSplits, expenses, idempotencyResponses, recurringExpenses },
		'@/core/db/private-image-deletions': stub,
		'@/core/db/transaction': { TransactionAbort },
		'@/core/errors': {
			apiError: stub.apiError,
			badRequest: stub.badRequest,
			conflict: stub.conflict,
			notFound: stub.notFound,
			serverError: stub.serverError,
			tooMany: (message) => Response.json({ error: message }, { status: 429 }),
		},
		'@/core/guards/idempotency': { ReplayCache },
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId, name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId: firstMemberId, name: 'First' },
			}),
		},
		'@/core/guards/route-preamble': stub,
		'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
		'@/core/idempotency': { RESPONSE_REPLAY_TTL_SECONDS: 604_800 },
		'@/core/infra/observability': stub,
		'@/core/rate-limit': {
			checkRateLimit: async (limiter, key) => {
				assert.equal(limiter, readLimiter);
				state.rateLimitKeys.push(key);
				return { success: !readLimited };
			},
			expensesReadLimiter: readLimiter,
			wgWriteLimiter: {},
		},
		'@/core/validators/currency': { currencySchema: requireFromWeb('zod').z.string() },
		'@/core/validators/image-url': {
			imageUrlSchema: requireFromWeb('zod').z.string().nullable().optional(),
		},
		'@/features/expenses/expense-constants': { AMOUNT_MAX_CENTS: 100_000_000, AMOUNT_MIN_CENTS: 1 },
		'@/features/expenses/expense-payments': { loadCompletedExpensePayments: async () => [] },
		'@/features/expenses/expenses': stub,
		'@/features/expenses/split-math': stub,
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	});
	return {
		state,
		get: () =>
			route.GET(new Request('https://example.invalid/api/wg/MTE8PZAT/expenses'), {
				params: Promise.resolve({ code: 'MTE8PZAT' }),
			}),
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
	assert.ok(body.expenses.every((expense) => expense.splits.length === 1));
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
	const { PgDialect } = requireFromWeb('drizzle-orm/pg-core');
	const compiled = new PgDialect().sqlToQuery(query.predicate);
	assert.deepEqual(compiled.params, [wgId]);
});
