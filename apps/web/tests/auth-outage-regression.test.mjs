import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server.js';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === 'server-only') {
			return { url: 'data:text/javascript,', shortCircuit: true };
		}
		if (specifier === 'next/server') return nextResolve('next/server.js', context);
		if (specifier === 'next/headers') return nextResolve('next/headers.js', context);
		if (specifier === '@/core/infra/e2e-db-down') {
			return {
				url: 'data:text/javascript,export%20function%20isE2EDbDownMode()%20%7B%20return%20false%3B%20%7D',
				shortCircuit: true,
			};
		}
		if (
			specifier.startsWith('.') &&
			!extname(specifier) &&
			context.parentURL?.startsWith('file:')
		) {
			const file = resolve(dirname(fileURLToPath(context.parentURL)), `${specifier}.ts`);
			if (existsSync(file)) return nextResolve(pathToFileURL(file).href, context);
		}
		return nextResolve(specifier, context);
	},
});

const originalFetch = globalThis.fetch;

let getAuthenticatedUser;
let refreshSupabaseSession;
let authFetchCalls;

before(async () => {
	process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://auth-outage.supabase.co';
	process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';
	({ getAuthenticatedUser } = await import('../src/core/auth/server.ts'));
	({ refreshSupabaseSession } = await import('../src/core/auth/middleware.ts'));
});

after(() => {
	globalThis.fetch = originalFetch;
});

function authenticatedRequest(path = '/api/wg/mine') {
	const session = Buffer.from(
		JSON.stringify({
			access_token: 'test-access-token',
			refresh_token: 'test-refresh-token',
			token_type: 'bearer',
			expires_at: Math.floor(Date.now() / 1000) + 3600,
			expires_in: 3600,
		}),
	).toString('base64url');
	return new NextRequest(`https://app.test${path}`, {
		headers: { cookie: `sb-auth-outage-auth-token=base64-${session}` },
	});
}

function mockAuthResponse(status) {
	authFetchCalls = 0;
	const body =
		status === 401
			? { code: 'bad_jwt', message: 'Invalid JWT' }
			: status === 429
				? { code: 'over_request_rate_limit', message: 'Too many requests' }
				: { code: 'server_error', message: 'Auth service unavailable' };
	globalThis.fetch = async () => {
		authFetchCalls += 1;
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	};
}

function middlewareResponse() {
	const response = NextResponse.next({
		request: { headers: new Headers({ 'x-nonce': 'request-nonce' }) },
	});
	response.headers.set('Content-Security-Policy', "script-src 'nonce-response-nonce'");
	response.cookies.set('auth-refresh', 'refreshed-token');
	return response;
}

test('transient Supabase Auth failures propagate instead of becoming an unauthenticated user', async () => {
	mockAuthResponse(503);
	let authError;
	try {
		await getAuthenticatedUser(authenticatedRequest());
	} catch (error) {
		authError = error;
	}
	assert.ok(authFetchCalls > 0, 'the active session must reach Supabase Auth');
	assert.ok(isAuthRetryableFetchError(authError), 'the retryable Auth failure must propagate');
});

test('temporary Auth failures keep WG page headers and cookies for the retry boundary', async () => {
	for (const status of [503, 429]) {
		mockAuthResponse(status);
		const response = middlewareResponse();
		const result = await refreshSupabaseSession(
			authenticatedRequest('/wg/ABC123/ausgaben'),
			response,
		);

		assert.ok(authFetchCalls > 0, 'the active session must reach Supabase Auth');
		assert.strictEqual(result, response);
		assert.equal(result.headers.get('location'), null);
		assert.equal(result.headers.get('x-middleware-request-x-nonce'), 'request-nonce');
		assert.equal(
			result.headers.get('content-security-policy'),
			"script-src 'nonce-response-nonce'",
		);
		assert.equal(result.cookies.get('auth-refresh')?.value, 'refreshed-token');
	}
});

test('an upstream Auth rate limit propagates instead of becoming an unauthenticated user', async () => {
	mockAuthResponse(429);
	let authError;
	try {
		await getAuthenticatedUser(authenticatedRequest());
	} catch (error) {
		authError = error;
	}
	assert.ok(authFetchCalls > 0, 'the active session must reach Supabase Auth');
	assert.equal(authError?.status, 429);
});

test('an invalid session still redirects to sign-in', async () => {
	mockAuthResponse(401);
	assert.equal(await getAuthenticatedUser(authenticatedRequest()), null);
	const response = await refreshSupabaseSession(
		authenticatedRequest('/wg/ABC123/ausgaben'),
		NextResponse.next(),
	);

	assert.ok(authFetchCalls > 0, 'the active session must reach Supabase Auth');
	assert.equal(response.status, 307);
	assert.equal(new URL(response.headers.get('location')).pathname, '/neu');
});
