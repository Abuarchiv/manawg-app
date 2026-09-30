import { expect, test } from '@playwright/test';
import { isE2EDbDownMode } from '../src/core/infra/e2e-db-down';
import { contentSecurityPolicy } from '../src/shared/lib/security-headers';
import { FIXTURE_WG, setupMember } from './_helpers';

test('CSP keeps upgrade-insecure-requests by default', () => {
	const nonce = 'security-headers-test-nonce';
	const policy = contentSecurityPolicy(nonce);

	expect(policy).toContain('upgrade-insecure-requests');
	expect(policy).toContain(`'nonce-${nonce}'`);
});

test('fixture CSP opt-out removes only upgrade-insecure-requests', () => {
	const nonce = 'security-headers-test-nonce';
	const defaultPolicy = contentSecurityPolicy(nonce);
	const fixturePolicy = contentSecurityPolicy(nonce, false);

	expect(fixturePolicy).toBe(defaultPolicy.replace(/; upgrade-insecure-requests$/, ''));
});

test('fixture guard allows Preview but rejects Production', () => {
	const keys = [
		'E2E_FIXTURE_MODE',
		'VERCEL_ENV',
		'NEXT_PUBLIC_DB_DOWN',
		'CI',
		'POSTGRES_URL',
		'DATABASE_URL',
	] as const;
	const saved = new Map(keys.map((key) => [key, process.env[key]]));

	try {
		process.env.E2E_FIXTURE_MODE = 'true';
		process.env.VERCEL_ENV = 'preview';
		process.env.NEXT_PUBLIC_DB_DOWN = 'true';
		process.env.CI = 'true';
		process.env.POSTGRES_URL = '';
		process.env.DATABASE_URL = '';
		expect(isE2EDbDownMode()).toBe(true);

		process.env.VERCEL_ENV = 'production';
		expect(isE2EDbDownMode()).toBe(false);
	} finally {
		for (const key of keys) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test('local fixture HTTP response keeps the rest of the strict CSP', async ({ page }) => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
	await setupMember(page);

	const response = await page.goto(`/wg/${FIXTURE_WG.shareCode}/putzen`, {
		waitUntil: 'domcontentloaded',
	});
	expect(response?.status()).toBe(200);

	const policy = response?.headers()['content-security-policy'] ?? '';
	expect(policy).not.toContain('upgrade-insecure-requests');
	expect(policy).toMatch(/script-src [^;]*'nonce-[^']+'/);
	expect(policy).toContain("frame-ancestors 'none'");
	expect(policy).toContain("object-src 'none'");
	expect(policy).toContain("base-uri 'self'");
	expect(policy).toContain("form-action 'self'");
});
