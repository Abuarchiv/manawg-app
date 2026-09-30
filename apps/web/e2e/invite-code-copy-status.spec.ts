import { expect, test } from '@playwright/test';

test.describe('invite code copy feedback', () => {
	test.skip(
		process.env.E2E_FIXTURE_MODE !== 'true' || process.env.NEXT_PUBLIC_DB_DOWN !== 'true',
		'Requires the local database-down fixture server.',
	);

	test('announces a copied code without reporting that the invitation link was copied', async ({
		page,
	}) => {
		const code = 'MTE8PZAT';
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.addInitScript(() => window.localStorage.clear());
		await page.route('**/api/wg/mine', (route) => route.fulfill({ json: { wgs: [] } }));
		await page.route('**/api/wg', async (route) => {
			if (route.request().method() === 'POST') {
				await route.fulfill({
					json: {
						wg: { id: 'fixture', shareCode: code, name: 'Fixture WG' },
						creator: { id: 'fixture-user', name: 'Anna' },
					},
				});
				return;
			}
			await route.continue();
		});

		await page.goto('/neu');
		await page.getByRole('button', { name: 'Neue WG erstellen', exact: true }).click();
		await page.getByLabel('WG-Name').fill('Fixture WG');
		await page.getByLabel('Dein Anzeigename').fill('Anna');
		await page.getByRole('button', { name: 'WG erstellen', exact: true }).click();

		const copyCodeButton = page.getByRole('button', {
			name: `Code ${code} kopieren`,
			exact: true,
		});
		await expect(copyCodeButton).toBeVisible();
		await copyCodeButton.focus();
		await expect(copyCodeButton).toBeFocused();
		await page.keyboard.press('Enter');

		await expect(page.locator('#share-status-live')).toHaveText('Einladungscode wurde kopiert.');
		await expect(
			page.getByRole('button', { name: 'Mitbewohner einladen', exact: true }),
		).toBeVisible();
		await expect(page.getByText('Code kopiert', { exact: true })).toBeVisible();
		await expect(page.getByText('Link kopiert', { exact: true })).toHaveCount(0);
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
	});
});
