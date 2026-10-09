import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// PayPal capture rechecks active membership under the payment lock, so a capture never runs
// for a member who left the WG between the guard and the lock.

const wgId = '550e8400-e29b-41d4-a716-446655440000';
const callerId = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';
const recipientId = '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55';
const expensePayments = {
	id: 'payment.id',
	wgId: 'payment.wgId',
	providerOrderId: 'payment.providerOrderId',
	fromMemberId: 'payment.fromMemberId',
	status: 'payment.status',
	expiresAt: 'payment.expiresAt',
};
const wgMembers = {
	id: 'member.id',
	name: 'member.name',
	color: 'member.color',
	wgId: 'member.wgId',
};
const payment = {
	id: 'payment-1',
	wgId,
	providerOrderId: 'paypal-order-1',
	payeeMerchantId: 'merchant-1',
	fromMemberId: callerId,
	toMemberId: recipientId,
	amountCents: 1200,
	currency: 'EUR',
	status: 'created',
	expiresAt: new Date(Date.now() + 60_000),
};
let membershipActive = true;
let requireMemberCalls = 0;
let lockHeld = false;
let membershipChecks = 0;
let membershipChecksUnderLock = 0;
let captureCalls = 0;
let orderReads = 0;
const statusWrites: string[] = [];

const jsonResponse = (body: unknown, init: number | ResponseInit = 200): Response =>
	Response.json(body, typeof init === 'number' ? { status: init } : init);

function selectQuery(): unknown {
	let selectedTable: unknown;
	const rows = () => {
		if (selectedTable === expensePayments) return [{ ...payment }];
		if (selectedTable === wgMembers) return [{ id: callerId, name: 'Mina', color: 'blue' }];
		return [];
	};
	const result = Promise.resolve().then(rows);
	const chain: unknown = new Proxy(
		{},
		{
			get: (_target, key) => {
				if (key === 'then') return result.then.bind(result);
				if (key === 'limit') return async () => rows();
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
			if (typeof values.status === 'string') {
				statusWrites.push(values.status);
				Object.assign(payment, values);
			}
			return {
				where: () => ({ returning: async () => [{ ...payment }] }),
			};
		},
	}),
};
const db = {
	select: () => {
		// Simulate deactivation after requireWgMember succeeds but before the payment lock.
		if (requireMemberCalls > 0) membershipActive = false;
		return selectQuery();
	},
};

mock.module('@/core/audit', { namedExports: { recordAuditEvent: async () => undefined } });
mock.module('@/core/db', { namedExports: { db, expensePayments, wgMembers } });
mock.module('@/core/db/account-deletion', {
	namedExports: {
		lockActiveAccountMember: async () => {
			membershipChecks += 1;
			if (lockHeld) membershipChecksUnderLock += 1;
			return membershipActive ? { memberId: callerId } : null;
		},
	},
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
		requireWgMember: async () => {
			requireMemberCalls += 1;
			membershipActive = true;
			return {
				ok: true,
				wg: { id: wgId },
				member: { memberId: callerId, name: 'Mina' },
				authUserId: callerId,
			};
		},
	},
});
mock.module('@/core/guards/with-wg-route', {
	namedExports: { withWgRoute: (_name: string, handler: unknown) => handler },
});
mock.module('@/core/infra/observability', { namedExports: { logApiError: () => undefined } });
mock.module('@/core/infra/paypal', {
	namedExports: {
		capturePayPalOrder: async () => {
			captureCalls += 1;
			return {
				status: 'COMPLETED',
				purchase_units: [
					{
						payments: {
							captures: [
								{
									status: 'COMPLETED',
									amount: { value: '12.00', currency_code: 'EUR' },
								},
							],
						},
					},
				],
			};
		},
		getPayPalOrder: async () => {
			orderReads += 1;
			return { status: 'COMPLETED' };
		},
		isPayPalConfigured: () => true,
	},
});
mock.module('@/core/rate-limit', {
	namedExports: { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
});
mock.module('@/features/expenses/debt-reduction', {
	namedExports: {
		computeNetBalances: () => [],
		simplifyDebts: () => [
			{ fromId: callerId, toId: recipientId, currency: 'EUR', cents: payment.amountCents },
		],
	},
});
mock.module('@/features/expenses/server/expense-payments', {
	namedExports: {
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
		loadCompletedExpensePayments: async () => [],
		hasCapturingExpensePayment: async () => false,
	},
});
mock.module('@/features/expenses/server/settle-notify', {
	namedExports: {
		notifySettlement: async () => undefined,
		announcePayPalSettlement: async () => undefined,
	},
});
mock.module('@/features/expenses/server/open-expenses', {
	namedExports: { loadOpenExpenses: async () => [] },
});
mock.module('@/features/expenses/paypal-settlement', {
	namedExports: {
		isPayPalCaptureDebtChanged: () => false,
		parsePayPalAmountCents: () => 1200,
		terminalPayPalCaptureOutcome: () => null,
		isUnapprovedPayPalOrder: () => false,
	},
});
mock.module('drizzle-orm', {
	namedExports: {
		and: (...conditions: unknown[]) => conditions,
		eq: (column: unknown, value: unknown) => ({ column, value }),
		gt: (column: unknown, value: unknown) => ({ column, value }),
	},
});
mock.module('next/server', { namedExports: { NextResponse: { json: jsonResponse } } });

const route = (await import('@/app/api/wg/[code]/paypal/capture/route')) as unknown as {
	POST: (request: Request, context: { code: string }) => Promise<Response>;
};

test('PayPal capture rechecks active membership under the payment lock', async () => {
	const response = await route.POST(
		new Request('http://localhost/api/wg/test/paypal/capture', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ orderId: payment.providerOrderId }),
		}),
		{ code: 'test' },
	);

	assert.deepEqual(
		{
			responseStatus: response.status,
			responseBody: await response.json(),
			captureCalls,
			orderReads,
			statusWrites,
		},
		{
			responseStatus: 403,
			responseBody: { error: 'member_deactivated' },
			captureCalls: 0,
			orderReads: 0,
			statusWrites: [],
		},
	);
	assert.equal(requireMemberCalls, 1);
	assert.equal(membershipChecks, 1);
	assert.equal(membershipChecksUnderLock, 1);
});
