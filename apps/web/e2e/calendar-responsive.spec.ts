// Public calendar preview and marker overflow on phones.
// Why: Markers and previews must not overflow at 320px.

import { type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './support/helpers';

test.describe('public calendar preview responsive', () => {
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

		const homeLink = page
			.getByRole('navigation', { name: 'Öffentliche Hauptnavigation' })
			.getByRole('link', { name: 'Start', exact: true });
		await expect(homeLink).toHaveAttribute('href', '/');
		await homeLink.focus();
		await expect(homeLink).toBeFocused();
	});
});

test.describe('marker mobile overflow', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	async function setTextScale(page: Page) {
		await page.evaluate(() => {
			const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
			if (!nonce) throw new Error('CSP nonce not found');
			const style = document.createElement('style');
			style.nonce = nonce;
			style.textContent = 'html { font-size: 200% !important; }';
			document.head.append(style);
		});
	}

	for (const width of [320, 360] as const) {
		for (const colorScheme of ['light', 'dark'] as const) {
			if (width !== 320) continue;
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
				const marker = page.locator('[data-slot="chat-day"]').first();
				await expect(marker).toBeVisible();
				await expect(marker).toHaveText(/\S/);
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
});
