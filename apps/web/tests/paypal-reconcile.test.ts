import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
	parsePayPalAmountCents,
	terminalPayPalCaptureOutcome,
} from '../src/features/expenses/paypal-settlement.ts';

// The module under test imports its siblings with relative specifiers, so those are mocked by URL.
const sibling = (name: string) => new URL(`../src/features/expenses/${name}`, import.meta.url).href;

const harness = {
	writes: 0,
	payment: {
		id: 'payment-1',
		wgId: 'wg-1',
		providerOrderId: 'expected-order',
		payeeMerchantId: 'merchant-1',
		amountCents: 1234,
		currency: 'EUR',
		expiresAt: new Date(),
	},
	order: {} as unknown,
	lookupError: null as Error | null,
};

const query = {
	from: () => query,
	where: () => query,
	orderBy: () => query,
	limit: async () => [harness.payment],
};

mock.module('@/core/audit', {
	namedExports: {
		recordAuditEvent: async () => {
			harness.writes += 1;
		},
	},
});
mock.module('@/core/db', {
	namedExports: { db: { select: () => query }, expensePayments: {}, wgMembers: {} },
});
mock.module('@/core/infra/observability', { namedExports: { logApiError: () => {} } });
mock.module('@/core/infra/paypal', {
	namedExports: {
		getPayPalOrder: async (orderId: string, merchantId: string) => {
			assert.equal(orderId, harness.payment.providerOrderId);
			assert.equal(merchantId, harness.payment.payeeMerchantId);
			if (harness.lookupError) throw harness.lookupError;
			return harness.order;
		},
	},
});
mock.module('@/core/utils/money', { namedExports: { formatEuroCents: () => '12,34 €' } });
mock.module('drizzle-orm', {
	namedExports: { and: () => {}, asc: () => {}, eq: () => {}, lt: () => {} },
});
mock.module(sibling('server/expense-payments.ts'), {
	namedExports: {
		PAYPAL_ORDER_TTL_MS: 3 * 60 * 60 * 1000,
		withExpensePaymentLock: async (_wgId: string, action: (tx: unknown) => Promise<unknown>) => {
			harness.writes += 1;
			return action({
				update: () => ({
					set: () => ({
						where: () => ({ returning: async () => [{ id: harness.payment.id }] }),
					}),
				}),
			});
		},
	},
});
mock.module(sibling('paypal-settlement.ts'), {
	namedExports: { parsePayPalAmountCents, terminalPayPalCaptureOutcome },
});

const { reconcileStaleCapturingPayments } = await import(
	'../src/features/expenses/server/paypal-reconcile.ts'
);

test('reconciliation leaves a mismatched or missing provider order identity unresolved', async () => {
	for (const status of ['COMPLETED', 'VOIDED']) {
		for (const id of ['different-order', undefined]) {
			harness.writes = 0;
			harness.order = {
				id,
				status,
				purchase_units: [
					{
						payee: { merchant_id: harness.payment.payeeMerchantId },
						payments: {
							captures:
								status === 'VOIDED'
									? []
									: [{ status: 'COMPLETED', amount: { value: '12.34', currency_code: 'EUR' } }],
						},
					},
				],
			};
			assert.deepEqual(await reconcileStaleCapturingPayments(), {
				completed: 0,
				failed: 0,
				pending: 1,
			});
			assert.equal(harness.writes, 0);
		}
	}
});

test('an unapproved order is only given up once it is long past its expiry', async () => {
	const hour = 60 * 60 * 1000;
	const now = new Date();
	const cases: Array<[string, number, unknown, Error | null, Record<string, number>]> = [
		[
			'abandoned CREATED',
			-2 * hour,
			{ id: 'expected-order', status: 'CREATED' },
			null,
			{ failed: 1 },
		],
		['fresh CREATED', 10 * hour, { id: 'expected-order', status: 'CREATED' }, null, { pending: 1 }],
		[
			'abandoned with PENDING capture',
			-2 * hour,
			{
				id: 'expected-order',
				status: 'COMPLETED',
				purchase_units: [{ payments: { captures: [{ status: 'PENDING' }] } }],
			},
			null,
			{ pending: 1 },
		],
		['abandoned 404', -2 * hour, null, new Error('paypal_api_404'), { failed: 1 }],
		['fresh 404', 10 * hour, null, new Error('paypal_api_404'), { pending: 1 }],
	];
	for (const [label, expiresIn, order, lookupError, expected] of cases) {
		harness.payment.expiresAt = new Date(now.getTime() + expiresIn);
		harness.order = order;
		harness.lookupError = lookupError;
		assert.deepEqual(
			await reconcileStaleCapturingPayments(now),
			{ completed: 0, failed: 0, pending: 0, ...expected },
			label,
		);
	}
	harness.lookupError = null;
});
