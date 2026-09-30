import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

// Regression: these free-text fields had no enterKeyHint, so the on-screen
// keyboard's action key showed the generic "return" glyph instead of a
// next/done affordance (Apple HIG / Material 3 text input guidance).
const { shareCode, memberId, memberName } = FIXTURE_WG;

test('inventory add name field hints "next"', async ({ page }) => {
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/inventory*`, (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ json: { items: [], grouped: {} } })
			: route.continue(),
	);

	await navigateToFeature(page, `/wg/${shareCode}/vorraete`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Vorrat hinzufügen', exact: true }).first().click();

	await expect(page.locator('#inventory-name')).toHaveAttribute('enterkeyhint', 'next');
});

test('abo description and amount fields hint "next"', async ({ page }) => {
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/recurring-expenses*`, (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ json: { recurringExpenses: [] } })
			: route.continue(),
	);

	await navigateToFeature(page, `/wg/${shareCode}/abos`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Neue Fixkosten' }).click();
	await expect(page.getByRole('dialog', { name: 'Neue Fixkosten' })).toBeVisible();

	await expect(page.locator('#abo-description')).toHaveAttribute('enterkeyhint', 'next');
	await expect(page.locator('#abo-amount')).toHaveAttribute('enterkeyhint', 'next');
});

test('chore title field hints "done"', async ({ page }) => {
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/chores*`, (route) =>
		route.request().method() === 'GET' ? route.fulfill({ json: { chores: [] } }) : route.continue(),
	);
	await page.route(`**/api/wg/${shareCode}/absences*`, (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ json: { absences: [] } })
			: route.continue(),
	);

	await navigateToFeature(page, `/wg/${shareCode}/putzen`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Putzaufgabe erfassen', exact: true }).click();

	await expect(page.locator('#chore-title')).toHaveAttribute('enterkeyhint', 'done');
});

test('absence reason field hints "done"', async ({ page }) => {
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/chores*`, (route) =>
		route.request().method() === 'GET' ? route.fulfill({ json: { chores: [] } }) : route.continue(),
	);
	await page.route(`**/api/wg/${shareCode}/absences*`, (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ json: { absences: [] } })
			: route.continue(),
	);

	await navigateToFeature(page, `/wg/${shareCode}/putzen?panel=absences`);
	await dismissOnboarding(page);
	// `?panel=absences` already opens the form (button reads "...schließen").

	await expect(page.locator('#absence-reason')).toHaveAttribute('enterkeyhint', 'done');
});

test('expense description and amount fields hint "next"', async ({ page }) => {
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/members*`, (route) =>
		route.fulfill({
			json: { members: [{ id: memberId, name: memberName, color: null, active: true }] },
		}),
	);
	await page.route(`**/api/wg/${shareCode}/expenses*`, (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ json: { expenses: [], payments: [] } })
			: route.continue(),
	);
	await page.route(`**/api/wg/${shareCode}/recurring-expenses*`, (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ json: { recurringExpenses: [] } })
			: route.continue(),
	);
	await page.route(`**/api/wg/${shareCode}/dashboard*`, (route) =>
		route.fulfill({ json: { openShoppingCount: 0, dueChores: [], dueRecurringExpenses: [] } }),
	);

	await navigateToFeature(page, `/wg/${shareCode}/ausgaben`);
	await dismissOnboarding(page);
	// Das Plus unten rechts öffnet das Formular.
	await page
		.locator('[data-page-primary-action]')
		.getByRole('button', { name: 'Ausgabe erfassen' })
		.click();

	await expect(page.locator('#expense-description')).toHaveAttribute('enterkeyhint', 'next');
	await expect(page.locator('#f-betrag')).toHaveAttribute('enterkeyhint', 'next');
});

test('legacy account recovery share code field hints "done"', async ({ page }) => {
	await page.route('**/api/wg/mine', (route) => route.fulfill({ status: 200, json: { wgs: [] } }));

	await page.goto('/neu');
	await page
		.getByRole('button', { name: 'Altes Profil auf diesem Gerät wiederherstellen' })
		.click();

	await expect(page.locator('#legacy-recovery-share-code')).toHaveAttribute('enterkeyhint', 'done');
});
