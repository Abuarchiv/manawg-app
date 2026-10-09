import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
	CALLER_ID,
	EXPENSE_ID,
	PAYER_ID,
	type Predicate,
	WG_ID,
	errorOf,
	installWgRouteMocks,
	jsonRequest,
	matches,
	routeContext,
	tables,
	thenableQuery,
} from './support/expense-route-fakes.ts';

// Recurring-template routes against fake databases [suite "expense integrity
// regressions" and "finance failure regressions"]: payer guard, inactive members and pausing.

const env = installWgRouteMocks();
mock.module('@/core/idempotency-store', {
	namedExports: {
		claimResponseSlot: async () => new Date(),
		getCachedResponse: async () => null,
		readIdempotencyKey: () => null,
		setReplayWarning: async () => undefined,
	},
});
const collection = await import('../src/app/api/wg/[code]/recurring-expenses/route.ts');
const item = await import('../src/app/api/wg/[code]/recurring-expenses/[id]/route.ts');
const { expenses, recurringExpenses, wgMembers } = tables;

type Route = (req: never, ctx: never) => Promise<Response>;

function memberRows(rows: Array<{ id: string; deactivatedAt: Date | null }>) {
	return rows.map((row) => ({ wgId: WG_ID, ...row }));
}

test('both recurring expense PATCH routes guard financial edits without blocking ordinary changes', async () => {
	const OTHER_MEMBER_ID = 'd35ea6ee-e297-4a90-b6df-3e78ce47b395';
	const template = {
		id: EXPENSE_ID,
		wgId: WG_ID,
		createdByMemberId: CALLER_ID,
		description: 'Miete',
		amountCents: 1200,
		paidByMemberId: CALLER_ID,
		intervalMonths: 1,
		nextDueAt: new Date('2026-10-01T00:00:00.000Z'),
		anchorAt: new Date('2026-10-01T00:00:00.000Z'),
		lastCreatedAt: null,
		pausedAt: null,
		splitsJson: JSON.stringify([{ debtorMemberId: CALLER_ID, amountCents: 1200 }]),
		createdAt: new Date('2026-09-01T00:00:00.000Z'),
	};
	const members = memberRows([
		{ id: CALLER_ID, deactivatedAt: null },
		{ id: PAYER_ID, deactivatedAt: null },
		{ id: OTHER_MEMBER_ID, deactivatedAt: null },
	]);
	let updates = 0;
	env.db = {
		select: () => {
			let table: unknown;
			const query = {
				from(nextTable: unknown) {
					table = nextTable;
					return query;
				},
				where(condition: Predicate) {
					const rows =
						table === wgMembers ? members.filter((row) => matches(row, condition)) : [template];
					const result = Promise.resolve(rows) as Promise<unknown[]> & {
						limit: (count: number) => Promise<unknown[]>;
					};
					// The expense lookup stands for the booking that lets a template advance.
					result.limit = async () =>
						table === recurringExpenses || table === expenses ? [template] : [];
					return result;
				},
			};
			return query;
		},
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: () => ({
					returning: async () => {
						updates += 1;
						Object.assign(template, values);
						return [template];
					},
				}),
			}),
		}),
	} as never;

	const endpoints = [
		{ route: collection.PATCH as Route, context: routeContext(), withId: true },
		{ route: item.PATCH as Route, context: routeContext({ id: EXPENSE_ID }), withId: false },
	];
	const [collectionEndpoint, itemEndpoint] = endpoints as [
		(typeof endpoints)[number],
		(typeof endpoints)[number],
	];
	const send = async (endpoint: (typeof endpoints)[number], body: Record<string, unknown>) => {
		const response = await endpoint.route(
			jsonRequest('PATCH', endpoint.withId ? { id: EXPENSE_ID, ...body } : body),
			endpoint.context as never,
		);
		return { status: response.status, body: await response.json() };
	};
	const results = [];
	for (const endpoint of endpoints) {
		results.push(
			await send(endpoint, {
				paidByMemberId: PAYER_ID,
				splits: [{ debtorMemberId: PAYER_ID, amountCents: 1200 }],
			}),
		);
	}

	assert.deepEqual(
		{ results: results.map(({ status, body }) => ({ status, error: body.error })), updates },
		{
			results: [
				{ status: 403, error: 'paid_by_must_include_caller' },
				{ status: 403, error: 'paid_by_must_include_caller' },
			],
			updates: 0,
		},
	);

	const positiveCallerShare = await send(collectionEndpoint, {
		paidByMemberId: PAYER_ID,
		splits: [
			{ debtorMemberId: PAYER_ID, amountCents: 1199 },
			{ debtorMemberId: CALLER_ID, amountCents: 1 },
		],
	});
	const selfPayer = await send(itemEndpoint, {
		paidByMemberId: CALLER_ID,
		splits: [{ debtorMemberId: CALLER_ID, amountCents: 1200 }],
	});
	const legacySplits = [{ debtorMemberId: PAYER_ID, amountCents: 1200 }];
	const reorderedLegacySplits = [
		{ debtorMemberId: PAYER_ID, amountCents: 900 },
		{ debtorMemberId: OTHER_MEMBER_ID, amountCents: 300 },
	];
	Object.assign(template, {
		amountCents: 1200,
		paidByMemberId: PAYER_ID,
		splitsJson: JSON.stringify(legacySplits),
		pausedAt: null,
	});
	const unchangedForeignPayerEdits = [];
	for (const endpoint of endpoints) {
		for (const splits of [legacySplits, reorderedLegacySplits]) {
			Object.assign(template, {
				description: 'Miete',
				amountCents: 1200,
				paidByMemberId: PAYER_ID,
				splitsJson: JSON.stringify(splits),
			});
			unchangedForeignPayerEdits.push(
				await send(endpoint, {
					description: 'Miete angepasst',
					amountCents: 1200,
					paidByMemberId: PAYER_ID,
					intervalMonths: 1,
					nextDueAt: '2026-10-01T00:00:00.000Z',
					splits: [...splits].reverse(),
				}),
			);
		}
	}
	Object.assign(template, {
		description: 'Miete',
		amountCents: 1200,
		paidByMemberId: PAYER_ID,
		splitsJson: JSON.stringify(legacySplits),
	});
	const updatesBeforeRejectedEdits = updates;
	const rejectedFinancialEdits = [];
	for (const endpoint of endpoints) {
		rejectedFinancialEdits.push(
			await send(endpoint, {
				amountCents: 1300,
				paidByMemberId: PAYER_ID,
				splits: [{ debtorMemberId: PAYER_ID, amountCents: 1300 }],
			}),
			await send(endpoint, {
				amountCents: 1200,
				paidByMemberId: PAYER_ID,
				splits: [
					{ debtorMemberId: PAYER_ID, amountCents: 1000 },
					{ debtorMemberId: OTHER_MEMBER_ID, amountCents: 200 },
				],
			}),
			await send(endpoint, {
				amountCents: 1200,
				paidByMemberId: OTHER_MEMBER_ID,
				splits: legacySplits,
			}),
		);
	}
	const ordinaryChanges = [
		await send(collectionEndpoint, { description: 'Miete angepasst' }),
		await send(collectionEndpoint, { nextDueAt: '2026-11-01T00:00:00.000Z' }),
		await send(collectionEndpoint, { expectedNextDueAt: template.nextDueAt.toISOString() }),
		await send(itemEndpoint, { description: 'Miete angepasst' }),
		await send(itemEndpoint, { nextDueAt: '2026-12-01T00:00:00.000Z' }),
		await send(itemEndpoint, { paused: true }),
		await send(itemEndpoint, { paused: false }),
	];

	assert.equal(positiveCallerShare.status, 200);
	assert.equal(selfPayer.status, 200);
	assert.deepEqual(
		unchangedForeignPayerEdits.map((result) => result.status),
		[200, 200, 200, 200],
	);
	assert.deepEqual(
		rejectedFinancialEdits.map((result) => result.status),
		[403, 403, 403, 403, 403, 403],
	);
	assert.equal(updates, updatesBeforeRejectedEdits + 7);
	assert.deepEqual(
		ordinaryChanges.map((result) => result.status),
		[200, 200, 200, 200, 200, 200, 200],
	);
});

test('recurring expense PATCH rejects an inactive payer', async () => {
	const inactiveId = '24ba761e-a429-45c3-a311-18e9a44b9be8';
	const activeDebtorId = 'f2e2a748-3888-44fc-8c3c-6badfcad5690';
	const template = {
		id: EXPENSE_ID,
		wgId: WG_ID,
		createdByMemberId: CALLER_ID,
		description: 'Miete',
		amountCents: 1200,
		paidByMemberId: CALLER_ID,
		intervalMonths: 1,
		nextDueAt: new Date('2026-10-01T00:00:00.000Z'),
		lastCreatedAt: null,
		pausedAt: null,
		splitsJson: JSON.stringify([{ debtorMemberId: activeDebtorId, amountCents: 1200 }]),
		createdAt: new Date('2026-09-01T00:00:00.000Z'),
	};
	const members = memberRows([
		{ id: activeDebtorId, deactivatedAt: null },
		{ id: inactiveId, deactivatedAt: new Date('2026-09-10T00:00:00.000Z') },
	]);
	env.db = {
		select: () => {
			let table: unknown;
			let condition: Predicate | undefined;
			const rows = () =>
				table === recurringExpenses
					? [template]
					: table === wgMembers
						? members.filter((row) => !condition || matches(row, condition))
						: [];
			const query = {
				from(nextTable: unknown) {
					table = nextTable;
					return query;
				},
				where(nextCondition: Predicate) {
					condition = nextCondition;
					return query;
				},
				...thenableQuery(rows),
			};
			return query;
		},
		update: () => ({
			set: () => ({ where: () => ({ returning: async () => [template] }) }),
		}),
	} as never;
	// The caller bears the template's only share, so the payer guard passes and the member check decides.
	env.requireWgMember = async () => ({
		ok: true,
		wg: { id: WG_ID },
		member: { memberId: activeDebtorId, name: 'Mina' },
	});

	const response = await item.PATCH(
		jsonRequest('PATCH', { paidByMemberId: inactiveId }),
		routeContext({ id: EXPENSE_ID }),
	);

	assert.equal(response.status, 400);
	assert.equal(await errorOf(response), 'member_not_in_wg');
});

test('recurring expense creation requires the caller to bear a positive share', async () => {
	let members = [{ id: PAYER_ID }];
	let insertCount = 0;
	const tx = {
		insert: () => ({
			values: (value: Record<string, unknown>) => ({
				returning: async () => {
					insertCount += 1;
					return [
						{
							...value,
							id: EXPENSE_ID,
							createdAt: new Date(),
							lastCreatedAt: null,
							pausedAt: null,
						},
					];
				},
			}),
		}),
	};
	env.db = { select: () => ({ from: () => ({ where: async () => members }) }) } as never;
	env.requireWgMember = async () => ({
		ok: true,
		wg: { id: WG_ID, name: 'WG', shareCode: 'MTE8PZAT' },
		member: { memberId: CALLER_ID, name: 'Mina' },
	});
	env.payments = {
		...env.payments,
		withExpensePaymentLock: async (_wgId: string, operation: (tx: unknown) => Promise<unknown>) =>
			operation(tx),
	};
	const post = (splits: Array<{ debtorMemberId: string; amountCents: number }>) =>
		collection.POST(
			jsonRequest('POST', {
				description: 'Miete',
				amountCents: 1200,
				paidByMemberId: PAYER_ID,
				nextDueAt: new Date(Date.now() + 86_400_000).toISOString(),
				splits,
			}) as never,
			routeContext(),
		);

	const fabricated = await post([{ debtorMemberId: PAYER_ID, amountCents: 1200 }]);
	assert.equal(fabricated.status, 403);
	assert.equal(await errorOf(fabricated), 'paid_by_must_include_caller');
	assert.equal(insertCount, 0);

	members = [{ id: PAYER_ID }, { id: CALLER_ID }];
	const zeroShare = await post([
		{ debtorMemberId: PAYER_ID, amountCents: 1200 },
		{ debtorMemberId: CALLER_ID, amountCents: 0 },
	]);
	assert.equal(zeroShare.status, 403);
	assert.equal(await errorOf(zeroShare), 'paid_by_must_include_caller');
	assert.equal(insertCount, 0);

	const includedCaller = await post([
		{ debtorMemberId: PAYER_ID, amountCents: 1199 },
		{ debtorMemberId: CALLER_ID, amountCents: 1 },
	]);
	assert.equal(includedCaller.status, 200);
	assert.equal(insertCount, 1);
});

// Pausing a template after one of its participants left.
const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const DEPARTED_ID = '22222222-2222-4222-8222-222222222222';
const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333';

async function patchWithDepartedMember(body: Record<string, unknown>, paused = false) {
	const template = {
		id: TEMPLATE_ID,
		wgId: WG_ID,
		createdByMemberId: MEMBER_ID,
		paidByMemberId: MEMBER_ID,
		description: 'Internet',
		amountCents: 1000,
		intervalMonths: 1,
		nextDueAt: new Date(),
		createdAt: new Date(),
		lastCreatedAt: null,
		pausedAt: paused ? new Date() : null,
		splitsJson: JSON.stringify([{ debtorMemberId: DEPARTED_ID, amountCents: 1000 }]),
	};
	const members = memberRows([
		{ id: MEMBER_ID, deactivatedAt: null },
		{ id: DEPARTED_ID, deactivatedAt: new Date('2026-09-01T00:00:00.000Z') },
	]);
	let writes = 0;
	env.db = {
		select: () => ({
			from: (table: unknown) => ({
				where: (condition: Predicate) =>
					thenableQuery(() =>
						table === recurringExpenses
							? [template]
							: members.filter((row) => matches(row, condition)),
					),
			}),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: () => ({
					returning: async () => {
						writes += 1;
						return [{ ...template, ...values }];
					},
				}),
			}),
		}),
	} as never;
	env.requireWgMember = async () => ({
		ok: true,
		wg: { id: WG_ID },
		member: { memberId: MEMBER_ID, name: 'Anna' },
	});
	const response = await item.PATCH(jsonRequest('PATCH', body), routeContext({ id: TEMPLATE_ID }));
	return { response, writes };
}

test('an existing subscription can be paused after a participant leaves', async () => {
	const { response, writes } = await patchWithDepartedMember({ paused: true });
	assert.equal(response.status, 200);
	assert.notEqual(
		((await response.json()) as { recurringExpense: { pausedAt: unknown } }).recurringExpense
			.pausedAt,
		null,
	);
	assert.equal(writes, 1);
});

test('inactive participants still block resuming and changing finances', async () => {
	const financial = {
		amountCents: 2000,
		splits: [{ debtorMemberId: DEPARTED_ID, amountCents: 2000 }],
	};
	for (const body of [{ paused: false }, financial]) {
		const { response, writes } = await patchWithDepartedMember(body, true);
		assert.equal(response.status, 400);
		assert.equal(await errorOf(response), 'member_not_in_wg');
		assert.equal(writes, 0);
	}
});
