import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
test.use({ hasTouch: true, isMobile: true });

const MINA_ID = '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55';

test('a failed abo action does not leak its error into a freshly opened create form', async ({
	page,
}) => {
	const abo = {
		id: 'abo-netflix',
		description: 'Netflix',
		amountCents: 1499,
		currency: 'EUR',
		paidByMemberId: FIXTURE_WG.memberId,
		intervalMonths: 1,
		nextDueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
		lastCreatedAt: null,
		pausedAt: null,
		splits: [
			{ debtorMemberId: FIXTURE_WG.memberId, amountCents: 750 },
			{ debtorMemberId: MINA_ID, amountCents: 749 },
		],
	};

	await setupMember(page);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/recurring-expenses`, (route) => {
		if (route.request().method() === 'GET') {
			return route.fulfill({ json: { recurringExpenses: [abo] } });
		}
		return route.continue();
	});
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/recurring-expenses/*`, (route) => {
		if (route.request().method() === 'DELETE') {
			return route.fulfill({ status: 500, json: { error: 'delete_failed' } });
		}
		return route.continue();
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/abos`);
	await dismissOnboarding(page);

	await page.getByRole('button', { name: /^Details öffnen: Netflix/ }).click();
	await page.getByRole('button', { name: 'Netflix löschen' }).click();
	await page.getByRole('button', { name: 'Löschen' }).last().click();
	// Scoped to #main: the identical error is also announced via the transient toast region,
	// which would make an unscoped getByText match ambiguous.
	await expect(
		page.locator('#main').getByText('Fixkosten konnten nicht gelöscht werden', { exact: false }),
	).toBeVisible();

	await page.getByRole('button', { name: 'Neue Fixkosten' }).click();
	const dialog = page.getByRole('dialog', { name: 'Neue Fixkosten' });
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByText('Fixkosten konnten nicht gelöscht werden', { exact: false }),
	).toHaveCount(0);
});
