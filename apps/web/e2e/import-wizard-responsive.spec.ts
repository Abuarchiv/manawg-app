import { type Locator, type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

async function setLargeText(page: Page): Promise<void> {
	await page.evaluate(() => {
		const nonce = document.querySelector('script[nonce]')?.nonce;
		if (!nonce) throw new Error('CSP nonce not found');
		const style = document.createElement('style');
		style.nonce = nonce;
		style.textContent = 'html { font-size: 200% !important; }';
		document.head.append(style);
	});
}

async function expectPageFits(page: Page, width: number): Promise<void> {
	const dimensions = await page.evaluate(() => ({
		documentWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
		bodyWidth: document.body.scrollWidth,
	}));
	expect(dimensions.documentWidth).toBeLessThanOrEqual(width);
	expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.clientWidth);
	expect(dimensions.bodyWidth).toBeLessThanOrEqual(width);
}

async function expectElementReachable(
	page: Page,
	element: Locator,
	viewportWidth: number,
): Promise<void> {
	await expect(element).toBeVisible();
	await element.scrollIntoViewIfNeeded();
	const bounds = await element.boundingBox();
	if (!bounds) throw new Error('Action has no visible bounds');
	const viewport = page.viewportSize();
	if (!viewport) throw new Error('Viewport size is unavailable');
	const navBounds = await page
		.getByRole('navigation', { name: 'WG Hauptnavigation' })
		.boundingBox();
	if (!navBounds) throw new Error('WG navigation has no visible bounds');
	expect(bounds.x).toBeGreaterThanOrEqual(0);
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewportWidth);
	expect(bounds.y).toBeGreaterThanOrEqual(0);
	expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
	expect(bounds.y + bounds.height).toBeLessThanOrEqual(navBounds.y);
}

async function expectActionBounds(
	page: Page,
	labels: string[],
	viewportWidth: number,
): Promise<void> {
	for (const label of labels) {
		const action = page.getByRole('button', { name: label, exact: true });
		await expectElementReachable(page, action, viewportWidth);
	}
	await expectPageFits(page, viewportWidth);
}

const parsedExpense = {
	date: '2026-09-25T00:00:00.000Z',
	description: 'Wocheneinkauf',
	amountCents: 1200,
	currency: 'EUR',
	paidByName: FIXTURE_WG.memberName,
	splits: [{ memberName: FIXTURE_WG.memberName, amountCents: 1200 }],
	warnings: [],
};

for (const width of [320, 360] as const) {
	for (const largeText of [false, true] as const) {
		const textScale = largeText ? '32px' : 'normal';
		for (const colorScheme of ['light', 'dark'] as const) {
			test(`Splitwise import actions fit at ${width}px with ${textScale} root text (${colorScheme})`, async ({
				page,
			}) => {
				await page.setViewportSize({ width, height: 844 });
				await page.emulateMedia({ colorScheme });
				await setupMember(page);
				await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/imports/preview`, (route) =>
					route.fulfill({
						json: {
							parsed: [parsedExpense],
							payloadHash: 'responsive-import-payload',
							memberMapping: { [FIXTURE_WG.memberName]: FIXTURE_WG.memberId },
							conflicts: [],
							members: [{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName }],
						},
					}),
				);
				await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/imports/commit`, (route) =>
					route.fulfill({
						json: {
							importId: 'responsive-import',
							inserted: 1,
							skipped: 0,
							errors: [],
							warning: null,
						},
					}),
				);

				await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/import`);
				await dismissOnboarding(page);
				if (largeText) await setLargeText(page);
				await expect(page.getByRole('button', { name: /Splitwise CSV/ })).toBeVisible();
				await expect
					.poll(() =>
						page.locator('html').evaluate((element) => element.classList.contains('dark')),
					)
					.toBe(colorScheme === 'dark');

				const isDark = await page
					.locator('html')
					.evaluate((element) => element.classList.contains('dark'));
				expect(isDark).toBe(colorScheme === 'dark');
				const rootFontSize = await page.evaluate(() =>
					Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
				);
				if (largeText) expect(rootFontSize).toBe(32);
				else expect(rootFontSize).toBeGreaterThanOrEqual(14);

				await page.getByRole('button', { name: /Splitwise CSV/ }).click();
				await expect(page.getByRole('heading', { name: 'Export-Datei auswählen' })).toBeVisible();
				await expectActionBounds(page, ['Vorschau erstellen', 'Zurück'], width);

				if (width === 320 && largeText && colorScheme === 'light') {
					const back = page.getByRole('button', { name: 'Zurück', exact: true });
					await page.getByRole('heading', { name: 'Export-Datei auswählen' }).focus();
					for (
						let attempt = 0;
						attempt < 8 && !(await back.evaluate((el) => el === document.activeElement));
						attempt += 1
					) {
						await page.keyboard.press('Tab');
					}
					expect(await back.evaluate((el) => el === document.activeElement)).toBe(true);
					await page.keyboard.press('Enter');
					await expect(page.getByRole('heading', { name: 'Importquelle wählen' })).toBeVisible();
					await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/import`);
					await setLargeText(page);
					const restartedFontSize = await page.evaluate(() =>
						Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
					);
					expect(restartedFontSize).toBe(32);
					await page.getByRole('button', { name: /Splitwise CSV/ }).click();
				}

				await page.getByText('Oder Inhalt einfügen', { exact: true }).click();
				await page.getByRole('textbox', { name: 'Inhalt des Exports' }).fill('fixture export');
				await page.getByRole('button', { name: 'Vorschau erstellen', exact: true }).click();
				await expect(
					page.getByRole('heading', { name: 'Namen WG-Mitgliedern zuordnen' }),
				).toBeVisible();
				await expectActionBounds(page, ['Weiter zur Vorschau', 'Zurück'], width);

				await page.getByRole('button', { name: 'Weiter zur Vorschau', exact: true }).click();
				await expect(page.getByRole('heading', { name: 'Vorschau', exact: true })).toBeVisible();
				await expectActionBounds(page, ['Importieren (1)', 'Zurück'], width);

				await page.getByRole('button', { name: 'Importieren (1)', exact: true }).click();
				await expect(page.getByRole('heading', { name: 'Import abgeschlossen' })).toBeVisible();
				const expensesLink = page.getByRole('link', { name: 'Zu den Ausgaben', exact: true });
				await expectElementReachable(page, expensesLink, width);
				await expectPageFits(page, width);
			});
		}
	}
}
