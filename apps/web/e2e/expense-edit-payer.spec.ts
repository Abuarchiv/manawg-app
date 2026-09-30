import { expect, test } from '@playwright/test';
import type { Expense } from '../src/features/expenses/components/ausgaben/expense-types';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const SHARE_CODE = FIXTURE_WG.shareCode;
const MEMBER = {
	id: FIXTURE_WG.memberId,
	name: FIXTURE_WG.memberName,
	color: null,
	active: true,
};
const INACTIVE_MEMBER = {
	id: 'fixture-inactive-member',
	name: 'Ben',
	color: null,
	active: false,
};
const SECOND_ACTIVE_MEMBER = {
	id: 'fixture-second-active-member',
	name: 'Cara',
	color: null,
	active: true,
};
const MEMBERS = [MEMBER, SECOND_ACTIVE_MEMBER, INACTIVE_MEMBER];

const expense: Expense = {
	id: 'fixture-expense-edit-payer',
	paidByMemberId: MEMBER.id,
	amountCents: 1250,
	currency: 'EUR',
	description: 'Payer contract test',
	imageUrl: null,
	occurredAt: '2026-09-25T10:00:00.000Z',
	createdAt: '2026-09-25T10:00:00.000Z',
	updatedAt: '2026-09-25T10:00:00.000Z',
	splits: [
		{
			id: 'fixture-expense-edit-payer-split',
			debtorMemberId: MEMBER.id,
			amountCents: 1000,
			settledAt: null,
		},
		{
			id: 'fixture-expense-edit-payer-inactive-split',
			debtorMemberId: INACTIVE_MEMBER.id,
			amountCents: 250,
			settledAt: null,
		},
	],
};
const activeOnlyExpense: Expense = {
	...expense,
	id: 'fixture-expense-active-only',
	amountCents: 1200,
	description: 'Active-only split',
	splits: [
		{
			id: 'fixture-expense-active-only-first-split',
			debtorMemberId: MEMBER.id,
			amountCents: 1000,
			settledAt: null,
		},
		{
			id: 'fixture-expense-active-only-second-split',
			debtorMemberId: SECOND_ACTIVE_MEMBER.id,
			amountCents: 200,
			settledAt: null,
		},
	],
};

async function openAusgaben(page: import('@playwright/test').Page, expenses: Expense[]) {
	await setupMember(page);
	await page.route(`**/api/wg/${SHARE_CODE}/members`, (route) =>
		route.fulfill({ json: { members: MEMBERS, viewerIsAdmin: false } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/expenses**`, (route) =>
		route.request().method() === 'PATCH'
			? route.fulfill({ json: { expense: expenses[0] ?? expense } })
			: route.fulfill({ json: { expenses, payments: [] } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/recurring-expenses*`, (route) =>
		route.fulfill({ json: { recurringExpenses: [] } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/dashboard`, (route) =>
		route.fulfill({ json: { openShoppingCount: 0, dueChores: [], dueRecurringExpenses: [] } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/chat/unread-count`, (route) =>
		route.fulfill({ json: { count: 0, overflow: false } }),
	);
	await navigateToFeature(page, `/wg/${SHARE_CODE}/ausgaben`);
	await dismissOnboarding(page);
}

test('keeps the payer selectable while creating an expense', async ({ page }) => {
	await openAusgaben(page, []);
	await page.getByRole('button', { name: 'Ausgabe erfassen' }).first().click();
	await expect(page.getByLabel('Bezahlt von')).toBeEnabled();
	await expect(page.getByLabel('Aufteilung: Gleichmäßig')).toBeEnabled();
});

test('preserves historical inactive shares on a description-only edit', async ({ page }) => {
	await openAusgaben(page, [expense]);
	await page.getByRole('button', { name: `Aktionen für ${expense.description}` }).click();
	await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();

	const patchRequest = page.waitForRequest(
		(request) =>
			request.method() === 'PATCH' &&
			request.url().endsWith(`/api/wg/${SHARE_CODE}/expenses/${expense.id}`),
	);
	await page.getByLabel('Beschreibung').fill('Reine Textkorrektur');
	await page.getByRole('button', { name: 'Ausgabe speichern', exact: true }).click();
	const body = (await patchRequest).postDataJSON();
	expect(body.splits).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ debtorMemberId: INACTIVE_MEMBER.id, amountCents: 250 }),
		]),
	);
});

test('locks the payer and preserves departed shares while editing an expense', async ({ page }) => {
	await openAusgaben(page, [expense]);
	await page.getByRole('button', { name: `Aktionen für ${expense.description}` }).click();
	await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();

	await expect(page.getByLabel('Bezahlt von')).toBeDisabled();
	await expect(
		page.getByText('Die zahlende Person kann bei einer bestehenden Ausgabe nicht geändert werden.'),
	).toBeVisible();
	const equalToggle = page.getByLabel('Aufteilung: Gleichmäßig');
	await expect(equalToggle).toBeDisabled();
	await expect(
		page.getByText(
			'Ausgezogene Anteile bleiben unverändert; nur aktive Personen übernehmen den Rest.',
		),
	).toBeVisible();
	const departedShare = page.getByRole('textbox', {
		name: 'Anteil Ben in Euro, ausgezogen. Anteil bleibt unverändert.',
	});
	await expect(departedShare).toBeDisabled();
	await page.getByRole('textbox', { name: `Anteil ${MEMBER.name} in Euro` }).fill('8,00');
	await page.getByRole('button', { name: 'Rest aufteilen', exact: true }).click();

	const patchRequest = page.waitForRequest(
		(request) =>
			request.method() === 'PATCH' &&
			request.url().endsWith(`/api/wg/${SHARE_CODE}/expenses/${expense.id}`),
	);
	await page.getByLabel('Beschreibung').fill('Geänderter Verwendungszweck');
	await page.getByRole('button', { name: 'Ausgabe speichern', exact: true }).click();
	const body = (await patchRequest).postDataJSON();
	expect(body.description).toBe('Geänderter Verwendungszweck');
	expect(body.splits).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ debtorMemberId: INACTIVE_MEMBER.id, amountCents: 250 }),
		]),
	);
});

test('remainder distribution skips inactive members on every persisted edit', async ({ page }) => {
	await openAusgaben(page, [activeOnlyExpense]);
	await page.getByRole('button', { name: `Aktionen für ${activeOnlyExpense.description}` }).click();
	await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
	await page.getByLabel('Betrag').fill('14,00');
	await page.getByRole('button', { name: 'Rest aufteilen', exact: true }).click();

	const patchRequest = page.waitForRequest(
		(request) =>
			request.method() === 'PATCH' &&
			request.url().endsWith(`/api/wg/${SHARE_CODE}/expenses/${activeOnlyExpense.id}`),
	);
	await page.getByLabel('Beschreibung').fill('Aktive Anteile angepasst');
	await page.getByRole('button', { name: 'Ausgabe speichern', exact: true }).click();
	const body = (await patchRequest).postDataJSON();
	expect(
		body.splits.some(
			(split: { debtorMemberId: string }) => split.debtorMemberId === INACTIVE_MEMBER.id,
		),
	).toBe(false);
});
