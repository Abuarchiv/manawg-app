import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

for (const width of [320, 360]) {
	for (const theme of ['Hell', 'Dunkel'] as const) {
		test(`${width}px ${theme}: failed status check blocks connect until retry`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 780 });
			await setupMember(page);

			let retryRequested = false;
			let statusGets = 0;
			const startBodies: unknown[] = [];
			await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/paypal/connect`, async (route) => {
				if (route.request().method() === 'GET') {
					statusGets += 1;
					if (!retryRequested) {
						return route.fulfill({ status: 503, json: { error: 'temporary_failure' } });
					}
					return route.fulfill({ json: { available: true, connected: false } });
				}
				const body = route.request().postDataJSON() as { action?: string };
				if (body.action === 'start') startBodies.push(body);
				return route.fulfill({ status: 400, json: { error: 'unexpected_action' } });
			});

			await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen`);
			const themeButton = page.getByRole('button', { name: theme, exact: true });
			await expect(themeButton).toBeVisible({ timeout: 30_000 });
			const errorAlert = page.getByRole('alert').filter({
				hasText: 'PayPal-Verbindung konnte nicht geprüft werden. Bitte versuche es erneut.',
			});
			await expect(errorAlert).toBeVisible();
			expect(statusGets).toBeGreaterThan(0);
			await expect(page.getByRole('textbox', { name: /merchant.?id/i })).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'PayPal verbinden', exact: true })).toHaveCount(
				0,
			);

			await themeButton.click();
			if (theme === 'Dunkel') await expect(page.locator('html')).toHaveClass(/dark/);
			else await expect(page.locator('html')).not.toHaveClass(/dark/);
			const layout = await page.evaluate(() => ({
				viewport: document.documentElement.clientWidth,
				content: document.documentElement.scrollWidth,
			}));
			expect(layout.content).toBeLessThanOrEqual(layout.viewport);
			expect(startBodies).toEqual([]);

			const retry = page.getByRole('button', { name: 'Verbindung prüfen', exact: true });
			await expect(retry).toBeVisible();
			const getsBeforeRetry = statusGets;
			await retry.focus();
			retryRequested = true;
			await page.keyboard.press('Enter');

			await expect(errorAlert).toBeHidden();
			await expect(
				page.getByRole('button', { name: 'PayPal verbinden', exact: true }),
			).toBeEnabled();
			await expect.poll(() => statusGets).toBeGreaterThan(getsBeforeRetry);
			expect(startBodies).toEqual([]);
		});
	}
}
