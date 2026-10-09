import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TransactionAbort } from '@/core/db/transaction-abort';

const wgId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';
const idemKey = '55555555-5555-4555-8555-555555555555';
const shoppingTable = { name: 'shopping_items' };
const idempotencyTable = {
	scope: 'scope',
	key: 'key',
	responseBody: 'responseBody',
	expiresAt: 'expiresAt',
};
const PLACEHOLDER = '{"_claimed":true}';

interface Slot {
	scope: string;
	key?: string;
	responseBody: unknown;
	expiresAt: Date;
}
type Condition = [string, ...unknown[]] | undefined;
type Tx = Record<string, (...args: never[]) => unknown>;

// The claim row and its predicates, evaluated the way Postgres would. The fake db reads the
// predicate's SQL text because the claim protocol builds its jsonb comparisons with `sql`.
function claimMatches(slot: Slot, condition: Condition): boolean {
	if (!condition) return true;
	const [op, ...args] = condition;
	if (op === 'and') return args.every((part) => claimMatches(slot, part as Condition));
	if (op === 'eq') {
		const value = (slot as unknown as Record<string, unknown>)[args[0] as string];
		return value instanceof Date
			? value.getTime() === (args[1] as Date)?.getTime()
			: value === args[1];
	}
	const text = args[0] as string;
	if (op === 'sql' && text.includes(`= '${PLACEHOLDER}'::jsonb`)) {
		return JSON.stringify(slot.responseBody) === PLACEHOLDER;
	}
	if (op === 'sql' && text.includes('> now()')) return slot.expiresAt > new Date();
	throw new Error(`unsupported predicate ${op}`);
}

/** Every `post()` is its own server process sharing one database. */
const state = {
	slot: null as Slot | null,
	items: [] as Record<string, unknown>[],
	failInsert: false,
	reclaimOnRollback: false,
	stall: null as { reached: () => void; released: Promise<void> } | null,
};

/** The claim row the fake db currently holds; fails the test when there is none. */
function slot(): Slot {
	assert.ok(state.slot, 'no claim row');
	return state.slot;
}

const withTransaction = async <R>(operation: (tx: Tx) => Promise<R>): Promise<R> => {
	if (state.stall) {
		const { reached, released } = state.stall;
		state.stall = null;
		reached();
		await released;
	}
	const snapshot = { slot: state.slot && { ...state.slot }, items: [...state.items] };
	const tx = {
		select: () => ({
			from: (table: unknown) => ({
				where: (condition: Condition) => ({
					limit: () => ({
						for: async (lock: string) => {
							assert.equal(table, idempotencyTable);
							assert.equal(lock, 'update');
							return state.slot && claimMatches(state.slot, condition)
								? [{ body: state.slot.responseBody, expiresAt: state.slot.expiresAt }]
								: [];
						},
					}),
				}),
			}),
		}),
		insert: (table: unknown) => ({
			values: (values: Record<string, unknown>) => ({
				returning: async () => {
					assert.equal(table, shoppingTable);
					if (state.failInsert) throw new Error('connection reset');
					const item = {
						id: `item-${state.items.length + 1}`,
						createdAt: new Date(),
						...values,
					};
					state.items.push(item);
					return [item];
				},
			}),
		}),
		update: (table: unknown) => ({
			set: (values: { responseBody: unknown; expiresAt: Date }) => ({
				where: (condition: Condition) => ({
					returning: async () => {
						assert.equal(table, idempotencyTable);
						if (!state.slot || !claimMatches(state.slot, condition)) return [];
						// jsonb keeps only what JSON can express, dates become strings.
						state.slot = {
							...state.slot,
							responseBody: JSON.parse(JSON.stringify(values.responseBody)),
							expiresAt: values.expiresAt,
						};
						return [{ scope: state.slot.scope }];
					},
				}),
			}),
		}),
	};
	try {
		return await operation(tx as unknown as Tx);
	} catch (err) {
		state.slot = snapshot.slot;
		state.items = snapshot.items;
		if (state.reclaimOnRollback) {
			state.slot = { ...slot(), expiresAt: new Date(Date.now() + 20 * 60_000) };
		}
		throw err;
	}
};

const db = {
	delete: (table: unknown) => ({
		where: (condition: Condition) => ({
			returning: async () => {
				assert.equal(table, idempotencyTable);
				if (!state.slot || !claimMatches(state.slot, condition)) return [];
				state.slot = null;
				return [{ scope: 'released' }];
			},
		}),
	}),
};

const cachedBody = () =>
	state.slot &&
	state.slot.expiresAt > new Date() &&
	JSON.stringify(state.slot.responseBody) !== PLACEHOLDER
		? state.slot.responseBody
		: null;

mock.module('drizzle-orm', {
	namedExports: {
		and: (...parts: unknown[]) => ['and', ...parts],
		asc: (column: unknown) => ['asc', column],
		desc: (column: unknown) => ['desc', column],
		eq: (...parts: unknown[]) => ['eq', ...parts],
		isNotNull: (column: unknown) => ['isNotNull', column],
		isNull: (column: unknown) => ['isNull', column],
		sql: (strings: TemplateStringsArray, ...values: unknown[]) => [
			'sql',
			strings.join('?'),
			...values,
		],
	},
});
mock.module('@/core/db', {
	namedExports: {
		db,
		idempotencyResponses: idempotencyTable,
		shoppingItems: shoppingTable,
		wgMembers: {},
	},
});
mock.module('@/core/db/transaction', { namedExports: { TransactionAbort, withTransaction } });
mock.module('@/core/guards/replay-slot', {
	namedExports: {
		claimReplaySlot: async (scope: string, key: string) => {
			const cached = cachedBody();
			if (cached) return { won: false, cached };
			if (state.slot && state.slot.expiresAt > new Date()) {
				throw new Error('idempotency_response_pending');
			}
			state.slot = {
				scope,
				key,
				responseBody: { _claimed: true },
				expiresAt: new Date(Date.now() + 15 * 60_000),
			};
			return { won: true };
		},
	},
});
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: wgId },
			member: { memberId, name: 'Mina' },
		}),
	},
});
mock.module('@/core/idempotency-store', {
	namedExports: {
		claimResponseSlot: async () => true,
		getCachedResponse: async () => cachedBody(),
		readIdempotencyKey: (req: Request) => req.headers.get('idempotency-key'),
		setReplayWarning: async (_scope: string, _key: string, _target: unknown, warning: unknown) => {
			(slot().responseBody as { body: { warning: unknown } }).body.warning = warning;
			return true;
		},
	},
});
mock.module('@/core/infra/observability', {
	namedExports: { captureException: () => undefined, logApiError: () => undefined },
});
mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => undefined } });
mock.module('@/core/notifications/notification-dispatch', {
	namedExports: { dispatchNotificationSafely: async () => ({ warning: null }) },
});
mock.module('@/core/rate-limit', {
	namedExports: { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
});

const { POST } = await import('./route');

function harness() {
	state.slot = null;
	state.items = [];
	state.failInsert = false;
	state.reclaimOnRollback = false;
	state.stall = null;
	const post = (body: unknown) =>
		POST(
			new Request('https://example.invalid/api/wg/MTE8PZAT/shopping', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'idempotency-key': idemKey },
				body: JSON.stringify(body),
			}) as never,
			{ params: Promise.resolve({ code: 'MTE8PZAT' }) } as never,
		);
	const stallNextTransaction = () => {
		let reached: () => void = () => undefined;
		let release: () => void = () => undefined;
		const atTransaction = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		state.stall = { reached, released };
		return { atTransaction, release };
	};
	return { state, post, stallNextTransaction };
}

test('a create stalled past its lease replays the request that took its key over', async () => {
	const { state, post, stallNextTransaction } = harness();
	const stalled = stallNextTransaction();
	const late = post({ name: 'Kaffee', bought: true });
	await stalled.atTransaction;
	// The lease runs out while the first request stalls; a retry reclaims the key.
	slot().expiresAt = new Date(Date.now() - 1_000);

	const retry = await post({ name: 'Kaffee', bought: true });
	assert.equal(retry.status, 200);
	const retryBody = (await retry.json()) as { item: { name: string; boughtAt: unknown } };
	assert.equal(retryBody.item.name, 'Kaffee');
	assert.ok(retryBody.item.boughtAt, 'a bought item is not caught by the open-name index');

	stalled.release();
	const lateResponse = await late;
	assert.equal(lateResponse.status, 200);
	assert.deepEqual(await lateResponse.json(), retryBody);
	assert.equal(state.items.length, 1);
});

test('a create stalled past its lease writes once when the reclaiming request has not locked yet', async () => {
	const { state, post, stallNextTransaction } = harness();
	const stalled = stallNextTransaction();
	const late = post({ name: 'Kaffee', bought: true });
	await stalled.atTransaction;
	// Another request reclaimed the key with a fresh lease but has not reached its transaction.
	slot().expiresAt = new Date(Date.now() + 15 * 60_000);

	stalled.release();
	const lateResponse = await late;
	assert.equal(lateResponse.status, 200);
	const reclaiming = await post({ name: 'Kaffee', bought: true });
	assert.deepEqual(await reclaiming.json(), await lateResponse.json());
	assert.equal(state.items.length, 1);
});

test('a rolled-back create frees its claim so the same key runs again at once', async () => {
	const { state, post } = harness();
	state.failInsert = true;
	const failed = await post({ name: 'Milch' });
	assert.equal(failed.status, 503);
	assert.deepEqual(await failed.json(), {
		error: 'service_unavailable',
		code: 'idempotency_retryable',
	});
	assert.equal(state.slot, null);

	state.failInsert = false;
	const retry = await post({ name: 'Milch' });
	assert.equal(retry.status, 200);
	assert.equal(state.items.length, 1);
});

test('a rolled-back create keeps a claim another request took over', async () => {
	const { state, post } = harness();
	state.failInsert = true;
	state.reclaimOnRollback = true;
	const failed = await post({ name: 'Milch' });
	assert.equal(failed.status, 503);
	assert.deepEqual(slot().responseBody, { _claimed: true });
	assert.equal(state.items.length, 0);
});
