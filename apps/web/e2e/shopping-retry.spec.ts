import { expect, test } from '@playwright/test';
import { dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.setTimeout(240_000);

test('requires a WG member for shopping API data', async ({ request }) => {
	const response = await request.get('/api/wg/MTE8PZAT/shopping', {
		timeout: 120_000,
	});

	expect(response.status()).toBe(401);
	await expect(response.json()).resolves.toMatchObject({ error: 'auth_required' });
});

test('retries an uncertain shopping create with the same idempotency key', async ({ page }) => {
	test.skip(
		process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
		'requires the local fixture server',
	);
	const keys: string[] = [];
	await page.route('**/api/wg/MTE8PZAT/shopping', async (route) => {
		if (route.request().method() !== 'POST') {
			await route.continue();
			return;
		}
		keys.push(route.request().headers()['idempotency-key']);
		await route.fulfill({
			status: keys.length === 1 ? 503 : 200,
			contentType: 'application/json',
			body: JSON.stringify(
				keys.length === 1
					? { error: 'idempotency_response_pending' }
					: {
							item: {
								id: 'replayed-shopping-item',
								name: 'Rettich',
								quantity: null,
								addedByMemberId: 'fixture-member',
								boughtAt: null,
								boughtByMemberId: null,
								createdAt: new Date().toISOString(),
							},
							warning: null,
						},
			),
		});
	});
	await setupMember(page);
	await navigateToFeature(page, '/wg/MTE8PZAT/einkauf');
	await dismissOnboarding(page);
	await page.getByLabel('Artikel-Name').fill('Rettich');
	await page.getByRole('button', { name: 'Artikel hinzufügen', exact: true }).click();
	await expect(
		page.getByText('Speicherstatus unklar. Prüfe die Liste und versuche es bei Bedarf erneut.'),
	).toBeVisible();
	await page.getByRole('button', { name: 'Artikel hinzufügen', exact: true }).click();
	await expect.poll(() => keys.length).toBe(2);
	expect(keys[0]).toBeTruthy();
	expect(keys[1]).toBe(keys[0]);
});

test('uses a fresh idempotency key after an offline-queued shopping create', async ({ page }) => {
	test.skip(
		process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
		'requires the local fixture server',
	);
	await page.route('**/api/wg/MTE8PZAT/shopping', async (route) => {
		if (route.request().method() !== 'POST') {
			await route.continue();
			return;
		}
		await route.abort('internetdisconnected');
	});
	await setupMember(page);
	await navigateToFeature(page, '/wg/MTE8PZAT/einkauf');
	await dismissOnboarding(page);
	const readQueuedKeys = () =>
		page.evaluate(() => {
			const raw = window.localStorage.getItem('manawg:offline-actions');
			const actions = raw
				? (JSON.parse(raw) as Array<{ type: string; idempotencyKey?: string }>)
				: [];
			return actions
				.filter((action) => action.type === 'shopping.create')
				.map((action) => action.idempotencyKey);
		});
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await page.getByLabel('Artikel-Name').fill('Rettich');
		await page.getByRole('button', { name: 'Artikel hinzufügen', exact: true }).click();
		await expect.poll(async () => (await readQueuedKeys()).length).toBe(attempt + 1);
	}
	const keys = await readQueuedKeys();
	expect(keys[0]).toBeTruthy();
	expect(keys[1]).toBeTruthy();
	expect(keys[1]).not.toBe(keys[0]);
});
