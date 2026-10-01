import { isE2EDbDownMode } from '@/core/infra/e2e-db-down';
import { createServerClient } from '@supabase/ssr';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseEnv, hasSupabaseEnv } from './env';

function isTransientAuthError(error: unknown): boolean {
	return (
		isAuthRetryableFetchError(error) ||
		(typeof error === 'object' && error !== null && 'status' in error && error.status === 429)
	);
}

function signInRedirect(request: NextRequest, response: NextResponse): NextResponse {
	const url = request.nextUrl.clone();
	url.pathname = '/neu';
	url.search = '';
	url.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
	const redirect = NextResponse.redirect(url);
	response.headers.forEach((value, name) => {
		const lowerName = name.toLowerCase();
		if (
			lowerName !== 'set-cookie' &&
			lowerName !== 'location' &&
			!lowerName.startsWith('x-middleware-')
		) {
			redirect.headers.set(name, value);
		}
	});
	for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
	redirect.headers.set('Cache-Control', 'private, no-store');
	return redirect;
}

/** Refresh sessions and require social authentication before serving WG pages. */
export async function refreshSupabaseSession(
	request: NextRequest,
	response: NextResponse,
): Promise<NextResponse> {
	const requiresSignIn = request.nextUrl.pathname.startsWith('/wg/') && !isE2EDbDownMode();
	if (!hasSupabaseEnv()) return requiresSignIn ? signInRedirect(request, response) : response;

	const { url, publishableKey } = getSupabaseEnv();
	let refreshedResponse = response;
	const supabase = createServerClient(url, publishableKey, {
		cookies: {
			getAll: () => request.cookies.getAll(),
			setAll: (cookiesToSet, headers = {}) => {
				for (const { name, value } of cookiesToSet) {
					request.cookies.set(name, value);
				}
				const requestHeaders = new Headers(request.headers);
				refreshedResponse.headers.forEach((value, name) => {
					const lowerName = name.toLowerCase();
					if (!lowerName.startsWith('x-middleware-request-')) return;
					const forwardedName = lowerName.slice('x-middleware-request-'.length);
					if (forwardedName !== 'cookie') requestHeaders.set(forwardedName, value);
				});
				requestHeaders.set('cookie', request.cookies.toString());

				const nextResponse = NextResponse.next({ request: { headers: requestHeaders } });
				refreshedResponse.headers.forEach((value, name) => {
					const lowerName = name.toLowerCase();
					if (lowerName !== 'set-cookie' && !lowerName.startsWith('x-middleware-')) {
						nextResponse.headers.set(name, value);
					}
				});
				for (const cookie of refreshedResponse.cookies.getAll()) nextResponse.cookies.set(cookie);
				for (const { name, value, options } of cookiesToSet) {
					nextResponse.cookies.set(name, value, options);
				}
				for (const [name, value] of Object.entries(headers)) {
					nextResponse.headers.set(name, value);
				}
				refreshedResponse = nextResponse;
			},
		},
	});

	try {
		const { data, error } = await supabase.auth.getUser();
		if (requiresSignIn && isTransientAuthError(error)) return refreshedResponse;
		if (requiresSignIn && (error || !data.user)) return signInRedirect(request, refreshedResponse);
	} catch {
		if (requiresSignIn) return refreshedResponse;
		// Public entry pages remain available when Auth cannot be reached.
	}
	return refreshedResponse;
}
