// PWA platform: service worker, install prompt, cold start, offline page and offline banner focus.
// Why: the installed app must open and degrade gracefully with no network.

import { writeFile } from 'node:fs/promises';
import { type Page, type Route, expect, test } from '@playwright/test';
import { isIosLikeDevice } from '../src/shared/lib/pwa-install';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './support/helpers';

test.describe('pwa platform', () => {
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
						return (
							nav !== null && Math.abs(nav.getBoundingClientRect().height - sharedHeight) < 0.1
						);
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
		['einkauf', 'Einkäufe — ManaWG'],
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
		// Fixture WG name (E2E_EXISTING_WG.name in src/fixtures/data.ts) is "sadf".
		await expect.poll(() => page.title()).toBe('sadf — ManaWG');
	});
});

test.describe('cold pwa', () => {
	test('hydrates the offline fallback in a cold browser', async ({ browser }) => {
		const context = await browser.newContext({ serviceWorkers: 'allow' });
		const page = await context.newPage();
		const failedStaticAssets: string[] = [];
		page.on('requestfailed', (request) => {
			const path = new URL(request.url()).pathname;
			if (path.startsWith('/_next/static/') && /\.(?:js|css)$/i.test(path)) {
				failedStaticAssets.push(path);
			}
		});

		try {
			await page.goto('/');
			await expect
				.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), {
					timeout: 20_000,
				})
				.toBe(true);

			await context.setOffline(true);
			await page.goto('/cold-pwa-never-visited', { waitUntil: 'load' });

			await expect(page).toHaveTitle('Offline — ManaWG');
			await expect(page.locator('h1')).not.toHaveText('Verbindung wird geprüft…', {
				timeout: 15_000,
			});
			await expect(
				page.getByRole('button', { name: 'Offline-Status erneut prüfen' }),
			).toBeVisible();
			expect(failedStaticAssets).toEqual([]);
		} finally {
			await context.close();
		}
	});
});

test.describe('offline page', () => {
	const knownWg = {
		code: FIXTURE_WG.shareCode,
		name: 'Fixture WG',
		lastVisitedAt: 1_758_272_400_000,
	};

	const queuedAction = {
		id: `shopping:${FIXTURE_WG.shareCode}:offline-test`,
		idempotencyKey: '11111111-1111-4111-8111-111111111111',
		type: 'shopping.create',
		wgId: FIXTURE_WG.id,
		shareCode: FIXTURE_WG.shareCode,
		memberId: FIXTURE_WG.memberId,
		createdAt: new Date().toISOString(),
		payload: { name: 'Milch', quantity: '1L' },
	};

	async function seedOfflineState(page: Page): Promise<void> {
		await page.addInitScript(
			({ storedWg, storedAction }) => {
				localStorage.setItem('manawg_known_wgs', JSON.stringify([storedWg]));
				localStorage.setItem('manawg:offline-actions', JSON.stringify([storedAction]));
			},
			{ storedWg: knownWg, storedAction: queuedAction },
		);
	}

	async function fulfillMembership(route: Route, status = 200): Promise<void> {
		await route.fulfill({
			status,
			contentType: 'application/json',
			body: JSON.stringify(
				status === 200
					? { wgs: [{ code: FIXTURE_WG.shareCode, memberId: FIXTURE_WG.memberId }] }
					: { error: 'auth_required', code: 'auth_required' },
			),
		});
	}

	test.describe('Offline fallback page', () => {
		test.setTimeout(300_000);

		test('shows an honest "checking" state instead of a false reconnected message', async ({
			page,
		}) => {
			const pageErrors: string[] = [];
			page.on('pageerror', (error) => pageErrors.push(error.message));
			let resolveRoute: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				resolveRoute = resolve;
			});
			await page.route('**/api/wg/mine', async (route) => {
				await gate;
				await fulfillMembership(route);
			});
			await seedOfflineState(page);
			const navigation = navigateToFeature(page, '/offline');

			await expect(page.getByRole('heading', { name: 'Verbindung wird geprüft…' })).toBeVisible();
			await expect(page.getByRole('heading', { name: 'Du bist wieder verbunden.' })).toHaveCount(0);

			resolveRoute?.();
			await navigation;
			await expect(page.getByRole('heading', { name: 'Du bist wieder verbunden.' })).toBeVisible();
			expect(pageErrors).toEqual([]);
		});

		test('keeps queued actions visible when the browser is offline', async ({ page, context }) => {
			await page.route('**/api/wg/mine', (route) => fulfillMembership(route));
			await seedOfflineState(page);
			await navigateToFeature(page, '/offline');

			await expect(page.getByText('Einkauf', { exact: true })).toBeVisible();
			await page.unroute('**/api/wg/mine');
			await context.setOffline(true);
			await page.evaluate(() => window.dispatchEvent(new Event('offline')));

			await expect(page.getByRole('heading', { name: 'Du bist gerade offline.' })).toBeVisible();
			await expect(page.getByText('Einkauf', { exact: true })).toBeVisible();
			await expect(page.getByText('Milch')).toBeVisible();
		});

		test('offers the remembered WG offline when an identity exists but nothing is queued', async ({
			page,
			context,
		}) => {
			await page.route('**/api/wg/mine', (route) => fulfillMembership(route));
			await setupMember(page);
			await page.addInitScript((storedWg) => {
				localStorage.setItem('manawg_known_wgs', JSON.stringify([storedWg]));
			}, knownWg);
			await navigateToFeature(page, '/offline');
			await expect(page.getByRole('heading', { name: 'Du bist wieder verbunden.' })).toBeVisible();
			await page.unroute('**/api/wg/mine');
			await context.setOffline(true);
			await page.evaluate(() => window.dispatchEvent(new Event('offline')));

			await expect(page.getByRole('heading', { name: 'Du bist gerade offline.' })).toBeVisible();
			await expect(page.getByText('Noch keine WG auf diesem Gerät gemerkt')).toHaveCount(0);
			// WG pages are not cached: offline there is no link into a dead end, only a hint.
			await expect(page.getByRole('button', { name: 'Zurück zu Fixture WG' })).toBeDisabled();
			await expect(page.getByRole('link', { name: 'Fixture WG öffnen' })).toHaveCount(0);
			await expect(
				page.getByText('Deine WG öffnet sich erst, sobald du wieder online bist.'),
			).toBeVisible();
		});

		test('keeps queued actions visible when the server is unreachable', async ({ page }) => {
			await page.route('**/api/wg/mine', (route) => route.abort());
			await seedOfflineState(page);
			await navigateToFeature(page, '/offline');

			await expect(
				page.getByRole('heading', { name: 'Server gerade nicht erreichbar.' }),
			).toBeVisible();
			await expect(page.getByText('Einkauf', { exact: true })).toBeVisible();
			await expect(page.getByText('Milch')).toBeVisible();
		});

		test('hides local actions when the account is unauthenticated', async ({ page }) => {
			await page.route('**/api/wg/mine', (route) => fulfillMembership(route, 401));
			await seedOfflineState(page);
			await navigateToFeature(page, '/offline');

			await expect(
				page.getByRole('heading', { name: 'Melde dich an, um Offline-Aktionen zu sehen.' }),
			).toBeVisible();
			await expect(
				page.getByText('Nach der Anmeldung siehst du deine wartenden Aktionen.'),
			).toBeVisible();
			await expect(page.getByText('Milch')).toHaveCount(0);
			await expect(page.getByText('Fixture WG')).toHaveCount(0);
		});

		test('confirms a successful synchronization and clears the action', async ({ page }) => {
			await page.route('**/api/wg/mine', (route) => fulfillMembership(route));
			await page.route('**/api/wg/MTE8PZAT/shopping', (route) =>
				route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
			);
			await seedOfflineState(page);
			await navigateToFeature(page, '/offline');

			await page.getByRole('button', { name: 'Offline-Aktionen jetzt synchronisieren' }).click();

			await expect(page.getByText('1 Aktion synchronisiert.')).toBeVisible();
			await expect(page.getByText('Keine wartenden Aktionen.')).toBeVisible();
			await expect(page.getByText('Milch')).toHaveCount(0);
		});

		test('a 429 stops the replay after one request and keeps every action queued', async ({
			page,
		}) => {
			await page.route('**/api/wg/mine', (route) => fulfillMembership(route));
			let posts = 0;
			await page.route('**/api/wg/MTE8PZAT/shopping', (route) => {
				posts += 1;
				return route.fulfill({
					status: 429,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'rate_limited' }),
				});
			});
			await page.addInitScript(
				({ storedWg, storedActions }) => {
					localStorage.setItem('manawg_known_wgs', JSON.stringify([storedWg]));
					localStorage.setItem('manawg:offline-actions', JSON.stringify(storedActions));
				},
				{
					storedWg: knownWg,
					storedActions: [
						queuedAction,
						{
							...queuedAction,
							id: `shopping:${FIXTURE_WG.shareCode}:offline-test-2`,
							idempotencyKey: '22222222-2222-4222-8222-222222222222',
							payload: { name: 'Brot', quantity: null },
						},
					],
				},
			);
			await navigateToFeature(page, '/offline');

			await page.getByRole('button', { name: 'Offline-Aktionen jetzt synchronisieren' }).click();

			await expect(page.getByText('Zu viele Anfragen: Die Aktion bleibt')).toBeVisible();
			await expect(page.getByText('Brot')).toBeVisible();
			await expect(page.getByText('2 Aktionen warten.').first()).toBeVisible();
			expect(posts).toBe(1);
		});
	});
});

test.describe('offline banner focus', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	// WCAG 2.4.11: the sticky offline banner must not cover focused content or the
	// sticky settings tabs.
	test('offline banner keeps focused content and sticky tabs clear', async ({ page, context }) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await setupMember(page);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);
		await dismissOnboarding(page);

		const target = page.getByRole('button', { name: 'Einladungslink kopieren' });
		await expect(target).toBeVisible();
		await page.waitForLoadState('networkidle');

		await context.setOffline(true);
		const banner = page.locator('[data-offline-banner]');
		await expect(banner).toBeVisible();

		// Park the target under the banner: still inside the viewport, so focus only
		// scrolls it clear if scroll-padding marks the banner area as obscured.
		await target.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 10));
		await target.focus();

		const bannerBox = await banner.boundingBox();
		const targetBox = await target.boundingBox();
		const tabsBox = await page.getByRole('tablist').boundingBox();
		const checkBox = await banner
			.getByRole('link', { name: 'Offline-Übersicht prüfen' })
			.boundingBox();
		if (!bannerBox || !targetBox || !tabsBox || !checkBox)
			throw new Error('banner parts not measurable');
		const bannerBottom = bannerBox.y + bannerBox.height;
		expect(bannerBox.height).toBeGreaterThanOrEqual(44);
		expect(checkBox.x + checkBox.width).toBeLessThanOrEqual(320);
		expect(tabsBox.y).toBeGreaterThanOrEqual(bannerBottom);
		expect(targetBox.y).toBeGreaterThanOrEqual(bannerBottom);

		await context.setOffline(false);
	});
});
