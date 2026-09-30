import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
test.use({ hasTouch: true });

const EXPENSE_ID = '9af0f27a-3d2b-4983-b5cb-3920f6d6e51f';
const DESCRIPTION = 'Einkäufe für das Abendessen bei Freunden morgen';

test('expense rows stay readable and actionable on narrow screens', async ({ page }) => {
	expect(DESCRIPTION).toHaveLength(47);

	const { memberId, memberName, shareCode } = FIXTURE_WG;
	await setupMember(page);
	await page.setViewportSize({ width: 320, height: 800 });
	await page.route(`**/api/wg/${shareCode}/members`, (route) =>
		route.fulfill({
			json: {
				members: [{ id: memberId, name: memberName, color: null, active: true }],
				viewerIsAdmin: false,
			},
		}),
	);
	await page.route(`**/api/wg/${shareCode}/expenses`, (route) =>
		route.fulfill({
			json: {
				expenses: [
					{
						id: EXPENSE_ID,
						paidByMemberId: memberId,
						amountCents: 12345,
						currency: 'EUR',
						description: DESCRIPTION,
						imageUrl: null,
						occurredAt: '2026-09-24T17:00:00.000Z',
						createdAt: '2026-09-24T17:00:00.000Z',
						updatedAt: '2026-09-24T17:00:00.000Z',
						splits: [],
					},
				],
				payments: [],
			},
		}),
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

	await navigateToFeature(page, `/wg/${shareCode}/ausgaben`);
	await dismissOnboarding(page);

	const row = page.locator(`#expense-${EXPENSE_ID}`);
	const title = row.getByText(DESCRIPTION, { exact: true });
	const amount = row.getByRole('button').first().locator('span.font-mono');
	const action = row.getByRole('button', { name: `Aktionen für ${DESCRIPTION}` });
	await expect(title).toBeVisible();

	for (const theme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: theme });
		await expect
			.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
			.toBe(theme === 'dark');

		for (const width of [320, 360, 390]) {
			await page.setViewportSize({ width, height: 800 });
			for (const largeText of [false, true]) {
				await page.evaluate((enabled) => {
					document.documentElement.style.fontSize = enabled ? '200%' : '';
				}, largeText);

				const layout = await row.evaluate((element) => ({
					rowHeight: element.getBoundingClientRect().height,
					rowClientWidth: element.clientWidth,
					rowScrollWidth: element.scrollWidth,
				}));
				const documentWidth = await page.evaluate(() => ({
					client: document.documentElement.clientWidth,
					scroll: document.documentElement.scrollWidth,
				}));

				expect(
					layout.rowHeight,
					`${theme}, ${width}px, ${largeText ? '32px' : 'normal'} text`,
				).toBeLessThan(500);
				expect(layout.rowScrollWidth).toBeLessThanOrEqual(layout.rowClientWidth);
				expect(documentWidth.scroll).toBeLessThanOrEqual(documentWidth.client);
				if (width === 390 && !largeText) {
					const titleBox = await title.boundingBox();
					const amountBox = await amount.boundingBox();
					if (!titleBox || !amountBox) throw new Error('expense title or amount missing');
					expect(Math.abs(titleBox.y - amountBox.y)).toBeLessThan(2);
				}

				await expect(action).toBeVisible();
				await action.focus();
				await page.keyboard.press('Enter');
				await expect(page.getByRole('menuitem', { name: 'Bearbeiten', exact: true })).toBeVisible();
				await page.keyboard.press('Escape');
				await action.tap();
				await expect(page.getByRole('menuitem', { name: 'Bearbeiten', exact: true })).toBeVisible();
				await page.keyboard.press('Escape');
			}
		}
	}
});
