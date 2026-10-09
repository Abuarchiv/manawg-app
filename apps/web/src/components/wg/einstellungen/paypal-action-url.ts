const PAYPAL_ACTION_HOSTS = new Set(['paypal.com', 'www.paypal.com', 'www.sandbox.paypal.com']);

export function isPayPalActionUrl(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === 'https:' &&
			(url.port === '' || url.port === '443') &&
			!url.username &&
			!url.password &&
			PAYPAL_ACTION_HOSTS.has(url.hostname.toLowerCase())
		);
	} catch {
		return false;
	}
}
