// Start overview navigation from cards and shortcuts.
// Why: Every card must lead to the matching feature view.

import { expect, test } from '@playwright/test';
import {
	dismissOnboarding,
	FIXTURE_WG,
	mockDashboard,
	mockUnreadCount,
	navigateToFeature,
	setupMember,
} from './support/helpers';

test.describe('daily overview navigation', () => {
	const BASE = `/api/wg/${FIXTURE_WG.shareCode}`;

	test('keeps the calendar in the exchange group and shows the confirmed unread count', async ({
		page,
	}) => {
		await setupMember(page);
		let dashboardReads = 0;
		let unreadReads = 0;
		await page.route(`**${BASE}/dashboard`, (route) => {
			dashboardReads += 1;
			return route.fulfill({
				status: 200,
				json: { openShoppingCount: 0, dueChores: [], dueRecurringExpenses: [] },
			});
		});
		await page.route(`**${BASE}/chat/unread-count`, (route) => {
			unreadReads += 1;
			return route.fulfill({ status: 200, json: { count: 7, overflow: false } });
		});

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/calendar`);
		await dismissOnboarding(page);

		const exchange = page.getByRole('navigation', { name: 'Austausch' });
		await expect(exchange.getByRole('link', { name: 'Pinnwand' })).toBeVisible();
		await expect(exchange.getByRole('link', { name: 'Chat, 7 ungelesen' })).toBeVisible();
		await expect(exchange.getByRole('link', { name: 'Kalender' })).toHaveAttribute(
			'aria-current',
			'page',
		);
		await expect(page.getByText('0 WG-Termine', { exact: true })).toBeVisible();
		await expect(page.getByText('Bad putzen', { exact: true })).toBeVisible();
		await expect(exchange.getByRole('link')).toHaveCount(3);
		await expect.poll(() => unreadReads).toBe(1);
		await expect.poll(() => dashboardReads).toBe(0);
	});

	test('marks an unavailable count without fabricating zero', async ({ page }) => {
		await setupMember(page);
		await mockDashboard(page, BASE, {
			openShoppingCount: 0,
			dueChores: [],
			dueRecurringExpenses: [],
		});
		await page.route(`**${BASE}/chat/unread-count`, (route) =>
			route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } }),
		);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/calendar`);
		await dismissOnboarding(page);

		const exchange = page.getByRole('navigation', { name: 'Austausch' });
		await expect(
			exchange.getByRole('link', { name: 'Chat, Zähler nicht verfügbar' }),
		).toBeVisible();
	});

	test('hides confirmed zero visually and keeps its meaning accessible', async ({ page }) => {
		await setupMember(page);
		await mockDashboard(page, BASE, {
			openShoppingCount: 0,
			dueChores: [],
			dueRecurringExpenses: [],
		});
		await mockUnreadCount(page, BASE);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/calendar`);
		await dismissOnboarding(page);

		const chat = page.getByRole('navigation', { name: 'Austausch' }).getByRole('link', {
			name: 'Chat, 0 ungelesen',
		});
		await expect(chat).toBeVisible();
		await expect(chat).toHaveText('Chat');
	});

	test('caps visible shopping counts and counts only the viewer’s due chores', async ({ page }) => {
		await setupMember(page);
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const nextQuarter = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
		await mockDashboard(page, BASE, {
			openShoppingCount: 123,
			dueChores: [
				{
					id: 'mine-due',
					assignedMemberId: FIXTURE_WG.memberId,
					nextDueAt: yesterday,
				},
				{ id: 'theirs-due', assignedMemberId: 'other-member', nextDueAt: yesterday },
				{
					id: 'mine-later',
					assignedMemberId: FIXTURE_WG.memberId,
					nextDueAt: nextQuarter,
				},
			],
			dueRecurringExpenses: [],
		});
		await mockUnreadCount(page, BASE);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/supplies`);
		await dismissOnboarding(page);

		const household = page.getByRole('navigation', { name: 'Haushalt' });
		const shopping = household.getByRole('link', { name: 'Einkäufe, 123 offen' });
		await expect(shopping).toBeVisible();
		await expect(shopping).toHaveText('Einkäufe99+');
		await expect(
			household.getByRole('link', { name: 'Putzplan, 1 für dich fällig' }),
		).toBeVisible();
	});

	test('reconciles the Shopping count after success, rollback, and offline queueing', async ({
		page,
	}) => {
		await setupMember(page);
		await mockDashboard(page, BASE, {
			openShoppingCount: 2,
			dueChores: [],
			dueRecurringExpenses: [],
		});
		await mockUnreadCount(page, BASE);
		const createdAt = new Date(Date.now() - 60_000).toISOString();
		const coffee = {
			id: 'coffee',
			name: 'Kaffee',
			normalizedName: 'kaffee',
			quantity: null,
			boughtAt: null as string | null,
			boughtByMemberId: null as string | null,
			addedByMemberId: FIXTURE_WG.memberId,
			createdAt,
			updatedAt: createdAt,
		};
		const milk = { ...coffee, id: 'milk', name: 'Milch', normalizedName: 'milch' };
		let serverItems = [coffee, milk];
		await page.route(`**${BASE}/shopping`, (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			return route.fulfill({ status: 200, json: { items: serverItems } });
		});
		await page.route(`**${BASE}/shopping/coffee`, (route) => {
			if (route.request().method() !== 'PATCH') return route.continue();
			const boughtCoffee = {
				...coffee,
				boughtAt: new Date().toISOString(),
				boughtByMemberId: FIXTURE_WG.memberId,
			};
			serverItems = [boughtCoffee, ...serverItems.slice(1)];
			return route.fulfill({ status: 200, json: { item: boughtCoffee } });
		});
		let milkPatchCount = 0;
		let markFailureStarted: () => void = () => {};
		let releaseFailure: () => void = () => {};
		const failureStarted = new Promise<void>((resolve) => {
			markFailureStarted = resolve;
		});
		const failureGate = new Promise<void>((resolve) => {
			releaseFailure = resolve;
		});
		await page.route(`**${BASE}/shopping/milk`, async (route) => {
			if (route.request().method() !== 'PATCH') return route.continue();
			milkPatchCount += 1;
			if (milkPatchCount === 1) {
				markFailureStarted();
				await failureGate;
				return route.fulfill({ status: 500, json: { error: 'temporarily_unavailable' } });
			}
			return route.abort('failed');
		});

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/shopping`);
		await dismissOnboarding(page);
		const household = page.getByRole('navigation', { name: 'Haushalt' });
		await expect(household.getByRole('link', { name: 'Einkäufe, 2 offen' })).toBeVisible();

		await page.getByRole('checkbox', { name: 'Kaffee erledigen' }).click();
		await expect(household.getByRole('link', { name: 'Einkäufe, 1 offen' })).toBeVisible();

		await page.getByRole('checkbox', { name: 'Milch erledigen' }).click();
		await failureStarted;
		await expect(household.getByRole('link', { name: 'Einkäufe' })).toHaveText('Einkäufe');
		releaseFailure();
		await expect(household.getByRole('link', { name: 'Einkäufe, 1 offen' })).toBeVisible();

		await page.getByRole('checkbox', { name: 'Milch erledigen' }).click();
		await expect.poll(() => milkPatchCount).toBe(2);
		await expect(household.getByRole('link', { name: 'Einkäufe' })).toHaveText('Einkäufe');
		await expect(
			page.getByText('Offline vorgemerkt. Der Artikel wird später als erledigt synchronisiert.'),
		).toBeVisible();
	});

	test('keeps unread count after a failed chat read acknowledgement', async ({ page }) => {
		await setupMember(page);
		await mockDashboard(page, BASE, {
			openShoppingCount: 0,
			dueChores: [],
			dueRecurringExpenses: [],
		});
		await page.route(`**${BASE}/chat/unread-count`, (route) =>
			route.fulfill({ status: 200, json: { count: 6, overflow: false } }),
		);
		let readAcknowledgements = 0;
		await page.route(`**${BASE}/chat/read`, (route) => {
			readAcknowledgements += 1;
			return route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } });
		});

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
		await dismissOnboarding(page);

		const chat = page.getByRole('navigation', { name: 'Austausch' }).getByRole('link', {
			name: 'Chat, 6 ungelesen',
		});
		await expect(chat).toBeVisible();
		await expect.poll(() => readAcknowledgements).toBeGreaterThan(0);
		await expect(chat).toHaveAccessibleName('Chat, 6 ungelesen');
	});

	test('refreshes the Chat count after a successful read acknowledgement', async ({ page }) => {
		await setupMember(page);
		await mockDashboard(page, BASE, {
			openShoppingCount: 0,
			dueChores: [],
			dueRecurringExpenses: [],
		});
		let unreadReads = 0;
		let acknowledged = false;
		let readAcknowledgements = 0;
		let markReadStarted: () => void = () => {};
		let releaseRead: () => void = () => {};
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		const readGate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		await page.route(`**${BASE}/chat/unread-count`, (route) => {
			unreadReads += 1;
			return route.fulfill({
				status: 200,
				json: {
					count: acknowledged ? 0 : 6,
					exactCount: acknowledged ? 0 : 6,
					overflow: false,
				},
			});
		});
		await page.route(`**${BASE}/chat/read`, async (route) => {
			readAcknowledgements += 1;
			markReadStarted();
			await readGate;
			acknowledged = true;
			return route.fulfill({ status: 200, json: { ok: true } });
		});
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
		await dismissOnboarding(page);
		const exchange = page.getByRole('navigation', { name: 'Austausch' });
		const unreadChat = exchange.getByRole('link', { name: 'Chat, 6 ungelesen' });
		await expect(unreadChat).toBeVisible();
		await readStarted;
		await expect(unreadChat).toBeVisible();
		releaseRead();
		await expect.poll(() => readAcknowledgements).toBeGreaterThan(0);
		await expect.poll(() => unreadReads).toBeGreaterThan(1);
		const readConfirmedChat = exchange.getByRole('link', { name: 'Chat, 0 ungelesen' });
		await expect(readConfirmedChat).toBeVisible();
		await expect(readConfirmedChat).toHaveText('Chat');
	});

	test('announces the exact unread total while keeping the visible badge capped', async ({
		page,
	}) => {
		await setupMember(page);
		await page.route(`**${BASE}/chat/unread-count`, (route) =>
			route.fulfill({
				status: 200,
				json: { count: 99, exactCount: 147, overflow: true },
			}),
		);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
		await dismissOnboarding(page);
		const chatTopLink = page.getByRole('link', { name: 'Chat öffnen, 147 ungelesen' });
		await expect(chatTopLink).toBeVisible();
		await expect(chatTopLink.getByText('99+', { exact: true })).toBeVisible();
		await expect(chatTopLink.locator('[aria-live="polite"]')).toHaveText(
			'147 ungelesene Nachrichten',
		);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/calendar`);
		const exchange = page.getByRole('navigation', { name: 'Austausch' });
		const chatSegment = exchange.getByRole('link', { name: 'Chat, 147 ungelesen' });
		await expect(chatSegment).toBeVisible();
		await expect(chatSegment).toHaveText('Chat99+');
	});

	test('respects motion and contrast preferences and fits tablet widths', async ({
		page,
		browserName,
	}, testInfo) => {
		test.skip(
			browserName !== 'chromium',
			'Drives prefers-reduced-transparency through a CDP session, which only Chromium offers.',
		);
		await setupMember(page);
		await mockDashboard(page, BASE, {
			openShoppingCount: 0,
			dueChores: [],
			dueRecurringExpenses: [],
		});
		await page.route(`**${BASE}/chat/unread-count`, (route) =>
			route.fulfill({
				status: 200,
				json: { count: 99, exactCount: 147, overflow: true },
			}),
		);

		await page.setViewportSize({ width: 390, height: 844 });
		await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' });
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/calendar`);
		await dismissOnboarding(page);

		const exchange = page.getByRole('navigation', { name: 'Austausch' });
		await expect(exchange.getByRole('link', { name: 'Pinnwand' })).toBeVisible();
		await expect(exchange.getByRole('link', { name: 'Chat, 147 ungelesen' })).toBeVisible();
		await expect(exchange.getByRole('link', { name: 'Kalender' })).toBeVisible();
		const mobilePreferences = await page.evaluate(() => ({
			reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
			increasedContrast: window.matchMedia('(prefers-contrast: more)').matches,
		}));
		expect(mobilePreferences).toEqual({ reducedMotion: true, increasedContrast: true });
		const transitionMilliseconds = await exchange
			.getByRole('link', { name: 'Chat, 147 ungelesen' })
			.evaluate((node) => {
				const value = getComputedStyle(node).transitionDuration.split(',')[0] ?? '0s';
				const duration = Number.parseFloat(value);
				return value.endsWith('ms') ? duration : duration * 1000;
			});
		expect(transitionMilliseconds).toBeLessThanOrEqual(0.01);
		await page.screenshot({ path: testInfo.outputPath('a11y-contrast-reduced-motion.png') });

		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
		});
		const reducesTransparency = await page.evaluate(
			() => window.matchMedia('(prefers-reduced-transparency: reduce)').matches,
		);
		expect(reducesTransparency).toBe(true);
		await page.screenshot({ path: testInfo.outputPath('a11y-reduced-transparency.png') });
		await cdp.detach();

		for (const width of [768, 1024]) {
			await page.setViewportSize({ width, height: 1024 });
			await page.emulateMedia({ contrast: 'no-preference', reducedMotion: 'no-preference' });
			const layout = await page.evaluate(() => ({
				viewport: document.documentElement.clientWidth,
				page: document.documentElement.scrollWidth,
			}));
			expect(layout.page).toBeLessThanOrEqual(layout.viewport);
			await expect(exchange.getByRole('link', { name: 'Pinnwand' })).toBeVisible();
			await expect(exchange.getByRole('link', { name: 'Chat, 147 ungelesen' })).toBeVisible();
			await expect(exchange.getByRole('link', { name: 'Kalender' })).toBeVisible();
			await page.screenshot({ path: testInfo.outputPath(`exchange-tablet-${width}.png`) });
		}
	});

	test('marks cached counts stale when the refresh fails', async ({ page }) => {
		await setupMember(page);
		await mockDashboard(page, BASE, {
			openShoppingCount: 0,
			dueChores: [],
			dueRecurringExpenses: [],
		});
		let unreadReads = 0;
		await page.route(`**${BASE}/chat/unread-count`, (route) => {
			unreadReads += 1;
			return route.fulfill(
				unreadReads === 1
					? { status: 200, json: { count: 8, overflow: false } }
					: { status: 503, json: { error: 'temporarily_unavailable' } },
			);
		});

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/calendar`);
		await dismissOnboarding(page);

		const chat = page.getByRole('navigation', { name: 'Austausch' }).getByRole('link', {
			name: 'Chat, 8 ungelesen',
		});
		await expect(chat).toBeVisible();
		await page.evaluate(() => {
			// Focus refreshes are throttled to 10 s after a successful fetch; jump past it.
			const now = Date.now;
			Date.now = () => now() + 60_000;
			window.dispatchEvent(new Event('focus'));
		});
		await expect.poll(() => unreadReads).toBe(2);
		await expect(
			page.getByRole('navigation', { name: 'Austausch' }).getByRole('link', {
				name: 'Chat, 8 ungelesen, Stand möglicherweise veraltet',
			}),
		).toBeVisible();
	});

	test('public Calendar link uses the Exchange segments', async ({ page }) => {
		await page.goto('/discover/calendar', { waitUntil: 'domcontentloaded' });

		const exchange = page.getByRole('navigation', { name: 'Austausch – entdecken' });
		await expect(exchange.getByRole('link', { name: 'Pinnwand' })).toBeVisible();
		await expect(exchange.getByRole('link', { name: 'Chat' })).toBeVisible();
		await expect(exchange.getByRole('link', { name: 'Kalender' })).toHaveAttribute(
			'aria-current',
			'page',
		);
		await expect(exchange.getByRole('link')).toHaveCount(3);
	});

	test('keeps all Exchange segments visible at 320 and 390 pixels in both themes', async ({
		page,
	}, testInfo) => {
		await setupMember(page);
		await page.route(`**${BASE}/chat/unread-count`, (route) =>
			route.fulfill({ status: 200, json: { count: 4, overflow: false } }),
		);

		for (const theme of ['light', 'dark'] as const) {
			for (const width of [320, 390]) {
				await page.setViewportSize({ width, height: 844 });
				await page.emulateMedia({ colorScheme: theme });
				await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/calendar`);
				await dismissOnboarding(page);

				const exchange = page.getByRole('navigation', { name: 'Austausch' });
				await expect(exchange.getByRole('link', { name: 'Pinnwand' })).toBeVisible();
				await expect(exchange.getByRole('link', { name: 'Chat, 4 ungelesen' })).toBeVisible();
				await expect(exchange.getByRole('link', { name: 'Kalender' })).toBeVisible();
				const layout = await page.evaluate(() => ({
					viewport: document.documentElement.clientWidth,
					page: document.documentElement.scrollWidth,
				}));
				expect(layout.page).toBeLessThanOrEqual(layout.viewport);
				await page.screenshot({ path: testInfo.outputPath(`exchange-${width}-${theme}.png`) });
			}
		}
	});
});
