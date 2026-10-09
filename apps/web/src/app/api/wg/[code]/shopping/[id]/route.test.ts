import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const itemId = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';
const otherMemberId = '55555555-5555-4555-8555-555555555555';
const shareCode = 'MTE8PZAT';

// The mocked drizzle-orm still has to hand out the real error class the route's duplicate check
// walks through.
const { DrizzleQueryError } = await import('drizzle-orm');

interface Row {
	id: string;
	wgId: string;
	updatedAt: string | Date;
	boughtAt: Date | null;
	boughtByMemberId: string | null;
	addedByMemberId: string;
	name: string;
}

const shoppingItems = {
	id: 'shopping_items.id',
	wgId: 'shopping_items.wg_id',
	updatedAt: 'shopping_items.updated_at',
	boughtAt: 'shopping_items.bought_at',
	addedByMemberId: 'shopping_items.added_by_member_id',
	name: 'shopping_items.name',
};
const wgMembers = {
	id: 'wg_members.id',
	wgId: 'wg_members.wg_id',
	role: 'wg_members.role',
	deactivatedAt: 'wg_members.deactivated_at',
};

function freshState() {
	return {
		adminMemberId: null as string | null,
		audits: 0,
		deleted: 0,
		member: { memberId, name: 'Alex' },
		update: null as Record<string, unknown> | null,
		current: {
			id: itemId,
			wgId,
			updatedAt: '2026-09-27T10:00:00.123456Z',
			boughtAt: null,
			boughtByMemberId: null,
			addedByMemberId: memberId,
			name: 'Milch',
		} as Row | null,
		loggedErrors: [] as unknown[],
		patches: 0,
		transactionAborted: false,
		returning: (async () => [{ id: itemId }]) as () => Promise<unknown[]>,
		replayCache: new Map<string, unknown>(),
	};
}
let state = freshState();

/** The row the fake db currently holds; fails the test when it was deleted. */
function row(): Row {
	assert.ok(state.current, 'row was deleted');
	return state.current;
}

type Pair = unknown[] | { column: string; value: unknown; truncateMilliseconds: true };

const matches = (conditions: unknown[]) => {
	const pairs: Pair[] = [];
	const visit = (value: unknown) => {
		if ((value as { truncateMilliseconds?: boolean } | null)?.truncateMilliseconds === true) {
			pairs.push(value as Pair);
			return;
		}
		if (!Array.isArray(value)) return;
		if (value.length === 2 && typeof value[0] === 'string') {
			pairs.push(value);
			return;
		}
		value.forEach(visit);
	};
	conditions.forEach(visit);
	return pairs.every((pair) => {
		const [column, value] = Array.isArray(pair) ? pair : [pair.column, pair.value];
		if (column === shoppingItems.updatedAt)
			return (
				!Array.isArray(pair) &&
				pair.truncateMilliseconds === true &&
				new Date(value as string).getTime() === new Date(row().updatedAt).getTime()
			);
		if (column === shoppingItems.boughtAt) {
			const actual = row().boughtAt?.getTime() ?? null;
			const expected = value === null ? null : new Date(value as string).getTime();
			return actual === expected;
		}
		return true;
	});
};

const db = {
	update(table: unknown) {
		assert.equal(table, shoppingItems);
		return {
			set(values: Record<string, unknown>) {
				state.update = values;
				return {
					where(conditions: unknown[]) {
						state.patches += 1;
						return {
							returning: async () => {
								if (!matches(conditions)) return [];
								let rows: unknown[];
								try {
									rows = await state.returning();
								} catch (error) {
									state.transactionAborted = true;
									throw error;
								}
								if (rows.length > 0) state.current = { ...row(), ...values } as Row;
								return rows;
							},
						};
					},
				};
			},
		};
	},
	select() {
		return {
			from(table: unknown) {
				if (table === wgMembers) {
					return {
						where() {
							const rows = state.adminMemberId ? [{ id: state.adminMemberId }] : [];
							return { limit: async () => rows };
						},
					};
				}
				assert.equal(table, shoppingItems);
				return {
					where() {
						const rows = state.current
							? [
									{
										id: state.current.id,
										addedByMemberId: state.current.addedByMemberId,
										name: state.current.name,
									},
								]
							: [];
						return { limit: async () => rows };
					},
				};
			},
		};
	},
	delete(table: unknown) {
		assert.equal(table, shoppingItems);
		return {
			where() {
				return {
					returning: async () => {
						if (!state.current) return [];
						state.deleted += 1;
						const { id } = state.current;
						state.current = null;
						return [{ id }];
					},
				};
			},
		};
	},
};

mock.module('@/core/audit', {
	namedExports: {
		recordAuditEvent: async () => {
			state.audits += 1;
		},
	},
});
mock.module('@/core/db', { namedExports: { db, shoppingItems, wgMembers } });
mock.module('@/core/guards/api-auth', { namedExports: { UUID_PATTERN: /^[0-9a-f-]{36}$/i } });
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({ ok: true, wg: { id: wgId }, member: state.member }),
	},
});
mock.module('@/core/infra/observability', {
	namedExports: {
		captureException: () => undefined,
		logApiError: (_label: string, error: unknown) => state.loggedErrors.push(error),
	},
});
mock.module('@/core/rate-limit', {
	namedExports: { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
});
mock.module('drizzle-orm', {
	namedExports: {
		DrizzleQueryError,
		and: (...conditions: unknown[]) => conditions,
		eq: (...condition: unknown[]) => condition,
		isNull: (column: unknown) => [column, null],
		sql: (strings: TemplateStringsArray, column: unknown, value: unknown) =>
			strings[0]?.includes('greatest')
				? new Date('2026-09-27T10:00:00.124Z')
				: { column, value, truncateMilliseconds: true },
	},
});
mock.module('@/core/idempotency-store', {
	namedExports: {
		readIdempotencyKey: (request: Request) => request.headers.get('idempotency-key'),
	},
});
mock.module('@/features/pinnwand/server/announcement-replay', {
	namedExports: {
		withAnnouncementReplay: async (
			request: Request,
			scope: string,
			mutate: (tx: typeof db) => Promise<{ response: unknown; effect: unknown }>,
		) => {
			const key = request.headers.get('idempotency-key');
			const cacheKey = `${scope}:${key}`;
			if (state.replayCache.has(cacheKey)) {
				return { response: state.replayCache.get(cacheKey), effect: null, key };
			}
			let result: { response: unknown; effect: unknown };
			try {
				result = await mutate(db);
			} catch (error) {
				state.transactionAborted = false;
				throw error;
			}
			if (state.transactionAborted) {
				state.transactionAborted = false;
				throw new Error('transaction_aborted');
			}
			if (key) state.replayCache.set(cacheKey, result.response);
			return { ...result, key };
		},
	},
});

const { DELETE, PATCH } = await import('./route');

function harness(returning: () => Promise<unknown[]> = async () => [{ id: itemId }]) {
	state = freshState();
	state.returning = returning;
	const ctx = { params: Promise.resolve({ code: shareCode, id: itemId }) };
	return {
		state,
		patch: ({
			body,
			bought = false,
			expectedUpdatedAt = new Date(row().updatedAt).toISOString(),
			expectedBoughtAt = null,
			key = '44444444-4444-4444-8444-444444444444',
		}: {
			body?: unknown;
			bought?: boolean;
			expectedUpdatedAt?: string;
			expectedBoughtAt?: string | null;
			key?: string;
		} = {}) =>
			PATCH(
				new Request(`https://example.invalid/api/wg/${shareCode}/shopping/${itemId}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json', 'idempotency-key': key },
					body: JSON.stringify(body ?? { bought, expectedUpdatedAt, expectedBoughtAt }),
				}) as never,
				ctx as never,
			),
		remove: () =>
			DELETE(
				new Request(`https://example.invalid/api/wg/${shareCode}/shopping/${itemId}`, {
					method: 'DELETE',
				}) as never,
				ctx as never,
			),
	};
}

test('reopening an item that conflicts with another open name returns 409', async () => {
	const postgresError = Object.assign(new Error('duplicate key value violates unique constraint'), {
		code: '23505',
		constraint: 'shopping_items_unique_open_name',
	});
	const duplicateError = new DrizzleQueryError(
		'update shopping_items set bought_at = null',
		[],
		postgresError,
	);
	const { patch, state } = harness(async () => {
		throw duplicateError;
	});

	const response = await patch();

	assert.deepEqual(await response.json(), { error: 'shopping_item_duplicate' });
	assert.equal(response.status, 409);
	assert.deepEqual(state.update, {
		boughtAt: null,
		boughtByMemberId: null,
		updatedAt: state.update?.updatedAt,
	});
	assert.equal(state.audits, 0);
});

test('other database errors still use the shared 500 handler', async () => {
	const postgresError = Object.assign(new Error('different constraint'), {
		code: '23505',
		constraint: 'shopping_items_other_unique_key',
	});
	const queryError = new DrizzleQueryError('update shopping_items', [], postgresError);
	const { patch, state } = harness(async () => {
		throw queryError;
	});

	const response = await patch();

	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: 'server_error' });
	assert.equal(state.loggedErrors[0], queryError);
});

test('stale shopping state conflicts without mutation or notification', async () => {
	const { patch, state } = harness();
	row().updatedAt = new Date('2026-09-27T11:00:00.000Z');

	const response = await patch({ bought: true, expectedUpdatedAt: '2026-09-27T10:00:00.000Z' });

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: 'shopping_item_changed' });
	assert.equal(state.audits, 0);
	assert.equal(row().boughtAt, null);
});

test('legacy queued shopping update remains a visible conflict', async () => {
	const { patch, state } = harness();

	const response = await patch({ body: { bought: true } });

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: 'shopping_item_changed' });
	assert.equal(state.patches, 0);
	assert.equal(state.audits, 0);
});

test('retry of a bought PATCH replays after another member reopens the item', async () => {
	const { patch, state } = harness();
	const request = {
		bought: true,
		expectedUpdatedAt: '2026-09-27T10:00:00.123Z',
		expectedBoughtAt: null,
	};
	const first = await patch(request);
	assert.equal(first.status, 200);
	assert.equal((row().updatedAt as Date).getTime(), Date.parse('2026-09-27T10:00:00.124Z'));
	row().updatedAt = new Date('2026-09-27T11:00:00.000Z');
	row().boughtAt = null;
	row().boughtByMemberId = null;

	const retry = await patch(request);

	assert.equal(retry.status, 200);
	assert.equal(state.patches, 1);
	assert.equal(state.audits, 1);
	assert.equal(row().boughtAt, null);
});

test('the member who added a shopping item may delete it', async () => {
	const { remove, state } = harness();

	const response = await remove();

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { deleted: true });
	assert.equal(state.deleted, 1);
	assert.equal(state.audits, 1);
});

test("a WG admin may delete another member's shopping item", async () => {
	const { remove, state } = harness();
	row().addedByMemberId = otherMemberId;
	state.adminMemberId = memberId;

	const response = await remove();

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { deleted: true });
	assert.equal(state.deleted, 1);
	assert.equal(state.audits, 1);
});

test("non-admins cannot delete another member's item", async () => {
	for (const adminMemberId of [otherMemberId, null]) {
		const { remove, state } = harness();
		row().addedByMemberId = otherMemberId;
		state.adminMemberId = adminMemberId;

		const response = await remove();

		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: 'not_owner', code: 'not_owner' });
		assert.equal(state.deleted, 0);
		assert.equal(state.audits, 0);
	}
});
