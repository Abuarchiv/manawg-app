import { type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const INVALID_SPLIT_MESSAGE =
	'Mindestens ein Anteil ist ungültig. Gib einen gültigen Betrag ein oder lasse das Feld leer.';
const MEMBERS = [
	{ id: FIXTURE_WG.memberId, name: 'Alexandra Beispielfamilienname', color: null, active: true },
	{ id: FIXTURE_WG.id, name: 'Maximilian Mustermann-Langname', color: null, active: true },
];

async function mockFinanceReads(page: Page): Promise<void> {
	const { shareCode } = FIXTURE_WG;
	await page.route(`**/api/wg/${shareCode}/members`, (route) =>
		route.fulfill({ json: { members: MEMBERS, viewerIsAdmin: false } }),
	);
	await page.route(`**/api/wg/${shareCode}/expenses`, (route) =>
		route.fulfill({ json: { expenses: [], payments: [] } }),
	);
	await page.route(`**/api/wg/${shareCode}/recurring-expenses`, (route) =>
		route.fulfill({ json: { recurringExpenses: [] } }),
	);
	await page.route(`**/api/wg/${shareCode}/dashboard`, (route) =>
		route.fulfill({ json: { openShoppingCount: 0, dueChores: [], dueRecurringExpenses: [] } }),
	);
	await page.route(`**/api/wg/${shareCode}/chat/unread-count`, (route) =>
		route.fulfill({ json: { count: 0, overflow: false } }),
	);
}

test('blocks an invalid manual expense share, then submits the corrected split', async ({
	page,
}) => {
	const { shareCode } = FIXTURE_WG;
	let submitted: Record<string, unknown> | null = null;
	let postCount = 0;
	await page.setViewportSize({ width: 320, height: 640 });
	await setupMember(page);
	await mockFinanceReads(page);
	await page.route(`**/api/wg/${shareCode}/expenses`, async (route) => {
		if (route.request().method() === 'POST') {
			postCount += 1;
			submitted = route.request().postDataJSON() as Record<string, unknown>;
			await route.fulfill({ status: 500, json: { error: 'test_response' } });
			return;
		}
		await route.fulfill({ json: { expenses: [], payments: [] } });
	});

	await navigateToFeature(page, `/wg/${shareCode}/ausgaben`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Ausgabe erfassen' }).first().click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Beschreibung', { exact: true }).fill('Internet');
	await dialog.getByLabel('Betrag', { exact: true }).fill('10');
	await dialog.getByRole('button', { name: 'Aufteilung: Manuell', exact: true }).click();
	const firstShare = dialog.getByLabel('Anteil Alexandra Beispielfamilienname in Euro');
	const invalidShare = dialog.getByLabel('Anteil Maximilian Mustermann-Langname in Euro');
	await firstShare.fill('10');
	await invalidShare.fill('-5');
	await dialog.getByRole('button', { name: 'Ausgabe speichern', exact: true }).click();
	await expect(dialog.getByText(INVALID_SPLIT_MESSAGE, { exact: true })).toBeVisible();
	await expect(firstShare).toHaveAttribute('aria-invalid', 'true');
	await expect(firstShare).toHaveAttribute('aria-describedby', 'expense-splits-error');
	expect((await invalidShare.boundingBox())?.width).toBeGreaterThan(0);
	expect(submitted).toBeNull();
	expect(postCount).toBe(0);

	await firstShare.fill('6');
	await invalidShare.fill('4');
	await dialog.getByRole('button', { name: 'Ausgabe speichern', exact: true }).click();
	await expect.poll(() => postCount).toBe(1);
	expect(submitted?.splits).toEqual([
		{ debtorMemberId: FIXTURE_WG.memberId, amountCents: 600 },
		{ debtorMemberId: FIXTURE_WG.id, amountCents: 400 },
	]);
});

test('blocks a malformed manual Abo share, then submits the corrected split', async ({ page }) => {
	const { shareCode } = FIXTURE_WG;
	let submitted: Record<string, unknown> | null = null;
	let postCount = 0;
	await page.setViewportSize({ width: 320, height: 640 });
	await setupMember(page);
	await mockFinanceReads(page);
	await page.route(`**/api/wg/${shareCode}/recurring-expenses`, async (route) => {
		if (route.request().method() === 'POST') {
			postCount += 1;
			submitted = route.request().postDataJSON() as Record<string, unknown>;
			await route.fulfill({ status: 500, json: { error: 'test_response' } });
			return;
		}
		await route.fulfill({ json: { recurringExpenses: [] } });
	});

	await navigateToFeature(page, `/wg/${shareCode}/abos`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Neue Fixkosten' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Beschreibung', { exact: true }).fill('Internet');
	await dialog.getByLabel('Betrag', { exact: true }).fill('10');
	await dialog.getByRole('button', { name: 'Manuell', exact: true }).click();
	const firstShare = dialog.getByLabel('Anteil Alexandra Beispielfamilienname in Euro');
	const invalidShare = dialog.getByLabel('Anteil Maximilian Mustermann-Langname in Euro');
	await firstShare.fill('10');
	await invalidShare.fill('unbekannt');
	await dialog.getByRole('button', { name: 'Fixkosten anlegen', exact: true }).click();
	await expect(dialog.getByText(INVALID_SPLIT_MESSAGE, { exact: true })).toBeVisible();
	await expect(invalidShare).toHaveAttribute('aria-invalid', 'true');
	await expect(invalidShare).toHaveAttribute('aria-describedby', 'abo-splits-error');
	expect((await invalidShare.boundingBox())?.width).toBeGreaterThan(0);
	expect(submitted).toBeNull();
	expect(postCount).toBe(0);

	await firstShare.fill('6');
	await invalidShare.fill('4');
	await dialog.getByRole('button', { name: 'Fixkosten anlegen', exact: true }).click();
	await expect.poll(() => postCount).toBe(1);
	expect(submitted?.splits).toEqual([
		{ debtorMemberId: FIXTURE_WG.memberId, amountCents: 600 },
		{ debtorMemberId: FIXTURE_WG.id, amountCents: 400 },
	]);
});

test('keeps blank and zero Abo shares opt-out while posting valid shares', async ({ page }) => {
	const { shareCode } = FIXTURE_WG;
	let submitted: Record<string, unknown> | null = null;
	let postCount = 0;
	await page.setViewportSize({ width: 360, height: 640 });
	await setupMember(page);
	await mockFinanceReads(page);
	await page.route(`**/api/wg/${shareCode}/recurring-expenses`, async (route) => {
		if (route.request().method() === 'POST') {
			postCount += 1;
			submitted = route.request().postDataJSON() as Record<string, unknown>;
			await route.fulfill({ status: 500, json: { error: 'test_response' } });
			return;
		}
		await route.fulfill({ json: { recurringExpenses: [] } });
	});

	await navigateToFeature(page, `/wg/${shareCode}/abos`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Neue Fixkosten' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Beschreibung', { exact: true }).fill('Internet');
	await dialog.getByLabel('Betrag', { exact: true }).fill('10');
	await dialog.getByRole('button', { name: 'Manuell', exact: true }).click();
	const firstShare = dialog.getByLabel('Anteil Alexandra Beispielfamilienname in Euro');
	const optOutShare = dialog.getByLabel('Anteil Maximilian Mustermann-Langname in Euro');
	await firstShare.fill('10');
	await dialog.getByRole('button', { name: 'Fixkosten anlegen', exact: true }).click();
	await expect.poll(() => postCount).toBe(1);
	expect(submitted?.splits).toEqual([{ debtorMemberId: FIXTURE_WG.memberId, amountCents: 1000 }]);

	submitted = null;
	postCount = 0;
	await expect(
		dialog.getByRole('button', { name: 'Fixkosten anlegen', exact: true }),
	).toBeEnabled();
	await optOutShare.fill('0');
	await dialog.getByRole('button', { name: 'Fixkosten anlegen', exact: true }).click();
	await expect.poll(() => postCount).toBe(1);
	expect(submitted?.splits).toEqual([{ debtorMemberId: FIXTURE_WG.memberId, amountCents: 1000 }]);
});
