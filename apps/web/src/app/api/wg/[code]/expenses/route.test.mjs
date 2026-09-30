import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routePath = 'src/app/api/wg/[code]/expenses/route.ts';

/** Postgres refuses a statement with more than 65,535 bind parameters. */
const POSTGRES_BIND_LIMIT = 65_535;

function loadTs(file, overrides) {
	const source = transpileModule(readFileSync(path.join(process.cwd(), file), 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return module.exports;
}

function harness({ expenseRows = [], payments = [], rateLimit = { success: true } } = {}) {
	const state = {
		limits: [],
		offsets: [],
		inArrayIds: null,
		rateLimitKeys: [],
		rateLimit,
	};

	const expenses = {};
	const expenseSplits = {};
	const idempotencyResponses = {};

	function query(result) {
		const q = Object.assign(Promise.resolve(result), {
			where: () => q,
			orderBy: () => q,
			limit: (limit) => {
				state.limits.push(limit);
				return q;
			},
			offset: (offset) => {
				state.offsets.push(offset);
				return q;
			},
		});
		return q;
	}

	const db = {
		select: (fields) => ({
			from: (table) => {
				if (table === expenses && fields && 'total' in fields) {
					return query([{ total: expenseRows.length }]);
				}
				if (table === expenses) return query(expenseRows);
				if (table === expenseSplits) return query([]);
				return query([]);
			},
		}),
	};

	const z = requireFromWeb('zod').z;
	const { GET, POST } = loadTs(routePath, {
		'@/core/db': { db, expenses, expenseSplits, idempotencyResponses },
		'@/core/db/transaction': {
			TransactionAbort: class TransactionAbort extends Error {
				constructor(code) {
					super(String(code));
					this.code = String(code);
				}
			},
			withTransaction: async (fn) => fn({}),
		},
		'@/core/errors': {
			apiError: (error, status) => Response.json({ error }, { status }),
			badRequest: (error) => Response.json({ error }, { status: 400 }),
			serverError: (error) => Response.json({ error: String(error) }, { status: 500 }),
			tooMany: () => Response.json({ error: 'rate_limited' }, { status: 429 }),
		},
		'@/core/guards/idempotency': {
			ReplayCache: class ReplayCache {
				get() {
					return null;
				}
				reserve() {
					return null;
				}
				remember() {}
			},
			claimReplaySlotWithRetry: async () => ({ won: false }),
			replayKey: () => 'replay',
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: 'wg', name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId: 'member', name: 'Member', verified: true },
			}),
		},
		'@/core/guards/route-preamble': { readShareCode: async () => ({ ok: true, code: 'MTE8PZAT' }) },
		'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
		'@/core/idempotency': {
			RESPONSE_REPLAY_TTL_SECONDS: 600,
			getCachedResponse: async () => null,
			readIdempotencyKey: () => null,
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/rate-limit': {
			checkRateLimit: async (_limiter, key) => {
				state.rateLimitKeys.push(key);
				return state.rateLimit;
			},
			wgReadLimiter: {},
			wgWriteLimiter: {},
		},
		'@/core/validators/currency': { currencySchema: z.string() },
		'@/core/validators/image-url': {
			imageUrlSchema: z.string().nullable().optional(),
			isAllowedImageUrlForWg: () => true,
		},
		'@/features/expenses/expense-constants': { AMOUNT_MAX_CENTS: 1_000_000, AMOUNT_MIN_CENTS: 1 },
		'@/features/expenses/expense-payments': {
			loadCompletedExpensePayments: async () => payments,
			withExpensePaymentLock: async (_wgId, fn) => fn({}),
		},
		'@/features/expenses/expenses': {
			checkPaidByGuard: () => ({ ok: true }),
			findExpenseMemberIds: async () => new Set(),
			insertExpenseWithSplits: async () => ({ expense: {}, splits: [] }),
			recordExpenseCreatedSideEffects: async () => null,
			resolveExpensePayer: () => null,
		},
		'@/features/expenses/split-math': {
			splitValidationErrorCode: () => 'splits_invalid',
			validateSplits: () => ({ ok: true }),
		},
		'drizzle-orm': {
			and: () => null,
			count: () => ({ __count: true }),
			desc: () => null,
			eq: () => null,
			gt: () => null,
			inArray: (_column, ids) => {
				state.inArrayIds = ids;
				return null;
			},
			sql: (strings, ...values) => ({ strings, values }),
		},
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	});

	return {
		state,
		get: (search = '') =>
			GET({ nextUrl: new URL(`https://example.invalid/expenses${search}`) }, { code: 'MTE8PZAT' }),
		post: (body) =>
			POST(new Request('https://example.invalid', { method: 'POST', body: JSON.stringify(body) }), {
				code: 'MTE8PZAT',
			}),
	};
}

function expenseRow(index) {
	return {
		id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
		wgId: 'wg',
		description: `expense ${index}`,
		amountCents: 1000,
		currency: 'EUR',
		paidByMemberId: 'member',
		imageUrl: null,
		occurredAt: new Date('2026-09-01T10:00:00.000Z'),
	};
}

test('expenses GET is rate limited per member before any read runs', async () => {
	const route = harness({ rateLimit: { success: false } });
	const response = await route.get();
	assert.equal(response.status, 429);
	assert.deepEqual(route.state.rateLimitKeys, ['expenses:wg:member']);
	assert.deepEqual(route.state.limits, [], 'a throttled read must not query');
});

test('expenses GET reads a bounded page instead of the full history', async () => {
	const route = harness({ expenseRows: [expenseRow(1), expenseRow(2)], payments: [{ id: 'p1' }] });
	const response = await route.get();
	const body = await response.json();
	assert.equal(response.status, 200, JSON.stringify(body));

	assert.ok(route.state.limits.length > 0, 'the expense query must carry a limit');
	for (const limit of route.state.limits) {
		assert.ok(limit > 0, 'limit must be a positive number');
		assert.ok(
			limit <= POSTGRES_BIND_LIMIT,
			`limit ${limit} would let inArray exceed Postgres' bind-parameter cap`,
		);
	}

	assert.equal(body.expenses.length, 2);
	assert.equal(body.expenses[0].splits.length, 0);
	assert.deepEqual(body.payments, [{ id: 'p1' }]);
	assert.deepEqual(body.pagination, { total: 2, limit: route.state.limits[0], offset: 0 });
	// The ids handed to inArray come from the bounded page only.
	assert.equal(route.state.inArrayIds.length, 2);
});

test('expenses GET honours limit/offset and clamps abusive values', async () => {
	const paged = harness({ expenseRows: [expenseRow(1)] });
	const pagedResponse = await paged.get('?limit=5&offset=10');
	assert.equal(pagedResponse.status, 200);
	assert.deepEqual(paged.state.limits, [5]);
	assert.deepEqual(paged.state.offsets, [10]);
	assert.deepEqual((await pagedResponse.json()).pagination, { total: 1, limit: 5, offset: 10 });

	const clamped = harness({ expenseRows: [expenseRow(1)] });
	await clamped.get('?limit=999999&offset=-4');
	assert.equal(clamped.state.limits[0], 50_000, 'an oversized limit must clamp to the page max');
	assert.equal(clamped.state.offsets[0], 0, 'a negative offset must clamp to 0');

	const invalid = harness({ expenseRows: [expenseRow(1)] });
	await invalid.get('?limit=abc');
	assert.equal(invalid.state.limits[0], 50_000, 'an unusable limit falls back to the default');
});
