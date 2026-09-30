import { type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

async function setTextScale(page: Page) {
	await page.evaluate(() => {
		const nonce = document.querySelector('script[nonce]')?.nonce;
		if (!nonce) throw new Error('CSP nonce not found');
		const style = document.createElement('style');
		style.nonce = nonce;
		style.textContent = 'html { font-size: 200% !important; }';
		document.head.append(style);
	});
}

for (const width of [320, 360] as const) {
	for (const colorScheme of ['light', 'dark'] as const) {
		test(`chat date separator fits a ${width}px viewport at 200% text (${colorScheme})`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 844 });
			await page.emulateMedia({ colorScheme });
			await setupMember(page);
			await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
			await dismissOnboarding(page);
			await setTextScale(page);

			await expect(page.getByRole('textbox', { name: 'Chat-Nachricht' })).toBeVisible();
			const isDark = await page
				.locator('html')
				.evaluate((element) => element.classList.contains('dark'));
			expect(isDark).toBe(colorScheme === 'dark');
			const rootFontSize = await page.evaluate(() =>
				Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
			);
			expect(rootFontSize).toBeGreaterThanOrEqual(30);
			const marker = page.locator('[data-slot="marker-content"]').first();
			await expect(marker).toBeVisible();
			await expect(marker).toHaveText(/\d{1,2}\./);
			await marker.evaluate((element) => {
				element.textContent = 'Donnerstag, 30. September';
			});
			await expect(marker).toHaveText('Donnerstag, 30. September');
			const bounds = await marker.boundingBox();

			if (!bounds) throw new Error('chat date marker has no visible bounds');
			expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);

			const nav = page.getByRole('navigation', { name: 'WG Hauptnavigation' });
			await expect(nav).toBeVisible();
			const navTargets = await nav.locator('a[data-bottom-nav-item]').evaluateAll((items) =>
				items.map((item) => {
					const { x, y, width, height, right, bottom } = item.getBoundingClientRect();
					return { x, y, width, height, right, bottom };
				}),
			);
			expect(navTargets).toHaveLength(4);
			for (const target of navTargets) {
				expect(target.x).toBeGreaterThanOrEqual(0);
				expect(target.right).toBeLessThanOrEqual(width);
				expect(target.y + target.height).toBeLessThanOrEqual(844);
				expect(target.width).toBeGreaterThanOrEqual(44);
				expect(target.height).toBeGreaterThanOrEqual(44);
			}

			await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
			await dismissOnboarding(page);
			await setTextScale(page);
			const header = page.locator('[data-home-header]');
			await expect(header).toBeVisible();
			await expect(
				header.getByRole('link', { name: 'Konto und WG-Einstellungen öffnen' }),
			).toBeVisible();
			const headerBounds = await header.boundingBox();
			const actionBounds = await header.locator('a').evaluateAll((links) =>
				links.map((link) => {
					const { x, right } = link.getBoundingClientRect();
					return { x, right };
				}),
			);
			if (!headerBounds) throw new Error('WG home header has no visible bounds');
			expect(headerBounds.x + headerBounds.width).toBeLessThanOrEqual(width);
			for (const action of actionBounds) {
				expect(action.x).toBeGreaterThanOrEqual(0);
				expect(action.right).toBeLessThanOrEqual(width);
			}
		});
	}
}
