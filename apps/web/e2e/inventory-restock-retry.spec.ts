import { expect, test } from '@playwright/test';
import { type InventoryItemDto, groupItemsByCategory } from '../src/features/inventory/inventory';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test('quick restock retry keeps its idempotency key per inventory item', async ({ page }) => {
	const firstId = '11111111-1111-4111-8111-111111111111';
	const secondId = '22222222-2222-4222-8222-222222222222';
	const initialItems = [
		{
			id: firstId,
			wgId: FIXTURE_WG.id,
			name: 'Reis',
			quantity: 5,
			unit: 'Packung',
			threshold: 1,
			category: 'kueche',
			lastDecrementedAt: '2026-09-23T10:00:00.000Z',
			decrementCount30d: 3,
			createdAt: '2026-09-20T10:00:00.000Z',
			updatedAt: '2026-09-23T10:00:00.000Z',
		},
		{
			id: secondId,
			wgId: FIXTURE_WG.id,
			name: 'Linsen',
			quantity: 2,
			unit: 'Packung',
			threshold: 1,
			category: 'kueche',
			lastDecrementedAt: '2026-09-23T10:00:00.000Z',
			decrementCount30d: 2,
			createdAt: '2026-09-20T10:00:00.000Z',
			updatedAt: '2026-09-23T10:00:00.000Z',
		},
	];
	const quantities = new Map(initialItems.map((item) => [item.id, item.quantity]));
	const keysByItem = new Map<string, string[]>();
	const committedKeyByItem = new Map<string, string>();

	await setupMember(page);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/inventory`, async (route) => {
		if (route.request().method() !== 'GET') {
			await route.continue();
			return;
		}
		const items = initialItems.map((item) => ({ ...item, quantity: quantities.get(item.id) }));
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				items,
				grouped: { bad: [], kueche: items, putzmittel: [], sonstiges: [] },
			}),
		});
	});
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/inventory/*`, async (route) => {
		const request = route.request();
		if (request.method() !== 'PATCH') {
			await route.continue();
			return;
		}
		const itemId = new URL(request.url()).pathname.split('/').at(-1) ?? '';
		const key = request.headers()['idempotency-key'] ?? '';
		const keys = keysByItem.get(itemId) ?? [];
		keys.push(key);
		keysByItem.set(itemId, keys);

		const item = initialItems.find((candidate) => candidate.id === itemId);
		if (!item) throw new Error(`unexpected inventory item ${itemId}`);

		if (itemId === firstId && keys.length === 1) {
			// Simulate a committed increment whose response was lost after commit.
			quantities.set(itemId, (quantities.get(itemId) ?? 0) + 1);
			committedKeyByItem.set(itemId, key);
			await route.fulfill({
				status: 503,
				contentType: 'application/json',
				body: '{"error":"server_error"}',
			});
			return;
		}

		if (committedKeyByItem.get(itemId) !== key) {
			quantities.set(itemId, (quantities.get(itemId) ?? 0) + 1);
			committedKeyByItem.set(itemId, key);
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ item: { ...item, quantity: quantities.get(itemId) } }),
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/vorraete`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Schnell nachfüllen' }).click();
	const drawer = page
		.locator('[data-slot="drawer-popup"]')
		.filter({ hasText: 'Schnell nachfüllen' });

	await drawer.getByRole('button', { name: 'Reis um eins erhöhen' }).click();
	await expect(drawer.getByText('Aktualisierung fehlgeschlagen.')).toBeVisible();
	await drawer.getByRole('button', { name: 'Linsen um eins erhöhen' }).click();
	await expect.poll(() => keysByItem.get(secondId)?.length).toBe(1);
	await drawer.getByRole('button', { name: 'Reis um eins erhöhen' }).click();
	await expect.poll(() => keysByItem.get(firstId)?.length).toBe(2);

	expect(keysByItem.get(firstId)?.[1]).toBe(keysByItem.get(firstId)?.[0]);
	expect(quantities.get(firstId)).toBe(6);
});

test('inventory create, update, and delete survive a stale in-flight refresh', async ({ page }) => {
	const itemId = '11111111-1111-4111-8111-111111111111';
	const createdItemId = '22222222-2222-4222-8222-222222222222';
	const deletedItemId = '33333333-3333-4333-8333-333333333333';
	const initialItem: InventoryItemDto = {
		id: itemId,
		wgId: FIXTURE_WG.id,
		name: 'Reis',
		quantity: 5,
		unit: 'Packung',
		threshold: 1,
		category: 'kueche',
		lastDecrementedAt: '2026-09-23T10:00:00.000Z',
		decrementCount30d: 4,
		createdAt: '2026-09-20T10:00:00.000Z',
		updatedAt: '2026-09-23T10:00:00.000Z',
	};
	const deletedItem: InventoryItemDto = { ...initialItem, id: deletedItemId, name: 'Milch' };
	let items = [initialItem, deletedItem];
	let delayNextGet = false;
	let releaseStaleGet = () => {};
	let markStaleGetStarted = () => {};
	const staleGetStarted = new Promise<void>((resolve) => {
		markStaleGetStarted = resolve;
	});
	const staleGetGate = new Promise<void>((resolve) => {
		releaseStaleGet = resolve;
	});
	const inventoryUrl = `**/api/wg/${FIXTURE_WG.shareCode}/inventory`;

	await setupMember(page);
	await page.route(inventoryUrl, async (route) => {
		const request = route.request();
		if (request.method() === 'GET') {
			const snapshot = items.map((item) => ({ ...item }));
			if (delayNextGet) {
				delayNextGet = false;
				markStaleGetStarted();
				await staleGetGate;
			}
			await route.fulfill({
				json: { items: snapshot, grouped: groupItemsByCategory(snapshot) },
			});
			return;
		}

		if (request.method() === 'POST') {
			const body = request.postDataJSON() as Omit<
				InventoryItemDto,
				'id' | 'wgId' | 'lastDecrementedAt' | 'decrementCount30d' | 'createdAt' | 'updatedAt'
			>;
			const item: InventoryItemDto = {
				...body,
				id: createdItemId,
				wgId: FIXTURE_WG.id,
				lastDecrementedAt: null,
				decrementCount30d: 0,
				createdAt: '2026-09-27T10:00:00.000Z',
				updatedAt: '2026-09-27T10:00:00.000Z',
			};
			items = [...items, item];
			const responseItem = { ...item, decrementCount30d: undefined };
			await route.fulfill({ json: { item: responseItem } });
			return;
		}

		await route.continue();
	});
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/inventory/*`, async (route) => {
		const request = route.request();
		const requestItemId = new URL(request.url()).pathname.split('/').at(-1);
		if (request.method() === 'PATCH') {
			const current = items.find((item) => item.id === requestItemId);
			if (!current) throw new Error(`unexpected inventory item ${requestItemId}`);
			const body = request.postDataJSON() as { quantityDelta: number };
			const item = {
				...current,
				quantity: current.quantity + body.quantityDelta,
				updatedAt: '2026-09-27T10:01:00.000Z',
			};
			items = items.map((candidate) => (candidate.id === item.id ? item : candidate));
			const responseItem = { ...item, decrementCount30d: undefined };
			await route.fulfill({ json: { item: responseItem } });
			return;
		}

		if (request.method() === 'DELETE') {
			items = items.filter((item) => item.id !== requestItemId);
			await route.fulfill({ json: { ok: true } });
			return;
		}

		await route.continue();
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/vorraete`);
	await dismissOnboarding(page);
	await expect(page.getByRole('button', { name: 'Reis um eins erhöhen' })).toBeVisible();
	delayNextGet = true;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await staleGetStarted;

	try {
		await page.getByRole('button', { name: 'Reis um eins erhöhen' }).click();
		await expect(page.getByText('6 Packung · Nachkaufen ab 1')).toBeVisible();

		await page.getByRole('button', { name: 'Vorrat hinzufügen' }).click();
		await page.locator('#inventory-name').fill('Seife');
		await page.locator('#inventory-qty').fill('2');
		await page.getByRole('button', { name: 'Speichern', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Seife um eins erhöhen' })).toBeVisible();

		await page.getByRole('button', { name: 'Milch entfernen', exact: true }).click();
		await page.getByRole('button', { name: 'Endgültig entfernen: Milch' }).click();
		await expect(page.getByRole('button', { name: 'Milch um eins erhöhen' })).toHaveCount(0);

		const staleResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith(`/api/wg/${FIXTURE_WG.shareCode}/inventory`) &&
				response.request().method() === 'GET',
		);
		releaseStaleGet();
		const response = await staleResponse;
		await response.finished();
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);

		await expect(page.getByRole('button', { name: 'Seife um eins erhöhen' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Reis um eins erhöhen' })).toBeVisible();
		await expect(page.getByText('6 Packung · Nachkaufen ab 1')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Milch um eins erhöhen' })).toHaveCount(0);

		await page.getByRole('button', { name: 'Schnell nachfüllen' }).click();
		const restockSheet = page
			.locator('[data-slot="drawer-popup"]')
			.filter({ hasText: 'Schnell nachfüllen' });
		await expect(restockSheet.getByText('4× in 30 Tagen')).toBeVisible();
	} finally {
		releaseStaleGet();
	}
});

test('a deleted inventory item disappears before the refetch lands', async ({ page }) => {
	const item = {
		id: '11111111-1111-4111-8111-111111111111',
		wgId: FIXTURE_WG.id,
		name: 'Reis',
		quantity: 5,
		unit: 'Packung',
		threshold: 1,
		category: 'kueche',
		lastDecrementedAt: null,
		decrementCount30d: 0,
		createdAt: '2026-09-20T10:00:00.000Z',
		updatedAt: '2026-09-23T10:00:00.000Z',
	};
	let gets = 0;

	await setupMember(page);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/inventory`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		// Only the first load answers; the refetch after the delete stays in flight.
		if (++gets > 1) return;
		await route.fulfill({
			json: { items: [item], grouped: { bad: [], kueche: [item], putzmittel: [], sonstiges: [] } },
		});
	});
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/inventory/${item.id}`, async (route) => {
		if (route.request().method() !== 'DELETE') return route.continue();
		await route.fulfill({ json: { ok: true } });
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/vorraete`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Reis entfernen', exact: true }).click();
	await page.getByRole('button', { name: 'Endgültig entfernen: Reis' }).click();

	await expect.poll(() => gets).toBeGreaterThan(1);
	await expect(page.getByRole('button', { name: 'Reis um eins erhöhen' })).toHaveCount(0);
});

test('armed inventory delete can be cancelled without deleting the item', async ({ page }) => {
	const item = {
		id: '11111111-1111-4111-8111-111111111111',
		wgId: FIXTURE_WG.id,
		name: 'Reis',
		quantity: 5,
		unit: 'Packung',
		threshold: 1,
		category: 'kueche',
		lastDecrementedAt: null,
		decrementCount30d: 0,
		createdAt: '2026-09-20T10:00:00.000Z',
		updatedAt: '2026-09-23T10:00:00.000Z',
	};
	let deleteCalls = 0;

	await setupMember(page);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/inventory`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			json: { items: [item], grouped: { bad: [], kueche: [item], putzmittel: [], sonstiges: [] } },
		});
	});
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/inventory/${item.id}`, async (route) => {
		if (route.request().method() !== 'DELETE') return route.continue();
		deleteCalls += 1;
		await route.fulfill({ json: { ok: true } });
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/vorraete`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Reis entfernen', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Endgültig entfernen: Reis' })).toBeVisible();
	await page.getByRole('button', { name: 'Abbrechen: Löschen von Reis' }).click();

	await expect(page.getByRole('button', { name: 'Endgültig entfernen: Reis' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Reis entfernen', exact: true })).toBeVisible();
	expect(deleteCalls).toBe(0);
});
