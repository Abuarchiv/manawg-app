import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

test('legal links fit at 320px with normal and 200% text sizes', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 760 });
	await page.emulateMedia({ colorScheme: 'light' });
	await setupMember(page);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen`);
	await page.getByRole('tab', { name: 'Daten', exact: true }).click();

	const privacyLink = page.getByRole('link', {
		name: 'Datenschutz (öffnet in neuem Tab)',
		exact: true,
	});
	await expect(privacyLink).toBeVisible();
	const label = privacyLink.locator(':scope > span');
	const chevron = privacyLink.locator(':scope > svg');

	const width = 320;
	for (const fontSize of [16, 32]) {
		for (const colorScheme of ['light', 'dark'] as const) {
			await page.setViewportSize({ width, height: 760 });
			await page.emulateMedia({ colorScheme });
			await page.locator('html').evaluate((html, size) => {
				html.style.setProperty('font-size', `${size}px`, 'important');
			}, fontSize);

			await expect(page.locator('html')).toHaveCSS('font-size', `${fontSize}px`);
			if (colorScheme === 'dark') {
				await expect(page.locator('html')).toHaveClass(/dark/);
			} else {
				await expect(page.locator('html')).not.toHaveClass(/dark/);
			}

			const geometry = await privacyLink.evaluate((link) => {
				const anchor = link.getBoundingClientRect();
				return {
					anchor: {
						x: anchor.x,
						right: anchor.right,
						height: anchor.height,
						clientWidth: link.clientWidth,
						scrollWidth: link.scrollWidth,
					},
				};
			});
			const labelBox = await label.boundingBox();
			const chevronBox = await chevron.boundingBox();
			if (!labelBox || !chevronBox)
				throw new Error('Legal link label or chevron has no layout box');
			expect(geometry.anchor.x).toBeGreaterThanOrEqual(0);
			expect(geometry.anchor.right).toBeLessThanOrEqual(width);
			expect(geometry.anchor.height).toBeGreaterThanOrEqual(44);
			expect(geometry.anchor.scrollWidth).toBeLessThanOrEqual(geometry.anchor.clientWidth);
			expect(labelBox.x).toBeGreaterThanOrEqual(geometry.anchor.x);
			expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(geometry.anchor.right);
			expect(chevronBox.x).toBeGreaterThanOrEqual(geometry.anchor.x);
			expect(chevronBox.x + chevronBox.width).toBeLessThanOrEqual(geometry.anchor.right);

			if (fontSize === 32 && colorScheme === 'dark') {
				await page.evaluate(() => {
					if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
				});
				let reachedByKeyboard = false;
				for (let tab = 0; tab < 40; tab += 1) {
					await page.keyboard.press('Tab');
					if (await privacyLink.evaluate((link) => document.activeElement === link)) {
						reachedByKeyboard = true;
						break;
					}
				}
				expect(reachedByKeyboard).toBe(true);
				await expect(privacyLink).toBeFocused();
				const focusStyle = await privacyLink.evaluate((link) => ({
					isVisibleFocus: link.matches(':focus-visible'),
					boxShadow: getComputedStyle(link).boxShadow,
				}));
				expect(focusStyle.isVisibleFocus).toBe(true);
				expect(focusStyle.boxShadow).not.toBe('none');
			}
		}
	}
});
