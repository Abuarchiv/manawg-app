import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const choreId = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const otherWgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function json(body: unknown, status = 200) {
	return Response.json(body, { status });
}

interface ChoreRow {
	id: string;
	wgId: string;
	title: string;
	assignedMemberId: string | null;
	nextDueAt: Date;
	intervalDays: number;
	recurrenceType: string;
}
interface Condition {
	column: string;
	value: unknown;
}
interface State {
	rows: ChoreRow[];
	auth: unknown;
	authCalls: unknown[];
	queries: { table: unknown; conditions: Condition[]; limit: number }[];
}

const chores = { id: 'chores.id', wgId: 'chores.wg_id' };

function makeState(overrides: Partial<State> = {}): State {
	return {
		rows: [
			{
				id: choreId,
				wgId,
				title: 'Küche reinigen',
				assignedMemberId: null,
				nextDueAt: new Date('2026-09-27T10:00:00.000Z'),
				intervalDays: 7,
				recurrenceType: 'days',
			},
		],
		auth: { ok: true, wg: { id: wgId }, member: { memberId: choreId, name: 'Alex' } },
		authCalls: [],
		queries: [],
		...overrides,
	};
}
let state = makeState();

const db = {
	select: () => ({
		from: (table: unknown) => ({
			where: (conditions: Condition[]) => ({
				limit: async (limit: number) => {
					state.queries.push({ table, conditions, limit });
					const filters = new Map(conditions.map(({ column, value }) => [column, value]));
					return state.rows
						.filter(
							(row) => row.id === filters.get(chores.id) && row.wgId === filters.get(chores.wgId),
						)
						.slice(0, limit);
				},
			}),
		}),
	}),
};

mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => undefined } });
mock.module('@/core/db', {
	namedExports: { CHORE_RECURRENCE_TYPES: ['days', 'months'], chores, db, wgMembers: {} },
});
mock.module('@/core/guards/admin', { namedExports: { isWgAdmin: () => true } });
mock.module('@/core/guards/api-auth', {
	namedExports: {
		UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	},
});
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async (_request: Request, code: string) => {
			state.authCalls.push(code);
			return state.auth;
		},
	},
});
mock.module('@/core/infra/observability', {
	namedExports: { captureException: () => undefined, logApiError: () => undefined },
});
mock.module('@/core/rate-limit', {
	namedExports: { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
});
mock.module('@/core/notifications/notification-dispatch', {
	namedExports: { dispatchNotificationSafely: async () => ({ warning: null }) },
});
mock.module('@/features/chores/server/resolve-swap-request', {
	namedExports: { resolveChoreSwapRequest: async () => undefined },
});
mock.module('@/features/chores/chore-patch', {
	namedExports: { buildChorePatchUpdate: () => ({}) },
});
mock.module('drizzle-orm', {
	namedExports: {
		and: (...conditions: unknown[]) => conditions,
		eq: (column: unknown, value: unknown) => ({ column, value }),
		isNull: (column: unknown) => ({ column, value: null }),
		sql: (parts: unknown, ...values: unknown[]) => ({ parts, values }),
	},
});

const { GET } = await import('./route');

function setupState(overrides: Partial<State> = {}): State {
	state = makeState(overrides);
	return state;
}

function request() {
	return new Request(`https://example.invalid/api/wg/MTE8PZAT/chores/${choreId}`) as never;
}

function context(id = choreId) {
	return { params: Promise.resolve({ code: 'MTE8PZAT', id }) } as never;
}

test('GET returns the chore needed by the MCP detail reader and scopes by id and WG', async () => {
	const state = setupState();

	const response = await GET(request(), context());

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { chore: JSON.parse(JSON.stringify(state.rows[0])) });
	assert.equal(state.authCalls.length, 1);
	assert.deepEqual(
		state.queries[0]?.conditions.map(({ column, value }) => [column, value]),
		[
			['chores.id', choreId],
			['chores.wg_id', wgId],
		],
	);
	assert.equal(state.queries[0]?.limit, 1);
});

test('GET returns not found for a chore id that belongs to another WG', async () => {
	const state = setupState({ rows: [{ ...(makeState().rows[0] as ChoreRow), wgId: otherWgId }] });

	const response = await GET(request(), context());

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: 'chore_not_found' });
	assert.equal(state.queries.length, 1);
});

test('GET requires WG membership before querying chores', async () => {
	const denied = json({ error: 'not_a_member' }, 403);
	const state = setupState({ auth: { ok: false, response: denied } });

	const response = await GET(request(), context());

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: 'not_a_member' });
	assert.equal(state.queries.length, 0);
});

test('GET rejects a malformed UUID before auth or database access', async () => {
	const state = setupState();

	const response = await GET(request(), context('not-a-uuid'));

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { error: 'id_invalid' });
	assert.equal(state.authCalls.length, 0);
	assert.equal(state.queries.length, 0);
});
