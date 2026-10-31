// Debt overview, reminders, settle errors and dashboard balance consistency.
// Why: Dashboard, debt list and settlement must agree to the cent.

import { expect, test } from '@playwright/test';
import {
	balanceTotalsFromRows,
	computeMemberBalances,
} from '../src/composition/dashboard-balances';
import { getDebtOverview } from '../src/features/expenses/debt-overview';
import {
	buildSettlementSummary,
	computeDirectDebts,
} from '../src/features/expenses/debt-reduction';
import {
	dismissOnboarding,
	FIXTURE_WG,
	mockUnreadCount,
	navigateToFeature,
	setupMember,
	skipUnlessFixtures,
	tuple,
} from './support/helpers';

test.describe('debt overview', () => {
	const outgoing = { fromId: 'me', fromName: 'Alex', toId: 'lisa', toName: 'Lisa', cents: 1200 };
	const incoming = { fromId: 'lisa', fromName: 'Lisa', toId: 'me', toName: 'Alex', cents: 1200 };
	const other = { fromId: 'ben', fromName: 'Ben', toId: 'sara', toName: 'Sara', cents: 2500 };

	test('reciprocal open expenses cancel without resurfacing as transfer demands', () => {
		const members = [
			{ id: 'me', name: 'Alex', color: null },
			{ id: 'lisa', name: 'Lisa', color: null },
		];
		const expenses = [
			{
				paidByMemberId: 'me',
				splits: [{ debtorMemberId: 'lisa', amountCents: 1200, settledAt: null }],
			},
			{
				paidByMemberId: 'lisa',
				splits: [{ debtorMemberId: 'me', amountCents: 1200, settledAt: null }],
			},
		];
		const summary = buildSettlementSummary(expenses, members);
		expect(getDebtOverview(computeDirectDebts(expenses, members), 'me', summary)).toEqual({
			personal: [],
			others: [],
		});
		expect(expenses.every((expense) => expense.splits[0]?.settledAt === null)).toBe(true);
	});

	test('incoming and outgoing personal transfers are separated from other residents', () => {
		expect(getDebtOverview([other, outgoing, incoming], 'me')).toEqual({
			personal: [outgoing, incoming],
			others: [other],
		});
	});

	test('uninvolved residents have no personal demand', () => {
		expect(getDebtOverview([other], 'me')).toEqual({ personal: [], others: [other] });
	});

	test('a provided simplified result is authoritative even without direct debts', () => {
		expect(
			getDebtOverview([], 'me', {
				simplified: [outgoing],
			}).personal,
		).toEqual([outgoing]);
	});
});

test.describe('debt summary reminder link', () => {
	skipUnlessFixtures();

	test('keeps finance actions and expense summary keyboard-operable at phone sizes', async ({
		page,
		browserName,
	}, testInfo) => {
		const { shareCode, memberId } = FIXTURE_WG;
		const otherMemberId = '11111111-1111-4111-8111-111111111111';
		const longMemberName = 'A'.repeat(80);
		await setupMember(page);
		await page.route(`**/api/wg/${shareCode}/members`, (route) =>
			route.fulfill({
				json: {
					members: [
						{ id: memberId, name: 'Abu', color: null, active: true },
						{ id: otherMemberId, name: longMemberName, color: null, active: true },
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
		await mockUnreadCount(page, `/api/wg/${shareCode}`);
		await navigateToFeature(page, `/wg/${shareCode}/expenses`);
		await dismissOnboarding(page);

		const debtList = page.getByRole('list', { name: 'Deine offenen Zahlungen' });
		await expect(debtList).toBeVisible();
		// Balances are always visible, not hidden behind „Alle Salden“.
		const balanceList = page.getByRole('list', { name: 'Saldo pro Mitglied' });
		await expect(balanceList).toBeVisible();
		const balanceLabel = page.getByText('Dein Saldo', { exact: true });
		await expect(balanceLabel).toBeVisible();
		// The balance is the heading; the open payments follow directly below.
		const balancePrecedesDebtsInDom = await balanceLabel.evaluate((node) => {
			const debt = document.querySelector('[aria-label="Deine offenen Zahlungen"]');
			return debt
				? Boolean(node.compareDocumentPosition(debt) & Node.DOCUMENT_POSITION_FOLLOWING)
				: false;
		});
		expect(balancePrecedesDebtsInDom).toBe(true);
		const debts = debtList.locator('[data-slot="item"]');
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
		await expect(reminderLink).toHaveAttribute('href', `/wg/${shareCode}/reminders`);
		await reminderLink.focus();
		await expect(reminderLink).toBeFocused();
		await page.keyboard.press('Tab');
		await page.keyboard.press('Shift+Tab');
		if (browserName === 'webkit') {
			// WebKit's native reverse Tab traversal can skip anchors without Full Keyboard Access.
			await reminderLink.focus();
		}
		await expect(reminderLink).toBeFocused();
		await expect
			.poll(() => reminderLink.evaluate((node) => node.matches(':focus-visible')))
			.toBe(true);
		for (const theme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: theme });
			for (const textScale of ['100%', '200%'] as const) {
				await page.evaluate((fontSize) => {
					document.documentElement.style.setProperty('font-size', fontSize, 'important');
				}, textScale);
				for (const width of [320, 360, 390]) {
					await page.setViewportSize({ width, height: 844 });
					// Measure both buttons in the same frame: getBoundingClientRect is
					// viewport-relative, and two separate evaluate calls can straddle
					// scroll or render steps and report a false overlap.
					const metrics = await secondaryDebt.evaluate((row) =>
						(['Ausgleichen', 'Erinnern'] as const).map((label) => {
							const element = [...row.querySelectorAll('button')].find(
								(button) => button.textContent?.trim() === label,
							);
							if (!element) throw new Error(`${label} button missing`);
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
						}),
					);
					const [settle, remind] = tuple(metrics, 2);
					const buttonsOverlap =
						settle.button.left < remind.button.right &&
						remind.button.left < settle.button.right &&
						settle.button.top < remind.button.bottom &&
						remind.button.top < settle.button.bottom;
					const layout = await page.evaluate(() => ({
						viewport: document.documentElement.clientWidth,
						scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
					}));

					expect(
						buttonsOverlap,
						`${width}px / ${textScale} / ${theme}: action buttons overlap`,
					).toBe(false);
					expect(
						settle.textFits,
						`${width}px / ${textScale} / ${theme}: settlement text clips`,
					).toBe(true);
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
						const debtBox = await debtList.boundingBox();
						if (!balanceBox || !debtBox) throw new Error('Summary must have layout boxes');
						expect(balanceBox.y).toBeLessThan(debtBox.y);
						const chfBalance = balanceList
							.getByRole('listitem')
							.filter({ hasText: longMemberName })
							.filter({ hasText: 'CHF' });
						await expect(chfBalance).toHaveCount(1);
						const balanceMetrics = await chfBalance.evaluate((row) => {
							const name = row.firstElementChild?.lastElementChild as HTMLElement | null;
							const amount = row.lastElementChild as HTMLElement | null;
							const card = row.closest('[data-slot="card"]') as HTMLElement | null;
							if (!name || !amount || !card) throw new Error('Balance row layout is incomplete');
							const nameRect = name.getBoundingClientRect();
							const amountRect = amount.getBoundingClientRect();
							const cardRect = card.getBoundingClientRect();
							return {
								nameWidth: nameRect.width,
								nameClientWidth: name.clientWidth,
								nameScrollWidth: name.scrollWidth,
								nameRight: nameRect.right,
								cardRight: cardRect.right,
								amountLeft: amountRect.left,
								amountRight: amountRect.right,
								cardLeft: cardRect.left,
							};
						});
						expect(
							balanceMetrics.nameWidth,
							`${width}px / ${theme}: member name must have visible width`,
						).toBeGreaterThan(32);
						expect(
							balanceMetrics.nameScrollWidth,
							`${width}px / ${theme}: member name must not be clipped`,
						).toBeLessThanOrEqual(balanceMetrics.nameClientWidth + 1);
						expect(
							balanceMetrics.nameRight,
							`${width}px / ${theme}: member name extends beyond its card`,
						).toBeLessThanOrEqual(balanceMetrics.cardRight + 1);
						expect(
							balanceMetrics.amountLeft,
							`${width}px / ${theme}: balance amount starts outside its card`,
						).toBeGreaterThanOrEqual(balanceMetrics.cardLeft - 1);
						expect(
							balanceMetrics.amountRight,
							`${width}px / ${theme}: balance amount extends beyond its card`,
						).toBeLessThanOrEqual(balanceMetrics.cardRight + 1);
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
		await expect(page).toHaveURL(new RegExp(`/wg/${shareCode}/reminders$`));
	});
});

test.describe('debt settle error notice', () => {
	skipUnlessFixtures();
	test.use({ hasTouch: true, isMobile: true });

	const MINA_ID = '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55';

	test('cancelling the settle-confirmation dialog clears a failed settle attempt error', async ({
		page,
	}) => {
		const { shareCode, memberId } = FIXTURE_WG;

		await setupMember(page);
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
									debtorMemberId: MINA_ID,
									amountCents: 1000,
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
		await mockUnreadCount(page, `/api/wg/${shareCode}`);
		await page.route(`**/api/wg/${shareCode}/expenses/settle-batch*`, (route) => {
			if (route.request().method() === 'GET') {
				return route.fulfill({
					json: {
						currency: 'EUR',
						netCents: 1000,
						settleableCents: 1000,
						remainingCents: 0,
						splits: [{ id: 'split-rent', expenseId: 'expense-rent', amountCents: 1000 }],
					},
				});
			}
			return route.fulfill({ status: 500, json: { error: 'server_error' } });
		});

		await navigateToFeature(page, `/wg/${shareCode}/expenses`);
		await dismissOnboarding(page);

		await page.getByRole('button', { name: 'Ausgleichen' }).click();
		const dialog = page.getByRole('alertdialog', { name: 'Bereits erfolgte Zahlung bestätigen' });
		await expect(dialog).toBeVisible();

		await dialog.getByRole('button', { name: /als bezahlt eintragen/i }).click();
		await expect(
			dialog.getByText('Ausgleich konnte nicht gespeichert werden', { exact: false }),
		).toBeVisible();

		await dialog.getByRole('button', { name: 'Abbrechen' }).click();
		await expect(dialog).not.toBeVisible();
		await expect(
			page.getByText('Ausgleich konnte nicht gespeichert werden', { exact: false }),
		).toHaveCount(0);
	});
});

test.describe('dashboard balance consistency', () => {
	const memberA = '11111111-1111-4111-8111-111111111111';
	const memberB = '22222222-2222-4222-8222-222222222222';
	const memberC = '33333333-3333-4333-8333-333333333333';

	const members = [
		{ id: memberA, name: 'Anna', color: null },
		{ id: memberB, name: 'Ben', color: null },
		{ id: memberC, name: 'Cem', color: null },
	];

	type DashboardExpense = {
		id: string;
		paidByMemberId: string;
		amountCents: number;
	};

	type DashboardSplit = {
		expenseId: string;
		debtorMemberId: string;
		amountCents: number;
		settledAt: Date | null;
	};

	type Payment = {
		fromMemberId: string;
		toMemberId: string;
		amountCents: number;
		currency: string;
	};

	function expense(id: string, paidByMemberId: string, amountCents = 3_000): DashboardExpense {
		return { id, paidByMemberId, amountCents };
	}

	function split(
		expenseId: string,
		debtorMemberId: string,
		amountCents: number,
		settledAt: Date | null = null,
	): DashboardSplit {
		return { expenseId, debtorMemberId, amountCents, settledAt };
	}

	function dashboardBalances(
		expenses: DashboardExpense[],
		splits: DashboardSplit[],
		payments: Payment[] = [],
	) {
		const { payerTotals, openDebts } = balanceTotalsFromRows(expenses, splits);
		return computeMemberBalances(members, payerTotals, openDebts, payments);
	}
	test.describe('Dashboard balance consistency', () => {
		test('matches expected balances for an unsettled three-person expense', () => {
			const currentExpense = expense('expense-unpaid', memberA);
			const actual = dashboardBalances(
				[currentExpense],
				[
					split(currentExpense.id, memberA, 1_000),
					split(currentExpense.id, memberB, 1_000),
					split(currentExpense.id, memberC, 1_000),
				],
			);

			expect(
				actual.map(({ paidCents, owedCents, balanceCents }) => ({
					paidCents,
					owedCents,
					balanceCents,
				})),
			).toEqual([
				{ paidCents: 3_000, owedCents: 1_000, balanceCents: 2_000 },
				{ paidCents: 0, owedCents: 1_000, balanceCents: -1_000 },
				{ paidCents: 0, owedCents: 1_000, balanceCents: -1_000 },
			]);
		});

		test('matches expected balances for partial and full settlement', () => {
			const currentExpense = expense('expense-settlement', memberA);
			const splits = [
				split(currentExpense.id, memberA, 1_000),
				split(currentExpense.id, memberB, 1_000),
				split(currentExpense.id, memberC, 1_000),
			];

			const [splitA, splitB, splitC] = tuple(splits, 3);
			const partialSplits = [splitA, { ...splitB, settledAt: new Date() }, splitC];
			const partial = dashboardBalances([currentExpense], partialSplits);
			expect(
				partial.map(({ paidCents, owedCents, balanceCents }) => ({
					paidCents,
					owedCents,
					balanceCents,
				})),
			).toEqual([
				{ paidCents: 3_000, owedCents: 1_000, balanceCents: 1_000 },
				{ paidCents: 0, owedCents: 0, balanceCents: 0 },
				{ paidCents: 0, owedCents: 1_000, balanceCents: -1_000 },
			]);
			const full = dashboardBalances(
				[currentExpense],
				splits.map((current) => ({ ...current, settledAt: new Date() })),
			);
			expect(
				full.map(({ paidCents, owedCents, balanceCents }) => ({
					paidCents,
					owedCents,
					balanceCents,
				})),
			).toEqual([
				{ paidCents: 3_000, owedCents: 0, balanceCents: 0 },
				{ paidCents: 0, owedCents: 0, balanceCents: 0 },
				{ paidCents: 0, owedCents: 0, balanceCents: 0 },
			]);
		});

		test('keeps own shares neutral and applies completed cash payments', () => {
			const ownExpense = expense('expense-own', memberA);
			const own = dashboardBalances([ownExpense], [split(ownExpense.id, memberA, 3_000)]);
			expect(
				own.map(({ paidCents, owedCents, balanceCents }) => ({
					paidCents,
					owedCents,
					balanceCents,
				})),
			).toEqual([
				{ paidCents: 3_000, owedCents: 3_000, balanceCents: 0 },
				{ paidCents: 0, owedCents: 0, balanceCents: 0 },
				{ paidCents: 0, owedCents: 0, balanceCents: 0 },
			]);

			const sharedExpense = expense('expense-paid', memberA);
			const transferred = dashboardBalances(
				[sharedExpense],
				[
					split(sharedExpense.id, memberA, 1_000),
					split(sharedExpense.id, memberB, 1_000),
					split(sharedExpense.id, memberC, 1_000),
				],
				[{ fromMemberId: memberB, toMemberId: memberA, amountCents: 1_000, currency: 'EUR' }],
			);
			expect(
				transferred.map(({ paidCents, owedCents, balanceCents }) => ({
					paidCents,
					owedCents,
					balanceCents,
				})),
			).toEqual([
				{ paidCents: 3_000, owedCents: 2_000, balanceCents: 1_000 },
				{ paidCents: 1_000, owedCents: 1_000, balanceCents: 0 },
				{ paidCents: 0, owedCents: 1_000, balanceCents: -1_000 },
			]);
		});
	});
});
