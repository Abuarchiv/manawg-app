import { type Page, type Route, expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature } from './_helpers';

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

		await expect(page.getByRole('heading', { name: 'Verbindung wird geprüft …' })).toBeVisible();
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
		await expect(page.getByText('Keine wartenden Aktionen.')).toBeVisible();
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
});
