import { type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const { id: wgId, memberId, memberName, shareCode } = FIXTURE_WG;

const drawers = [
	{ feature: 'putzen', openButton: 'Putzaufgabe erfassen' },
	{ feature: 'vorraete', openButton: 'Vorrat hinzufügen' },
	{ feature: 'kalender', openButton: 'Termin hinzufügen' },
] as const;

async function mockHouseholdData(page: Page): Promise<void> {
	await page.route(`**/api/wg/${shareCode}/members`, (route) =>
		route.fulfill({
			json: {
				members: [
					{ id: memberId, name: memberName, color: null, active: true },
					{ id: wgId, name: 'Mina', color: null, active: true },
				],
				viewerIsAdmin: false,
			},
		}),
	);
	await page.route(`**/api/wg/${shareCode}/chores`, (route) =>
		route.fulfill({ json: { chores: [] } }),
	);
	await page.route(`**/api/wg/${shareCode}/absences`, (route) =>
		route.fulfill({ json: { absences: [] } }),
	);
	await page.route(`**/api/wg/${shareCode}/inventory`, (route) =>
		route.fulfill({ json: { items: [] } }),
	);
	await page.route(`**/api/wg/${shareCode}/events**`, (route) =>
		route.fulfill({ json: { events: [] } }),
	);
	await page.route(`**/api/wg/${shareCode}/dashboard`, (route) =>
		route.fulfill({ json: { openShoppingCount: 0, dueChores: [], dueRecurringExpenses: [] } }),
	);
	await page.route(`**/api/wg/${shareCode}/chat/unread-count`, (route) =>
		route.fulfill({ json: { count: 0, overflow: false } }),
	);
}

for (const drawerCase of drawers) {
	test(`${drawerCase.feature} drawer stays usable at large text on a narrow phone`, async ({
		page,
	}) => {
		test.setTimeout(120_000);
		await setupMember(page);
		await mockHouseholdData(page);
		await page.setViewportSize({ width: 320, height: 640 });
		await navigateToFeature(page, `/wg/${shareCode}/${drawerCase.feature}`);
		await dismissOnboarding(page);
		await page.getByRole('button', { name: drawerCase.openButton, exact: true }).first().click();

		const drawer = page.getByRole('dialog');
		await expect(drawer).toBeVisible();
		const footer = drawer.locator('[data-slot="drawer-footer"]');
		const fields = drawer.locator(
			'input:visible:not([type="checkbox"]), textarea:visible, select:visible',
		);
		await expect(fields.first()).toBeVisible();
		await expect(footer.getByRole('button').first()).toHaveAccessibleName(/.+/);

		for (const fontSize of [32, 16]) {
			await page.evaluate((size) => {
				document.documentElement.style.fontSize = `${size}px`;
			}, fontSize);
			await expect
				.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize))
				.toBe(`${fontSize}px`);

			for (const height of [640, 812]) {
				await page.setViewportSize({ width: 320, height });
				for (const theme of ['light', 'dark'] as const) {
					await page.emulateMedia({ colorScheme: theme });
					await expect
						.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
						.toBe(theme === 'dark');

					const firstField = fields.first();
					const lastField = fields.last();
					await firstField.focus();
					await page.keyboard.press('Tab');
					expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(
						true,
					);
					await lastField.focus();
					await expect(lastField).toBeInViewport();

					if (fontSize === 32 && height === 640) {
						const scroll = await lastField.evaluate((field) => {
							let parent = field.parentElement;
							while (parent) {
								const overflowY = getComputedStyle(parent).overflowY;
								if (
									(overflowY === 'auto' || overflowY === 'scroll') &&
									parent.scrollHeight > parent.clientHeight
								) {
									return {
										clientHeight: parent.clientHeight,
										scrollHeight: parent.scrollHeight,
										scrollTop: parent.scrollTop,
									};
								}
								parent = parent.parentElement;
							}
							return null;
						});
						expect(scroll).not.toBeNull();
						expect(scroll?.scrollHeight).toBeGreaterThan(scroll?.clientHeight ?? 0);
						expect(scroll?.scrollTop).toBeGreaterThan(0);
					}

					for (const button of await footer.getByRole('button').all()) {
						await expect(button).toHaveAccessibleName(/.+/);
						await button.focus();
						await expect(button).toBeInViewport({ ratio: 1 });
					}
				}
			}
		}
	});
}
