/**
 * Error reporting.
 *
 * Errors go to the platform log (`console.error`), which Vercel captures and
 * retains per its log-retention window. Configured Sentry receives sanitized
 * diagnostics through the shared telemetry helper.
 *
 * Deliberately best-effort: reporting an error must never itself throw and
 * never change control flow at the call site.
 */

import { captureSentryException, logSentryApiError } from './sentry';
import { SAFE_TAG_VALUES, safeErrorName } from './sentry-privacy';

/**
 * Report an unexpected error with only fixed diagnostic labels. Error messages
 * and arbitrary context can contain provider responses, SQL, or request data.
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
	captureSentryException(err, safeContext(context));
	try {
		console.error('[error]', describeThrown(err), safeContext(context));
	} catch {
		// Logging must never break the caller.
	}
}

/**
 * Log an API-route failure as a redacted one-line summary.
 *
 * Passing the raw error object to `console.error` would copy stacks, request
 * details, and Postgres payloads into platform logs that outlive the
 * request. Keep the static route label and error type; discard message and
 * stack contents.
 */
export function logApiError(label: string, ...errors: unknown[]): void {
	logSentryApiError(errors.map(describeThrown));
	try {
		console.error(sanitizeLabel(label), errors.map(describeThrown).join(' | '));
	} catch {
		// Logging must never break the caller.
	}
}

function describeThrown(err: unknown): string {
	if (err instanceof Error) {
		// Node's network codes (ETIMEDOUT, ECONNRESET…) are fixed identifiers, never request data;
		// an AggregateError (connection attempts to every address failed) only says something
		// through the codes of its inner errors.
		const inner = err instanceof AggregateError ? err.errors : [];
		const codes = [...new Set([err, ...inner].map(systemErrorCode).filter(Boolean))];
		return codes.length > 0
			? `${safeErrorName(err.name)} ${codes.join(',')}`
			: safeErrorName(err.name);
	}
	return `thrown ${typeof err}`;
}

function systemErrorCode(err: unknown): string | null {
	const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
	return typeof code === 'string' && /^E[A-Z_]{2,30}$/.test(code) ? code : null;
}

function safeContext(context?: Record<string, unknown>): Record<string, string> {
	const safe: Record<string, string> = {};
	if (!context) return safe;
	for (const [key, allowedValues] of Object.entries(SAFE_TAG_VALUES)) {
		const value = context[key];
		if (typeof value === 'string' && allowedValues.has(value)) {
			safe[key] = value;
		}
	}
	return safe;
}

function sanitizeLabel(label: string): string {
	return label
		.replace(/[^A-Za-z0-9 _./:[\]-]/g, '?')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 160);
}

/**
 * Wrap a cron handler so a thrown error is logged with its job name before it
 * propagates. Without this, a crashing cron job surfaces only as an opaque 500
 * with no indication of which job failed.
 *
 * The error is rethrown so the framework still returns 500 — this only adds
 * visibility, it never swallows the failure.
 */
export function withCronLogging<T extends (...args: never[]) => Promise<unknown>>(
	jobName: string,
	handler: T,
): T {
	return (async (...args: Parameters<T>): Promise<unknown> => {
		try {
			return await handler(...args);
		} catch (err) {
			captureException(err, { cronJob: jobName });
			throw err;
		}
	}) as T;
}
