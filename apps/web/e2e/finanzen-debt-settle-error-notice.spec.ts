import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
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
	await page.route(`**/api/wg/${shareCode}/chat/unread-count`, (route) =>
		route.fulfill({ json: { count: 0, overflow: false } }),
	);
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

	await navigateToFeature(page, `/wg/${shareCode}/ausgaben`);
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
