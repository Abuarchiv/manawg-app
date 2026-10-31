import { safeNextPath } from './next-path';

/** The pages that start an account flow; neither may be a post-login `next` target. */
const SIGN_IN_PATH = '/login';
const SIGN_UP_PATH = '/signup';

/** Sign-in, registration and the `/auth/*` utility routes are never a place to return to after login. */
export function isAuthPagePath(path: string): boolean {
	const { pathname } = new URL(path, 'https://manawg.invalid');
	return pathname === SIGN_IN_PATH || pathname === SIGN_UP_PATH || pathname.startsWith('/auth/');
}

/**
 * Reduces a query string to the intent the start flow understands: the create action and
 * a safe return path (an invitation travels as `next=/invite/<token>`). Anything else
 * is dropped, so the result can be appended to links and to the e-mail confirmation target.
 */
export function authIntentQuery(search: string): string {
	const source = new URLSearchParams(search);
	const params = new URLSearchParams();
	if (source.get('action') === 'create') params.set('action', 'create');
	const next = safeNextPath(source.get('next'));
	if (next !== '/' && !isAuthPagePath(next)) params.set('next', next);
	return params.toString();
}

/** Link to a sign-in or registration page that keeps the visitor's validated intent. */
export function authPageHref(page: typeof SIGN_IN_PATH | typeof SIGN_UP_PATH, search: string) {
	const query = authIntentQuery(search);
	return query ? `${page}?${query}` : page;
}
