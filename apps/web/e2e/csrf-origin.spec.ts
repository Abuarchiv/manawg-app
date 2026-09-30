import { expect, test } from '@playwright/test';
import { NextRequest } from 'next/server';
import {
	config,
	isRateLimitedApiPath,
	isShareCodeLookup,
	middleware,
	originAllowed,
} from '../src/middleware';

const WRITE_URL = 'https://app.example.com/api/wg/ABCDEFGH/expenses';

function request(headers: Record<string, string>, method = 'POST'): NextRequest {
	return new NextRequest(WRITE_URL, { method, headers });
}

test('covers the password-recovery endpoint with the shared write controls', () => {
	const matcher = config.matcher;
	expect(matcher).toContain('/api/auth/:path*');

	// Without this the path fell through before the Origin/CSRF check and had no
	// limiter at all: DELETE is a state-changing API handler like any other.
	expect(isRateLimitedApiPath('/api/auth/recovery')).toBe(true);
	expect(
		originAllowed(
			new NextRequest('https://app.example.com/api/auth/recovery', {
				method: 'DELETE',
				headers: { host: 'app.example.com', origin: 'https://evil.example.com' },
			}),
		),
	).toBe(false);
	// Same-origin DELETE stays possible, and the path is not a share-code probe.
	expect(
		originAllowed(
			new NextRequest('https://app.example.com/api/auth/recovery', {
				method: 'DELETE',
				headers: { host: 'app.example.com', origin: 'https://app.example.com' },
			}),
		),
	).toBe(true);
	expect(isShareCodeLookup('/api/auth/recovery', 'DELETE')).toBe(false);
});

test('allows same-origin writes and browser-less reads', () => {
	expect(
		originAllowed(request({ host: 'app.example.com', origin: 'https://app.example.com' })),
	).toBe(true);
	expect(
		originAllowed(request({ host: 'app.example.com', origin: 'https://app.example.com/' })),
	).toBe(true);
	expect(originAllowed(request({ host: 'app.example.com' }, 'GET'))).toBe(true);
	expect(originAllowed(request({ host: 'app.example.com' }, 'HEAD'))).toBe(true);
	expect(originAllowed(request({ host: 'app.example.com' }, 'OPTIONS'))).toBe(true);
});

test('fails closed for a write without an Origin header', () => {
	expect(originAllowed(request({ host: 'app.example.com' }))).toBe(false);
});

test('rejects cross-origin writes including takeover lookalikes', async () => {
	const rejected = [
		'https://evil.example.com',
		'https://app.example.com.evil.test',
		// A taken-over subdomain must not inherit the parent origin's trust.
		'https://takeover.app.example.com',
		// userinfo@host parsing: the real host is evil.test.
		'https://app.example.com@evil.test',
		// Port and protocol must match the request.
		'https://app.example.com:8443',
		'http://app.example.com',
		// Sandboxed iframes and non-http contexts send "null" or no usable URL.
		'null',
		'not-a-url',
	];

	for (const origin of rejected) {
		const req = request({ host: 'app.example.com', origin });
		expect(originAllowed(req), origin).toBe(false);
		expect((await middleware(req)).status, origin).toBe(403);
	}
});

test('rejects a write when the Host header is missing', () => {
	expect(originAllowed(request({ origin: 'https://app.example.com' }))).toBe(false);
});

test('treats an explicit default port as same-origin and still rejects others', () => {
	// Browsers normalize https://host:443 to https://host, so this IS same-origin.
	expect(
		originAllowed(request({ host: 'app.example.com', origin: 'https://app.example.com:443' })),
	).toBe(true);
	expect(
		originAllowed(
			request({ host: 'app.example.com:3000', origin: 'https://app.example.com:3000' }),
		),
	).toBe(true);
	expect(
		originAllowed(request({ host: 'app.example.com', origin: 'https://app.example.com:3000' })),
	).toBe(false);
});

test('guards the password-recovery API like every other state-changing route', async () => {
	expect(config.matcher).toContain('/api/auth/:path*');
	const req = new NextRequest('https://app.example.com/api/auth/recovery', {
		method: 'DELETE',
		headers: { host: 'app.example.com', origin: 'https://evil.example.com' },
	});
	expect((await middleware(req)).status).toBe(403);
});
