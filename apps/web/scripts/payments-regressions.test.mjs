import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalPayPalOrderCreationError } from '../src/core/infra/paypal.ts';
import { filterPersistedMentionIds } from '../src/features/chat/chat-pure.ts';
import {
	isPayPalCaptureDebtChanged,
	isPayPalCapturePendingResult,
	parsePayPalAmountCents,
	resolvePayPalOrderLookup,
	shouldRetryPayPalCapture,
	terminalPayPalCaptureOutcome,
} from '../src/features/expenses/paypal-settlement.ts';

test('returns only mention IDs confirmed by the database insert', () => {
	assert.deepEqual(
		filterPersistedMentionIds(
			['member-a', 'member-b', 'member-c'],
			[{ mentionedMemberId: 'member-c' }, { mentionedMemberId: 'member-a' }],
		),
		['member-a', 'member-c'],
	);
});

test('accepts a capture that exactly settles the remaining debt', () => {
	assert.equal(isPayPalCaptureDebtChanged(1_000, 1_000), false);
	assert.equal(isPayPalCaptureDebtChanged(1_001, 1_000), true);
	assert.equal(isPayPalCaptureDebtChanged(999, 1_000), true);
	assert.equal(isPayPalCaptureDebtChanged(undefined, 1_000), true);
});

test('leaves provider-pending captures for deliberate reconciliation', () => {
	assert.equal(shouldRetryPayPalCapture({ ok: true, data: { status: 'PENDING' } }), false);
	assert.equal(shouldRetryPayPalCapture({ ok: true, data: { status: 'COMPLETED' } }), false);
	assert.equal(shouldRetryPayPalCapture({ ok: false, status: 0, error: 'network' }), true);
	assert.equal(shouldRetryPayPalCapture({ ok: false, status: 503, error: 'server_error' }), true);
	assert.equal(shouldRetryPayPalCapture({ ok: false, status: 409, error: 'debt_changed' }), false);
});

test('only definitive provider failure and voided orders release the active capture', () => {
	assert.equal(terminalPayPalCaptureOutcome('COMPLETED', ['PENDING']), null);
	assert.equal(terminalPayPalCaptureOutcome('COMPLETED', ['DECLINED']), 'FAILED');
	assert.equal(terminalPayPalCaptureOutcome('COMPLETED', ['FAILED']), 'FAILED');
	assert.equal(terminalPayPalCaptureOutcome('VOIDED', []), 'CANCELLED');
	assert.equal(terminalPayPalCaptureOutcome('VOIDED', ['PENDING']), null);
	assert.equal(terminalPayPalCaptureOutcome('COMPLETED', []), null);
});

test('parses PayPal amounts without rounding fractional cents', () => {
	assert.equal(parsePayPalAmountCents('12'), 1200);
	assert.equal(parsePayPalAmountCents('12.4'), 1240);
	assert.equal(parsePayPalAmountCents('12.00'), 1200);
	assert.equal(parsePayPalAmountCents('12.004'), null);
	assert.equal(parsePayPalAmountCents('12.00e0'), null);
});

test('unknown capture results and failed lookups keep recovery attached to the same order', () => {
	assert.equal(isPayPalCapturePendingResult({ ok: true, data: { status: 'UNKNOWN' } }), true);
	assert.equal(
		isPayPalCapturePendingResult({ ok: false, status: 409, error: 'paypal_payment_not_completed' }),
		true,
	);
	assert.equal(
		isPayPalCapturePendingResult({ ok: false, status: 409, error: 'unknown_capture_state' }),
		true,
	);
	assert.equal(
		isPayPalCapturePendingResult({ ok: false, status: 409, error: 'debt_changed' }),
		false,
	);
	assert.deepEqual(resolvePayPalOrderLookup({ ok: false, status: 503 }), { kind: 'retry' });
	assert.deepEqual(resolvePayPalOrderLookup({ ok: true, data: { status: 'UNKNOWN' } }), {
		kind: 'retry',
	});
	assert.deepEqual(
		resolvePayPalOrderLookup({ ok: true, data: { status: 'CAPTURING', orderId: 'paypal-1' } }),
		{ kind: 'capture', orderId: 'paypal-1' },
	);
	assert.deepEqual(
		resolvePayPalOrderLookup({ ok: true, data: { status: 'WAITING', orderId: 'paypal-1' } }),
		{ kind: 'capture', orderId: 'paypal-1' },
	);
	assert.deepEqual(resolvePayPalOrderLookup({ ok: true, data: { status: 'CAPTURING' } }), {
		kind: 'retry',
	});
	assert.deepEqual(resolvePayPalOrderLookup({ ok: true, data: { status: 'NONE' } }), {
		kind: 'ready',
	});
	assert.deepEqual(resolvePayPalOrderLookup({ ok: true, data: { status: 'CREATING' } }), {
		kind: 'ready',
	});
});

test('only definitive Payee account errors release an order-creation reservation', () => {
	assert.equal(
		isTerminalPayPalOrderCreationError(new Error('paypal_api_422_PAYEE_ACCOUNT_INVALID')),
		true,
	);
	assert.equal(
		isTerminalPayPalOrderCreationError(new Error('paypal_api_422_DUPLICATE_REQUEST_ID')),
		false,
	);
	assert.equal(isTerminalPayPalOrderCreationError(new Error('paypal_api_503')), false);
});
