import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const choreId = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';

interface Calls {
	set: Record<string, unknown>[];
	resolved: string[][];
	dispatched: Record<string, unknown>[];
}
let calls: Calls;
let current: { assignedMemberId: string | null; nextDueAt: Date };

const chores = {
	id: 'chores.id',
	wgId: 'chores.wg_id',
	assignedMemberId: 'chores.assigned_member_id',
	intervalDays: 'chores.interval_days',
	recurrenceType: 'chores.recurrence_type',
	nextDueAt: 'chores.next_due_at',
	lastReminderAt: 'chores.last_reminder_at',
};

const db = {
	select: () => ({
		from: () => ({
			where: () => ({
				limit: async () => [
					{
						assignedMemberId: current.assignedMemberId,
						nextDueAt: current.nextDueAt,
						intervalDays: 7,
						recurrenceType: 'days',
					},
					// The member lookup shares this stub: any row means "found".
				],
			}),
		}),
	}),
	update: () => ({
		set: (values: Record<string, unknown>) => {
			calls.set.push(values);
			return {
				where: () => ({
					returning: async () => [
						{
							id: choreId,
							title: 'Bad putzen',
							intervalDays: 7,
							recurrenceType: 'days',
							nextDueAt: current.nextDueAt,
							assignedMemberId:
								'assignedMemberId' in values ? values.assignedMemberId : current.assignedMemberId,
							...values,
						},
					],
				}),
			};
		},
	}),
	delete: () => ({
		where: () => ({ returning: async () => [{ id: choreId }] }),
	}),
};

mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => undefined } });
mock.module('@/core/db', {
	namedExports: { CHORE_RECURRENCE_TYPES: ['days', 'months'], chores, db, wgMembers: {} },
});
mock.module('@/core/guards/admin', { namedExports: { isWgAdmin: async () => true } });
mock.module('@/core/guards/api-auth', {
	namedExports: {
		UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	},
});
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: wgId, name: 'WG', shareCode: 'MTE8PZAT' },
			member: { memberId: actorId, name: 'Alex' },
		}),
	},
});
mock.module('@/core/infra/observability', {
	namedExports: { captureException: () => undefined, logApiError: () => undefined },
});
mock.module('@/core/rate-limit', {
	namedExports: { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
});
mock.module('@/core/notifications/notification-dispatch', {
	namedExports: {
		dispatchNotificationSafely: async (input: Record<string, unknown>) => {
			calls.dispatched.push(input);
			return { warning: null };
		},
	},
});
mock.module('@/features/chores/server/resolve-swap-request', {
	namedExports: {
		resolveChoreSwapRequest: async (...args: string[]) => {
			calls.resolved.push(args);
		},
	},
});
mock.module('drizzle-orm', {
	namedExports: {
		and: (...conditions: unknown[]) => conditions,
		eq: (column: unknown, value: unknown) => ({ column, value }),
		isNull: (column: unknown) => ({ column, value: null }),
		sql: (parts: unknown, ...values: unknown[]) => ({ parts, values }),
	},
});

const { PATCH, DELETE } = await import('./route');

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000);

function setup(assignedMemberId: string | null = actorId, nextDueAt = inHours(2)) {
	calls = { set: [], resolved: [], dispatched: [] };
	current = { assignedMemberId, nextDueAt };
}

function patch(body: unknown) {
	return PATCH(
		new Request('https://example.invalid/x', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}) as never,
		{ params: Promise.resolve({ code: 'MTE8PZAT', id: choreId }) } as never,
	);
}

test('PATCH trims and stores a new title without touching the cadence', async () => {
	setup();
	const response = await patch({ title: '  Bad putzen  ' });
	assert.equal(response.status, 200);
	assert.equal(calls.set[0]?.title, 'Bad putzen');
	assert.equal('intervalDays' in (calls.set[0] ?? {}), false);
});

test('PATCH rejects an empty or too long title', async () => {
	setup();
	for (const title of ['   ', 'x'.repeat(121)]) {
		const response = await patch({ title });
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: 'title_invalid' });
	}
	assert.equal(calls.set.length, 0);
});

test('PATCH to another member closes the swap request and notifies when due soon', async () => {
	setup(actorId, inHours(2));
	const response = await patch({ assignedMemberId: otherId });
	assert.equal(response.status, 200);
	assert.deepEqual(calls.resolved, [[wgId, choreId, actorId]]);
	assert.equal(calls.dispatched.length, 1);
	assert.deepEqual(calls.dispatched[0]?.targetMemberIds, [otherId]);
	assert.equal(calls.dispatched[0]?.event, 'chore.due');
});

test('PATCH to another member does not notify when the chore is due later', async () => {
	setup(actorId, inHours(24 * 10));
	await patch({ assignedMemberId: otherId });
	assert.equal(calls.resolved.length, 1);
	assert.equal(calls.dispatched.length, 0);
});

test('Taking over yourself closes the swap request without a push', async () => {
	setup(otherId, inHours(2));
	await patch({ assignedMemberId: actorId });
	assert.equal(calls.resolved.length, 1);
	assert.equal(calls.dispatched.length, 0);
});

test('Re-saving the same assignee or a title-only change leaves the swap request open', async () => {
	setup(otherId, inHours(2));
	await patch({ assignedMemberId: otherId });
	await patch({ title: 'Neu' });
	assert.equal(calls.resolved.length, 0);
	assert.equal(calls.dispatched.length, 0);
});

test('DELETE closes the swap request of the removed chore', async () => {
	setup();
	const response = await DELETE(
		new Request('https://example.invalid/x', { method: 'DELETE' }) as never,
		{ params: Promise.resolve({ code: 'MTE8PZAT', id: choreId }) } as never,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(calls.resolved, [[wgId, choreId, actorId]]);
});
