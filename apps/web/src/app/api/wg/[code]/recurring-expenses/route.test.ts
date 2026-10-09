import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TransactionAbort } from '../../../../../core/db/transaction-abort';

const templateId = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const creatorId = '33333333-3333-4333-8333-333333333333';
const otherMemberId = '44444444-4444-4444-8444-444444444444';
const currentDueAt = new Date('2026-10-01T00:00:00.000Z');

const recurringExpenses = {
	id: 'recurringExpenses.id',
	wgId: 'recurringExpenses.wgId',
	nextDueAt: 'recurringExpenses.nextDueAt',
	pausedAt: 'recurringExpenses.pausedAt',
};
const wgMembers = { id: 'wgMembers.id' };
const expenses = { id: 'expenses.id' };

interface Template {
	[key: string]: unknown;
	description: string;
	nextDueAt: Date;
	anchorAt: Date;
}

function makeTemplate(): Template {
	return {
		id: templateId,
		wgId,
		createdByMemberId: creatorId,
		paidByMemberId: creatorId,
		description: 'Miete',
		amountCents: 500,
		currency: 'EUR',
		intervalMonths: 1,
		nextDueAt: currentDueAt,
		anchorAt: currentDueAt,
		lastCreatedAt: null,
		pausedAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		splitsJson: JSON.stringify([{ debtorMemberId: creatorId, amountCents: 500 }]),
	};
}

const state = {
	template: makeTemplate(),
	updates: [] as Partial<Template>[],
	ownerChecks: 0,
	callerId: otherMemberId,
	isAdmin: false,
	// Whether an expense was booked for the template's current due date.
	booked: true,
};

const db = {
	select() {
		let table: unknown;
		const query = {
			from(selected: unknown) {
				table = selected;
				return query;
			},
			where() {
				const rows =
					table === wgMembers
						? [{ id: creatorId }]
						: table === expenses
							? state.booked
								? [{ id: 'expense-1' }]
								: []
							: [{ ...state.template }];
				return Object.assign(Promise.resolve(rows), { limit: async () => rows });
			},
		};
		return query;
	},
	update() {
		let values: Partial<Template> = {};
		return {
			set(next: Partial<Template>) {
				values = next;
				return this;
			},
			where() {
				return {
					returning: async () => {
						state.updates.push(values);
						state.template = { ...state.template, ...values };
						return [{ ...state.template }];
					},
				};
			},
		};
	},
};

mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => {} } });
mock.module('@/core/db', {
	namedExports: { db, expenses, idempotencyResponses: {}, recurringExpenses, wgMembers },
});
mock.module('@/core/db/transaction', {
	namedExports: {
		TransactionAbort,
		withTransaction: async () => assert.fail('no plain transaction expected'),
	},
});
mock.module('@/core/guards/admin', {
	namedExports: {
		requireOwnerOrAdmin: async (_wgId: string, member: { memberId: string }, ownerId: string) => {
			state.ownerChecks++;
			return member.memberId === ownerId || state.isAdmin
				? null
				: Response.json({ error: 'forbidden' }, { status: 403 });
		},
	},
});
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: wgId },
			member: { memberId: state.callerId, name: 'Kim' },
		}),
	},
});
mock.module('@/core/idempotency-store', {
	namedExports: {
		RESPONSE_REPLAY_TTL_SECONDS: 60,
		getCachedResponse: async () => null,
		readIdempotencyKey: () => null,
		claimResponseSlot: async () => true,
	},
});
mock.module('@/core/infra/observability', {
	namedExports: { captureException: () => {}, logApiError: () => {} },
});
mock.module('@/core/rate-limit', {
	namedExports: { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
});
mock.module('@/features/expenses/server/expense-payments', {
	namedExports: { withExpensePaymentLock: async () => {} },
});
mock.module('@/features/expenses/paid-by-guard', {
	namedExports: { checkPaidByGuard: () => ({ ok: true }) },
});
// Column and predicate builders are irrelevant to the fake db, which ignores its filters.
const builder = () => ({});
mock.module('drizzle-orm', {
	namedExports: {
		and: builder,
		asc: builder,
		eq: builder,
		inArray: builder,
		isNotNull: builder,
		isNull: builder,
		sql: builder,
	},
});

const { PATCH } = await import('./route');

function harness({ callerId = otherMemberId, isAdmin = false } = {}) {
	state.template = makeTemplate();
	state.updates = [];
	state.ownerChecks = 0;
	state.callerId = callerId;
	state.isAdmin = isAdmin;
	state.booked = true;
	return {
		state,
		patch: (body: Record<string, unknown>) =>
			PATCH(
				new Request('https://example.test/api/wg/MTE8PZAT/recurring-expenses', {
					method: 'PATCH',
					body: JSON.stringify({ id: templateId, ...body }),
				}) as never,
				{ params: Promise.resolve({ code: 'MTE8PZAT' }) } as never,
			),
	};
}

test('PATCH rejects moving nextDueAt out of the catch-up range', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, patch } = harness({ callerId: creatorId });
	for (const nextDueAt of ['2000-01-01T00:00:00.000Z', '2040-01-01T00:00:00.000Z']) {
		const response = await patch({ description: 'Miete', nextDueAt });
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: 'due_date_invalid' });
	}
	assert.deepEqual(state.updates, []);

	const moved = await patch({ nextDueAt: '2026-11-01T00:00:00.000Z' });
	assert.equal(moved.status, 200);
	assert.equal(state.template.nextDueAt.toISOString(), '2026-11-01T00:00:00.000Z');
});

test('a template is not advanced while no expense was booked for its due date', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, patch } = harness({ callerId: otherMemberId });
	state.booked = false;

	const skipped = await patch({ expectedNextDueAt: currentDueAt.toISOString() });
	assert.equal(skipped.status, 409);
	assert.deepEqual(await skipped.json(), { error: 'recurring_expense_not_booked' });
	assert.deepEqual(state.updates, []);
});

test('any member may advance a template after booking it, but only the owner may edit it', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, patch } = harness({ callerId: otherMemberId });

	const edit = await patch({ description: 'Strom' });
	assert.equal(edit.status, 403);
	assert.equal(state.template.description, 'Miete');

	const advanced = await patch({ expectedNextDueAt: currentDueAt.toISOString() });
	assert.equal(advanced.status, 200);
	assert.equal(state.template.nextDueAt.toISOString(), '2026-11-01T00:00:00.000Z');

	// The expectedNextDueAt check still rejects a stale or replayed advance.
	const replay = await patch({ expectedNextDueAt: currentDueAt.toISOString() });
	assert.equal(replay.status, 409);
	assert.equal(state.template.nextDueAt.toISOString(), '2026-11-01T00:00:00.000Z');
});

test('PATCH resending the unchanged due date keeps the cadence anchor', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, patch } = harness({ callerId: creatorId });
	// A "31st" template whose due date was clamped to the 28th after February.
	const anchorAt = new Date('2026-01-31T11:00:00.000Z');
	const clampedDueAt = new Date('2026-10-28T11:00:00.000Z');
	state.template.anchorAt = anchorAt;
	state.template.nextDueAt = clampedDueAt;

	const edit = await patch({ description: 'Miete neu', nextDueAt: '2026-10-28T10:00:00.000Z' });
	assert.equal(edit.status, 200);
	assert.equal(state.template.anchorAt.toISOString(), anchorAt.toISOString());
	assert.equal(state.template.nextDueAt.toISOString(), clampedDueAt.toISOString());

	const moved = await patch({ nextDueAt: '2026-11-15T11:00:00.000Z' });
	assert.equal(moved.status, 200);
	assert.equal(state.template.anchorAt.toISOString(), '2026-11-15T11:00:00.000Z');
});

test('PATCH from an editor that loaded an older due date is refused, not written back', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, patch } = harness({ callerId: creatorId });
	const loadedDueAt = state.template.nextDueAt.toISOString();
	// A booking (cron or "Erfassen") moved the template on after the form was opened.
	state.template.nextDueAt = new Date('2026-11-01T11:00:00.000Z');

	const stale = await patch({
		description: 'Miete neu',
		nextDueAt: loadedDueAt,
		expectedNextDueAt: loadedDueAt,
	});
	assert.equal(stale.status, 409);
	assert.deepEqual(await stale.json(), {
		error: 'recurring_expense_changed',
		code: 'recurring_expense_changed',
	});
	assert.equal(state.updates.length, 0);
	assert.equal(state.template.nextDueAt.toISOString(), '2026-11-01T11:00:00.000Z');

	const fresh = await patch({
		description: 'Miete neu',
		expectedNextDueAt: '2026-11-01T11:00:00.000Z',
	});
	assert.equal(fresh.status, 200);
	assert.equal(state.template.description, 'Miete neu');
});
