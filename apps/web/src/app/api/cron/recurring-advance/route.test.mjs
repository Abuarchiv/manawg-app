import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routePath = path.join(process.cwd(), 'src/app/api/cron/recurring-advance/route.ts');
const templateId = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';
const originalDueAt = new Date('2026-09-01T00:00:00.000Z');
const editedDueAt = new Date('2027-01-15T00:00:00.000Z');

function harness({
	patchIntervalMonths = false,
	patchBeforeLock = null,
	patchAfterInsert = 'dueDate',
	initialDueAt = originalDueAt,
	initialIntervalMonths = 1,
	errorConstraint = null,
	duplicateErrorShape = 'cause',
	initialAnchorAt = initialDueAt,
	activeMemberIds = [memberId],
} = {}) {
	const recurringExpenses = {
		id: 'recurringExpenses.id',
		wgId: 'recurringExpenses.wgId',
		paidByMemberId: 'recurringExpenses.paidByMemberId',
		description: 'recurringExpenses.description',
		amountCents: 'recurringExpenses.amountCents',
		intervalMonths: 'recurringExpenses.intervalMonths',
		nextDueAt: 'recurringExpenses.nextDueAt',
		anchorAt: 'recurringExpenses.anchorAt',
		splitsJson: 'recurringExpenses.splitsJson',
		pausedAt: 'recurringExpenses.pausedAt',
	};
	const expenses = { id: 'expenses.id' };
	const expenseSplits = {};
	const wgs = { id: 'wgs.id', name: 'wgs.name', shareCode: 'wgs.shareCode' };
	const wgMembers = {
		id: 'wgMembers.id',
		wgId: 'wgMembers.wgId',
		deactivatedAt: 'wgMembers.deactivatedAt',
	};
	const state = {
		template: {
			id: templateId,
			wgId,
			paidByMemberId: memberId,
			description: 'Miete',
			amountCents: 500,
			intervalMonths: initialIntervalMonths,
			nextDueAt: initialDueAt,
			anchorAt: initialAnchorAt,
			splitsJson: JSON.stringify([{ debtorMemberId: memberId, amountCents: 500 }]),
			pausedAt: null,
			wgName: 'WG',
			shareCode: 'MTE8PZAT',
		},
		expenses: [],
		splits: [],
		notifications: [],
		events: [],
		updatePredicates: [],
		updateResults: [],
		concurrentPatchApplied: false,
		lockPatchApplied: false,
		lockReads: 0,
		lockOrder: [],
		capturing: false,
		wgExists: true,
		loggedErrors: [],
		memberQueries: [],
	};

	const eq = (field, value) => ({ operator: 'eq', field, value });
	const and = (...conditions) => ({ operator: 'and', conditions });
	const lte = (field, value) => ({ operator: 'lte', field, value });
	const isNull = (field) => ({ operator: 'isNull', field });
	const inArray = (field, values) => ({ operator: 'inArray', field, values });
	const valueFor = (field) => {
		if (field === wgs.id) return wgId;
		if (field === recurringExpenses.id) return state.template.id;
		if (field === recurringExpenses.wgId) return state.template.wgId;
		if (field === recurringExpenses.paidByMemberId) return state.template.paidByMemberId;
		if (field === recurringExpenses.description) return state.template.description;
		if (field === recurringExpenses.amountCents) return state.template.amountCents;
		if (field === recurringExpenses.intervalMonths) return state.template.intervalMonths;
		if (field === recurringExpenses.nextDueAt) return state.template.nextDueAt;
		if (field === recurringExpenses.anchorAt) return state.template.anchorAt;
		if (field === recurringExpenses.splitsJson) return state.template.splitsJson;
		if (field === recurringExpenses.pausedAt) return state.template.pausedAt;
		return undefined;
	};
	const matches = (predicate) => {
		if (predicate.operator === 'and') return predicate.conditions.every(matches);
		if (predicate.operator === 'isNull') return valueFor(predicate.field) === null;
		if (predicate.operator !== 'eq') return false;
		const actual = valueFor(predicate.field);
		return actual instanceof Date && predicate.value instanceof Date
			? actual.getTime() === predicate.value.getTime()
			: actual === predicate.value;
	};

	const transaction = {
		select() {
			let table;
			const query = {
				from(selectedTable) {
					table = selectedTable;
					return query;
				},
				where(predicate) {
					if (table === wgMembers) {
						const ids = predicate.conditions.find(
							(condition) => condition.operator === 'inArray',
						).values;
						state.memberQueries.push(ids);
						return Promise.resolve(
							ids.filter((id) => activeMemberIds.includes(id)).map((id) => ({ id })),
						);
					}
					assert.equal(matches(predicate), true);
					return query;
				},
				for(mode) {
					const tableName = table === wgs ? 'wgs' : 'recurringExpenses';
					state.lockOrder.push(`${tableName}:${mode}`);
					if (table === wgs) {
						assert.equal(mode, 'key share');
						return Promise.resolve(state.wgExists ? [{ id: wgId }] : []);
					}
					assert.equal(table, recurringExpenses);
					assert.equal(mode, 'update');
					state.lockReads++;
					return Promise.resolve([{ ...state.template }]);
				},
			};
			return query;
		},
		insert(table) {
			return {
				values(value) {
					if (table === expenses) {
						return {
							returning: async () => {
								if (errorConstraint) {
									throw Object.assign(new Error('unrelated unique violation'), {
										code: '23505',
										constraint: errorConstraint,
									});
								}
								if (
									state.expenses.some(
										(row) =>
											row.recurringExpenseId === value.recurringExpenseId &&
											row.recurringDueAt.getTime() === value.recurringDueAt.getTime(),
									)
								) {
									if (duplicateErrorShape === 'cause') {
										throw new Error('duplicate recurring charge', {
											cause: {
												code: '23505',
												constraint_name: 'expenses_recurring_due_unique_idx',
											},
										});
									}
									throw Object.assign(new Error('duplicate recurring charge'), {
										code: '23505',
										constraint: 'expenses_recurring_due_unique_idx',
									});
								}
								const row = { ...value, id: `expense-${state.expenses.length + 1}` };
								state.expenses.push(row);
								return [{ id: row.id }];
							},
						};
					}
					assert.equal(table, expenseSplits);
					state.splits.push(...value);
					return Promise.resolve();
				},
			};
		},
	};

	const db = {
		select() {
			const query = {
				from(table) {
					assert.equal(table, recurringExpenses);
					return query;
				},
				innerJoin(table) {
					assert.equal(table, wgs);
					return query;
				},
				where(predicate) {
					const dueCondition = predicate.conditions.find(
						(condition) => condition.operator === 'lte',
					);
					const due =
						state.template.nextDueAt <= dueCondition.value && state.template.pausedAt === null;
					return Promise.resolve(due ? [{ ...state.template }] : []);
				},
			};
			return query;
		},
		update(table) {
			assert.equal(table, recurringExpenses);
			let values;
			return {
				set(nextValues) {
					values = nextValues;
					return this;
				},
				where(predicate) {
					state.updatePredicates.push(predicate);
					let result;
					const apply = async () => {
						if (result) return result;
						if (!state.concurrentPatchApplied) {
							state.concurrentPatchApplied = true;
							if (patchIntervalMonths) state.template.intervalMonths = 3;
							else if (patchAfterInsert === 'dueDate') {
								state.template.nextDueAt = editedDueAt;
								state.template.anchorAt = editedDueAt;
							}
						}
						const updated = matches(predicate);
						if (updated) state.template = { ...state.template, ...values };
						result = updated ? [{ id: templateId }] : [];
						state.updateResults.push(result);
						return result;
					};
					return Object.assign(Promise.resolve().then(apply), { returning: apply });
				},
			};
		},
	};

	const mocks = {
		'@/core/audit': { recordAuditEvent: async (event) => state.events.push(event) },
		'@/core/db': { db, expenseSplits, expenses, recurringExpenses, wgMembers, wgs },
		'@/core/db/transaction': {
			TransactionAbort: class TransactionAbort extends Error {},
		},
		'@/core/infra/cron-auth': { verifyCronSecret: () => true },
		'@/core/infra/observability': {
			logApiError: (...args) => state.loggedErrors.push(args),
			withCronLogging: (_name, handler) => handler,
		},
		'@/core/notifications/notification-dispatch': {
			dispatchNotificationSafely: async (notification) => state.notifications.push(notification),
		},
		'@/features/expenses/expense-payments': {
			hasCapturingExpensePayment: async () => state.capturing,
			withExpensePaymentLock: async (_id, operation) => {
				if (!state.lockPatchApplied && patchBeforeLock) {
					state.lockPatchApplied = true;
					if (patchBeforeLock === 'deleteWg') state.wgExists = false;
					if (patchBeforeLock === 'pause')
						state.template.pausedAt = new Date('2026-09-20T00:00:00Z');
					if (patchBeforeLock === 'amount') {
						state.template.amountCents = 600;
						state.template.splitsJson = JSON.stringify([
							{ debtorMemberId: memberId, amountCents: 600 },
						]);
					}
				}
				return operation(transaction);
			},
		},
		'@/features/expenses/recurring-expenses': {
			addMonthsFromAnchor: (date, anchorDay, months) => {
				const next = new Date(date);
				next.setUTCMonth(next.getUTCMonth() + months, 1);
				const lastDay = new Date(
					Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
				).getUTCDate();
				next.setUTCDate(Math.min(anchorDay, lastDay));
				return next;
			},
			parseRecurringSplits: JSON.parse,
			recurringSplitsMatchAmount: (splits, amount) =>
				splits.reduce((sum, split) => sum + split.amountCents, 0) === amount,
		},
		'@/features/expenses/split-math': { settledAtForOwnShare: () => null },
		'drizzle-orm': { and, eq, inArray, isNull, lte },
		'next/server': {
			NextResponse: Object.assign(class extends Response {}, {
				json: (body, init) => Response.json(body, init),
			}),
		},
	};
	const source = transpileModule(readFileSync(routePath, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (Object.hasOwn(mocks, name) ? mocks[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return {
		state,
		get: () => module.exports.GET(new Request('https://example.test/api/cron/recurring-advance')),
	};
}

async function withCronSecret(run) {
	const previousSecret = process.env.CRON_SECRET;
	process.env.CRON_SECRET = 'test-cron-secret';
	try {
		return await run();
	} finally {
		if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'CRON_SECRET');
		else process.env.CRON_SECRET = previousSecret;
	}
}

test('recurring charge waits for PayPal capture and advances on retry', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, get } = harness();
	const dueAtBeforeCapture = state.template.nextDueAt.toISOString();
	state.capturing = true;
	await withCronSecret(async () => {
		const blocked = await get();
		assert.equal(blocked.status, 200);
		assert.equal(state.expenses.length, 0);
		assert.equal(state.template.nextDueAt.toISOString(), dueAtBeforeCapture);
		state.capturing = false;
		const retried = await get();
		assert.equal(retried.status, 200);
		assert.equal(state.expenses.length, 1);
	});
});

test('a concurrent schedule edit wins while the inserted charge is still notified and counted', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, get } = harness();
	await withCronSecret(async () => {
		const response = await get();
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, charged: 1, failedTemplates: 0 });
		assert.equal(state.expenses.length, 1);
		assert.equal(state.splits.length, 1);
		assert.equal(state.notifications.length, 1);
		assert.equal(state.events.length, 1);
		assert.equal(state.template.nextDueAt.toISOString(), editedDueAt.toISOString());
		assert.equal(state.template.anchorAt.toISOString(), editedDueAt.toISOString());
		assert.deepEqual(state.updateResults, [[]]);

		const retry = await get();
		assert.deepEqual(await retry.json(), { ok: true, charged: 0 });
		assert.equal(state.expenses.length, 1);
		assert.equal(state.notifications.length, 1);
	});
});

test('a concurrent interval edit is preserved and the idempotent retry uses it', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, get } = harness({ patchIntervalMonths: true });
	await withCronSecret(async () => {
		const response = await get();
		assert.deepEqual(await response.json(), { ok: true, charged: 1, failedTemplates: 0 });
		assert.equal(state.template.intervalMonths, 3);
		assert.equal(state.template.nextDueAt.toISOString(), originalDueAt.toISOString());
		assert.equal(state.template.anchorAt.toISOString(), originalDueAt.toISOString());
		assert.deepEqual(state.updateResults, [[]]);
		assert.equal(state.expenses.length, 1);
		assert.equal(state.notifications.length, 1);

		const retry = await get();
		assert.deepEqual(await retry.json(), { ok: true, charged: 0, failedTemplates: 0 });
		assert.equal(state.template.nextDueAt.toISOString(), '2026-12-01T00:00:00.000Z');
		assert.deepEqual(state.updateResults, [[], [{ id: templateId }]]);
		assert.equal(state.expenses.length, 1);
		assert.equal(state.notifications.length, 1);
	});
});

test('a pause committed before the locked template read prevents the charge', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, get } = harness({ patchBeforeLock: 'pause', patchAfterInsert: null });
	await withCronSecret(async () => {
		const response = await get();
		assert.deepEqual(await response.json(), { ok: true, charged: 0, failedTemplates: 0 });
		assert.equal(state.template.pausedAt.toISOString(), '2026-09-20T00:00:00.000Z');
		assert.equal(state.lockReads, 1);
		assert.equal(state.expenses.length, 0);
		assert.equal(state.notifications.length, 0);
		assert.equal(state.events.length, 0);
		assert.deepEqual(state.updateResults, []);
	});
});

test('a content edit committed before the locked read defers a stale charge', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, get } = harness({ patchBeforeLock: 'amount', patchAfterInsert: null });
	await withCronSecret(async () => {
		const response = await get();
		assert.deepEqual(await response.json(), { ok: true, charged: 0, failedTemplates: 0 });
		assert.equal(state.template.amountCents, 600);
		assert.equal(state.lockReads, 1);
		assert.equal(state.expenses.length, 0);
		assert.equal(state.notifications.length, 0);
		assert.deepEqual(state.updateResults, []);
	});
});

test('catch-up charges keep comparing against the initially loaded nextDueAt', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const julyDueAt = new Date('2026-07-01T00:00:00.000Z');
	const { state, get } = harness({ initialDueAt: julyDueAt, patchAfterInsert: null });
	await withCronSecret(async () => {
		const response = await get();
		assert.deepEqual(await response.json(), { ok: true, charged: 3, failedTemplates: 0 });
		assert.equal(state.lockReads, 3);
		assert.deepEqual(
			state.expenses.map((expense) => expense.recurringDueAt.toISOString()),
			['2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
		);
		assert.equal(state.template.nextDueAt.toISOString(), '2026-10-01T00:00:00.000Z');
		assert.equal(state.notifications.length, 3);
	});
});

test('an unrelated unique violation is logged and does not advance the template', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, get } = harness({
		patchAfterInsert: null,
		errorConstraint: 'expenses_import_duplicate_key_unique_idx',
	});
	await withCronSecret(async () => {
		const response = await get();
		assert.deepEqual(await response.json(), { ok: true, charged: 0, failedTemplates: 0 });
		assert.equal(state.loggedErrors.length, 1);
		assert.equal(state.expenses.length, 0);
		assert.equal(state.template.nextDueAt.toISOString(), originalDueAt.toISOString());
		assert.deepEqual(state.updateResults, []);
		assert.equal(state.notifications.length, 0);
	});
});

test('a direct recurring-index violation remains an idempotent advance', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, get } = harness({ patchAfterInsert: null, duplicateErrorShape: 'direct' });
	state.expenses.push({ recurringExpenseId: templateId, recurringDueAt: originalDueAt });
	await withCronSecret(async () => {
		const response = await get();
		assert.deepEqual(await response.json(), { ok: true, charged: 0, failedTemplates: 0 });
		assert.equal(state.template.nextDueAt.toISOString(), '2026-10-01T00:00:00.000Z');
		assert.deepEqual(state.updateResults, [[{ id: templateId }]]);
		assert.equal(state.expenses.length, 1);
		assert.equal(state.notifications.length, 0);
		assert.equal(state.loggedErrors.length, 0);
	});
});

test('Cron locks the WG before the recurring row and skips when the WG disappeared', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const liveWg = harness({ patchAfterInsert: null });
	await withCronSecret(async () => {
		const response = await liveWg.get();
		assert.deepEqual(await response.json(), { ok: true, charged: 1, failedTemplates: 0 });
		assert.deepEqual(liveWg.state.lockOrder, ['wgs:key share', 'recurringExpenses:update']);
	});

	const deletedWg = harness({ patchBeforeLock: 'deleteWg', patchAfterInsert: null });
	await withCronSecret(async () => {
		const response = await deletedWg.get();
		assert.deepEqual(await response.json(), { ok: true, charged: 0, failedTemplates: 0 });
		assert.deepEqual(deletedWg.state.lockOrder, ['wgs:key share']);
		assert.equal(deletedWg.state.lockReads, 0);
		assert.equal(deletedWg.state.expenses.length, 0);
		assert.deepEqual(deletedWg.state.updateResults, []);
	});
});

test('legacy month-end anchor survives separate January and February cron runs', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2025-01-31T12:00:00.000Z') });
	const legacy = harness({
		initialDueAt: new Date('2025-01-31T00:00:00.000Z'),
		initialAnchorAt: null,
		patchAfterInsert: null,
	});

	await withCronSecret(async () => {
		await legacy.get();
		assert.equal(legacy.state.template.nextDueAt.toISOString(), '2025-02-28T00:00:00.000Z');

		t.mock.timers.setTime(Date.parse('2025-02-28T12:00:00.000Z'));
		await legacy.get();

		assert.deepEqual(
			legacy.state.expenses.map((expense) => expense.recurringDueAt.toISOString()),
			['2025-01-31T00:00:00.000Z', '2025-02-28T00:00:00.000Z'],
		);
		assert.equal(legacy.state.template.nextDueAt.toISOString(), '2025-03-31T00:00:00.000Z');
		assert.equal(legacy.state.template.anchorAt.toISOString(), '2025-01-31T00:00:00.000Z');
	});
});

test('legacy month-end anchor adopts the pre-advance due date across three months', async (t) => {
	// Due dates are stored as local noon (inputDateToIso), so the UTC day is the Berlin day.
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-31T12:00:00.000Z') });
	const legacy = harness({
		initialDueAt: new Date('2026-01-31T11:00:00.000Z'),
		initialAnchorAt: null,
		patchAfterInsert: null,
	});

	await withCronSecret(async () => {
		const runs = [
			['2026-01-31T12:00:00.000Z', '2026-02-28T11:00:00.000Z'],
			['2026-02-28T12:00:00.000Z', '2026-03-31T11:00:00.000Z'],
			['2026-03-31T12:00:00.000Z', '2026-04-30T11:00:00.000Z'],
			['2026-04-30T12:00:00.000Z', '2026-05-31T11:00:00.000Z'],
		];
		for (const [runAt, expectedNext] of runs) {
			t.mock.timers.setTime(Date.parse(runAt));
			await legacy.get();
			assert.equal(legacy.state.template.nextDueAt.toISOString(), expectedNext);
			assert.equal(legacy.state.template.anchorAt.toISOString(), '2026-01-31T11:00:00.000Z');
			assert.equal(legacy.state.template.anchorAt.getUTCDate(), 31);
		}
		assert.deepEqual(
			legacy.state.expenses.map((expense) => expense.recurringDueAt.toISOString()),
			[
				'2026-01-31T11:00:00.000Z',
				'2026-02-28T11:00:00.000Z',
				'2026-03-31T11:00:00.000Z',
				'2026-04-30T11:00:00.000Z',
			],
		);
	});
});

test('legacy month-end catch-up keeps anchor day 31 within a single run', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-04-30T12:00:00.000Z') });
	const legacy = harness({
		initialDueAt: new Date('2026-01-31T11:00:00.000Z'),
		initialAnchorAt: null,
		patchAfterInsert: null,
	});

	await withCronSecret(async () => {
		const response = await legacy.get();
		assert.deepEqual(await response.json(), { ok: true, charged: 4, failedTemplates: 0 });
		assert.deepEqual(
			legacy.state.expenses.map((expense) => expense.recurringDueAt.toISOString()),
			[
				'2026-01-31T11:00:00.000Z',
				'2026-02-28T11:00:00.000Z',
				'2026-03-31T11:00:00.000Z',
				'2026-04-30T11:00:00.000Z',
			],
		);
		assert.equal(legacy.state.template.nextDueAt.toISOString(), '2026-05-31T11:00:00.000Z');
		assert.equal(legacy.state.template.anchorAt.toISOString(), '2026-01-31T11:00:00.000Z');
	});
});

test('a template with a moved-out payer or debtor is skipped without advancing', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const julyDueAt = new Date('2026-07-01T00:00:00.000Z');
	const { state, get } = harness({
		initialDueAt: julyDueAt,
		patchAfterInsert: null,
		activeMemberIds: [],
	});
	await withCronSecret(async () => {
		const response = await get();
		assert.deepEqual(await response.json(), { ok: true, charged: 0, failedTemplates: 0 });
		// One check per run: the catch-up loop stops at the first skip.
		assert.deepEqual(state.memberQueries, [[memberId]]);
		assert.equal(state.expenses.length, 0);
		assert.equal(state.splits.length, 0);
		assert.equal(state.notifications.length, 0);
		assert.deepEqual(state.updateResults, []);
		assert.equal(state.template.nextDueAt.toISOString(), julyDueAt.toISOString());
		assert.equal(state.loggedErrors.length, 1);
	});
});
