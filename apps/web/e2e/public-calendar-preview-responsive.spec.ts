import { expect, test } from '@playwright/test';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

test('keeps the featured calendar preview readable at narrow widths and 200% text', async ({
	page,
}) => {
	await page.goto('/entdecken/kalender');

	const example = page.locator('article[aria-label="Kalender, Beispiel-WG"]');
	await expect(example).toBeVisible();

	for (const colorScheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme });

		for (const textScale of ['normal', '200%'] as const) {
			await page.evaluate((scale) => {
				if (scale === '200%') {
					document.documentElement.style.fontSize = '32px';
				} else {
					document.documentElement.style.removeProperty('font-size');
				}
			}, textScale);

			for (const width of [320, 360, 390]) {
				await page.setViewportSize({ width, height: 812 });

				const metrics = await example.locator('[data-slot="item"]').evaluate((row) => {
					const content = row.querySelector<HTMLElement>('[data-slot="item-content"]');
					if (!content) throw new Error('Preview row has no text content');

					return {
						contentWidth: content.getBoundingClientRect().width,
						rowWidth: row.getBoundingClientRect().width,
						rowHeight: row.getBoundingClientRect().height,
						rootFontSize: getComputedStyle(document.documentElement).fontSize,
					};
				});

				if (textScale === '200%') expect(metrics.rootFontSize).toBe('32px');
				expect(
					metrics.contentWidth,
					`${width}px ${colorScheme} ${textScale}: preview text must not collapse between the icon and badge`,
				).toBeGreaterThanOrEqual(metrics.rowWidth * 0.45);
				expect(metrics.rowHeight).toBeLessThan(480);
			}
		}
	}

	const homeLink = page.getByRole('link', { name: 'Alle Bereiche ansehen' });
	await expect(homeLink).toBeVisible();
	await expect(homeLink).toHaveAttribute('href', '/');
	await homeLink.focus();
	await expect(homeLink).toBeFocused();
});
