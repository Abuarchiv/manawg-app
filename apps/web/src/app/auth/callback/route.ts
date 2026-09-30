import { safeNextPath } from '@/core/auth/next-path';
import { createSupabaseServerClient } from '@/core/auth/server';
import { type NextRequest, NextResponse } from 'next/server';

function callbackError(request: NextRequest, response?: NextResponse): NextResponse {
	const url = new URL('/neu', request.url);
	url.searchParams.set('error', 'auth_callback');
	url.searchParams.set('next', safeNextPath(request.nextUrl.searchParams.get('next')));
	const redirect = response ?? NextResponse.redirect(url);
	redirect.headers.set('Location', url.toString());
	redirect.headers.set('Cache-Control', 'private, no-store');
	return redirect;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
	const code = request.nextUrl.searchParams.get('code');
	const flowId = request.nextUrl.searchParams.get('sb_flow_id');
	const next = safeNextPath(request.nextUrl.searchParams.get('next'));
	if (!code) return callbackError(request);

	// Defense in depth: safeNextPath should already reject absolute URLs,
	// but verify at the redirect boundary so a future regression cannot
	// produce an open redirect.
	if (!next.startsWith('/') || next.startsWith('//')) {
		return callbackError(request);
	}

	const response = NextResponse.redirect(new URL(next, request.url));
	try {
		const supabase = createSupabaseServerClient(request, response);
		const { data, error } = await supabase.auth.exchangeCodeForSession(
			code,
			flowId !== null ? { flowId } : undefined,
		);
		if (error || !data.session) return callbackError(request, response);
		if (next === '/auth/reset') {
			response.cookies.set({
				name: 'manawg_password_recovery',
				value: data.session.user.id,
				httpOnly: true,
				secure: true,
				sameSite: 'lax',
				maxAge: 600,
				path: '/auth/reset',
			});
		}
		return response;
	} catch {
		return callbackError(request, response);
	}
}
