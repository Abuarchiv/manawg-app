import { expect, test } from '@playwright/test';

test.describe('credentials auth form validation fixture', () => {
	test.skip(
		process.env.E2E_FIXTURE_MODE !== 'true' || process.env.NEXT_PUBLIC_DB_DOWN !== 'true',
		'Requires the database-down fixture server.',
	);

	test('shows the custom error box instead of native browser validation', async ({ page }) => {
		await page.route('**/api/wg/mine', (route) =>
			route.fulfill({
				status: 401,
				contentType: 'application/json',
				body: '{"error":"auth_required"}',
			}),
		);
		await page.goto('/neu');

		const email = page.locator('#auth-email');
		const password = page.locator('#auth-password');
		await expect(email).toBeVisible();

		// Both fields must skip native constraint validation (noValidate) so an
		// invalid email or short password reaches the custom, German ErrorBox
		// instead of a silently-swallowed submit or a browser-default tooltip.
		await expect(page.locator('form').filter({ has: email })).toHaveAttribute('novalidate', '');

		await email.fill('not-an-email');
		await password.fill('123');
		await password.press('Enter');

		await expect(page.locator('#auth-email-error')).toContainText(
			'Bitte gib eine gültige E-Mail-Adresse und ein Passwort mit mindestens 6 Zeichen ein.',
		);
	});
});
