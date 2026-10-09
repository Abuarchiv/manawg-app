/** Codes after which the debt on screen is outdated and the balances must be reloaded. */
export const PAYPAL_STALE_CODES = new Set([
	'debt_changed',
	'paypal_order_expired',
	'paypal_order_unavailable',
	'paypal_order_not_found',
]);

/**
 * Copy for a PayPal flow that stopped before any money could move. Returns null for codes that
 * may leave an unclear payment state, so the caller keeps the "check PayPal first" warning.
 */
export function paypalErrorMessage(code: string): string | null {
	switch (code) {
		case 'no_open_debt':
			return 'Diese Schuld ist bereits beglichen oder hat sich geändert.';
		case 'paypal_direct_debt_required':
			return 'Mit PayPal lässt sich nur eine direkte Schuld bezahlen. Gleiche zuerst die Gegenforderung aus.';
		case 'paypal_recipient_missing':
		case 'paypal_onboarding_pending':
			return 'Der Empfänger hat PayPal noch nicht fertig verbunden.';
		case 'paypal_order_in_progress':
			return 'Es läuft bereits eine PayPal-Zahlung.';
		case 'paypal_currency_unsupported':
			return 'PayPal ist nur für Euro verfügbar.';
		case 'too_many_requests':
		case 'rate_limited':
			return 'Zu viele Versuche. Warte kurz und versuche es erneut.';
		case 'debt_changed':
			return 'Der Betrag hat sich geändert. Die Salden werden neu geladen.';
		case 'paypal_order_expired':
		case 'paypal_order_unavailable':
		case 'paypal_order_not_found':
			return 'Die PayPal-Bestellung ist abgelaufen. Starte die Zahlung neu.';
		default:
			return null;
	}
}
