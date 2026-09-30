import { expect, test } from '@playwright/test';

test.describe('entry headings on narrow screens', () => {
	test.skip(
		process.env.E2E_FIXTURE_MODE !== 'true' || process.env.NEXT_PUBLIC_DB_DOWN !== 'true',
		'Requires the local database-down fixture server.',
	);

	test('wraps an unbroken WG name at handset widths and 32px text', async ({ page }) => {
		const wgName = 'Donaudampfschifffahrtsgesellschaftskapitänswohngemeinschaft';
		await page.setViewportSize({ width: 320, height: 780 });
		await page.addInitScript(() => window.localStorage.clear());
		await page.route('**/api/wg/mine', (route) => route.fulfill({ json: { wgs: [] } }));
		await page.route('**/api/wg', async (route) => {
			if (route.request().method() === 'POST') {
				await route.fulfill({
					json: {
						wg: { id: 'fixture', shareCode: 'MTE8PZAT', name: wgName },
						creator: { id: 'fixture-user', name: 'Anna' },
					},
				});
				return;
			}
			await route.continue();
		});

		await page.goto('/neu');
		await page.getByRole('button', { name: 'Neue WG erstellen', exact: true }).click();
		await page.getByLabel('WG-Name').fill(wgName);
		await page.getByLabel('Dein Anzeigename').fill('Anna');
		await page.getByRole('button', { name: 'WG erstellen', exact: true }).click();

		const heading = page.getByRole('heading', { name: wgName, exact: true, level: 1 });
		await expect(heading).toBeVisible();

		for (const width of [320, 360]) {
			for (const fontSize of [26, 32]) {
				for (const colorScheme of ['light', 'dark'] as const) {
					await page.setViewportSize({ width, height: 780 });
					await page.emulateMedia({ colorScheme });
					await expect
						.poll(() =>
							page.locator('html').evaluate((element) => element.classList.contains('dark')),
						)
						.toBe(colorScheme === 'dark');
					await heading.evaluate((element, size) => {
						(element as HTMLElement).style.fontSize = `${size}px`;
					}, fontSize);
					const layout = await heading.evaluate((element) => {
						const style = getComputedStyle(element);
						const rect = element.getBoundingClientRect();
						return {
							documentWidth: document.documentElement.scrollWidth,
							viewportWidth: window.innerWidth,
							headingRight: rect.right,
							headingHeight: rect.height,
							lineHeight: Number.parseFloat(style.lineHeight),
						};
					});

					expect(
						layout.documentWidth,
						`${width}px, ${fontSize}px, ${colorScheme}`,
					).toBeLessThanOrEqual(layout.viewportWidth);
					expect(
						layout.headingRight,
						`${width}px, ${fontSize}px, ${colorScheme}`,
					).toBeLessThanOrEqual(layout.viewportWidth);
					expect(layout.headingHeight).toBeGreaterThan(layout.lineHeight);
				}
			}
		}
	});
});
