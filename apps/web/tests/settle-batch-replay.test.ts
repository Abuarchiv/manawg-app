import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TransactionAbort } from '../src/core/db/transaction-abort.ts';

// settle-batch POST runs through the real withIdempotentWrite: a stored settlement replays
// before the write rate limit, and a limiter outage answers a retryable 503 without a claim.

const WG = '11111111-1111-4111-8111-111111111111';
const FROM = '22222222-2222-4222-8222-222222222222';
const TO = '33333333-3333-4333-8333-333333333333';
const KEY = '44444444-4444-4444-8444-444444444444';

const state = {
	stored: new Map<string, unknown>(),
	lease: new Map<string, Date>(),
	limit: { success: true, remaining: 1, reset: Date.now() } as {
		success: boolean;
		remaining: number;
		reset: number;
		limiterUnavailable?: boolean;
	},
	limiterCalls: 0,
	writes: 0,
	claims: 0,
	notified: [] as Array<Record<string, unknown>>,
};

mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => undefined } });
mock.module('@/core/db', { namedExports: { db: {} } });
mock.module('@/core/db/transaction', {
	namedExports: { TransactionAbort, withTransaction: async () => assert.fail('no plain tx') },
});
mock.module('@/core/db/claimed-response', {
	namedExports: {
		lockClaimedResponse: async (_tx: unknown, scope: string, key: string) => ({
			kind: 'claimed',
			leaseExpiresAt: state.lease.get(`${scope}|${key}`),
		}),
		completeClaimedResponse: async (_tx: unknown, scope: string, key: string, body: unknown) => {
			state.stored.set(`${scope}|${key}`, body);
		},
		releaseLockedClaim: async () => undefined,
		releaseClaimedResponse: async () => true,
	},
});
mock.module('@/core/idempotency-store', {
	namedExports: {
		readIdempotencyKey: (req: Request) => req.headers.get('idempotency-key'),
		getCachedResponse: async (scope: string, key: string) =>
			state.stored.get(`${scope}|${key}`) ?? null,
		claimResponseSlot: async (scope: string, key: string) => {
			state.claims += 1;
			const lease = new Date(Date.now() + 60_000);
			state.lease.set(`${scope}|${key}`, lease);
			return lease;
		},
	},
});
mock.module('@/core/guards/api-auth', { namedExports: { UUID_PATTERN: /^[0-9a-f-]{36}$/i } });
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: WG },
			member: { memberId: FROM, name: 'From' },
		}),
	},
});
mock.module('@/core/guards/with-wg-route', {
	namedExports: { withWgRoute: (_label: string, handler: unknown) => handler },
});
mock.module('@/core/infra/observability', {
	namedExports: { captureException: () => undefined, logApiError: () => undefined },
});
mock.module('@/core/rate-limit', {
	namedExports: {
		wgWriteLimiter: {},
		checkRateLimit: async () => {
			state.limiterCalls += 1;
			return state.limit;
		},
	},
});
mock.module('@/features/expenses/server/expense-payments', {
	namedExports: {
		withExpensePaymentLock: (_wgId: string, work: (tx: unknown) => unknown) => work({}),
	},
});

mock.module('@/features/expenses/server/settle-notify', {
	namedExports: {
		notifySettlement: async (input: Record<string, unknown>) => {
			state.notified.push(input);
		},
	},
});

const { responseCodec } = await import('../src/core/db/idempotent-write.ts');
mock.module('@/features/expenses/server/settle-debt', {
	namedExports: {
		SettlementChangedError: class extends Error {},
		loadSettlementSnapshot: async () => ({ members: [], expenses: [], payments: [] }),
		pairIsInWg: () => true,
		settlementCodec: responseCodec(),
		settleDebtPair: async () => {
			state.writes += 1;
			return {
				status: 200,
				body: { settled: 0, settledIds: [] },
				context: { kind: 'settled', settledIds: ['split-1'], settledCents: 443 },
			};
		},
	},
});

const { POST } = (await import(
	'../src/app/api/wg/[code]/expenses/settle-batch/route.ts'
)) as unknown as {
	POST: (req: Request, ctx: { code: string }) => Promise<Response>;
};

function settle(): Promise<Response> {
	const body = {
		fromMemberId: FROM,
		toMemberId: TO,
		expected: { netCents: 0, settleableCents: 0, splits: [] },
	};
	return POST(
		new Request('https://example.invalid/api/wg/CODE/expenses/settle-batch', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'idempotency-key': KEY },
			body: JSON.stringify(body),
		}),
		{ code: 'CODE' },
	);
}

test('a stored settlement replays without counting against the rate limit', async () => {
	state.limit = { success: true, remaining: 1, reset: Date.now() };
	const first = await settle();
	assert.equal(first.status, 200);
	assert.equal(state.limiterCalls, 1);
	assert.equal(state.writes, 1);

	state.limit = { success: false, remaining: 0, reset: Date.now() + 60_000 };
	const replay = await settle();
	assert.equal(replay.status, 200);
	assert.deepEqual(await replay.json(), { settled: 0, settledIds: [] });
	assert.equal(state.limiterCalls, 1);
	assert.equal(state.writes, 1);
	// The other party hears about the settlement once, a replay stays silent.
	assert.equal(state.notified.length, 1);
	assert.partialDeepStrictEqual(state.notified[0], {
		otherMemberId: TO,
		amountCents: 443,
		direction: 'paid',
	});
});

test('a limiter outage answers a retryable 503 before claiming the key', async () => {
	state.stored.clear();
	state.claims = 0;
	state.writes = 0;
	state.limit = {
		success: false,
		remaining: 0,
		reset: Date.now() + 1000,
		limiterUnavailable: true,
	};
	const response = await settle();
	assert.equal(response.status, 503);
	assert.equal(((await response.json()) as { error: string }).error, 'rate_limiter_unavailable');
	assert.equal(state.claims, 0);
	assert.equal(state.writes, 0);
});
