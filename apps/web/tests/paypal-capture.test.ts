import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { isTerminalPayPalOrderCreationError } from '../src/core/infra/paypal.ts';
import { computeNetBalances, simplifyDebts } from '../src/features/expenses/debt-reduction.ts';
import { computeBalances } from '../src/features/expenses/debts.ts';
import type { DebtExpenseInput } from '../src/features/expenses/debts.ts';
import type { ExpensePaymentInput } from '../src/features/expenses/expense-payment-input.ts';

// PayPal capture state machine (server contracts, no browser).
// Why: a capture must settle exactly once and must not run for members who left the WG.
// The capture and order routes run for real against an in-memory payment row; only their
// collaborators (database, guards, PayPal client) are replaced.

const wgId = '550e8400-e29b-41d4-a716-446655440000';
const payerId = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';
const payeeId = '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55';
const providerOrderId = 'paypal-order-1';

const expensePayments = {
	id: 'payment.id',
	wgId: 'payment.wgId',
	provider: 'payment.provider',
	providerOrderId: 'payment.providerOrderId',
	fromMemberId: 'payment.fromMemberId',
	toMemberId: 'payment.toMemberId',
	payeeMerchantId: 'payment.payeeMerchantId',
	status: 'payment.status',
	amountCents: 'payment.amountCents',
	expiresAt: 'payment.expiresAt',
};
const wgMembers = {
	id: 'member.id',
	wgId: 'member.wgId',
	name: 'member.name',
	color: 'member.color',
	paypalMerchantId: 'member.paypalMerchantId',
};

const jsonResponse = (body: unknown, init: number | ResponseInit = 200): Response =>
	Response.json(body, typeof init === 'number' ? { status: init } : init);

/** Per-test collaborators; the module mocks below delegate to the fixture created last. */
interface Collaborators {
	select: (selection?: Record<string, unknown>) => unknown;
	lockActiveAccountMember: () => Promise<{ memberId: string } | null>;
	capturePayPalOrder: (id: string) => Promise<Record<string, unknown>>;
	getPayPalOrder: (id: string) => Promise<Record<string, unknown>>;
	createPayPalOrder: (input: Record<string, unknown>) => Promise<{ id: string }>;
	loadOpenExpenses: () => Promise<DebtExpenseInput[]>;
	loadCompletedExpensePayments: () => Promise<ExpensePaymentInput[]>;
	hasCapturingExpensePayment: () => Promise<boolean>;
	withExpensePaymentLock: (
		id: string,
		operation: (tx: unknown) => Promise<unknown>,
	) => Promise<unknown>;
}
let active: Collaborators;

mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => undefined } });
mock.module('@/core/db', {
	namedExports: {
		db: { select: (selection?: Record<string, unknown>) => active.select(selection) },
		expensePayments,
		wgMembers,
	},
});
mock.module('@/core/db/account-deletion', {
	namedExports: { lockActiveAccountMember: () => active.lockActiveAccountMember() },
});
mock.module('@/core/http/api-errors', {
	namedExports: {
		badRequest: (code: string) => jsonResponse({ error: code }, 400),
		conflict: (code: string) => jsonResponse({ error: code }, 409),
		forbidden: (code: string) => jsonResponse({ error: code }, 403),
		payloadTooLarge: () => jsonResponse({ error: 'payload_too_large' }, 413),
		serverError: (code: string) => jsonResponse({ error: code }, 500),
		tooMany: () => jsonResponse({ error: 'too_many' }, 429),
	},
});
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: wgId },
			member: { memberId: payerId, name: 'Mina' },
			authUserId: payerId,
		}),
	},
});
mock.module('@/core/guards/with-wg-route', {
	namedExports: { withWgRoute: (_name: string, handler: unknown) => handler },
});
mock.module('@/core/infra/observability', { namedExports: { logApiError: () => undefined } });
mock.module('@/core/infra/paypal', {
	namedExports: {
		capturePayPalOrder: (id: string) => active.capturePayPalOrder(id),
		getPayPalOrder: (id: string) => active.getPayPalOrder(id),
		createPayPalOrder: (input: Record<string, unknown>) => active.createPayPalOrder(input),
		isPayPalConfigured: () => true,
		isTerminalPayPalOrderCreationError,
	},
});
mock.module('@/core/infra/paypal-onboarding', {
	namedExports: { isPayPalMerchantReady: async () => true },
});
mock.module('@/core/rate-limit', {
	namedExports: { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
});
mock.module('@/features/expenses/server/settle-notify', {
	namedExports: {
		notifySettlement: async () => undefined,
		announcePayPalSettlement: async () => undefined,
	},
});
mock.module('@/features/expenses/server/open-expenses', {
	namedExports: { loadOpenExpenses: () => active.loadOpenExpenses() },
});
mock.module('@/features/expenses/server/expense-payments', {
	namedExports: {
		PAYPAL_ORDER_TTL_MS: 10_000,
		loadCompletedExpensePayments: () => active.loadCompletedExpensePayments(),
		hasCapturingExpensePayment: () => active.hasCapturingExpensePayment(),
		withExpensePaymentLock: (id: string, operation: (tx: unknown) => Promise<unknown>) =>
			active.withExpensePaymentLock(id, operation),
	},
});
mock.module('drizzle-orm', {
	namedExports: {
		and: (...conditions: unknown[]) => conditions,
		eq: (column: unknown, value: unknown) => ({ column, value }),
		gt: (column: unknown, value: unknown) => ({ column, value }),
		inArray: (column: unknown, values: unknown[]) => ({ column, values }),
		lte: (column: unknown, value: unknown) => ({ column, value }),
		sql: () => ({}),
	},
});
mock.module('next/server', { namedExports: { NextResponse: { json: jsonResponse } } });

type RouteModule = {
	GET?: (request: Request, context: { code: string }) => Promise<Response>;
	POST: (request: Request, context: { code: string }) => Promise<Response>;
};
const captureRoute = (await import(
	'@/app/api/wg/[code]/paypal/capture/route'
)) as unknown as RouteModule;
const orderRoute = (await import(
	'@/app/api/wg/[code]/paypal/order/route'
)) as unknown as RouteModule;

type ProviderResponse = Record<string, unknown> | Error;

function completedOrder(
	options: {
		orderStatus?: string;
		captureStatus?: string;
		amount?: string;
		currency?: string;
		merchantId?: string;
	} = {},
): Record<string, unknown> {
	return {
		id: providerOrderId,
		status: options.orderStatus ?? 'COMPLETED',
		purchase_units: [
			{
				payee: { merchant_id: options.merchantId ?? 'merchant-1' },
				payments: {
					captures: [
						{
							status: options.captureStatus ?? 'COMPLETED',
							amount: {
								value: options.amount ?? '12.00',
								currency_code: options.currency ?? 'EUR',
							},
						},
					],
				},
			},
		],
	};
}

function createPayPalFixture(
	options: {
		captureResponses?: ProviderResponse[];
		orderResponses?: ProviderResponse[];
		createdOrderIds?: string[];
		createdOrderErrors?: Error[];
		initialOrderId?: string;
		initialStatus?: string;
		initialAmountCents?: number;
		expenses?: DebtExpenseInput[];
		completedPayments?: ExpensePaymentInput[];
		members?: Array<{
			id: string;
			name: string;
			color: string | null;
			paypalMerchantId: string | null;
		}>;
		anotherCaptureActive?: boolean;
	} = {},
) {
	let payment: Record<string, unknown> = {
		id: 'payment-1',
		wgId,
		provider: 'paypal',
		providerOrderId: options.initialOrderId ?? providerOrderId,
		payeeMerchantId: 'merchant-1',
		fromMemberId: payerId,
		toMemberId: payeeId,
		amountCents: options.initialAmountCents ?? 1200,
		currency: 'EUR',
		status: options.initialStatus ?? 'created',
		expiresAt: new Date(Date.now() + 60_000),
	};
	const statusWrites: string[] = [];
	const captureOrderIds: string[] = [];
	const readOrderIds: string[] = [];
	const createdOrderInputs: Array<Record<string, unknown>> = [];
	const captureResponses = [...(options.captureResponses ?? [completedOrder()])];
	const orderResponses = [...(options.orderResponses ?? [])];
	const createdOrderIds = [...(options.createdOrderIds ?? ['paypal-order-replacement'])];
	const createdOrderErrors = [...(options.createdOrderErrors ?? [])];
	const members = (
		options.members ?? [
			{ id: payerId, name: 'Mina', color: 'blue', paypalMerchantId: null },
			{ id: payeeId, name: 'Noah', color: 'green', paypalMerchantId: 'merchant-1' },
		]
	).map((member) => ({ ...member, wgId }));
	const openExpenses = options.expenses ?? [
		{
			paidByMemberId: payeeId,
			currency: 'EUR',
			occurredAt: '2026-09-27T00:00:00.000Z',
			splits: [{ debtorMemberId: payerId, amountCents: 1_200, settledAt: null }],
		},
	];
	let paymentSequence = 0;

	function nextResponse(queue: ProviderResponse[], fallback: ProviderResponse) {
		const response = queue.shift() ?? fallback;
		if (response instanceof Error) throw response;
		return response;
	}

	function selectQuery(initialSelection?: Record<string, unknown>) {
		let selectedTable: unknown;
		let selection = initialSelection;
		let whereCondition: unknown;
		const matches = (row: Record<string, unknown>, condition: unknown): boolean => {
			if (Array.isArray(condition)) return condition.every((item) => matches(row, item));
			if (typeof condition !== 'object' || condition === null) return true;
			const filter = condition as { column?: unknown; value?: unknown; values?: unknown[] };
			if (filter.column === undefined) return true;
			const field = String(filter.column).split('.').at(-1) ?? '';
			if (Array.isArray(filter.values)) return filter.values.includes(row[field]);
			if ('value' in filter) return row[field] === filter.value;
			return true;
		};
		const project = (row: Record<string, unknown>) => {
			if (!selection) return { ...row };
			return Object.fromEntries(
				Object.entries(selection).map(([name, column]) => {
					const field = String(column).split('.').at(-1) ?? name;
					return [name, row[field]];
				}),
			);
		};
		const rows = () => {
			if (selectedTable === expensePayments) {
				const records = [payment];
				if (options.anotherCaptureActive) {
					records.push({
						...payment,
						id: 'other-payment',
						providerOrderId: 'paypal-other-order',
						fromMemberId: '00000000-0000-4000-8000-000000000009',
						status: 'capturing',
					});
				}
				return records
					.filter((row) => row.status !== 'failed' && matches(row, whereCondition))
					.map(project);
			}
			if (selectedTable === wgMembers) {
				return members.filter((row) => matches(row, whereCondition)).map(project);
			}
			return [];
		};
		const chain: Record<PropertyKey, unknown> = new Proxy(
			{},
			{
				get: (_target, key) => {
					if (key === 'then') {
						return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
							Promise.resolve(rows()).then(resolve, reject);
					}
					if (key === 'limit') return async () => rows();
					if (key === 'where') {
						return (condition: unknown) => {
							whereCondition = condition;
							return chain;
						};
					}
					if (key === 'select') {
						return (columns?: Record<string, unknown>) => {
							selection = columns;
							return chain;
						};
					}
					if (key === 'from') {
						return (table: unknown) => {
							selectedTable = table;
							return chain;
						};
					}
					return () => chain;
				},
			},
		);
		return chain;
	}

	const tx = {
		select: selectQuery,
		update: () => ({
			set: (values: Record<string, unknown>) => {
				if (typeof values.status === 'string') statusWrites.push(values.status);
				Object.assign(payment, values);
				return {
					where: () => ({
						returning: async () => [{ ...payment }],
					}),
				};
			},
		}),
		insert: () => ({
			values: (values: Record<string, unknown>) => {
				const result = {
					onConflictDoNothing: () => result,
					returning: async () => {
						payment = {
							...values,
							id: `payment-replacement-${++paymentSequence}`,
							provider: 'paypal',
							status: 'created',
						};
						return [{ id: payment.id }];
					},
				};
				return result;
			},
		}),
	};
	active = {
		select: selectQuery,
		lockActiveAccountMember: async () => ({ memberId: payerId }),
		capturePayPalOrder: async (id) => {
			captureOrderIds.push(id);
			return nextResponse(captureResponses, completedOrder());
		},
		getPayPalOrder: async (id) => {
			readOrderIds.push(id);
			return nextResponse(orderResponses, completedOrder());
		},
		createPayPalOrder: async (input) => {
			createdOrderInputs.push(input);
			const error = createdOrderErrors.shift();
			if (error) throw error;
			return { id: createdOrderIds.shift() ?? 'paypal-order-extra' };
		},
		loadOpenExpenses: async () => openExpenses,
		loadCompletedExpensePayments: async () => options.completedPayments ?? [],
		hasCapturingExpensePayment: async () => options.anotherCaptureActive ?? false,
		withExpensePaymentLock: (_id, operation) => operation(tx),
	};

	const capture = (orderId = providerOrderId) =>
		captureRoute.POST(
			new Request('http://localhost/api/wg/test/paypal/capture', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ orderId }),
			}),
			{ code: 'test' },
		);
	const lookupOrder = (toMemberId = payeeId) => {
		if (!orderRoute.GET) throw new Error('PayPal order status lookup is missing');
		return orderRoute.GET(
			new Request(`http://localhost/api/wg/test/paypal/order?toMemberId=${toMemberId}`),
			{ code: 'test' },
		);
	};
	const createOrder = () =>
		orderRoute.POST(
			new Request('http://localhost/api/wg/test/paypal/order', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ fromMemberId: payerId, toMemberId: payeeId, currency: 'EUR' }),
			}),
			{ code: 'test' },
		);

	return {
		capture,
		lookupOrder,
		createOrder,
		get payment() {
			return payment;
		},
		statusWrites,
		captureOrderIds,
		readOrderIds,
		createdOrderInputs,
		updatePayeeMerchantId: (merchantId: string) => {
			const payee = members[1];
			if (payee) payee.paypalMerchantId = merchantId;
		},
	};
}

test('pending capture stays active, survives remount, and completes on the same provider order', async () => {
	const fixture = createPayPalFixture({
		captureResponses: [completedOrder({ captureStatus: 'PENDING' }), completedOrder()],
	});
	const first = await fixture.capture();
	assert.equal(first.status, 202);
	assert.partialDeepStrictEqual(await first.json(), { status: 'PENDING' });
	assert.equal(fixture.payment.status, 'capturing');

	const current = await fixture.lookupOrder();
	assert.equal(current.status, 200);
	const activeOrder = (await current.json()) as { orderId: string };
	assert.partialDeepStrictEqual(activeOrder, { status: 'CAPTURING', orderId: providerOrderId });

	const duplicate = await fixture.createOrder();
	assert.equal(duplicate.status, 409);
	assert.deepEqual(await duplicate.json(), { error: 'paypal_order_in_progress' });

	const second = await fixture.capture(activeOrder.orderId);
	assert.equal(second.status, 200);
	assert.partialDeepStrictEqual(await second.json(), {
		status: 'COMPLETED',
		amountCents: 1200,
		currency: 'EUR',
	});
	assert.equal(fixture.payment.status, 'completed');
	assert.deepEqual(fixture.captureOrderIds, [providerOrderId]);
	assert.deepEqual(fixture.readOrderIds, [providerOrderId]);
	assert.equal(fixture.createdOrderInputs.length, 0);
});

test('reservation placeholders are hidden from clients and cannot enter capture', async () => {
	const fixture = createPayPalFixture({ initialOrderId: 'pending:reservation' });
	const lookup = await fixture.lookupOrder();
	assert.deepEqual(await lookup.json(), { status: 'CREATING' });

	const capture = await fixture.capture('pending:reservation');
	assert.equal(capture.status, 409);
	assert.deepEqual(await capture.json(), { error: 'paypal_order_unavailable' });
	assert.equal(fixture.payment.status, 'created');
	assert.equal(fixture.captureOrderIds.length, 0);
});

test('a persisted capture reconciles before a reshaped debt graph can invalidate it', async () => {
	const aId = '00000000-0000-4000-8000-000000000001';
	const cId = '00000000-0000-4000-8000-000000000003';
	const eId = '00000000-0000-4000-8000-000000000005';
	const members = [
		{ id: aId, name: 'A', color: null, paypalMerchantId: null },
		{ id: payerId, name: 'B', color: null, paypalMerchantId: null },
		{ id: cId, name: 'C', color: null, paypalMerchantId: null },
		{ id: payeeId, name: 'D', color: null, paypalMerchantId: 'merchant-1' },
		{ id: eId, name: 'E', color: null, paypalMerchantId: null },
	];
	const expenses = [
		{
			paidByMemberId: payeeId,
			currency: 'EUR',
			occurredAt: '2026-09-27T00:00:00.000Z',
			splits: [
				{ debtorMemberId: aId, amountCents: 2_000, settledAt: null },
				{ debtorMemberId: payerId, amountCents: 1_000, settledAt: null },
			],
		},
		{
			paidByMemberId: eId,
			currency: 'EUR',
			occurredAt: '2026-09-27T00:00:00.000Z',
			splits: [
				{ debtorMemberId: payerId, amountCents: 500, settledAt: null },
				{ debtorMemberId: cId, amountCents: 1_000, settledAt: null },
			],
		},
	];
	const completedPayments = [
		{ fromMemberId: aId, toMemberId: payeeId, amountCents: 2_000, currency: 'EUR' },
	];
	const before = simplifyDebts(computeNetBalances(expenses, members, []));
	const after = simplifyDebts(computeNetBalances(expenses, members, completedPayments));
	assert.ok(
		before.some((debt) => debt.fromId === payerId && debt.toId === payeeId && debt.cents === 1_000),
	);
	assert.equal(
		after.some((debt) => debt.fromId === payerId && debt.toId === payeeId),
		false,
	);

	const fixture = createPayPalFixture({
		initialStatus: 'capturing',
		initialAmountCents: 1_000,
		members,
		expenses,
		completedPayments,
		orderResponses: [completedOrder({ amount: '10.00' })],
	});
	const response = await fixture.capture();
	assert.equal(response.status, 200);
	assert.partialDeepStrictEqual(await response.json(), { status: 'COMPLETED', amountCents: 1_000 });
	assert.equal(fixture.payment.status, 'completed');
	assert.deepEqual(fixture.readOrderIds, [providerOrderId]);
	assert.equal(fixture.captureOrderIds.length, 0);
});

test('a new capture stays unclaimed while another WG capture is pending', async () => {
	const fixture = createPayPalFixture({ anotherCaptureActive: true });
	const response = await fixture.capture();
	assert.equal(response.status, 202);
	assert.partialDeepStrictEqual(await response.json(), { status: 'PENDING' });
	assert.equal(fixture.payment.status, 'created');
	assert.equal(fixture.captureOrderIds.length, 0);
	assert.equal(fixture.readOrderIds.length, 0);
	const lookup = await fixture.lookupOrder();
	assert.partialDeepStrictEqual(await lookup.json(), {
		status: 'WAITING',
		orderId: providerOrderId,
	});
});

test('an ambiguous order creation retries the same reservation with the same provider key', async () => {
	const fixture = createPayPalFixture({
		initialStatus: 'failed',
		createdOrderErrors: [new Error('create response lost')],
		createdOrderIds: ['paypal-order-created-once'],
	});
	const first = await fixture.createOrder();
	assert.equal(first.status, 500);
	assert.equal(fixture.payment.status, 'created');
	const reservationId = fixture.payment.id;
	assert.match(String(fixture.payment.providerOrderId), /^pending:/);

	const retry = await fixture.createOrder();
	assert.equal(retry.status, 200);
	assert.partialDeepStrictEqual(await retry.json(), { orderId: 'paypal-order-created-once' });
	assert.equal(fixture.payment.id, reservationId);
	assert.equal(fixture.payment.providerOrderId, 'paypal-order-created-once');
	assert.equal(fixture.createdOrderInputs.length, 2);
	assert.equal(fixture.createdOrderInputs[0]?.requestId, reservationId);
	assert.equal(fixture.createdOrderInputs[1]?.requestId, reservationId);
});

test('a definitive Payee rejection frees the reservation for a corrected merchant', async () => {
	const fixture = createPayPalFixture({
		initialStatus: 'failed',
		createdOrderErrors: [new Error('paypal_api_422_PAYEE_ACCOUNT_INVALID')],
		createdOrderIds: ['paypal-order-after-correction'],
	});
	const first = await fixture.createOrder();
	assert.equal(first.status, 500);
	assert.equal(fixture.payment.status, 'failed');
	const rejectedRequestId = fixture.createdOrderInputs[0]?.requestId;

	fixture.updatePayeeMerchantId('merchant-corrected');
	const retry = await fixture.createOrder();
	assert.equal(retry.status, 200);
	assert.equal(fixture.payment.status, 'created');
	assert.equal(fixture.createdOrderInputs[1]?.payeeMerchantId, 'merchant-corrected');
	assert.notEqual(fixture.createdOrderInputs[1]?.requestId, rejectedRequestId);
});

test('a lost capture response is reconciled from PayPal without retrying a new order', async () => {
	const fixture = createPayPalFixture({
		captureResponses: [new Error('capture response lost')],
		orderResponses: [completedOrder()],
	});
	const response = await fixture.capture();
	assert.equal(response.status, 200);
	assert.partialDeepStrictEqual(await response.json(), { status: 'COMPLETED' });
	assert.equal(fixture.payment.status, 'completed');
	assert.deepEqual(fixture.captureOrderIds, [providerOrderId]);
	assert.deepEqual(fixture.readOrderIds, [providerOrderId]);
});

test('an incomplete capture response is expanded with the same order before settlement', async () => {
	const fixture = createPayPalFixture({
		captureResponses: [{ id: providerOrderId, status: 'COMPLETED' }],
		orderResponses: [completedOrder()],
	});
	const response = await fixture.capture();
	assert.equal(response.status, 200);
	assert.partialDeepStrictEqual(await response.json(), { status: 'COMPLETED' });
	assert.equal(fixture.payment.status, 'completed');
	assert.deepEqual(fixture.captureOrderIds, [providerOrderId]);
	assert.deepEqual(fixture.readOrderIds, [providerOrderId]);
});

test('an ambiguous capture stays pending when PayPal status lookup is unavailable', async () => {
	const fixture = createPayPalFixture({
		captureResponses: [new Error('capture response lost'), completedOrder()],
		orderResponses: [new Error('status lookup unavailable')],
	});
	const first = await fixture.capture();
	assert.equal(first.status, 202);
	assert.partialDeepStrictEqual(await first.json(), { status: 'PENDING' });
	assert.equal(fixture.payment.status, 'capturing');

	const second = await fixture.capture();
	assert.equal(second.status, 200);
	assert.partialDeepStrictEqual(await second.json(), { status: 'COMPLETED' });
	assert.equal(fixture.payment.status, 'completed');
});

test('definitive capture failure or a voided order releases the active payment', async () => {
	for (const [providerResult, expectedStatus] of [
		[completedOrder({ captureStatus: 'DECLINED' }), 'FAILED'],
		[{ id: providerOrderId, status: 'VOIDED', purchase_units: [] }, 'CANCELLED'],
	] as const) {
		const fixture = createPayPalFixture({ captureResponses: [providerResult] });
		const capture = await fixture.capture();
		assert.equal(capture.status, 200);
		assert.partialDeepStrictEqual(await capture.json(), { status: expectedStatus });
		assert.equal(fixture.payment.status, 'failed');

		const replacement = await fixture.createOrder();
		assert.equal(replacement.status, 200);
		assert.partialDeepStrictEqual(await replacement.json(), {
			orderId: 'paypal-order-replacement',
		});
		assert.equal(fixture.createdOrderInputs.length, 1);
	}
});

test('completed captures are not settled when provider payee, amount, or currency differs', async () => {
	for (const providerResult of [
		completedOrder({ merchantId: 'merchant-other' }),
		completedOrder({ amount: '11.99' }),
		completedOrder({ amount: '12.004' }),
		completedOrder({ currency: 'USD' }),
	]) {
		const fixture = createPayPalFixture({ captureResponses: [providerResult] });
		const response = await fixture.capture();
		assert.equal(response.status, 409);
		assert.deepEqual(await response.json(), { error: 'paypal_payment_not_completed' });
		// Not settled, and not left capturing: that would lock the whole WG's finances.
		assert.equal(fixture.payment.status, 'failed');
	}
});

test('provider results without the persisted order identity stay unresolved', async () => {
	const noOrderId = completedOrder();
	noOrderId.id = undefined;
	for (const providerResult of [noOrderId, { ...completedOrder(), id: 'paypal-other-order' }]) {
		const fixture = createPayPalFixture({ captureResponses: [providerResult] });
		const response = await fixture.capture();
		assert.equal(response.status, 202);
		assert.partialDeepStrictEqual(await response.json(), { status: 'PENDING' });
		assert.equal(fixture.payment.status, 'capturing');
	}
});

test('a new capture is refused when its direct debt was replaced by an equal simplified path', async () => {
	const cId = '00000000-0000-4000-8000-000000000003';
	const members = [
		{ id: payerId, name: 'A', color: null, paypalMerchantId: null },
		{ id: payeeId, name: 'B', color: null, paypalMerchantId: 'merchant-1' },
		{ id: cId, name: 'C', color: null, paypalMerchantId: null },
	];
	const expenses: DebtExpenseInput[] = [
		{
			paidByMemberId: cId,
			currency: 'EUR',
			occurredAt: '2026-09-27T00:00:00.000Z',
			splits: [{ debtorMemberId: payerId, amountCents: 1_000, settledAt: null }],
		},
		{
			paidByMemberId: payeeId,
			currency: 'EUR',
			occurredAt: '2026-09-27T00:00:00.000Z',
			splits: [{ debtorMemberId: cId, amountCents: 1_000, settledAt: null }],
		},
	];

	assert.ok(
		simplifyDebts(computeNetBalances(expenses, members)).some(
			(debt) =>
				debt.fromId === payerId &&
				debt.toId === payeeId &&
				debt.cents === 1_000 &&
				debt.currency === 'EUR',
		),
	);
	assert.equal(
		computeBalances(expenses).some(
			(debt) => debt.debtorId === payerId && debt.creditorId === payeeId && debt.currency === 'EUR',
		),
		false,
	);

	const fixture = createPayPalFixture({
		initialAmountCents: 1_000,
		members,
		expenses,
		captureResponses: [completedOrder({ amount: '10.00' })],
	});
	const response = await fixture.capture();

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: 'debt_changed' });
	assert.equal(fixture.payment.status, 'failed');
	assert.deepEqual(fixture.captureOrderIds, []);
	assert.deepEqual(fixture.readOrderIds, []);
});

test('an order the payer never approved is released instead of blocking the WG', async () => {
	const fixture = createPayPalFixture({
		captureResponses: [new Error('ORDER_NOT_APPROVED')],
		orderResponses: [{ id: providerOrderId, status: 'CREATED' }],
	});
	const response = await fixture.capture();
	assert.equal(response.status, 202);
	assert.partialDeepStrictEqual(await response.json(), { status: 'PENDING' });
	assert.equal(fixture.payment.status, 'created');
});

test('a stored order with an outdated amount is replaced by a fresh one', async () => {
	const stale = createPayPalFixture({ initialAmountCents: 900, createdOrderIds: ['fresh-order'] });
	const replaced = await stale.createOrder();
	assert.equal(replaced.status, 200);
	assert.partialDeepStrictEqual(await replaced.json(), {
		orderId: 'fresh-order',
		amountCents: 1200,
	});
	assert.equal(stale.createdOrderInputs[0]?.amountCents, 1200);
	assert.ok(stale.statusWrites.includes('failed'));

	const same = createPayPalFixture();
	const reused = await same.createOrder();
	assert.partialDeepStrictEqual(await reused.json(), {
		orderId: providerOrderId,
		amountCents: 1200,
	});
	assert.equal(same.createdOrderInputs.length, 0);
});
