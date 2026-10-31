// Entry frame, public header and app shell state.
// Why: The frame around every page must not overflow or lose navigation state.

import { expect, test } from '@playwright/test';
import { FIXTURE_WG, mockNoWgs, setupMember, skipUnlessDbDown } from './support/helpers';

test.describe('entry frame overflow', () => {
	test.describe('entry headings on narrow screens', () => {
		skipUnlessDbDown();

		test('wraps an unbroken WG name at handset widths and 32px text', async ({ page }) => {
			const wgName = 'Donaudampfschifffahrtsgesellschaftskapitänswohngemeinschaft';
			await page.setViewportSize({ width: 320, height: 780 });
			await page.addInitScript(() => window.localStorage.clear());
			await mockNoWgs(page);
			await page.route('**/api/wg', async (route) => {
				if (route.request().method() === 'POST') {
					await route.fulfill({
						json: {
							wg: { id: 'fixture', shareCode: FIXTURE_WG.shareCode, name: wgName },
							creator: { id: 'fixture-user', name: 'Anna' },
						},
					});
					return;
				}
				await route.continue();
			});

			await page.goto('/login');
			await page.getByRole('button', { name: 'Neue WG erstellen', exact: true }).click();
			await page.getByLabel('WG-Name').fill(wgName);
			await page.getByLabel('Dein Anzeigename').fill('Anna');
			await page.getByRole('button', { name: 'WG erstellen', exact: true }).click();

			const heading = page.getByText(`Eure WG „${wgName}“ wurde erstellt.`, { exact: true });
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
});

test.describe('public header reflow', () => {
	test('public brand and account links reflow on narrow pages', async ({ page, browserName }) => {
		await page.route('**/api/wg/mine', (route) =>
			route.fulfill({
				status: 401,
				contentType: 'application/json',
				body: '{"error":"auth_required"}',
			}),
		);

		const layoutFailures: string[] = [];
		for (const path of ['/', '/discover/calendar']) {
			// Fixture builds always look up the session, which swaps the link for a skeleton until then.
			const sessionChecked = page.waitForResponse('**/api/wg/mine');
			await page.goto(path);
			await sessionChecked;
			const brand = page.getByRole('link', { name: 'ManaWG Startseite', exact: true });
			const account = page.getByRole('link', { name: 'Anmelden', exact: true });
			await expect(brand).toHaveAttribute('href', '/');
			await expect(account).toHaveAttribute('href', '/login');

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
			if (browserName === 'webkit') {
				// WebKit's native Tab traversal skips links without Full Keyboard Access.
				await account.focus();
			}
			await expect(account).toBeFocused();
		}

		expect(layoutFailures).toEqual([]);
	});
});

test.describe('app shell state', () => {
	test.describe('app shell navigation state', () => {
		test('lets a signed-in single-WG user open that WG from a module preview', async ({ page }) => {
			skipUnlessDbDown();

			await setupMember(page);
			await page.route('**/api/wg/mine', (route) =>
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						wgs: [{ id: FIXTURE_WG.id, code: FIXTURE_WG.shareCode, name: 'Meine WG' }],
					}),
				}),
			);

			await page.goto('/discover/shopping');
			const openWg = page.getByRole('link', { name: 'WG öffnen', exact: true });
			await expect(openWg).toBeVisible();
			await openWg.click();
			await expect(page).toHaveURL(new RegExp(`/wg/${FIXTURE_WG.shareCode}$`));
		});

		test('opens the WG chooser from a module preview with an invitation query', async ({
			page,
		}) => {
			skipUnlessDbDown();

			await page.route('**/api/wg/mine', (route) =>
				route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						wgs: [
							{ id: FIXTURE_WG.id, code: FIXTURE_WG.shareCode, name: 'Meine WG' },
							{ id: 'second-wg', code: 'ABCDEFGH', name: 'Zweite WG' },
						],
					}),
				}),
			);

			await page.goto('/discover/shopping?invite=fixture-invite-token01');
			const openWgs = page.getByRole('link', { name: 'Deine WGs', exact: true });
			await expect(openWgs).toBeVisible();
			await openWgs.click();
			await expect(page).toHaveURL('/');
			await expect(page.getByRole('heading', { name: 'Deine WGs', exact: true })).toBeVisible();
			await expect(page.getByText('Zweite WG', { exact: true })).toBeVisible();
		});
	});
});
