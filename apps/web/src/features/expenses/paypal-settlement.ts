export function isPayPalCaptureDebtChanged(
	debtCents: number | undefined,
	captureAmountCents: number,
): boolean {
	// Fail-closed on exact match: a capture for the exact remaining debt is NOT
	// a changed debt — it is the expected settlement. Only a mismatch (debt
	// moved since the order was created) should block the capture.
	return debtCents === undefined || debtCents !== captureAmountCents;
}

export type PayPalCaptureResult =
	| { ok: true; data: { status: string } }
	| { ok: false; status: number; error?: string };

export function parsePayPalAmountCents(value: string | undefined): number | null {
	const match = value?.match(/^(\d+)(?:\.(\d{1,2}))?$/);
	if (!match) return null;
	const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
	return Number.isSafeInteger(cents) ? cents : null;
}

export function terminalPayPalCaptureOutcome(
	orderStatus: string | undefined,
	captureStatuses: readonly (string | undefined)[],
): 'FAILED' | 'CANCELLED' | null {
	if (captureStatuses.includes('COMPLETED') || captureStatuses.includes('PENDING')) return null;
	if (captureStatuses.some((status) => status === 'DECLINED' || status === 'FAILED'))
		return 'FAILED';
	if (
		orderStatus === 'VOIDED' &&
		captureStatuses.every(
			(status) => status === undefined || status === 'DECLINED' || status === 'FAILED',
		)
	) {
		return 'CANCELLED';
	}
	return null;
}

export function isPayPalCapturePendingResult(result: PayPalCaptureResult): boolean {
	if (!result.ok) {
		if (result.status === 0 || result.status === 429 || result.status >= 500) return false;
		return ![
			'debt_changed',
			'paypal_order_expired',
			'paypal_order_not_found',
			'paypal_order_unavailable',
		].includes(result.error ?? '');
	}
	return !['COMPLETED', 'FAILED', 'CANCELLED'].includes(result.data.status);
}

export type PayPalOrderLookupResult =
	| { ok: true; data: { status: string; orderId?: string } }
	| { ok: false; status: number; error?: string };

export function resolvePayPalOrderLookup(
	result: PayPalOrderLookupResult,
): { kind: 'ready' } | { kind: 'capture'; orderId: string } | { kind: 'retry' } {
	if (!result.ok) return { kind: 'retry' };
	if (
		['CAPTURING', 'WAITING'].includes(result.data.status) &&
		typeof result.data.orderId === 'string'
	) {
		return { kind: 'capture', orderId: result.data.orderId };
	}
	if (
		result.data.status === 'NONE' ||
		result.data.status === 'CREATED' ||
		result.data.status === 'CREATING'
	) {
		return { kind: 'ready' };
	}
	return { kind: 'retry' };
}

/**
 * Decide whether a transient PayPal capture request should retry immediately.
 *
 * - Successful responses are final for this attempt. PENDING is stored and
 *   surfaced for deliberate reconciliation instead of an immediate loop.
 * - 4xx (except 429): client error, stop. The request will never succeed
 *   without the caller changing something.
 * - 429 / 5xx: transient, retry.
 * - network failure (status 0): retry.
 */
export function shouldRetryPayPalCapture(result: PayPalCaptureResult): boolean {
	if (result.ok) return false;
	if (result.status === 0 || result.status === 429 || result.status >= 500) return true;
	return false;
}
