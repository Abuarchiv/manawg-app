import { expect, test } from '@playwright/test';
import { buildDraftKey } from '../src/core/offline/drafts';
import type {
	Expense,
	RecurringExpense,
} from '../src/features/expenses/components/ausgaben/expense-types';
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
const THIRD_ACTIVE_MEMBER = {
	id: 'fixture-third-active-member',
	name: 'Dana',
	color: null,
	active: true,
};
const MEMBERS = [MEMBER, SECOND_ACTIVE_MEMBER, INACTIVE_MEMBER];
const THREE_ACTIVE_MEMBERS = [MEMBER, SECOND_ACTIVE_MEMBER, THIRD_ACTIVE_MEMBER];
const recurringTemplate: RecurringExpense = {
	id: '55555555-5555-4555-8555-555555555555',
	description: 'Internet',
	amountCents: 3000,
	currency: 'EUR',
	paidByMemberId: MEMBER.id,
	intervalMonths: 1,
	nextDueAt: '2026-10-15T00:00:00.000Z',
	lastCreatedAt: null,
	splits: [
		{ debtorMemberId: MEMBER.id, amountCents: 1500 },
		{ debtorMemberId: SECOND_ACTIVE_MEMBER.id, amountCents: 1500 },
	],
};
const equalRemainderExpense: Expense = {
	id: 'fixture-expense-equal-remainder',
	paidByMemberId: MEMBER.id,
	amountCents: 100,
	currency: 'EUR',
	description: 'Drei Cent-Anteile',
	imageUrl: null,
	occurredAt: '2026-09-25T10:00:00.000Z',
	createdAt: '2026-09-25T10:00:00.000Z',
	updatedAt: '2026-09-25T10:00:00.000Z',
	splits: [
		{ id: 'equal-remainder-a', debtorMemberId: MEMBER.id, amountCents: 34, settledAt: null },
		{
			id: 'equal-remainder-b',
			debtorMemberId: SECOND_ACTIVE_MEMBER.id,
			amountCents: 33,
			settledAt: '2026-09-25T00:00:00.000Z',
		},
		{
			id: 'equal-remainder-c',
			debtorMemberId: THIRD_ACTIVE_MEMBER.id,
			amountCents: 33,
			settledAt: null,
		},
	],
};

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
const unequalManualExpense: Expense = {
	...expense,
	id: 'fixture-expense-unequal-manual',
	amountCents: 1000,
	description: 'Manuelle Verteilung',
	splits: [
		{ id: 'unequal-a', debtorMemberId: MEMBER.id, amountCents: 900, settledAt: null },
		{ id: 'unequal-b', debtorMemberId: SECOND_ACTIVE_MEMBER.id, amountCents: 100, settledAt: null },
	],
};

async function openAusgaben(
	page: import('@playwright/test').Page,
	expenses: Expense[],
	options: {
		members?: typeof MEMBERS;
		recurringExpenses?: RecurringExpense[];
		draft?: Record<string, unknown>;
	} = {},
) {
	const members = options.members ?? MEMBERS;
	const recurringExpenses = options.recurringExpenses ?? [];
	await setupMember(page);
	if (options.draft) {
		await page.addInitScript(({ key, draft }) => localStorage.setItem(key, JSON.stringify(draft)), {
			key: buildDraftKey(SHARE_CODE, FIXTURE_WG.memberId, 'expense'),
			draft: options.draft,
		});
	}
	await page.route(`**/api/wg/${SHARE_CODE}/members`, (route) =>
		route.fulfill({ json: { members, viewerIsAdmin: false } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/expenses**`, (route) =>
		route.request().method() === 'PATCH'
			? route.fulfill({ json: { expense: expenses[0] ?? expense } })
			: route.fulfill({ json: { expenses, payments: [] } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/recurring-expenses*`, (route) =>
		route.request().method() === 'PATCH'
			? route.fulfill({ json: { recurringExpense: recurringExpenses[0] ?? recurringTemplate } })
			: route.fulfill({ json: { recurringExpenses } }),
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

test('description-only edit preserves an equal split cent already settled', async ({ page }) => {
	await openAusgaben(page, [equalRemainderExpense], { members: THREE_ACTIVE_MEMBERS });
	await page
		.getByRole('button', { name: `Aktionen für ${equalRemainderExpense.description}` })
		.click();
	await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
	const patchRequest = page.waitForRequest(
		(request) =>
			request.method() === 'PATCH' &&
			request.url().endsWith(`/api/wg/${SHARE_CODE}/expenses/${equalRemainderExpense.id}`),
	);
	await page.getByLabel('Beschreibung').fill('Drei Cent-Anteile korrigiert');
	await page.getByRole('button', { name: 'Ausgabe speichern', exact: true }).click();

	const body = (await patchRequest).postDataJSON();
	expect(body.splits).toEqual([
		{ debtorMemberId: MEMBER.id, amountCents: 34 },
		{ debtorMemberId: SECOND_ACTIVE_MEMBER.id, amountCents: 33 },
		{ debtorMemberId: THIRD_ACTIVE_MEMBER.id, amountCents: 33 },
	]);
});

test('switching an unequal manual split to equal applies equal shares', async ({ page }) => {
	await openAusgaben(page, [unequalManualExpense]);
	await page
		.getByRole('button', { name: `Aktionen für ${unequalManualExpense.description}` })
		.click();
	await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
	await page.getByLabel('Aufteilung: Gleichmäßig').click();
	const patchRequest = page.waitForRequest(
		(request) =>
			request.method() === 'PATCH' &&
			request.url().endsWith(`/api/wg/${SHARE_CODE}/expenses/${unequalManualExpense.id}`),
	);
	await page.getByLabel('Beschreibung').fill('Gleich verteilt');
	await page.getByRole('button', { name: 'Ausgabe speichern', exact: true }).click();

	const body = (await patchRequest).postDataJSON();
	expect(body.splits).toEqual(
		expect.arrayContaining([
			{ debtorMemberId: MEMBER.id, amountCents: 500 },
			{ debtorMemberId: SECOND_ACTIVE_MEMBER.id, amountCents: 500 },
		]),
	);
});

test('recurring template draft reloads in edit mode and updates the same template', async ({
	page,
}) => {
	await openAusgaben(page, [], { recurringExpenses: [recurringTemplate] });
	await page.getByRole('button', { name: /Wiederkehrende Kosten/ }).click();
	await page
		.getByRole('button', { name: `Fixkosten-Aktionen: ${recurringTemplate.description}` })
		.click();
	await page
		.getByRole('menuitem', {
			name: `Fixkosten-Vorlage bearbeiten: ${recurringTemplate.description}`,
		})
		.click();
	await page.getByLabel('Beschreibung').fill('Internet korrigiert');
	const draftKey = buildDraftKey(SHARE_CODE, FIXTURE_WG.memberId, 'expense');
	await expect
		.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), draftKey))
		.toMatchObject({ editingRecurringExpenseId: recurringTemplate.id });

	await page.reload();
	await expect(page.getByText('Fixkosten-Vorlage bearbeiten', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Beschreibung')).toHaveValue('Internet korrigiert');
	const forbiddenCreates: string[] = [];
	page.on('request', (request) => {
		if (
			request.method() === 'POST' &&
			(request.url().endsWith(`/api/wg/${SHARE_CODE}/expenses`) ||
				request.url().endsWith(`/api/wg/${SHARE_CODE}/recurring-expenses`))
		) {
			forbiddenCreates.push(request.url());
		}
	});
	const patchRequest = page.waitForRequest(
		(request) =>
			request.method() === 'PATCH' &&
			request.url().endsWith(`/api/wg/${SHARE_CODE}/recurring-expenses`),
	);
	await page.getByRole('button', { name: 'Fixkosten-Vorlage speichern', exact: true }).click();
	const body = (await patchRequest).postDataJSON();
	expect(body.id).toBe(recurringTemplate.id);
	expect(body.description).toBe('Internet korrigiert');
	expect(forbiddenCreates).toEqual([]);
});

test('malformed recurring edit metadata blocks creating a new expense', async ({ page }) => {
	await openAusgaben(page, [], {
		draft: {
			description: 'Entwurf mit kaputter Zuordnung',
			amountStr: '12,00',
			paidByMemberId: MEMBER.id,
			splitMode: 'equal',
			editingExpense: null,
			editingRecurringExpenseId: 42,
		},
	});
	const writes: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().includes(`/api/wg/${SHARE_CODE}/expenses`)) {
			writes.push(request.url());
		}
	});
	await page.getByRole('button', { name: 'Ausgabe speichern', exact: true }).click();
	await expect(page.getByText(/Zuordnung dieses Entwurfs ist beschädigt/)).toBeVisible();
	expect(writes).toEqual([]);
});

test('a draft for a missing recurring template does not fall back to expense creation', async ({
	page,
}) => {
	await openAusgaben(page, [], {
		draft: {
			description: 'Entwurf für gelöschte Vorlage',
			amountStr: '12,00',
			paidByMemberId: MEMBER.id,
			splitMode: 'equal',
			editingExpense: null,
			editingRecurringExpenseId: '99999999-9999-4999-8999-999999999999',
		},
	});
	const writes: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().includes(`/api/wg/${SHARE_CODE}/expenses`)) {
			writes.push(request.url());
		}
	});
	await page.getByRole('button', { name: 'Ausgabe speichern', exact: true }).click();
	await expect(page.getByText(/Zuordnung dieses Entwurfs/)).toBeVisible();
	expect(writes).toEqual([]);
});

test('starting an ordinary expense edit clears a recurring template edit', async ({ page }) => {
	await openAusgaben(page, [expense], { recurringExpenses: [recurringTemplate] });
	await page.getByRole('button', { name: /Wiederkehrende Kosten/ }).click();
	await page
		.getByRole('button', { name: `Fixkosten-Aktionen: ${recurringTemplate.description}` })
		.click();
	await page
		.getByRole('menuitem', {
			name: `Fixkosten-Vorlage bearbeiten: ${recurringTemplate.description}`,
		})
		.click();
	await expect(page.getByText('Fixkosten-Vorlage bearbeiten', { exact: true })).toBeVisible();
	await page.getByLabel('Beschreibung').fill('Internet korrigiert');
	await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Entwurf behalten?' })).toBeVisible();
	await page.getByRole('button', { name: 'Entwurf behalten', exact: true }).click();
	await page.getByRole('button', { name: `Aktionen für ${expense.description}` }).click();
	await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
	await expect(page.getByText('Ausgabe bearbeiten', { exact: true })).toBeVisible();
	await expect(page.getByText('Fixkosten-Vorlage bearbeiten', { exact: true })).toBeHidden();
});
