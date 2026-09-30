import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

test('quiet-time controls stay within the settings card at mobile widths and 200% text', async ({
	page,
}) => {
	test.setTimeout(120_000);
	const notificationStatus = {
		pushOptIn: false,
		notifyAnnouncements: true,
		notifyChores: true,
		notifyExpenses: true,
		notifyReminders: true,
		notifyShopping: true,
		notifyInventory: true,
		notifyChat: true,
		notifyEvents: true,
		quietStartHour: 22,
		quietEndHour: 7,
		pushConfigured: false,
	};
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/notifications`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(route.request().method() === 'GET' ? notificationStatus : { ok: true }),
		});
	});
	await setupMember(page);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#benachrichtigungen`);
	await expect(page.getByRole('tablist')).toBeVisible({ timeout: 60_000 });

	const card = page.locator('#benachrichtigungen > .overflow-hidden');
	const startHour = page.getByRole('combobox', { name: 'Ruhezeit von' });
	const endHour = page.getByRole('combobox', { name: 'Ruhezeit bis' });
	const disableButton = page
		.locator('#benachrichtigungen')
		.getByRole('button', { name: 'Aus', exact: true });
	await expect(startHour).toBeVisible({ timeout: 30_000 });
	await expect(endHour).toBeVisible();
	await expect(disableButton).toBeVisible();

	const overflows: string[] = [];
	for (const width of [320, 360, 390]) {
		await page.setViewportSize({ width, height: 720 });
		for (const fontSize of ['16px', '32px']) {
			for (const dark of [false, true]) {
				await page.evaluate(
					({ fontSize: nextFontSize, dark: darkMode }) => {
						document.documentElement.style.fontSize = nextFontSize;
						document.documentElement.classList.toggle('dark', darkMode);
					},
					{ fontSize, dark },
				);
				expect(
					await page.locator('html').evaluate((element) => getComputedStyle(element).fontSize),
				).toBe(fontSize);
				const cardBox = await card.boundingBox();
				const startBox = await startHour.boundingBox();
				const selectBox = await endHour.boundingBox();
				const buttonBox = await disableButton.boundingBox();
				if (!cardBox || !startBox || !selectBox || !buttonBox) {
					throw new Error('Expected the quiet-time controls to have layout boxes');
				}
				const cardRight = cardBox.x + cardBox.width;
				for (const [name, box] of [
					['Von', startBox],
					['Bis', selectBox],
					['Aus', buttonBox],
				] as const) {
					if (box.x < cardBox.x - 1 || box.x + box.width > cardRight + 1) {
						overflows.push(
							`${width}px / ${fontSize} / ${dark ? 'dark' : 'light'}: ${name} ${box.x.toFixed(1)}..${(box.x + box.width).toFixed(1)} outside ${cardBox.x.toFixed(1)}..${cardRight.toFixed(1)}`,
						);
					}
				}
				const pageOverflows = await page.evaluate(
					() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
				);
				if (pageOverflows) {
					overflows.push(
						`${width}px / ${fontSize} / ${dark ? 'dark' : 'light'}: page scrolls horizontally`,
					);
				}
				for (const hour of [startHour, endHour]) {
					const selectHeight = await hour.evaluate(
						(element) => element.getBoundingClientRect().height,
					);
					if (fontSize === '16px') expect(selectHeight).toBe(44);
					else expect(selectHeight).toBeGreaterThanOrEqual(44);
				}
			}
		}
	}
	expect(overflows).toEqual([]);

	await page.setViewportSize({ width: 320, height: 720 });
	await page.evaluate(() => {
		document.documentElement.style.fontSize = '32px';
		document.documentElement.classList.remove('dark');
	});
	await expect(endHour).toBeEnabled();
	await endHour.focus();
	await expect(endHour).toBeFocused();
	await endHour.selectOption('8');
	await expect(endHour).toHaveValue('8');
});
