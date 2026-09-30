import { expect, test } from '@playwright/test';
import { FIXTURE_WG, setupMember } from './_helpers';

test.describe('app shell navigation state', () => {
	test('restores create intent from the URL after signing out', async ({ page }) => {
		test.skip(
			!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
			'Requires the configured Supabase browser client.',
		);

		await page.route('**/api/wg/mine', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ wgs: [] }),
			}),
		);

		await page.goto('/neu?action=create');
		await page.getByRole('button', { name: 'Mit anderem Konto anmelden', exact: true }).click();

		await expect(page.getByText('Melde dich an, danach erstellst du deine neue WG.')).toBeVisible();
	});

	test('restores invitation intent from the URL after signing out', async ({ page }) => {
		test.skip(
			!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
			'Requires the configured Supabase browser client.',
		);

		await page.route('**/api/wg/mine', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ wgs: [] }),
			}),
		);

		await page.goto(`/neu?code=${FIXTURE_WG.shareCode}`);
		await page.getByRole('button', { name: 'Mit anderem Konto anmelden', exact: true }).click();

		await expect(
			page.getByText('Melde dich an, um mit deinem Einladungscode beizutreten.'),
		).toBeVisible();
	});

	test('lets a signed-in single-WG user open that WG from a module preview', async ({ page }) => {
		test.skip(
			process.env.E2E_FIXTURE_MODE !== 'true' || process.env.NEXT_PUBLIC_DB_DOWN !== 'true',
			'Requires the database-down fixture server.',
		);

		await setupMember(page);
		await page.route('**/api/wg/mine', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					wgs: [{ id: FIXTURE_WG.id, code: FIXTURE_WG.shareCode, name: 'Meine WG' }],
				}),
			}),
		);

		await page.goto('/entdecken/einkauf');
		const openWg = page.getByRole('link', { name: 'WG öffnen', exact: true });
		await expect(openWg).toBeVisible();
		await openWg.click();
		await expect(page).toHaveURL(new RegExp(`/wg/${FIXTURE_WG.shareCode}$`));
	});

	test('opens the WG chooser from a module preview with an invitation query', async ({ page }) => {
		test.skip(
			process.env.E2E_FIXTURE_MODE !== 'true' || process.env.NEXT_PUBLIC_DB_DOWN !== 'true',
			'Requires the database-down fixture server.',
		);

		await page.route('**/api/wg/mine', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					wgs: [
						{ id: FIXTURE_WG.id, code: FIXTURE_WG.shareCode, name: 'Meine WG' },
						{ id: 'second-wg', code: 'ABCDEFGH', name: 'Zweite WG' },
					],
				}),
			}),
		);

		await page.goto(`/entdecken/einkauf?code=${FIXTURE_WG.shareCode}`);
		const openWgs = page.getByRole('link', { name: 'Deine WGs', exact: true });
		await expect(openWgs).toBeVisible();
		await openWgs.click();
		await expect(page).toHaveURL('/');
		await expect(page.getByRole('heading', { name: 'Deine WGs', exact: true })).toBeVisible();
		await expect(page.getByText('Zweite WG', { exact: true })).toBeVisible();
	});
});
