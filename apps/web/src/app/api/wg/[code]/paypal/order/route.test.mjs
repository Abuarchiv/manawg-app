import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const wgId = '1bc67a5a-5c08-4c0d-8eaf-520def98021a';
const fromMemberId = '2bc67a5a-5c08-4c0d-8eaf-520def98021a';
const toMemberId = '3bc67a5a-5c08-4c0d-8eaf-520def98021a';

function loadOrderRoute(overrides) {
	const source = readFileSync('src/app/api/wg/[code]/paypal/order/route.ts', 'utf8');
	const compiled = transpileModule(source, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

function loadPayPalInfra() {
	const source = readFileSync('src/core/infra/paypal.ts', 'utf8');
	const compiled = transpileModule(source, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(
		(name) => requireFromWeb(name),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

function makeOrderHarness({ isPayPalMerchantReady, createPayPalOrder }) {
	const wgMembers = {
		id: 'id',
		wgId: 'wgId',
		name: 'name',
		color: 'color',
		paypalMerchantId: 'paypalMerchantId',
	};
	const expensePayments = {
		id: 'id',
		wgId: 'wgId',
		fromMemberId: 'fromMemberId',
		toMemberId: 'toMemberId',
		provider: 'provider',
		providerOrderId: 'providerOrderId',
		amountCents: 'amountCents',
		currency: 'currency',
		status: 'status',
		expiresAt: 'expiresAt',
		payeeMerchantId: 'payeeMerchantId',
	};
	const members = [
		{ id: fromMemberId, wgId, name: 'Payer', color: 'blue', paypalMerchantId: null },
		{ id: toMemberId, wgId, name: 'Payee', color: 'green', paypalMerchantId: '2B23456789ABC' },
	];
	const state = { payment: null, failedUpdates: 0 };
	const z = requireFromWeb('zod').z;

	function matches(row, condition) {
		if (!condition) return true;
		if (condition.kind === 'and') return condition.conditions.every((part) => matches(row, part));
		if (condition.kind === 'eq') return row[condition.field] === condition.value;
		if (condition.kind === 'in') return condition.values.includes(row[condition.field]);
		if (condition.kind === 'lte') return row[condition.field] <= condition.value;
		return true;
	}

	function queryBuilder() {
		let rows = [];
		const query = Promise.resolve().then(() => rows);
		Object.assign(query, {
			from(table) {
				rows =
					table === wgMembers
						? members
						: table === expensePayments && state.payment
							? [{ ...state.payment, orderId: state.payment.providerOrderId }]
							: [];
				return query;
			},
			where(condition) {
				rows = rows.filter((row) => matches(row, condition));
				return query;
			},
			limit(count) {
				return Promise.resolve(rows.slice(0, count));
			},
		});
		return query;
	}

	const tx = {
		select: () => queryBuilder(),
		insert: () => ({
			values: (values) => ({
				onConflictDoNothing: () => ({
					returning: async () => {
						if (state.payment) return [];
						state.payment = { ...values, id: 'payment-id', status: 'created' };
						return [{ id: state.payment.id }];
					},
				}),
			}),
		}),
		update: () => ({
			set: (updates) => ({
				where: async (condition) => {
					const matched = Boolean(state.payment && matches(state.payment, condition));
					if (matched) {
						Object.assign(state.payment, updates);
						if (updates.status === 'failed') state.failedUpdates += 1;
					}
					return {
						returning: async () => (matched ? [{ id: state.payment.id }] : []),
					};
				},
			}),
		}),
	};
	const orderRequests = [];
	const terminalPayPalError = loadPayPalInfra().isTerminalPayPalOrderCreationError;
	const dependencies = {
		'@/core/db': { db: {}, expensePayments, wgMembers },
		'@/core/errors': {
			badRequest: (error) => Response.json({ error }, { status: 400 }),
			conflict: (error) => Response.json({ error }, { status: 409 }),
			forbidden: (error) => Response.json({ error }, { status: 403 }),
			requireVerifiedMember: () => null,
			serverError: (error) => Response.json({ error: String(error) }, { status: 500 }),
			tooMany: () => new Response(null, { status: 429 }),
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId },
				member: { memberId: fromMemberId, verified: true },
			}),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_name, handler) => handler },
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/infra/paypal': {
			isPayPalConfigured: () => true,
			isTerminalPayPalOrderCreationError: terminalPayPalError,
			createPayPalOrder: async (input) => {
				orderRequests.push(input);
				return createPayPalOrder(input);
			},
		},
		'@/core/infra/paypal-onboarding': { isPayPalMerchantReady },
		'@/core/rate-limit': {
			checkRateLimit: async () => ({ success: true }),
			wgWriteLimiter: {},
		},
		'@/core/validators/currency': { currencySchema: z.string() },
		'@/features/expenses/debt-reduction': {
			computeNetBalances: () => [],
			simplifyDebts: () => [
				{ fromId: fromMemberId, toId: toMemberId, cents: 1_000, currency: 'EUR' },
			],
		},
		'@/features/expenses/debts': {
			computeBalances: () => [
				{ debtorId: fromMemberId, creditorId: toMemberId, amountCents: 1_000, currency: 'EUR' },
			],
		},
		'@/features/expenses/expense-payments': {
			PAYPAL_ORDER_TTL_MS: 60_000,
			loadCompletedExpensePayments: async () => [],
			withExpensePaymentLock: async (_id, operation) => operation(tx),
		},
		'@/features/expenses/open-expenses': { loadOpenExpenses: async () => [] },
		'drizzle-orm': {
			and: (...conditions) => ({ kind: 'and', conditions }),
			eq: (field, value) => ({ kind: 'eq', field, value }),
			inArray: (field, values) => ({ kind: 'in', field, values }),
			lte: (field, value) => ({ kind: 'lte', field, value }),
			sql: () => ({ kind: 'sql' }),
		},
		'next/server': { NextResponse: Response },
	};
	const { POST } = loadOrderRoute(dependencies);
	const post = () =>
		POST(
			new Request('https://manawg.example/api/paypal/order', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ fromMemberId, toMemberId, currency: 'EUR' }),
			}),
			{ code: 'MTE8PZAT' },
		);
	return { post, state, orderRequests };
}

test('new PayPal order is refused when the recipient has lost provider readiness', async () => {
	const wgMembers = { id: 'id', wgId: 'wgId' };
	const expensePayments = { id: 'id', status: 'status' };
	const debt = { fromId: fromMemberId, toId: toMemberId, cents: 1_000, currency: 'EUR' };
	const members = [
		{ id: fromMemberId, name: 'Payer', color: 'blue', paypalMerchantId: null },
		{ id: toMemberId, name: 'Payee', color: 'green', paypalMerchantId: '2B23456789ABC' },
	];
	const state = { created: 0, failed: false };
	const tx = {
		select: () => {
			let rows = [];
			const query = Promise.resolve().then(() => rows);
			return Object.assign(query, {
				from(value) {
					rows = value === wgMembers ? members : [];
					return this;
				},
				where() {
					return this;
				},
				limit: async () => [],
			});
		},
		insert: () => ({
			values: () => ({
				onConflictDoNothing: () => ({ returning: async () => [{ id: 'payment-id' }] }),
			}),
		}),
		update: () => ({
			set: (values) => ({
				where: async () => {
					if (values.status === 'failed') state.failed = true;
				},
			}),
		}),
	};
	const z = requireFromWeb('zod').z;
	const overrides = {
		'@/core/db': { expensePayments, wgMembers },
		'@/core/errors': {
			badRequest: (error) => Response.json({ error }, { status: 400 }),
			conflict: (error) => Response.json({ error }, { status: 409 }),
			forbidden: (error) => Response.json({ error }, { status: 403 }),
			requireVerifiedMember: () => null,
			serverError: (error) => Response.json({ error }, { status: 500 }),
			tooMany: () => new Response(null, { status: 429 }),
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId },
				member: { memberId: fromMemberId, verified: true },
			}),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_name, handler) => handler },
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/infra/paypal': {
			isPayPalConfigured: () => true,
			createPayPalOrder: async () => {
				state.created += 1;
				return { id: 'order-id' };
			},
		},
		'@/core/infra/paypal-onboarding': { isPayPalMerchantReady: async () => false },
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
		'@/core/validators/currency': { currencySchema: z.string() },
		'@/features/expenses/debt-reduction': {
			computeNetBalances: () => [],
			simplifyDebts: () => [debt],
		},
		'@/features/expenses/debts': {
			computeBalances: () => [
				{ debtorId: fromMemberId, creditorId: toMemberId, amountCents: 1_000, currency: 'EUR' },
			],
		},
		'@/features/expenses/expense-payments': {
			PAYPAL_ORDER_TTL_MS: 60_000,
			loadCompletedExpensePayments: async () => [],
			withExpensePaymentLock: async (_id, operation) => operation(tx),
		},
		'@/features/expenses/open-expenses': { loadOpenExpenses: async () => [] },
		'drizzle-orm': {
			and: () => null,
			eq: () => null,
			inArray: () => null,
			lte: () => null,
			sql: (parts, ...values) => ({ parts, values }),
		},
		'next/server': { NextResponse: Response },
	};
	const { POST } = loadOrderRoute(overrides);
	const response = await POST(
		new Request('https://manawg.example/api/paypal/order', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ fromMemberId, toMemberId, currency: 'EUR' }),
		}),
		{ code: 'MTE8PZAT' },
	);
	assert.equal(response.status, 409);
	assert.equal((await response.json()).error, 'paypal_onboarding_pending');
	assert.equal(state.created, 0);
	assert.equal(state.failed, true);
});

test('late readiness denial cannot release an already advanced reservation', async () => {
	for (const finalState of [
		{ status: 'created', providerOrderId: 'paypal-order-race' },
		{ status: 'capturing', providerOrderId: 'paypal-order-race' },
		{ status: 'completed', providerOrderId: 'paypal-order-race' },
	]) {
		let releaseReadiness;
		let notifyReadinessStarted;
		const readinessStarted = new Promise((resolve) => {
			notifyReadinessStarted = resolve;
		});
		const readinessGate = new Promise((resolve) => {
			releaseReadiness = resolve;
		});
		const harness = makeOrderHarness({
			isPayPalMerchantReady: async () => {
				notifyReadinessStarted();
				return readinessGate;
			},
			createPayPalOrder: async () => {
				throw new Error('order creation must not run after readiness was denied');
			},
		});

		const pendingRequest = harness.post();
		await readinessStarted;
		const paymentId = harness.state.payment.id;
		const pendingOrderId = harness.state.payment.providerOrderId;
		assert.equal(harness.state.payment.status, 'created');
		assert.match(pendingOrderId, /^pending:/);

		// Another request may move the row while PayPal's readiness lookup waits.
		Object.assign(harness.state.payment, finalState);
		releaseReadiness(false);
		const response = await pendingRequest;
		assert.equal(response.status, 409);
		assert.equal((await response.json()).error, 'paypal_onboarding_pending');
		assert.equal(harness.state.payment.id, paymentId);
		assert.equal(harness.state.payment.status, finalState.status);
		assert.equal(harness.state.payment.providerOrderId, finalState.providerOrderId);
		assert.equal(harness.state.failedUpdates, 0);
		assert.equal(harness.orderRequests.length, 0);
	}
});
test('readiness and provider availability failures retry the same pending payment id', async () => {
	let readinessCalls = 0;
	let createCalls = 0;
	const harness = makeOrderHarness({
		isPayPalMerchantReady: async () => {
			readinessCalls += 1;
			if (readinessCalls === 1) throw new Error('paypal_api_503');
			return true;
		},
		createPayPalOrder: async () => {
			createCalls += 1;
			if (createCalls === 1) throw new Error('paypal_api_503');
			return { id: 'paypal-order-recovered' };
		},
	});

	const readinessFailure = await harness.post();
	assert.equal(readinessFailure.status, 500);
	const paymentId = harness.state.payment.id;
	const pendingOrderId = harness.state.payment.providerOrderId;
	assert.match(pendingOrderId, /^pending:/);
	assert.equal(harness.state.payment.status, 'created');
	assert.equal(harness.state.failedUpdates, 0);
	assert.equal(harness.orderRequests.length, 0);

	const providerFailure = await harness.post();
	assert.equal(providerFailure.status, 500);
	assert.equal(harness.state.payment.id, paymentId);
	assert.equal(harness.state.payment.providerOrderId, pendingOrderId);
	assert.equal(harness.state.payment.status, 'created');
	assert.equal(harness.orderRequests.length, 1);
	assert.equal(harness.orderRequests[0].requestId, paymentId);
	assert.equal(harness.state.failedUpdates, 0);

	const recovered = await harness.post();
	assert.equal(recovered.status, 200);
	assert.equal(harness.state.payment.id, paymentId);
	assert.equal(harness.state.payment.providerOrderId, 'paypal-order-recovered');
	assert.equal(harness.orderRequests.length, 2);
	assert.deepEqual(
		harness.orderRequests.map((request) => request.requestId),
		[paymentId, paymentId],
	);
	assert.equal(harness.state.failedUpdates, 0);
});

test('PayPal API helper keeps onboarding status errors, PAYEE classification, and replay headers', async () => {
	const environmentNames = [
		'PAYPAL_ENV',
		'PAYPAL_CLIENT_ID',
		'PAYPAL_CLIENT_SECRET',
		'PAYPAL_PARTNER_ATTRIBUTION_ID',
	];
	const previousEnvironment = Object.fromEntries(
		environmentNames.map((name) => [name, process.env[name]]),
	);
	const previousFetch = globalThis.fetch;
	process.env.PAYPAL_ENV = 'sandbox';
	process.env.PAYPAL_CLIENT_ID = 'test-client';
	process.env.PAYPAL_CLIENT_SECRET = 'test-secret';
	process.env.PAYPAL_PARTNER_ATTRIBUTION_ID = 'BN-CODE';

	const calls = [];
	let responseMode = 'payee-error';
	globalThis.fetch = async (input, init = {}) => {
		const url = String(input);
		const headers = new Headers(init.headers ?? {});
		calls.push({ url, headers, init });
		if (url.endsWith('/v1/oauth2/token')) {
			return Response.json({ access_token: 'test-access-token', expires_in: 300 });
		}
		if (responseMode === 'payee-error') {
			return Response.json({ details: [{ issue: 'PAYEE_ACCOUNT_RESTRICTED' }] }, { status: 403 });
		}
		if (responseMode === 'onboarding-404') {
			return Response.json({ details: [{ issue: 'PAYEE_ACCOUNT_RESTRICTED' }] }, { status: 404 });
		}
		if (url.endsWith('/capture')) {
			return Response.json({
				id: 'paypal-order',
				status: 'COMPLETED',
				purchase_units: [
					{
						payee: { merchant_id: '2B23456789ABC' },
						payments: {
							captures: [
								{
									status: 'COMPLETED',
									amount: { currency_code: 'EUR', value: '12.34' },
								},
							],
						},
					},
				],
			});
		}
		return Response.json({ id: 'paypal-order', status: 'CREATED' });
	};

	try {
		const paypal = loadPayPalInfra();
		assert.equal(
			paypal.isTerminalPayPalOrderCreationError(
				new Error('paypal_api_403_PAYEE_ACCOUNT_RESTRICTED'),
			),
			true,
		);
		assert.equal(
			paypal.isTerminalPayPalOrderCreationError(
				new Error('paypal_api_503_PAYEE_ACCOUNT_RESTRICTED'),
			),
			false,
		);
		assert.equal(paypal.isTerminalPayPalOrderCreationError(new Error('paypal_api_403')), false);

		await assert.rejects(
			paypal.requestPayPalApi('/v2/checkout/orders', { method: 'POST' }, '2B23456789ABC'),
			/paypal_api_403_PAYEE_ACCOUNT_RESTRICTED/,
		);
		assert.ok(calls.at(-1).headers.get('PayPal-Auth-Assertion'));

		responseMode = 'onboarding-404';
		await assert.rejects(
			paypal.requestPayPalApi('/v1/merchant-integrations', { method: 'GET' }),
			/paypal_api_404$/,
		);
		assert.equal(calls.at(-1).headers.get('PayPal-Auth-Assertion'), null);

		responseMode = 'success';
		const created = await paypal.createPayPalOrder({
			amountCents: 1_234,
			currency: 'EUR',
			description: 'Miete',
			payeeMerchantId: '2B23456789ABC',
			customId: 'manawg:wg:payment-id',
			requestId: 'payment-id',
		});
		assert.equal(created.id, 'paypal-order');
		const createRequest = calls.filter((call) => call.url.endsWith('/v2/checkout/orders')).at(-1);
		assert.equal(createRequest.headers.get('PayPal-Request-Id'), 'payment-id');

		const capture = await paypal.capturePayPalOrder('paypal-order', '2B23456789ABC');
		const captureRequest = calls.find((call) => call.url.endsWith('/capture'));
		assert.equal(captureRequest.headers.get('PayPal-Request-Id'), 'paypal-order');
		assert.equal(captureRequest.headers.get('Prefer'), 'return=representation');
		assert.equal(capture.status, 'COMPLETED');
		assert.equal(capture.purchase_units[0].payee.merchant_id, '2B23456789ABC');
		assert.equal(capture.purchase_units[0].payments.captures[0].amount.value, '12.34');
	} finally {
		globalThis.fetch = previousFetch;
		for (const name of environmentNames) {
			if (previousEnvironment[name] === undefined) delete process.env[name];
			else process.env[name] = previousEnvironment[name];
		}
	}
});
