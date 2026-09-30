import { expect, test } from '@playwright/test';
import { E2E_EXISTING_WG } from '../src/core/infra/e2e-db-down';
import { dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
test.use({ hasTouch: true, isMobile: true });

const SHARE_CODE = 'MTE8PZAT';
const shoppingItems = [
	{
		id: 'shopping-oat-milk',
		addedByMemberId: '7d898f9e-5ad7-4f5d-abed-8c3e99a76973',
		name: 'Ungesüßte Hafermilch',
		quantity: '1 Packung',
		boughtAt: null,
		boughtByMemberId: null,
		createdAt: '2026-09-20T08:00:00.000Z',
	},
];

test('cached shopping content stays visible while a revisit is revalidating', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await setupMember(page);

	let shoppingReads = 0;
	let holdNextShoppingRead = false;
	let markSecondReadStarted: () => void = () => {};
	let releaseSecondRead: () => void = () => {};
	const secondReadStarted = new Promise<void>((resolve) => {
		markSecondReadStarted = resolve;
	});
	const secondReadGate = new Promise<void>((resolve) => {
		releaseSecondRead = resolve;
	});

	await page.route(`**/api/wg/${SHARE_CODE}/shopping*`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		shoppingReads += 1;
		if (holdNextShoppingRead) {
			holdNextShoppingRead = false;
			markSecondReadStarted();
			await secondReadGate;
		}
		return route.fulfill({ json: { items: shoppingItems } });
	});
	await page.route(`**/api/wg/${SHARE_CODE}`, (route) =>
		route.fulfill({
			json: {
				wg: {
					id: E2E_EXISTING_WG.id,
					name: E2E_EXISTING_WG.name,
					shareCode: E2E_EXISTING_WG.shareCode,
					joiningEnabled: true,
					shareCodeRotatedAt: null,
					createdAt: '2026-09-20T08:00:00.000Z',
				},
				members: [
					E2E_EXISTING_WG.member,
					{ id: '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55', name: 'Mina', color: '#0f766e' },
				],
				currentMember: {
					memberId: E2E_EXISTING_WG.member.id,
					name: E2E_EXISTING_WG.member.name,
				},
			},
		}),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/inventory*`, (route) =>
		route.fulfill({ json: { items: [], grouped: {} } }),
	);

	await navigateToFeature(page, `/wg/${SHARE_CODE}/vorraete`);
	await expect(page.getByRole('heading', { name: 'Vorräte' })).toBeVisible();
	await navigateToFeature(page, `/wg/${SHARE_CODE}/einkauf`);
	await dismissOnboarding(page);
	const item = page.getByRole('checkbox', { name: 'Ungesüßte Hafermilch erledigen' });
	await expect(item).toBeVisible();

	const inventoryLink = page.locator(
		`nav[aria-label="Haushalt"] a[href="/wg/${SHARE_CODE}/vorraete"]:visible`,
	);
	await inventoryLink.click();
	await expect(page).toHaveURL(new RegExp(`/wg/${SHARE_CODE}/vorraete$`));
	await expect(page.getByRole('heading', { name: 'Vorräte' })).toBeVisible();
	const shoppingLink = page.locator(
		`nav[aria-label="Haushalt"] a[href="/wg/${SHARE_CODE}/einkauf"]:visible`,
	);
	holdNextShoppingRead = true;
	await shoppingLink.click();
	await expect(page).toHaveURL(new RegExp(`/wg/${SHARE_CODE}/einkauf$`));
	await secondReadStarted;

	try {
		await expect(item).toBeVisible({ timeout: 250 });
	} finally {
		releaseSecondRead();
	}
	await expect(item).toBeVisible();
	expect(shoppingReads).toBeGreaterThanOrEqual(2);
});

test('revoked membership hides the WG shell after member refresh', async ({ page }) => {
	await setupMember(page);
	await page.route(`**/api/wg/${SHARE_CODE}/members`, (route) =>
		route.fulfill({ status: 401, json: { error: 'member_deactivated' } }),
	);
	await navigateToFeature(page, `/wg/${SHARE_CODE}`);

	await expect(page.getByText('Deine Mitgliedschaft konnte nicht bestätigt werden.')).toBeVisible();
	await expect(page.getByRole('link', { name: /Chat öffnen/ })).toHaveCount(0);
});
