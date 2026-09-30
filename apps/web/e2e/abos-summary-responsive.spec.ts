import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
test.use({ hasTouch: true, isMobile: true });

const abo = {
	id: 'abo-mobile-summary',
	description: 'Musik-Abo',
	amountCents: 123456,
	currency: 'EUR',
	paidByMemberId: FIXTURE_WG.memberId,
	intervalMonths: 1,
	nextDueAt: '2026-10-01T12:00:00.000Z',
	lastCreatedAt: null,
	pausedAt: null,
	splits: [{ debtorMemberId: FIXTURE_WG.memberId, amountCents: 123456 }],
};

for (const width of [320, 360]) {
	for (const colorScheme of ['light', 'dark'] as const) {
		for (const textScale of ['normal', '200%'] as const) {
			test(`monthly summary fits ${width}px ${colorScheme} ${textScale}`, async ({ page }) => {
				await page.setViewportSize({ width, height: 740 });
				await page.emulateMedia({ colorScheme });
				await setupMember(page);
				await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/members*`, (route) =>
					route.fulfill({
						json: {
							members: [
								{
									id: FIXTURE_WG.memberId,
									name: FIXTURE_WG.memberName,
									color: null,
									active: true,
								},
							],
						},
					}),
				);
				await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/recurring-expenses*`, (route) =>
					route.fulfill({ json: { recurringExpenses: [abo] } }),
				);
				await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/abos`);
				await expect(page.getByText('Pro Monat')).toBeVisible();

				if (textScale === '200%') {
					await page.evaluate(() => {
						document.documentElement.style.fontSize = '200%';
					});
				}

				const summary = page.getByText('Pro Monat').locator('xpath=../../..');
				const metrics = await summary.locator('[data-slot="card-content"]').evaluate((element) => ({
					rootFontSize: getComputedStyle(document.documentElement).fontSize,
					columns: getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
					contentWidth: element.clientWidth,
					scrollWidth: element.scrollWidth,
				}));

				if (textScale === '200%') {
					expect(metrics.rootFontSize).toBe('32px');
					expect(metrics.columns).toBe(1);
				} else {
					expect(metrics.columns).toBe(2);
				}
				expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.contentWidth + 1);
				await expect(page.locator('html')).toHaveJSProperty('scrollWidth', width);
				if (width === 320 && colorScheme === 'dark' && textScale === '200%') {
					await page.screenshot({ path: test.info().outputPath('summary-320-dark-200.png') });
				}
			});
		}
	}
}
