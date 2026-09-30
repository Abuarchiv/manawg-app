import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const shareCode = FIXTURE_WG.shareCode;
const memberId = FIXTURE_WG.memberId;

test('shopping remove button names the item and the armed confirm state', async ({ page }) => {
	const itemName = 'Milch';
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/shopping`, (route) =>
		route.fulfill({
			json: {
				items: [
					{
						id: 'sh-1',
						addedByMemberId: memberId,
						name: itemName,
						quantity: null,
						boughtAt: null,
						boughtByMemberId: null,
						createdAt: new Date().toISOString(),
					},
				],
				members: { [memberId]: { name: FIXTURE_WG.memberName, color: null } },
			},
		}),
	);

	await navigateToFeature(page, `/wg/${shareCode}/einkauf`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: `Artikelaktionen: ${itemName}` }).click();
	const drawer = page.getByRole('dialog');
	await drawer.getByRole('button', { name: `Artikel entfernen: ${itemName}` }).click();
	// WCAG 2.5.3 — the visible "Milch" label must stay in the accessible name,
	// and the armed (confirm) state must be named distinctly from the initial one.
	await expect(
		drawer.getByRole('button', { name: `Endgültig entfernen: ${itemName}` }),
	).toBeVisible();
});

test('inventory + button applies the PATCH response without waiting for a follow-up refetch', async ({
	page,
}) => {
	const items = [
		{
			id: 'inv-1',
			wgId: FIXTURE_WG.id,
			name: 'Spülmittel',
			quantity: 5,
			unit: 'Stück',
			threshold: 1,
			category: 'putzmittel',
			decrementCount30d: 0,
			lastDecrementedAt: null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
	];
	await setupMember(page);
	let getCount = 0;
	await page.route(`**/api/wg/${shareCode}/inventory`, async (route) => {
		getCount += 1;
		if (getCount > 1) {
			// The background re-sync fired after the mutation. Make it slow so a
			// regression that goes back to waiting on this GET (instead of the
			// PATCH response) would fail this test.
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
		return route.fulfill({ json: { items } });
	});
	await page.route(`**/api/wg/${shareCode}/inventory/inv-1`, (route) => {
		if (route.request().method() !== 'PATCH') return route.fallback();
		const updated = { ...items[0], quantity: 6 };
		return route.fulfill({ json: { item: updated } });
	});

	await navigateToFeature(page, `/wg/${shareCode}/vorraete`);
	await dismissOnboarding(page);
	const row = page.locator('[data-slot="item"]', { hasText: 'Spülmittel' });
	await row.getByRole('button', { name: 'Spülmittel um eins erhöhen' }).click();
	await expect(row).toContainText('6 Stück', { timeout: 600 });
});
