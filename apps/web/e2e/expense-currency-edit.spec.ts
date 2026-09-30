import { type Locator, type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const currencies = ['CHF', 'USD', 'GBP'] as const;
const splitCurrencyLabels: Record<(typeof currencies)[number], string> = {
	CHF: 'CHF',
	USD: '$',
	GBP: '£',
};
const otherMemberId = '11111111-1111-4111-8111-111111111111';

async function expectNoHorizontalOverflow(
	page: Page,
	width: number,
	elements: Locator[],
): Promise<void> {
	await page.setViewportSize({ width, height: 640 });
	for (const element of elements) {
		const bounds = await element.evaluate((node) => ({
			clientWidth: node.clientWidth,
			scrollWidth: node.scrollWidth,
		}));
		expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
	}
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
		width,
	);
}

test('shows each existing expense currency while editing at 200% text size', async ({ page }) => {
	const { shareCode, memberId, memberName } = FIXTURE_WG;
	const occurredAt = '2026-09-18T10:00:00.000Z';
	const expenses = currencies.map((currency) => {
		const id = `expense-${currency.toLowerCase()}`;
		return {
			id,
			paidByMemberId: memberId,
			amountCents: 12_345,
			currency,
			description: `Ausgabe ${currency}`,
			imageUrl: null,
			occurredAt,
			createdAt: occurredAt,
			updatedAt: occurredAt,
			splits: [
				{
					id: `split-${currency.toLowerCase()}`,
					expenseId: id,
					debtorMemberId: otherMemberId,
					amountCents: 12_345,
					settledAt: null,
				},
			],
		};
	});

	await setupMember(page);
	await page.setViewportSize({ width: 320, height: 640 });
	await page.route(`**/api/wg/${shareCode}/members`, (route) =>
		route.fulfill({
			json: {
				members: [
					{ id: memberId, name: memberName, color: null, active: true },
					{ id: otherMemberId, name: 'Mina', color: null, active: true },
				],
				viewerIsAdmin: false,
			},
		}),
	);
	await page.route(`**/api/wg/${shareCode}/expenses`, (route) =>
		route.fulfill({ json: { expenses, payments: [] } }),
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
	await page.evaluate(() => {
		document.documentElement.style.fontSize = '200%';
	});
	expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
		'32px',
	);

	for (const expense of expenses) {
		await page.getByRole('button', { name: `Aktionen für ${expense.description}` }).click();
		await page.getByRole('menuitem', { name: 'Bearbeiten', exact: true }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		const amountGroup = dialog.getByLabel('Betrag').locator('xpath=..');
		await expect(amountGroup).toContainText(expense.currency);
		await expect(amountGroup).not.toContainText('€');
		const shareGroup = dialog.getByLabel(`Anteil Mina in ${expense.currency}`).locator('xpath=..');
		await expect(shareGroup).toContainText(expense.currency);
		await expect(shareGroup).not.toContainText('€');
		const manualSummary = dialog.getByText('Summe:').locator('xpath=..');
		await expect(manualSummary).toContainText(splitCurrencyLabels[expense.currency]);
		await expect(manualSummary).not.toContainText('€');
		for (const theme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expect
				.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
				.toBe(theme === 'dark');
			for (const width of [320, 360]) {
				await expectNoHorizontalOverflow(page, width, [amountGroup, shareGroup, manualSummary]);
			}
		}
		await page.getByRole('button', { name: 'Aufteilung: Gleichmäßig', exact: true }).click();
		const splitReview = dialog.getByRole('list', { name: 'Anteile vor dem Speichern' });
		await expect(splitReview).toContainText(splitCurrencyLabels[expense.currency]);
		await expect(splitReview).not.toContainText('€');

		for (const theme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expect
				.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
				.toBe(theme === 'dark');
			for (const width of [320, 360]) {
				await expectNoHorizontalOverflow(page, width, [amountGroup, splitReview]);
			}
		}

		await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
		const confirmClose = page.getByRole('alertdialog');
		await expect(confirmClose).toBeVisible();
		await confirmClose.getByRole('button', { name: 'Entwurf behalten', exact: true }).click();
		await expect(dialog).toBeHidden();
	}
});
