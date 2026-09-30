import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
test.use({ hasTouch: true, isMobile: true });

test('going back from the preview step clears a stale commit error', async ({ page }) => {
	const preview = {
		parsed: [
			{
				date: '2026-01-01',
				description: 'Testeintrag',
				amountCents: 1000,
				currency: 'EUR',
				paidByName: FIXTURE_WG.memberName,
				splits: [{ memberName: FIXTURE_WG.memberName, amountCents: 1000 }],
				warnings: [],
			},
		],
		payloadHash: 'hash-1',
		memberMapping: { [FIXTURE_WG.memberName]: FIXTURE_WG.memberId },
		conflicts: [],
		members: [{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName }],
	};

	await setupMember(page);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/imports/preview`, (route) =>
		route.fulfill({ json: preview }),
	);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/imports/commit`, (route) =>
		route.fulfill({ status: 500, json: { error: 'server_error' } }),
	);

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/import`);
	await dismissOnboarding(page);

	await page.getByRole('button', { name: 'Splitwise CSV' }).click();
	await page.getByText('Oder Inhalt einfügen').click();
	await page.getByLabel('Inhalt des Exports').fill('irrelevant, response is mocked');
	await page.getByRole('button', { name: 'Vorschau erstellen' }).click();

	await page.getByRole('button', { name: 'Weiter zur Vorschau' }).click();

	await page.getByRole('button', { name: /^Importieren/ }).click();
	await expect(page.getByText('Import fehlgeschlagen', { exact: false })).toBeVisible();

	await page.getByRole('button', { name: 'Zurück' }).click();
	await expect(page.getByRole('heading', { name: 'Namen WG-Mitgliedern zuordnen' })).toBeVisible();
	await expect(page.getByText('Import fehlgeschlagen', { exact: false })).toHaveCount(0);
});
