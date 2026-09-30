import { randomUUID } from 'node:crypto';
import { type Page, expect, test } from '@playwright/test';
import { DrizzleQueryError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/core/db/schema';
import { isOpenShoppingItemDuplicate } from '../src/features/shopping/shopping-duplicate';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

const testDatabaseUrl = process.env.PILOT_SHOPPING_DATABASE_URL?.trim() ?? '';

type FixtureShoppingItem = {
	id: string;
	addedByMemberId: string;
	name: string;
	quantity: string | null;
	boughtAt: string | null;
	boughtByMemberId: string | null;
	createdAt: string;
	updatedAt: string;
};

function localTestDatabaseUrl(): string {
	if (!testDatabaseUrl) {
		test.skip(true, 'Set PILOT_SHOPPING_DATABASE_URL to an isolated local PostgreSQL database.');
	}
	const hostname = new URL(testDatabaseUrl).hostname.toLowerCase();
	expect(['localhost', '127.0.0.1', '::1']).toContain(hostname);
	return testDatabaseUrl;
}

test('recognizes a duplicate open shopping item through DrizzleQueryError.cause', () => {
	const postgresError = Object.assign(new Error('duplicate key value violates unique constraint'), {
		code: '23505',
		constraint: 'shopping_items_unique_open_name',
	});
	const wrapped = new DrizzleQueryError('insert into shopping_items ...', [], postgresError);

	expect(isOpenShoppingItemDuplicate(wrapped)).toBe(true);
});

async function mockShoppingPage(
	page: Page,
	viewerIsAdmin: boolean,
	deleteStatus = 200,
	items: FixtureShoppingItem[] = [
		{
			id: 'shopping-done',
			addedByMemberId: FIXTURE_WG.memberId,
			name: 'Kaffee',
			quantity: null,
			boughtAt: '2026-09-22T12:00:00.000Z',
			boughtByMemberId: FIXTURE_WG.memberId,
			createdAt: '2026-09-22T10:00:00.000Z',
			updatedAt: '2026-09-22T12:00:00.000Z',
		},
	],
	conflictOnPatch = false,
) {
	const { shareCode, memberId, memberName } = FIXTURE_WG;
	let getCalls = 0;
	await page.route(`**/api/wg/${shareCode}/members*`, (route) =>
		route.fulfill({
			json: {
				members: [{ id: memberId, name: memberName, active: true }],
				viewerIsAdmin,
			},
		}),
	);
	await page.route(new RegExp(`/api/wg/${shareCode}/shopping(?:/[^/?]+)?(?:\\?.*)?$`), (route) => {
		const method = route.request().method();
		if (method === 'DELETE') {
			return route.fulfill({
				status: deleteStatus,
				json: deleteStatus === 200 ? { deleted: 1 } : { error: 'not_admin' },
			});
		}
		if (method === 'PATCH' && conflictOnPatch) {
			return route.fulfill({ status: 409, json: { error: 'shopping_item_duplicate' } });
		}
		if (method === 'GET') getCalls += 1;
		return route.fulfill({ json: { items } });
	});
	await page.route(`**/api/wg/${shareCode}/inventory*`, (route) =>
		route.fulfill({ json: { items: [] } }),
	);
	return { getCalls: () => getCalls };
}

test('hides clearing bought items from non-admins', async ({ page }) => {
	test.skip(
		process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
		'requires the local fixture server',
	);
	await mockShoppingPage(page, false);
	await setupMember(page);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einkauf`);
	await dismissOnboarding(page);
	await page.getByText('Erledigt (1)', { exact: true }).click();
	await expect(page.getByRole('button', { name: 'Erledigte Artikel entfernen (1)' })).toHaveCount(
		0,
	);
});

test('explains the admin requirement when clear-bought returns 403', async ({ page }) => {
	test.skip(
		process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
		'requires the local fixture server',
	);
	await mockShoppingPage(page, true, 403);
	await setupMember(page);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einkauf`);
	await dismissOnboarding(page);
	await page.getByText('Erledigt (1)', { exact: true }).click();
	await page.getByRole('button', { name: 'Erledigte Artikel entfernen (1)' }).click();
	await page.getByRole('button', { name: 'Entfernen', exact: true }).click();
	await expect(
		page.getByText('Nur Admins dürfen erledigte Artikel für die ganze WG entfernen.'),
	).toBeVisible();
});

test('refreshes the list after a duplicate add and keeps the draft values', async ({ page }) => {
	test.skip(
		process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
		'requires the local fixture server',
	);
	const shareCode = 'MTE8PZAT';
	let getCalls = 0;
	let postCalls = 0;
	await page.route(`**/api/wg/${shareCode}/shopping*`, async (route) => {
		if (route.request().method() === 'GET') {
			getCalls += 1;
			return route.fulfill({
				json: {
					items:
						getCalls > 1
							? [
									{
										id: 'shopping-existing',
										addedByMemberId: '7d898f9e-5ad7-4f5d-abed-8c3e99a76973',
										name: 'Milch',
										quantity: '1 L',
										boughtAt: null,
										boughtByMemberId: null,
										createdAt: '2026-09-21T08:00:00.000Z',
										updatedAt: '2026-09-21T08:00:00.000Z',
									},
								]
							: [],
				},
			});
		}
		if (route.request().method() === 'POST') {
			postCalls += 1;
			return route.fulfill({ status: 409, json: { error: 'shopping_item_duplicate' } });
		}
		return route.continue();
	});

	await setupMember(page);
	await navigateToFeature(page, `/wg/${shareCode}/einkauf`);
	await dismissOnboarding(page);
	await page.getByLabel('Artikel-Name').fill('2 L Milch');
	await page.getByRole('button', { name: 'Artikel hinzufügen' }).click();

	await expect(
		page.getByText(
			'Dieser Artikel steht bereits offen auf der Einkaufsliste. Prüfe den vorhandenen Eintrag; seine Menge bleibt unverändert.',
		),
	).toBeVisible();
	await expect(page.locator('[data-shopping-row]')).toHaveCount(1);
	await expect(page.locator('[data-shopping-row]')).toContainText('Milch');
	await expect(page.getByLabel('Artikel-Name')).toHaveValue('2 L Milch');
	expect(postCalls).toBe(1);
	expect(getCalls).toBeGreaterThanOrEqual(2);
});

test('reopening a bought duplicate restores both items and explains the conflict at 320px', async ({
	page,
}) => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
	const { memberId } = FIXTURE_WG;
	const items: FixtureShoppingItem[] = [
		{
			id: '11111111-1111-4111-8111-111111111111',
			addedByMemberId: memberId,
			name: 'Milch',
			quantity: '1 L',
			boughtAt: '2026-09-22T12:00:00.000Z',
			boughtByMemberId: memberId,
			createdAt: '2026-09-22T10:00:00.000Z',
			updatedAt: '2026-09-22T12:00:00.000Z',
		},
		{
			id: '22222222-2222-4222-8222-222222222222',
			addedByMemberId: memberId,
			name: 'Milch',
			quantity: '2 L',
			boughtAt: null,
			boughtByMemberId: null,
			createdAt: '2026-09-23T10:00:00.000Z',
			updatedAt: '2026-09-23T10:00:00.000Z',
		},
	];
	const { getCalls } = await mockShoppingPage(page, true, 200, items, true);
	const conflictMessage =
		'Dieser Artikel steht bereits offen auf der Einkaufsliste. Prüfe den vorhandenen Eintrag; seine Menge bleibt unverändert.';

	await page.setViewportSize({ width: 320, height: 800 });
	await setupMember(page);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einkauf`);
	await dismissOnboarding(page);
	await page.getByText('Erledigt (1)', { exact: true }).click();
	const getCallsBeforeReopen = getCalls();
	await page.getByRole('checkbox', { name: 'Milch wieder öffnen', exact: true }).click();

	await expect(page.getByText(conflictMessage, { exact: true })).toBeVisible();
	await expect(page.locator('[data-shopping-row]')).toHaveCount(2);
	await expect(
		page.getByRole('checkbox', { name: 'Milch wieder öffnen', exact: true }),
	).toBeChecked();
	await expect(
		page.getByRole('checkbox', { name: 'Milch erledigen', exact: true }),
	).not.toBeChecked();
	expect(getCalls()).toBeGreaterThan(getCallsBeforeReopen);
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(page.getByText(conflictMessage, { exact: true })).toBeVisible();
});

test('real PostgreSQL partial unique index rejects open duplicates and allows repurchase', async () => {
	const pool = new Pool({ connectionString: localTestDatabaseUrl(), max: 1 });
	const database = drizzle(pool, { schema });
	const suffix = randomUUID().replaceAll('-', '');
	let wgId: string | undefined;
	let secondWgId: string | undefined;
	const name = `Pilot shopping ${suffix}`;
	const normalizedVariant = `  ${name.toUpperCase()}  `;

	try {
		const wg = await pool.query<{ id: string }>(
			'INSERT INTO public.wgs (share_code, name) VALUES ($1, $2) RETURNING id',
			[`P${suffix.slice(0, 7)}`, `Pilot shopping ${suffix}`],
		);
		wgId = wg.rows[0]?.id;
		expect(wgId).toBeTruthy();
		const secondWg = await pool.query<{ id: string }>(
			'INSERT INTO public.wgs (share_code, name) VALUES ($1, $2) RETURNING id',
			[`Q${suffix.slice(0, 7)}`, `Pilot shopping second ${suffix}`],
		);
		secondWgId = secondWg.rows[0]?.id;
		expect(secondWgId).toBeTruthy();

		const member = await pool.query<{ id: string }>(
			'INSERT INTO public.wg_members (wg_id, name) VALUES ($1, $2) RETURNING id',
			[wgId, `Pilot member ${suffix}`],
		);
		const memberId = member.rows[0]?.id;
		expect(memberId).toBeTruthy();
		const secondMember = await pool.query<{ id: string }>(
			'INSERT INTO public.wg_members (wg_id, name) VALUES ($1, $2) RETURNING id',
			[secondWgId, `Pilot second member ${suffix}`],
		);
		const secondMemberId = secondMember.rows[0]?.id;
		expect(secondMemberId).toBeTruthy();

		const first = await database
			.insert(schema.shoppingItems)
			.values({ wgId, addedByMemberId: memberId, name, quantity: '1x' })
			.returning({ id: schema.shoppingItems.id });
		expect(first).toHaveLength(1);

		let duplicateError: unknown;
		try {
			await database
				.insert(schema.shoppingItems)
				.values({ wgId, addedByMemberId: memberId, name: normalizedVariant, quantity: '2x' })
				.returning({ id: schema.shoppingItems.id });
		} catch (error) {
			duplicateError = error;
		}
		expect(duplicateError).toBeInstanceOf(DrizzleQueryError);
		expect(duplicateError).toMatchObject({
			cause: { code: '23505', constraint: 'shopping_items_unique_open_name' },
		});
		expect(isOpenShoppingItemDuplicate(duplicateError)).toBe(true);

		await pool.query(
			'UPDATE public.shopping_items SET bought_at = now(), bought_by_member_id = $2 WHERE id = $1',
			[first[0]?.id, memberId],
		);
		const repurchase = await database
			.insert(schema.shoppingItems)
			.values({ wgId, addedByMemberId: memberId, name: normalizedVariant, quantity: '2x' })
			.returning({ id: schema.shoppingItems.id });
		expect(repurchase).toHaveLength(1);

		const otherWgItem = await database
			.insert(schema.shoppingItems)
			.values({
				wgId: secondWgId,
				addedByMemberId: secondMemberId,
				name: normalizedVariant,
				quantity: '1x',
			})
			.returning({ id: schema.shoppingItems.id });
		expect(otherWgItem).toHaveLength(1);

		const rows = await pool.query<{ count: number }>(
			' SELECT count(*)::int AS count FROM public.shopping_items WHERE wg_id = $1 AND normalized_name = lower(btrim($2))',
			[wgId, name],
		);
		expect(rows.rows[0]?.count).toBe(2);
	} finally {
		if (wgId) await pool.query('DELETE FROM public.wgs WHERE id = $1', [wgId]);
		if (secondWgId) await pool.query('DELETE FROM public.wgs WHERE id = $1', [secondWgId]);
		await pool.end();
	}
});

test('wraps quick shopping suggestions at phone widths and large text', async ({ page }) => {
	test.skip(
		process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
		'requires the local fixture server',
	);

	const { shareCode, memberId, memberName } = FIXTURE_WG;
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/members*`, (route) =>
		route.fulfill({
			json: {
				members: [{ id: memberId, name: memberName, active: true }],
				viewerIsAdmin: false,
			},
		}),
	);
	let shoppingPostCount = 0;
	await page.route(`**/api/wg/${shareCode}/shopping*`, (route) => {
		if (route.request().method() === 'POST') shoppingPostCount += 1;
		return route.fulfill({ json: { items: [] } });
	});
	await page.route(`**/api/wg/${shareCode}/inventory*`, (route) =>
		route.fulfill({ json: { items: [] } }),
	);
	await navigateToFeature(page, `/wg/${shareCode}/einkauf`);
	await dismissOnboarding(page);

	const suggestions = page.locator('ul[aria-label="Vorschläge"]');
	await expect(suggestions).toBeVisible();
	expect(await suggestions.locator('button').count()).toBeGreaterThan(1);
	const assertSuggestionsFit = async (
		width: number,
		colorScheme: 'light' | 'dark',
		fontSize: number,
	) => {
		await page.setViewportSize({ width, height: 812 });
		await page.emulateMedia({ colorScheme });
		await expect
			.poll(() => page.locator('html').evaluate((html) => html.classList.contains('dark')))
			.toBe(colorScheme === 'dark');
		const state = await page.evaluate(() => ({
			viewport: document.documentElement.clientWidth,
			scroll: document.documentElement.scrollWidth,
			fontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
		}));
		expect(state.scroll).toBeLessThanOrEqual(state.viewport);
		expect(state.fontSize).toBe(fontSize);
		const geometry = await suggestions.evaluate((list) => {
			const bounds = list.getBoundingClientRect();
			return {
				clientWidth: list.clientWidth,
				scrollWidth: list.scrollWidth,
				left: bounds.left,
				right: bounds.right,
				items: Array.from(list.children).map((item) => {
					const rect = item.getBoundingClientRect();
					return { left: rect.left, right: rect.right };
				}),
			};
		});
		expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
		expect(
			geometry.items.every(
				(item) => item.left >= geometry.left - 1 && item.right <= geometry.right + 1,
			),
		).toBe(true);
	};
	for (const width of [320, 360]) {
		await page.setViewportSize({ width, height: 812 });
		const baseFontSize = await page.evaluate(() =>
			Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
		);
		for (const colorScheme of ['light', 'dark'] as const) {
			await assertSuggestionsFit(width, colorScheme, baseFontSize);
		}
	}

	await page.route('**/__e2e-font-scale-200.css', (route) =>
		route.fulfill({ contentType: 'text/css', body: ':root { font-size: 32px !important; }' }),
	);
	await page.addStyleTag({
		url: new URL('/__e2e-font-scale-200.css', page.url()).toString(),
	});
	await page.setViewportSize({ width: 320, height: 812 });
	await page.emulateMedia({ colorScheme: 'light' });
	const suggestionButtons = suggestions.locator('button');
	const pointerTarget = suggestionButtons.nth(1);
	// Arrange the same partial overlap from the rendered geometry.
	const overlapViewportHeight = await pointerTarget.evaluate((button) => {
		const action = document.querySelector('[data-page-primary-action]');
		if (!action) throw new Error('Expected the fixed shopping action');
		const buttonRect = button.getBoundingClientRect();
		return Math.round(
			window.innerHeight +
				buttonRect.top +
				buttonRect.height / 2 -
				action.getBoundingClientRect().top,
		);
	});
	await page.setViewportSize({ width: 320, height: overlapViewportHeight });
	const pointerPoint = await pointerTarget.evaluate((button) => {
		const action = document.querySelector('[data-page-primary-action]');
		if (!action) throw new Error('Expected the fixed shopping action');
		const buttonRect = button.getBoundingClientRect();
		const actionRect = action.getBoundingClientRect();
		return {
			x: buttonRect.left + buttonRect.width / 2,
			y: Math.min(buttonRect.bottom, actionRect.top) - 2,
			buttonTop: buttonRect.top,
			buttonBottom: buttonRect.bottom,
			actionTop: actionRect.top,
		};
	});
	expect(pointerPoint.buttonBottom).toBeGreaterThan(pointerPoint.actionTop);
	const pointerHitsSuggestion = await pointerTarget.evaluate((button, point) => {
		const hit = document.elementFromPoint(point.x, point.y);
		return Boolean(hit && button.contains(hit));
	}, pointerPoint);
	expect(pointerHitsSuggestion).toBe(true);
	await page.mouse.click(pointerPoint.x, pointerPoint.y);
	await expect.poll(() => shoppingPostCount).toBe(1);
	await expect
		.poll(() => pointerTarget.evaluate((button) => button.getBoundingClientRect().top))
		.toBe(pointerPoint.buttonTop);

	await suggestionButtons.first().focus();
	for (let index = 0; index < (await suggestionButtons.count()); index += 1) {
		if (index > 0) await page.keyboard.press('Tab');
		const button = suggestionButtons.nth(index);
		await expect(button).toBeFocused();
		await expect
			.poll(
				() =>
					button.evaluate((element) => {
						const action = document.querySelector('[data-page-primary-action]');
						if (!action) throw new Error('Expected the fixed shopping action');
						return element.getBoundingClientRect().bottom - action.getBoundingClientRect().top;
					}),
				{ timeout: 3_000 },
			)
			.toBeLessThan(0);
	}
	for (const width of [320, 360]) {
		for (const colorScheme of ['light', 'dark'] as const) {
			await assertSuggestionsFit(width, colorScheme, 32);
		}
	}
});
