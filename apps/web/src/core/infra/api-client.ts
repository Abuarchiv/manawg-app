import { getLocalAccount } from '@/core/auth/local-account';
import { INVALID_RESPONSE_CODE, NETWORK_ERROR_CODE } from '@/core/http/error-codes';
import { EXPECTED_MEMBER_ID_HEADER } from '@/shared/lib/member-header';

/** A request the server has not answered by then counts as a network failure. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * `AbortSignal.any`, with a fallback for browsers that lack it. The app
 * supports Safari 16.4+, but `AbortSignal.any` only exists from Safari 17.4;
 * calling it there throws, and every request with a caller signal (offline
 * sync, background refresh) would fail without reaching the server.
 */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
	if (typeof AbortSignal.any === 'function') return AbortSignal.any([...signals]);
	const controller = new AbortController();
	for (const source of signals) {
		if (source.aborted) {
			controller.abort(source.reason);
			break;
		}
		source.addEventListener('abort', () => controller.abort(source.reason), {
			once: true,
			signal: controller.signal,
		});
	}
	return controller.signal;
}

type ApiFetchInit = RequestInit & { memberId?: string };

/** status 0 means no trustworthy result was received; a write may still have committed. */
type ApiFetchResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

let mutationCount = 0;

export const MEMBERSHIP_LOST_EVENT = 'manawg:membership-lost';
export const SESSION_EXPIRED_EVENT = 'manawg:session-expired';
const MEMBERSHIP_LOST_ERRORS = new Set(['not_a_member', 'member_deactivated', 'wg_not_found']);

/**
 * For the few WG calls that use plain `fetch` (uploads, downloads, deleting the WG): lets a
 * 401 `auth_required` raise the same session-expired banner as `apiFetch` does.
 */
export function noteSessionExpiry(response: Response, expectedAccount: string | null): void {
	if (response.status !== 401 || typeof window === 'undefined') return;
	void readApiErrorCode(response).then((code) => {
		if (code === 'auth_required' && expectedAccount === getLocalAccount()) {
			window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
		}
	});
}

/**
 * Increases after every settled non-GET request. A cached read that started
 * before the latest mutation may not contain its effect (useCachedFetch).
 */
export function mutationGeneration(): number {
	return mutationCount;
}

/**
 * The error code of a failed raw `fetch` response (`error` first, then `code`), or '' when the
 * body has none. Reads a clone, so the caller can still consume the response; never throws.
 */
export async function readApiErrorCode(response: Response): Promise<string> {
	try {
		const body = (await response.clone().json()) as { code?: unknown; error?: unknown } | null;
		if (typeof body?.error === 'string' && body.error.length > 0) return body.error;
		if (typeof body?.code === 'string' && body.code.length > 0) return body.code;
	} catch {
		// No JSON body.
	}
	return '';
}

export async function apiFetch<T>(
	path: string,
	init: ApiFetchInit = {},
): Promise<ApiFetchResult<T>> {
	const requestAccount = getLocalAccount();
	const { memberId, signal, ...rest } = init;
	const method = rest.method ?? 'GET';

	const headers = new Headers(rest.headers);
	if (memberId) headers.set(EXPECTED_MEMBER_ID_HEADER, memberId);
	const hasBody = rest.body !== undefined && rest.body !== null;
	if (hasBody && ['POST', 'PUT', 'PATCH'].includes(method)) {
		headers.set('content-type', 'application/json');
	}

	const isMutation = method !== 'GET' && method !== 'HEAD';
	try {
		const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const requestSignal = signal ? anySignal([signal, timeoutSignal]) : timeoutSignal;
		const res = await fetch(path, {
			cache: 'no-store',
			...rest,
			method,
			headers,
			signal: requestSignal,
		});

		if (res.status === 204) return { ok: true, data: undefined as T };

		if (!res.ok) {
			const error = (await readApiErrorCode(res)) || res.statusText;
			// Removed, left, or the share code rotated while the app was open: every screen
			// would otherwise show an empty list. The WG shell reacts (explain or redirect).
			if (
				(res.status === 401 || res.status === 404) &&
				MEMBERSHIP_LOST_ERRORS.has(error) &&
				requestAccount === getLocalAccount() &&
				typeof window !== 'undefined' &&
				path.startsWith('/api/wg/')
			) {
				window.dispatchEvent(new CustomEvent(MEMBERSHIP_LOST_EVENT, { detail: { path, error } }));
			}
			if (
				res.status === 401 &&
				error === 'auth_required' &&
				requestAccount === getLocalAccount() &&
				typeof window !== 'undefined' &&
				path.startsWith('/api/')
			) {
				window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
			}
			return { ok: false, status: res.status, error };
		}

		const contentType = res.headers.get('content-type') ?? '';
		if (!contentType.includes('application/json')) {
			await res.text();
			return {
				ok: false,
				status: 0,
				error: INVALID_RESPONSE_CODE,
			};
		}
		try {
			const data = (await res.json()) as T;
			return { ok: true, data };
		} catch {
			return {
				ok: false,
				status: 0,
				error: INVALID_RESPONSE_CODE,
			};
		}
	} catch {
		return { ok: false, status: 0, error: NETWORK_ERROR_CODE };
	} finally {
		if (isMutation) mutationCount += 1;
	}
}
