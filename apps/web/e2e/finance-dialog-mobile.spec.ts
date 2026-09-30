import { type Locator, type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

async function expectManualSplitLayout(
	page: Page,
	dialog: Locator,
	shareInputPrefix: 'share-' | 'abo-share-',
): Promise<void> {
	const rows = dialog.locator(`[data-slot="field"]:has(input[id^="${shareInputPrefix}"])`);
	await expect(rows).toHaveCount(2);
	const cancelButton = page.getByRole('button', { name: 'Abbrechen', exact: true });
	for (const rootFontSize of [16, 32]) {
		await page.evaluate((size) => {
			document.documentElement.style.fontSize = `${size}px`;
		}, rootFontSize);
		await expect
			.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize))
			.toBe(`${rootFontSize}px`);
		for (const theme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expect
				.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
				.toBe(theme === 'dark');
			for (const width of [320, 360, 390]) {
				await page.setViewportSize({ width, height: 740 });
				const layout = await dialog.evaluate((element) => ({
					clientWidth: element.clientWidth,
					scrollWidth: element.scrollWidth,
				}));
				expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
				expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
					width,
				);
				const cancelBounds = await cancelButton.boundingBox();
				expect(cancelBounds).not.toBeNull();
				if (cancelBounds) expect(cancelBounds.x + cancelBounds.width).toBeLessThanOrEqual(width);
				const metrics = await rows.evaluateAll((elements) =>
					elements.map((element) => {
						const row = element as HTMLElement;
						const label = row.querySelector<HTMLElement>('[data-slot="field-label"]');
						const amount = row.querySelector<HTMLElement>('[data-slot="input-group"]');
						if (!label || !amount) return null;
						const labelBounds = label.getBoundingClientRect();
						const amountBounds = amount.getBoundingClientRect();
						return {
							clientWidth: row.clientWidth,
							scrollWidth: row.scrollWidth,
							direction: getComputedStyle(row).flexDirection,
							labelWidth: labelBounds.width,
							labelRight: labelBounds.right,
							labelTop: labelBounds.top,
							labelBottom: labelBounds.bottom,
							amountLeft: amountBounds.left,
							amountTop: amountBounds.top,
							amountBottom: amountBounds.bottom,
							amountWidth: amountBounds.width,
						};
					}),
				);
				expect(metrics.every((metric) => metric !== null)).toBe(true);
				for (const metric of metrics) {
					if (!metric) throw new Error('Manual share field layout could not be measured');
					expect(
						metric.labelWidth,
						JSON.stringify({ width, rootFontSize, metric }),
					).toBeGreaterThan(0);
					expect(metric.direction).toBe('column');
					expect(metric.scrollWidth).toBeLessThanOrEqual(metric.clientWidth + 1);
					const overlaps =
						metric.labelRight > metric.amountLeft + 1 &&
						metric.labelBottom > metric.amountTop + 1 &&
						metric.labelTop < metric.amountBottom - 1;
					expect(overlaps).toBe(false);
				}
			}
		}
	}
	await page.evaluate(() => {
		document.documentElement.style.fontSize = '16px';
	});
	await page.setViewportSize({ width: 1440, height: 900 });
	const wideMetrics = await rows.first().evaluate((element) => {
		const row = element as HTMLElement;
		const amount = row.querySelector<HTMLElement>('[data-slot="input-group"]');
		return {
			direction: getComputedStyle(row).flexDirection,
			amountWidth: amount?.getBoundingClientRect().width ?? 0,
		};
	});
	expect(wideMetrics.direction).toBe('row');
	expect(wideMetrics.amountWidth).toBeCloseTo(128, 0);
}

test('keeps finance forms in narrow viewports at 200% text size', async ({ page }) => {
	const { shareCode, id, memberId } = FIXTURE_WG;
	await setupMember(page);
	await page.setViewportSize({ width: 320, height: 640 });
	await page.route(`**/api/wg/${shareCode}/members`, (route) =>
		route.fulfill({
			json: {
				members: [
					{ id: memberId, name: 'Alexandra von Hohenlohe-Waldberg', color: null, active: true },
					{ id, name: 'Maximilian-Wilhelm Demonstrationshausen', color: null, active: true },
				],
				viewerIsAdmin: false,
			},
		}),
	);
	await page.route(`**/api/wg/${shareCode}/expenses`, (route) =>
		route.fulfill({ json: { expenses: [], payments: [] } }),
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
	await page.getByRole('button', { name: 'Ausgabe erfassen' }).first().click();
	const expenseDialog = page.getByRole('dialog');
	await expect(expenseDialog).toBeVisible();
	await expenseDialog.getByText('Manuell', { exact: true }).click();
	await expectManualSplitLayout(page, expenseDialog, 'share-');
	await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Entwurf verwerfen' }).click();
	await expect(expenseDialog).toBeHidden();

	await page.goto(`/wg/${shareCode}/abos`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Neue Fixkosten' }).click();
	const aboDialog = page.getByRole('dialog');
	await expect(aboDialog).toBeVisible();
	await aboDialog.getByText('Manuell', { exact: true }).click();
	await expectManualSplitLayout(page, aboDialog, 'abo-share-');
	await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
	await expect(aboDialog).toBeHidden();
});
