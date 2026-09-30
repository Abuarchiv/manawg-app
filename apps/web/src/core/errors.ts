import { captureException } from '@/core/infra/observability';
import { NextResponse } from 'next/server';

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_TOO_MANY = 429;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_SERVER_ERROR = 500;

export const HTTP = {
	BAD_REQUEST: HTTP_BAD_REQUEST,
	FORBIDDEN: HTTP_FORBIDDEN,
	NOT_FOUND: HTTP_NOT_FOUND,
	CONFLICT: HTTP_CONFLICT,
	PAYLOAD_TOO_LARGE: HTTP_PAYLOAD_TOO_LARGE,
	TOO_MANY: HTTP_TOO_MANY,
	SERVICE_UNAVAILABLE: HTTP_SERVICE_UNAVAILABLE,
	SERVER_ERROR: HTTP_SERVER_ERROR,
} as const;

interface ApiErrorBody {
	error: string;
	code?: string;
}

export function apiError(
	message: string,
	status: number,
	code?: string,
): NextResponse<ApiErrorBody> {
	const body: ApiErrorBody = code !== undefined ? { error: message, code } : { error: message };
	return NextResponse.json<ApiErrorBody>(body, { status });
}

const IDEMPOTENCY_RETRYABLE_CODES = new Set([
	'idempotency_claim_failed',
	'idempotency_cache_read_failed',
	'idempotency_response_pending',
]);

/**
 * A transient Supabase Auth failure while resolving the caller.
 *
 * `getAuthenticatedUser` throws instead of returning `null` so an Auth outage
 * can never be read as "not signed in". Handlers that call it outside a
 * try/catch map that throw to this response — the same structured
 * `503 db_error` that `requireWgMember`/`requireMember`/`requireWgAdmin`
 * already return for it — plus `Retry-After`, so clients retry instead of
 * getting a bare 500 with an unhandled error in the logs.
 */
export function authUnavailable(): NextResponse<ApiErrorBody> {
	const response = apiError('db_error', HTTP_SERVICE_UNAVAILABLE);
	response.headers.set('Retry-After', '1');
	return response;
}

function isIdempotencyRetryable(value: unknown): boolean {
	const message = typeof value === 'string' ? value : value instanceof Error ? value.message : null;
	return message !== null && IDEMPOTENCY_RETRYABLE_CODES.has(message);
}

function idempotencyRetryableResponse(): NextResponse<ApiErrorBody> {
	return NextResponse.json<ApiErrorBody>(
		{ error: 'service_unavailable', code: 'idempotency_retryable' },
		{ status: HTTP_SERVICE_UNAVAILABLE, headers: { 'Retry-After': '1' } },
	);
}

export function badRequest(message = 'bad_request', code?: string): NextResponse<ApiErrorBody> {
	return apiError(message, HTTP_BAD_REQUEST, code);
}

export function forbidden(message = 'forbidden', code?: string): NextResponse<ApiErrorBody> {
	return apiError(message, HTTP_FORBIDDEN, code);
}

/**
 * Money/state mutations that trust a caller-claimed id (owner checks, self-
 * settle, comment authorship) require a verified HMAC token first — a bare
 * `x-manawg-member-id` is spoofable. Returns the `forbidden` response to
 * return immediately, or `null` when the caller is verified.
 */
export function requireVerifiedMember(member: {
	verified: boolean;
}): NextResponse<ApiErrorBody> | null {
	if (!member.verified) return forbidden('member_not_verified', 'member_not_verified');
	return null;
}

export function conflict(message = 'conflict', code?: string): NextResponse<ApiErrorBody> {
	return apiError(message, HTTP_CONFLICT, code);
}

export function notFound(message = 'not_found', code?: string): NextResponse<ApiErrorBody> {
	return apiError(message, HTTP_NOT_FOUND, code);
}

export function tooMany(message = 'too_many_requests', code?: string): NextResponse<ApiErrorBody> {
	return apiError(message, HTTP_TOO_MANY, code);
}

export function payloadTooLarge(
	message = 'payload_too_large',
	code = 'payload_too_large',
): NextResponse<ApiErrorBody> {
	return apiError(message, HTTP_PAYLOAD_TOO_LARGE, code);
}

/**
 * Return a server error response. Idempotency safety failures are returned as
 * an explicit retryable 503 so callers never continue into the mutation.
 *
 * Supports two calling styles (backward-compatible):
 *   - `serverError()` — reports `server_error`, so bare calls are still
 *     visible to error monitoring instead of failing silently
 *   - `serverError('share_code_exhausted')` — response message, also reported
 *   - `serverError(err, 'message')` — reports the caught error, then returns 500
 *
 * Heuristic: if the first arg is a `string` (or omitted), it is treated as the
 * response message. Anything else is treated as the error to report.
 *
 * Using this helper from API route catch blocks keeps error reporting out of
 * every individual route file.
 */
export function serverError(
	errOrMessage?: unknown,
	message = 'server_error',
	code?: string,
): NextResponse<ApiErrorBody> {
	if (isIdempotencyRetryable(errOrMessage)) {
		captureException(typeof errOrMessage === 'string' ? new Error(errOrMessage) : errOrMessage);
		return idempotencyRetryableResponse();
	}
	if (errOrMessage === null) {
		captureException(new Error(message));
		return apiError(message, HTTP_SERVER_ERROR, code);
	}
	if (typeof errOrMessage === 'string' || errOrMessage === undefined) {
		const finalMessage = typeof errOrMessage === 'string' ? errOrMessage : message;
		captureException(new Error(finalMessage));
		return apiError(finalMessage, HTTP_SERVER_ERROR, code);
	}

	captureException(errOrMessage);
	return apiError(message, HTTP_SERVER_ERROR, code);
}
