import type { Message } from '@/shared/i18n/message';

type PushErrorKey = Extract<Message['key'], `settings.notifications.errors.push${string}`>;

/** A push (de)activation failure that carries the message to show the person. */
export class PushError extends Error {
	readonly copy: Message;
	constructor(key: PushErrorKey) {
		super(key);
		this.copy = { key };
	}
}

export function formatPushActivationError(error: unknown): Message {
	if (error instanceof PushError) return error.copy;
	if (error instanceof Error && error.name === 'NotAllowedError') {
		return { key: 'settings.notifications.errors.pushNotAllowed' };
	}
	if (error instanceof Error && error.message.includes('Failed to register a ServiceWorker')) {
		return { key: 'settings.notifications.errors.pushServiceWorker' };
	}
	return { key: 'settings.notifications.errors.pushActivateFailed' };
}

export function formatPushDeactivationError(error: unknown): Message {
	return error instanceof PushError
		? error.copy
		: { key: 'settings.notifications.errors.pushDeactivateFailed' };
}

export function parseWebPushStatusCode(err: unknown): number {
	if (!err || typeof err !== 'object' || !('statusCode' in err)) return 0;
	const value = (err as { statusCode?: unknown }).statusCode;
	const statusCode =
		typeof value === 'number'
			? value
			: typeof value === 'string' && /^\d{3}$/.test(value)
				? Number(value)
				: 0;
	if (!Number.isInteger(statusCode)) return 0;
	return statusCode >= 100 && statusCode <= 599 ? statusCode : 0;
}

function isTransientWebPushStatus(statusCode: number): boolean {
	return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

// Connection failures before the push service answered. Node reports a failed IPv6/IPv4 race as an
// AggregateError (e.g. ENETUNREACH + ETIMEDOUT in a container without IPv6), which the next attempt
// usually wins.
const TRANSIENT_NETWORK_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'EAI_AGAIN',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ETIMEDOUT',
]);

/** Worth another attempt: a retryable push-service status or a connection that never got through. */
export function isTransientWebPushError(err: unknown): boolean {
	const statusCode = parseWebPushStatusCode(err);
	if (statusCode !== 0) return isTransientWebPushStatus(statusCode);
	const attempts = err instanceof AggregateError ? err.errors : [err];
	return attempts.some((attempt) => {
		const code =
			attempt && typeof attempt === 'object' ? (attempt as { code?: unknown }).code : null;
		return typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code);
	});
}

// Messages web-push throws locally (encryption-helper) when a stored subscription's own keys are
// unusable. VAPID (server key) errors never match these prefixes.
const INVALID_SUBSCRIPTION_KEY_MESSAGE =
	/^(The subscription (p256dh|auth key)\b|No user (public key|auth) provided)/;

/** A local web-push failure caused by the subscription's keys: it can never be delivered. */
export function isInvalidSubscriptionKeyError(err: unknown): boolean {
	return err instanceof Error && INVALID_SUBSCRIPTION_KEY_MESSAGE.test(err.message);
}
