import { type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const { shareCode } = FIXTURE_WG;

test.use({ hasTouch: true });

// Record CloseWatchers so the test can fire the close request Android's back
// gesture would send; Playwright has no system back button.
async function trackCloseWatchers(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const Native = (window as unknown as { CloseWatcher?: new () => object }).CloseWatcher;
		if (!Native) return;
		const watchers: object[] = [];
		(window as unknown as { __closeWatchers: object[] }).__closeWatchers = watchers;
		(window as unknown as { CloseWatcher: unknown }).CloseWatcher = class extends Native {
			constructor() {
				super();
				watchers.push(this);
			}
		};
	});
}

async function pressSystemBack(page: Page): Promise<void> {
	await page.evaluate(() => {
		const watchers = (window as unknown as { __closeWatchers: { requestClose(): void }[] })
			.__closeWatchers;
		watchers.at(-1)?.requestClose();
	});
}

// Material 3: the Android back gesture closes an open overlay instead of
// leaving the page.
test('system back closes an open drawer instead of leaving the page', async ({ page }) => {
	await trackCloseWatchers(page);
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/chores`, (route) =>
		route.fulfill({ json: { chores: [] } }),
	);
	await page.setViewportSize({ width: 320, height: 640 });
	await navigateToFeature(page, `/wg/${shareCode}/putzen`);
	await dismissOnboarding(page);

	const trigger = page.getByRole('button', { name: 'Putzaufgabe erfassen', exact: true });
	await trigger.click();
	const drawer = page.getByRole('dialog');
	await expect(drawer).toBeVisible();

	await pressSystemBack(page);

	expect(new URL(page.url()).pathname).toBe(`/wg/${shareCode}/putzen`);
	await expect(drawer).toBeHidden();
	await expect(trigger).toBeFocused();
});

test('system back closes an open alert dialog instead of leaving the page', async ({ page }) => {
	await trackCloseWatchers(page);
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/members`, (route) =>
		route.fulfill({
			json: {
				members: [
					{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName, color: null, active: true },
					{ id: 'fixture-other-member', name: 'Mira', color: null, active: true },
				],
				viewerIsAdmin: true,
			},
		}),
	);
	await page.setViewportSize({ width: 320, height: 640 });
	await navigateToFeature(page, `/wg/${shareCode}/einstellungen#zugang`);
	await dismissOnboarding(page);

	const trigger = page.getByRole('button', { name: 'Komplette WG für alle löschen' });
	await trigger.click();
	const alertDialog = page.getByRole('alertdialog', { name: 'WG dauerhaft löschen?' });
	await expect(alertDialog).toBeVisible();

	await pressSystemBack(page);

	expect(new URL(page.url()).pathname).toBe(`/wg/${shareCode}/einstellungen`);
	await expect(alertDialog).toBeHidden();
	await expect(trigger).toBeFocused();
});

// A history-based back handler once cancelled this navigation.
test('closing an overlay keeps the navigation it started', async ({ page }) => {
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/imports/preview`, (route) =>
		route.fulfill({
			json: {
				parsed: [
					{
						date: '2026-09-25T00:00:00.000Z',
						description: 'Wocheneinkauf',
						amountCents: 1200,
						currency: 'EUR',
						paidByName: FIXTURE_WG.memberName,
						splits: [{ memberName: FIXTURE_WG.memberName, amountCents: 1200 }],
						warnings: [],
					},
				],
				payloadHash: 'overlay-navigation',
				memberMapping: { [FIXTURE_WG.memberName]: FIXTURE_WG.memberId },
				conflicts: [],
				members: [{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName }],
			},
		}),
	);
	await page.setViewportSize({ width: 320, height: 640 });
	await navigateToFeature(page, `/wg/${shareCode}/import`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: /Splitwise CSV/ }).click();
	await page.getByText('Oder Inhalt einfügen', { exact: true }).click();
	await page.getByRole('textbox', { name: 'Inhalt des Exports' }).fill('fixture export');
	await page.getByRole('button', { name: 'Vorschau erstellen', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Namen WG-Mitgliedern zuordnen' })).toBeVisible();

	await page.getByRole('link', { name: 'Ausgaben' }).first().click();
	await page.getByRole('button', { name: 'Verwerfen' }).click();

	await expect(page).toHaveURL(new RegExp(`/wg/${shareCode}/ausgaben$`));
	await page.waitForTimeout(1000);
	await expect(page).toHaveURL(new RegExp(`/wg/${shareCode}/ausgaben$`));
});
