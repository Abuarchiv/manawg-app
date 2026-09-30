import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { isTerminalPayPalOrderCreationError } from '../src/core/infra/paypal.ts';
import { computeNetBalances, simplifyDebts } from '../src/features/expenses/debt-reduction.ts';
import type { DebtExpenseInput, PairBalance } from '../src/features/expenses/debts.ts';
import type { ExpensePaymentInput } from '../src/features/expenses/expense-payments.ts';
import {
	isPayPalCaptureDebtChanged,
	parsePayPalAmountCents,
	terminalPayPalCaptureOutcome,
} from '../src/features/expenses/paypal-settlement.ts';

const CAPTURE_ROUTE_PATH = path.join(
	process.cwd(),
	'src/app/api/wg/[code]/paypal/capture/route.ts',
);
const ORDER_ROUTE_PATH = path.join(process.cwd(), 'src/app/api/wg/[code]/paypal/order/route.ts');
const DEBTS_PATH = path.join(process.cwd(), 'src/features/expenses/debts.ts');
const wgId = '550e8400-e29b-41d4-a716-446655440000';
const payerId = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';
const payeeId = '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55';
const providerOrderId = 'paypal-order-1';

type RouteModule = {
	GET?: (request: Request, context: { code: string }) => Promise<Response>;
	POST: (request: Request, context: { code: string }) => Promise<Response>;
};

function loadRoute<T>(routePath: string, overrides: Record<string, unknown>): T {
	const compiled = transpileModule(readFileSync(routePath, 'utf8'), {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} as T };
	const realRequire = createRequire(routePath);
	new Function('require', 'module', 'exports', compiled)(
		(name: string) => (Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name)),
		module,
		module.exports,
	);
	return module.exports;
}

const { computeBalances } = loadRoute<{
	computeBalances: (
		expenses: ReadonlyArray<DebtExpenseInput>,
		payments?: ReadonlyArray<ExpensePaymentInput>,
	) => PairBalance[];
}>(DEBTS_PATH, { '@/core/utils/time': { MS_PER_DAY: 86_400_000 } });

function jsonResponse(body: unknown, init: number | ResponseInit = 200): Response {
	const status = typeof init === 'number' ? init : (init.status ?? 200);
	return new Response(JSON.stringify(body), {
		...(typeof init === 'number' ? {} : init),
		status,
		headers: { 'content-type': 'application/json' },
	});
}

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
	const expensePayments = {
		id: 'payment.id',
		wgId: 'payment.wgId',
		provider: 'payment.provider',
		providerOrderId: 'payment.providerOrderId',
		fromMemberId: 'payment.fromMemberId',
		toMemberId: 'payment.toMemberId',
		payeeMerchantId: 'payment.payeeMerchantId',
		status: 'payment.status',
		expiresAt: 'payment.expiresAt',
	};
	const wgMembers = {
		id: 'member.id',
		wgId: 'member.wgId',
		name: 'member.name',
		color: 'member.color',
		paypalMerchantId: 'member.paypalMerchantId',
	};
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
	let lockHeld = false;
	let paymentSequence = 0;

	function nextResponse(
		queue: ProviderResponse[],
		fallback: ProviderResponse,
	): Record<string, unknown> {
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
	const db = { select: selectQuery };
	const commonOverrides = {
		'@/core/db': { db, expensePayments, wgMembers },
		'@/core/errors': {
			badRequest: (code: string) => jsonResponse({ error: code }, 400),
			conflict: (code: string) => jsonResponse({ error: code }, 409),
			forbidden: (code: string) => jsonResponse({ error: code }, 403),
			requireVerifiedMember: () => null,
			serverError: (code: string) => jsonResponse({ error: code }, 500),
			tooMany: () => jsonResponse({ error: 'too_many' }, 429),
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId },
				member: { memberId: payerId, name: 'Mina', verified: true },
				authUserId: payerId,
			}),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_name: string, handler: unknown) => handler },
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/infra/paypal-onboarding': { isPayPalMerchantReady: async () => true },
		'@/features/expenses/open-expenses': {
			loadOpenExpenses: async () => openExpenses,
		},
		'@/core/rate-limit': {
			checkRateLimit: async () => ({ success: true }),
			wgWriteLimiter: {},
		},
		'@/features/expenses/debt-reduction': {
			computeNetBalances,
			simplifyDebts,
		},
		'@/features/expenses/debts': {
			computeBalances,
		},
		'@/features/expenses/expense-payments': {
			PAYPAL_ORDER_TTL_MS: 10_000,
			loadCompletedExpensePayments: async () => options.completedPayments ?? [],
			hasCapturingExpensePayment: async () => options.anotherCaptureActive ?? false,
			withExpensePaymentLock: async (
				_id: string,
				operation: (value: typeof tx) => Promise<unknown>,
			) => {
				lockHeld = true;
				try {
					return await operation(tx);
				} finally {
					lockHeld = false;
				}
			},
		},
		'drizzle-orm': {
			and: (...conditions: unknown[]) => conditions,
			eq: (column: unknown, value: unknown) => ({ column, value }),
			gt: (column: unknown, value: unknown) => ({ column, value }),
			inArray: (column: unknown, values: unknown[]) => ({ column, values }),
			lte: (column: unknown, value: unknown) => ({ column, value }),
			sql: () => ({}),
		},
		'next/server': { NextResponse: { json: jsonResponse } },
	};
	const captureRoute = loadRoute<RouteModule>(CAPTURE_ROUTE_PATH, {
		...commonOverrides,
		'@/core/audit': { recordAuditEvent: async () => undefined },
		'@/core/db/account-deletion': {
			lockActiveAccountMember: async () => {
				if (lockHeld) return { memberId: payerId };
				return { memberId: payerId };
			},
		},
		'@/core/infra/paypal': {
			capturePayPalOrder: async (id: string) => {
				captureOrderIds.push(id);
				return nextResponse(captureResponses, completedOrder());
			},
			getPayPalOrder: async (id: string) => {
				readOrderIds.push(id);
				return nextResponse(orderResponses, completedOrder());
			},
			isPayPalConfigured: () => true,
		},
		'@/features/expenses/paypal-settlement': {
			isPayPalCaptureDebtChanged,
			parsePayPalAmountCents,
			terminalPayPalCaptureOutcome,
		},
	});
	const orderRoute = loadRoute<RouteModule>(ORDER_ROUTE_PATH, {
		...commonOverrides,
		'@/core/infra/paypal': {
			createPayPalOrder: async (input: Record<string, unknown>) => {
				createdOrderInputs.push(input);
				const error = createdOrderErrors.shift();
				if (error) throw error;
				return { id: createdOrderIds.shift() ?? 'paypal-order-extra' };
			},
			isPayPalConfigured: () => true,
			isTerminalPayPalOrderCreationError,
		},
	});

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
	expect(first.status).toBe(202);
	expect(await first.json()).toMatchObject({ status: 'PENDING' });
	expect(fixture.payment.status).toBe('capturing');

	const current = await fixture.lookupOrder();
	expect(current.status).toBe(200);
	const activeOrder = await current.json();
	expect(activeOrder).toMatchObject({ status: 'CAPTURING', orderId: providerOrderId });

	const duplicate = await fixture.createOrder();
	expect(duplicate.status).toBe(409);
	expect(await duplicate.json()).toEqual({ error: 'paypal_order_in_progress' });

	const second = await fixture.capture(activeOrder.orderId);
	expect(second.status).toBe(200);
	expect(await second.json()).toMatchObject({
		status: 'COMPLETED',
		amountCents: 1200,
		currency: 'EUR',
	});
	expect(fixture.payment.status).toBe('completed');
	expect(fixture.captureOrderIds).toEqual([providerOrderId]);
	expect(fixture.readOrderIds).toEqual([providerOrderId]);
	expect(fixture.createdOrderInputs).toHaveLength(0);
});

test('reservation placeholders are hidden from clients and cannot enter capture', async () => {
	const fixture = createPayPalFixture({ initialOrderId: 'pending:reservation' });
	const lookup = await fixture.lookupOrder();
	expect(await lookup.json()).toEqual({ status: 'CREATING' });

	const capture = await fixture.capture('pending:reservation');
	expect(capture.status).toBe(409);
	expect(await capture.json()).toEqual({ error: 'paypal_order_unavailable' });
	expect(fixture.payment.status).toBe('created');
	expect(fixture.captureOrderIds).toHaveLength(0);
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
	expect(before).toContainEqual(
		expect.objectContaining({ fromId: payerId, toId: payeeId, cents: 1_000 }),
	);
	expect(after.some((debt) => debt.fromId === payerId && debt.toId === payeeId)).toBe(false);

	const fixture = createPayPalFixture({
		initialStatus: 'capturing',
		initialAmountCents: 1_000,
		members,
		expenses,
		completedPayments,
		orderResponses: [completedOrder({ amount: '10.00' })],
	});
	const response = await fixture.capture();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ status: 'COMPLETED', amountCents: 1_000 });
	expect(fixture.payment.status).toBe('completed');
	expect(fixture.readOrderIds).toEqual([providerOrderId]);
	expect(fixture.captureOrderIds).toHaveLength(0);
});

test('a new capture stays unclaimed while another WG capture is pending', async () => {
	const fixture = createPayPalFixture({ anotherCaptureActive: true });
	const response = await fixture.capture();
	expect(response.status).toBe(202);
	expect(await response.json()).toMatchObject({ status: 'PENDING' });
	expect(fixture.payment.status).toBe('created');
	expect(fixture.captureOrderIds).toHaveLength(0);
	expect(fixture.readOrderIds).toHaveLength(0);
	const lookup = await fixture.lookupOrder();
	expect(await lookup.json()).toMatchObject({ status: 'WAITING', orderId: providerOrderId });
});

test('an ambiguous order creation retries the same reservation with the same provider key', async () => {
	const fixture = createPayPalFixture({
		initialStatus: 'failed',
		createdOrderErrors: [new Error('create response lost')],
		createdOrderIds: ['paypal-order-created-once'],
	});
	const first = await fixture.createOrder();
	expect(first.status).toBe(500);
	expect(fixture.payment.status).toBe('created');
	const reservationId = fixture.payment.id;
	expect(String(fixture.payment.providerOrderId)).toMatch(/^pending:/);

	const retry = await fixture.createOrder();
	expect(retry.status).toBe(200);
	expect(await retry.json()).toMatchObject({ orderId: 'paypal-order-created-once' });
	expect(fixture.payment.id).toBe(reservationId);
	expect(fixture.payment.providerOrderId).toBe('paypal-order-created-once');
	expect(fixture.createdOrderInputs).toHaveLength(2);
	expect(fixture.createdOrderInputs[0].requestId).toBe(reservationId);
	expect(fixture.createdOrderInputs[1].requestId).toBe(reservationId);
});

test('a definitive Payee rejection frees the reservation for a corrected merchant', async () => {
	const fixture = createPayPalFixture({
		initialStatus: 'failed',
		createdOrderErrors: [new Error('paypal_api_422_PAYEE_ACCOUNT_INVALID')],
		createdOrderIds: ['paypal-order-after-correction'],
	});
	const first = await fixture.createOrder();
	expect(first.status).toBe(500);
	expect(fixture.payment.status).toBe('failed');
	const rejectedRequestId = fixture.createdOrderInputs[0].requestId;

	fixture.updatePayeeMerchantId('merchant-corrected');
	const retry = await fixture.createOrder();
	expect(retry.status).toBe(200);
	expect(fixture.payment.status).toBe('created');
	expect(fixture.createdOrderInputs[1].payeeMerchantId).toBe('merchant-corrected');
	expect(fixture.createdOrderInputs[1].requestId).not.toBe(rejectedRequestId);
});

test('a lost capture response is reconciled from PayPal without retrying a new order', async () => {
	const fixture = createPayPalFixture({
		captureResponses: [new Error('capture response lost')],
		orderResponses: [completedOrder()],
	});
	const response = await fixture.capture();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ status: 'COMPLETED' });
	expect(fixture.payment.status).toBe('completed');
	expect(fixture.captureOrderIds).toEqual([providerOrderId]);
	expect(fixture.readOrderIds).toEqual([providerOrderId]);
});

test('an incomplete capture response is expanded with the same order before settlement', async () => {
	const fixture = createPayPalFixture({
		captureResponses: [{ id: providerOrderId, status: 'COMPLETED' }],
		orderResponses: [completedOrder()],
	});
	const response = await fixture.capture();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ status: 'COMPLETED' });
	expect(fixture.payment.status).toBe('completed');
	expect(fixture.captureOrderIds).toEqual([providerOrderId]);
	expect(fixture.readOrderIds).toEqual([providerOrderId]);
});

test('an ambiguous capture stays pending when PayPal status lookup is unavailable', async () => {
	const fixture = createPayPalFixture({
		captureResponses: [new Error('capture response lost'), completedOrder()],
		orderResponses: [new Error('status lookup unavailable')],
	});
	const first = await fixture.capture();
	expect(first.status).toBe(202);
	expect(await first.json()).toMatchObject({ status: 'PENDING' });
	expect(fixture.payment.status).toBe('capturing');

	const second = await fixture.capture();
	expect(second.status).toBe(200);
	expect(await second.json()).toMatchObject({ status: 'COMPLETED' });
	expect(fixture.payment.status).toBe('completed');
});

test('definitive capture failure or a voided order releases the active payment', async () => {
	for (const [providerResult, expectedStatus] of [
		[completedOrder({ captureStatus: 'DECLINED' }), 'FAILED'],
		[{ id: providerOrderId, status: 'VOIDED', purchase_units: [] }, 'CANCELLED'],
	] as const) {
		const fixture = createPayPalFixture({ captureResponses: [providerResult] });
		const capture = await fixture.capture();
		expect(capture.status).toBe(200);
		expect(await capture.json()).toMatchObject({ status: expectedStatus });
		expect(fixture.payment.status).toBe('failed');

		const replacement = await fixture.createOrder();
		expect(replacement.status).toBe(200);
		expect(await replacement.json()).toMatchObject({ orderId: 'paypal-order-replacement' });
		expect(fixture.createdOrderInputs).toHaveLength(1);
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
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: 'paypal_payment_not_completed' });
		expect(fixture.payment.status).toBe('capturing');
	}
});

test('provider results without the persisted order identity stay unresolved', async () => {
	const noOrderId = completedOrder();
	noOrderId.id = undefined;
	for (const providerResult of [noOrderId, { ...completedOrder(), id: 'paypal-other-order' }]) {
		const fixture = createPayPalFixture({ captureResponses: [providerResult] });
		const response = await fixture.capture();
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ status: 'PENDING' });
		expect(fixture.payment.status).toBe('capturing');
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

	expect(simplifyDebts(computeNetBalances(expenses, members))).toContainEqual(
		expect.objectContaining({ fromId: payerId, toId: payeeId, cents: 1_000, currency: 'EUR' }),
	);
	expect(
		computeBalances(expenses).some(
			(debt) => debt.debtorId === payerId && debt.creditorId === payeeId && debt.currency === 'EUR',
		),
	).toBe(false);

	const fixture = createPayPalFixture({
		initialAmountCents: 1_000,
		members,
		expenses,
		captureResponses: [completedOrder({ amount: '10.00' })],
	});
	const response = await fixture.capture();

	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: 'debt_changed' });
	expect(fixture.payment.status).toBe('failed');
	expect(fixture.captureOrderIds).toEqual([]);
	expect(fixture.readOrderIds).toEqual([]);
});
