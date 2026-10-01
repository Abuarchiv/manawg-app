import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

test('keeps finance actions and expense summary keyboard-operable at phone sizes', async ({
	page,
}, testInfo) => {
	const { shareCode, memberId } = FIXTURE_WG;
	const otherMemberId = '11111111-1111-4111-8111-111111111111';
	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/members`, (route) =>
		route.fulfill({
			json: {
				members: [
					{ id: memberId, name: 'Abu', color: null, active: true },
					{ id: otherMemberId, name: 'Mustermann-Langname', color: null, active: true },
				],
				viewerIsAdmin: false,
			},
		}),
	);
	await page.route(`**/api/wg/${shareCode}/expenses`, (route) =>
		route.fulfill({
			json: {
				expenses: [
					{
						id: 'expense-rent',
						paidByMemberId: memberId,
						amountCents: 2000,
						currency: 'EUR',
						description: 'Miete',
						occurredAt: '2026-09-01T10:00:00.000Z',
						splits: [
							{
								id: 'split-rent',
								expenseId: 'expense-rent',
								debtorMemberId: otherMemberId,
								amountCents: 1000,
								settledAt: null,
							},
						],
					},
					{
						id: 'expense-chf',
						paidByMemberId: memberId,
						amountCents: 24690,
						currency: 'CHF',
						description: 'Stromnachzahlung Oktober',
						occurredAt: '2026-09-02T10:00:00.000Z',
						splits: [
							{
								id: 'split-chf',
								expenseId: 'expense-chf',
								debtorMemberId: otherMemberId,
								amountCents: 12345,
								settledAt: null,
							},
						],
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

	await expect(page.getByRole('heading', { name: 'Deine offenen Zahlungen' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Alle Salden' })).toBeVisible();
	const balanceLabel = page.getByText('Dein Saldo', { exact: true });
	const debtHeading = page.getByRole('heading', { name: 'Deine offenen Zahlungen' });
	await expect(balanceLabel).toBeVisible();
	const debtPrecedesBalanceInDom = await balanceLabel.evaluate((node) => {
		const debt = Array.from(document.querySelectorAll('h2')).find(
			(heading) => heading.textContent?.trim() === 'Deine offenen Zahlungen',
		);
		return debt
			? Boolean(debt.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
			: false;
	});
	expect(debtPrecedesBalanceInDom).toBe(true);
	const balanceTrigger = page.getByRole('button', { name: 'Saldo pro Mitglied', exact: true });
	const debts = page
		.getByRole('list', { name: 'Deine offenen Zahlungen' })
		.locator('[data-slot="item"]');
	await expect(debts).toHaveCount(2);
	const secondaryDebt = debts.nth(1);
	const settleButton = secondaryDebt.getByRole('button', { name: 'Ausgleichen' });
	const remindButton = secondaryDebt.getByRole('button', { name: 'Erinnern', exact: true });
	await expect(settleButton).toBeVisible();
	await expect(remindButton).toBeVisible();
	await settleButton.focus();
	await page.keyboard.press('Tab');
	await expect(remindButton).toBeFocused();
	const reminderLink = page.getByRole('link', { name: 'Alle Erinnerungen' });
	await expect(reminderLink).toBeVisible();
	await expect(reminderLink).toHaveAttribute('href', `/wg/${shareCode}/mahnungen`);
	await reminderLink.focus();
	await expect(reminderLink).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(balanceTrigger).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(reminderLink).toBeFocused();
	await expect
		.poll(() => reminderLink.evaluate((node) => node.matches(':focus-visible')))
		.toBe(true);
	await page.evaluate(async () => {
		await document.fonts.ready;
	});
	for (const theme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: theme });
		for (const textScale of ['100%', '200%'] as const) {
			await page.evaluate((fontSize) => {
				document.documentElement.style.setProperty('font-size', fontSize, 'important');
			}, textScale);
			for (const width of [390, 360, 320]) {
				await page.setViewportSize({ width, height: 844 });
				const [settle, remind] = await secondaryDebt.evaluate((container) => {
					const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
					const settleElement = buttons.find(
						(button) => button.textContent?.trim() === 'Ausgleichen',
					);
					const remindElement = buttons.find((button) => button.textContent?.trim() === 'Erinnern');
					if (!settleElement || !remindElement) {
						throw new Error('Both debt action buttons must be present');
					}
					const measure = (element: HTMLButtonElement) => {
						const buttonRect = element.getBoundingClientRect();
						const textRange = document.createRange();
						textRange.selectNodeContents(element);
						const textRect = textRange.getBoundingClientRect();
						const hitTarget = getComputedStyle(element, '::after');
						return {
							button: {
								left: buttonRect.left,
								right: buttonRect.right,
								top: buttonRect.top,
								bottom: buttonRect.bottom,
							},
							textFits:
								textRect.left >= buttonRect.left - 1 && textRect.right <= buttonRect.right + 1,
							touchWidth: Number.parseFloat(hitTarget.minWidth),
							touchHeight: Number.parseFloat(hitTarget.height),
						};
					};
					return [measure(settleElement), measure(remindElement)] as const;
				});
				const buttonsOverlap =
					settle.button.left < remind.button.right &&
					remind.button.left < settle.button.right &&
					settle.button.top < remind.button.bottom &&
					remind.button.top < settle.button.bottom;
				const layout = await page.evaluate(() => ({
					viewport: document.documentElement.clientWidth,
					scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
				}));

				expect(buttonsOverlap, `${width}px / ${textScale} / ${theme}: action buttons overlap`).toBe(
					false,
				);
				expect(settle.textFits, `${width}px / ${textScale} / ${theme}: settlement text clips`).toBe(
					true,
				);
				expect(remind.textFits, `${width}px / ${textScale} / ${theme}: reminder text clips`).toBe(
					true,
				);
				expect(
					layout.scroll,
					`${width}px / ${textScale} / ${theme}: page overflows horizontally`,
				).toBeLessThanOrEqual(layout.viewport);
				expect(settle.touchWidth).toBeGreaterThanOrEqual(44);
				expect(settle.touchHeight).toBeGreaterThanOrEqual(44);
				if (textScale === '200%') {
					const balanceBox = await balanceLabel.boundingBox();
					const debtBox = await debtHeading.boundingBox();
					if (!balanceBox || !debtBox) throw new Error('Summary headings must have layout boxes');
					expect(debtBox.y).toBeLessThan(balanceBox.y);
					await page.screenshot({
						path: testInfo.outputPath(`reminders-${width}-${theme}.png`),
						animations: 'disabled',
					});
				}
			}
		}
	}
	await reminderLink.focus();
	await expect(reminderLink).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(new RegExp(`/wg/${shareCode}/mahnungen$`));
});
