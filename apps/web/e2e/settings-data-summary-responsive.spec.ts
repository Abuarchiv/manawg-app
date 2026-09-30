import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const width = 320;
for (const colorScheme of ['light', 'dark'] as const) {
	for (const textScale of ['normal', '32px'] as const) {
		test(`export summary fits ${width}px ${colorScheme} ${textScale}`, async ({ page }) => {
			await page.setViewportSize({ width, height: 844 });
			await page.emulateMedia({ colorScheme });
			await setupMember(page);
			await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#daten`);
			await expect(page.getByRole('heading', { name: 'Datenexport' })).toBeVisible({
				timeout: 30_000,
			});

			if (textScale === '32px') {
				await page.evaluate(() => {
					document.documentElement.style.fontSize = '200%';
				});
			}

			const summary = page
				.getByRole('region', { name: 'Datenexport' })
				.locator('div.border-b')
				.first();
			const labels = await summary.locator('span').evaluateAll((spans) =>
				spans
					.filter((span) => ['Ausgaben', 'Abwesenheiten'].includes(span.textContent?.trim() ?? ''))
					.map((span) => {
						const { left, right } = span.getBoundingClientRect();
						return { text: span.textContent?.trim(), left, right };
					}),
			);

			expect(labels).toHaveLength(2);
			for (const label of labels) {
				expect(label.left).toBeGreaterThanOrEqual(-1);
				expect(label.right).toBeLessThanOrEqual(width + 1);
			}
			const overflow = await summary.evaluate(
				(element) => element.scrollWidth - element.clientWidth,
			);
			expect(overflow).toBeLessThanOrEqual(1);
			if (colorScheme === 'dark' && textScale === '32px') {
				await page.screenshot({
					path: test.info().outputPath('export-summary-320-dark-32.png'),
				});
			}
		});
	}
}
