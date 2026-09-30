import { expect, test } from '@playwright/test';

test('public brand and account links reflow on narrow pages', async ({ page }) => {
	await page.route('**/api/wg/mine', (route) =>
		route.fulfill({
			status: 401,
			contentType: 'application/json',
			body: '{"error":"auth_required"}',
		}),
	);

	const layoutFailures: string[] = [];
	for (const path of ['/', '/entdecken/kalender']) {
		await page.goto(path);
		const brand = page.getByRole('link', { name: 'ManaWG Startseite', exact: true });
		const account = page.getByRole('link', { name: 'Anmelden', exact: true });
		await expect(brand).toHaveAttribute('href', '/');
		await expect(account).toHaveAttribute('href', '/neu');

		for (const width of [320, 360, 390]) {
			await page.setViewportSize({ width, height: 844 });
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme });
				await expect
					.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
					.toBe(scheme === 'dark');
				for (const rootFontSize of [16, 32]) {
					await page.evaluate((size) => {
						document.documentElement.style.fontSize = `${size}px`;
					}, rootFontSize);
					await page.evaluate(() => document.fonts.ready);
					await expect(account).toBeVisible();

					const metrics = await page.evaluate(() => {
						const brandLink = document.querySelector<HTMLAnchorElement>(
							'a[aria-label="ManaWG Startseite"]',
						);
						const accountLink = [...document.querySelectorAll<HTMLAnchorElement>('a')].find(
							(link) => link.textContent?.trim() === 'Anmelden',
						);
						if (!brandLink || !accountLink) return null;
						const brandRect = brandLink.getBoundingClientRect();
						const accountRect = accountLink.getBoundingClientRect();
						return {
							viewportWidth: window.innerWidth,
							documentWidth: Math.max(
								document.documentElement.scrollWidth,
								document.body.scrollWidth,
							),
							brandRight: brandRect.right,
							accountRight: accountRect.right,
							overlap:
								brandRect.right > accountRect.left &&
								accountRect.right > brandRect.left &&
								brandRect.bottom > accountRect.top &&
								accountRect.bottom > brandRect.top,
						};
					});
					const label = `${path} ${width}px root ${rootFontSize}px ${scheme}`;
					if (!metrics) {
						layoutFailures.push(`${label}: header links missing`);
						continue;
					}
					if (
						metrics.documentWidth > metrics.viewportWidth ||
						metrics.brandRight > width ||
						metrics.accountRight > width ||
						metrics.overlap
					) {
						layoutFailures.push(`${label}: ${JSON.stringify(metrics)}`);
					}
				}
			}
		}

		await page.setViewportSize({ width: 320, height: 844 });
		await page.emulateMedia({ colorScheme: 'dark' });
		await page.evaluate(() => {
			document.documentElement.style.fontSize = '32px';
		});
		await brand.focus();
		await page.keyboard.press('Tab');
		await expect(account).toBeFocused();
	}

	expect(layoutFailures).toEqual([]);
});
