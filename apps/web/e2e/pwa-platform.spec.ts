import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { isIosLikeDevice } from '../src/shared/lib/pwa-install';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test('iPadOS desktop Safari is treated as an iOS-like device', () => {
	expect(
		isIosLikeDevice({
			userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
			platform: 'MacIntel',
			maxTouchPoints: 5,
		}),
	).toBe(true);
	expect(
		isIosLikeDevice({
			userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
			platform: 'MacIntel',
			maxTouchPoints: 0,
		}),
	).toBe(false);
});

async function fireInstallEvent(page: import('@playwright/test').Page) {
	await page.evaluate(() => {
		const event = Object.assign(new Event('beforeinstallprompt'), {
			prompt: async () => {},
			userChoice: Promise.resolve({ outcome: 'dismissed' }),
		});
		window.dispatchEvent(event);
	});
}

test('dismissed install prompt returns on the next page load', async ({ page }) => {
	await page.goto('/');
	await fireInstallEvent(page);
	const install = page.getByRole('button', { name: 'Jetzt installieren', exact: true });
	await expect(install).toBeVisible();

	await page.getByRole('button', { name: 'Installationshinweis ausblenden' }).click();
	await expect(install).toHaveCount(0);
	await page.getByRole('link', { name: 'Haushalt' }).click();
	await expect(page).toHaveURL(/entdecken/);
	await expect(install).toHaveCount(0);

	// Feature pages keep their bottom actions free; the next start page shows it again.
	await page.reload();
	await fireInstallEvent(page);
	await expect(install).toHaveCount(0);
	await page.goto('/');
	await fireInstallEvent(page);
	await expect(install).toBeVisible();
});

test('browsers without a native prompt get the manual install steps', async ({ page }) => {
	await page.addInitScript(() => {
		// biome-ignore lint/performance/noDelete: simulate a browser without the API
		delete (window as { onbeforeinstallprompt?: unknown }).onbeforeinstallprompt;
	});
	await page.goto('/');
	await page.getByRole('button', { name: 'So installierst du ManaWG', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'ManaWG als App installieren' })).toBeVisible();
});

test('WG install prompt stays above and does not block the bottom navigation', async ({
	page,
}, testInfo) => {
	await setupMember(page);
	await page.addInitScript(() => {
		// biome-ignore lint/performance/noDelete: simulate a browser without the API
		delete (window as { onbeforeinstallprompt?: unknown }).onbeforeinstallprompt;
	});
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
	await dismissOnboarding(page);

	const prompt = page.locator('section[aria-label="App installieren"]');
	await expect(prompt).toBeVisible();
	await expect(prompt.getByRole('button', { name: 'So installierst du ManaWG' })).toBeVisible();
	const card = prompt.locator('[data-slot="card"]');
	await expect(card).toBeVisible();
	const bottomNav = page.getByRole('navigation', { name: 'WG Hauptnavigation' });
	for (const label of ['Start', 'Haushalt', 'Finanzen', 'Austausch']) {
		await expect(bottomNav.getByRole('link', { name: label })).toBeVisible();
	}

	const measurements: Array<{
		width: number;
		theme: 'light' | 'dark';
		textScale: '100%' | '200%';
		cardBottom: number;
		navTop: number;
		gap: number;
		sharedNavHeight: number;
		navItemHeights: number[];
	}> = [];
	for (const textScale of ['100%', '200%'] as const) {
		await page.evaluate((fontSize) => {
			document.documentElement.style.fontSize = fontSize;
		}, textScale);
		await expect
			.poll(() =>
				page.evaluate(() => {
					const nav = document.querySelector('nav[aria-label="WG Hauptnavigation"]');
					const sharedHeight = Number.parseFloat(
						getComputedStyle(document.documentElement).getPropertyValue('--app-nav-height'),
					);
					return nav !== null && Math.abs(nav.getBoundingClientRect().height - sharedHeight) < 0.1;
				}),
			)
			.toBe(true);
		for (const theme of ['light', 'dark'] as const) {
			for (const width of [320, 390]) {
				await page.setViewportSize({ width, height: 844 });
				await page.emulateMedia({ colorScheme: theme });
				await expect
					.poll(() =>
						page.evaluate(() => {
							const nav = document.querySelector('nav[aria-label="WG Hauptnavigation"]');
							const sharedHeight = Number.parseFloat(
								getComputedStyle(document.documentElement).getPropertyValue('--app-nav-height'),
							);
							const promptCard = document.querySelector(
								'section[aria-label="App installieren"] [data-slot="card"]',
							);
							if (!nav || !promptCard) return false;
							const navBounds = nav.getBoundingClientRect();
							return (
								Math.abs(navBounds.height - sharedHeight) < 0.1 &&
								promptCard.getBoundingClientRect().bottom <= navBounds.top
							);
						}),
					)
					.toBe(true);
				const [cardBox, navBox, navItemHeights, sharedNavHeight] = await Promise.all([
					card.boundingBox(),
					bottomNav.boundingBox(),
					bottomNav
						.getByRole('link')
						.evaluateAll((links) => links.map((link) => link.getBoundingClientRect().height)),
					page.evaluate(() =>
						Number.parseFloat(
							getComputedStyle(document.documentElement).getPropertyValue('--app-nav-height'),
						),
					),
				]);
				expect(cardBox).not.toBeNull();
				expect(navBox).not.toBeNull();
				if (!cardBox || !navBox)
					throw new Error('Prompt card or bottom navigation is not measurable');
				measurements.push({
					width,
					theme,
					textScale,
					cardBottom: cardBox.y + cardBox.height,
					navTop: navBox.y,
					gap: navBox.y - (cardBox.y + cardBox.height),
					sharedNavHeight,
					navItemHeights,
				});
				expect(sharedNavHeight).toBeCloseTo(navBox.height, 2);
				expect(navItemHeights.length).toBe(4);
				expect(navItemHeights.every((height) => height >= 44)).toBe(true);
				for (const label of ['Start', 'Haushalt', 'Finanzen', 'Austausch']) {
					await bottomNav.getByRole('link', { name: label }).click({ trial: true });
				}
				await page.screenshot({
					path: testInfo.outputPath(
						`wg-install-${width}-${theme}-text-${textScale === '200%' ? '200' : '100'}.png`,
					),
					animations: 'disabled',
				});
				if (textScale === '200%') {
					const dismissButton = prompt.getByRole('button', {
						name: 'Installationshinweis ausblenden',
					});
					const installButton = prompt.getByRole('button', {
						name: 'So installierst du ManaWG',
					});
					await dismissButton.focus();
					await expect(dismissButton).toBeFocused();
					await page.keyboard.press('Tab');
					await expect(installButton).toBeFocused();
					await expect
						.poll(() => installButton.evaluate((element) => element.matches(':focus-visible')))
						.toBe(true);
					const [installBox, scrolledCardBox] = await Promise.all([
						installButton.boundingBox(),
						card.boundingBox(),
					]);
					expect(installBox).not.toBeNull();
					expect(scrolledCardBox).not.toBeNull();
					if (!installBox || !scrolledCardBox)
						throw new Error('Install action or scrollable card is not measurable');
					expect(installBox.y).toBeGreaterThanOrEqual(scrolledCardBox.y);
					expect(installBox.y + installBox.height).toBeLessThanOrEqual(
						scrolledCardBox.y + scrolledCardBox.height,
					);
					await installButton.click({ trial: true });
					await page.screenshot({
						path: testInfo.outputPath(`wg-install-${width}-${theme}-text-200-action.png`),
						animations: 'disabled',
					});
					await dismissButton.focus();
					await expect(dismissButton).toBeFocused();
					await expect(dismissButton).toBeVisible();
					await dismissButton.click({ trial: true });
				}
			}
		}
	}
	await writeFile(
		testInfo.outputPath('pwa-bottom-nav-bounds.json'),
		JSON.stringify(measurements, null, 2),
	);
	expect(measurements.filter((measurement) => measurement.gap < 0)).toEqual([]);
});

const wgFeatureTitles = [
	['abos', 'Fixkosten — ManaWG'],
	['putzen', 'Putzplan — ManaWG'],
	['einkauf', 'Einkaufsliste — ManaWG'],
	['kalender', 'Kalender — ManaWG'],
	['import', 'Ausgaben importieren — ManaWG'],
	['ausgaben', 'Ausgaben — ManaWG'],
	['pinnwand', 'Pinnwand — ManaWG'],
	['aktivitaet', 'Aktivität — ManaWG'],
	['mahnungen', 'Erinnerungen — ManaWG'],
	['einstellungen', 'Einstellungen — ManaWG'],
	['vorraete', 'Vorräte — ManaWG'],
] as const;

/** WCAG 2.4.2: each WG feature segment must publish its own descriptive title. */
test('WG feature pages get distinct, descriptive document titles', async ({ page }) => {
	await setupMember(page);
	for (const [feature, title] of wgFeatureTitles) {
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/${feature}`);
		await dismissOnboarding(page);
		await expect.poll(() => page.title()).toBe(title);
	}
});

/**
 * Guards metadata replacement through SPA navigation: feature title, another
 * feature title, then the WG dashboard title from the parent layout.
 */
test('leaving a titled feature page via client-side navigation restores the WG dashboard title', async ({
	page,
}) => {
	await setupMember(page);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/putzen`);
	await dismissOnboarding(page);
	await expect.poll(() => page.title()).toBe('Putzplan — ManaWG');

	const bottomNav = page.getByRole('navigation', { name: 'WG Hauptnavigation' });
	await bottomNav.getByRole('link', { name: 'Finanzen' }).click();
	await expect(page).toHaveURL(new RegExp(`/wg/${FIXTURE_WG.shareCode}/ausgaben`));
	await expect.poll(() => page.title()).toBe('Ausgaben — ManaWG');

	await bottomNav.getByRole('link', { name: 'Start' }).click();
	await expect(page).toHaveURL(new RegExp(`/wg/${FIXTURE_WG.shareCode}$`));
	// Fixture WG name (E2E_EXISTING_WG.name in e2e-db-down.ts) is "sadf".
	await expect.poll(() => page.title()).toBe('sadf — ManaWG');
});
