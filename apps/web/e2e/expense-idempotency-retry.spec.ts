import { type Page, type Route, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const API = `/api/wg/${FIXTURE_WG.shareCode}`;
const createdAt = '2026-09-25T10:00:00.000Z';

function expense(id: string, description: string) {
	return {
		id,
		paidByMemberId: FIXTURE_WG.memberId,
		amountCents: 1234,
		currency: 'EUR',
		description,
		imageUrl: null,
		occurredAt: createdAt,
		createdAt,
		updatedAt: createdAt,
		splits: [],
	};
}

function recurringExpense(
	overrides: Partial<{
		id: string;
		description: string;
		amountCents: number;
		nextDueAt: string;
	}> = {},
) {
	return {
		id: 'recurring-rent',
		description: 'Miete',
		amountCents: 1234,
		currency: 'EUR',
		paidByMemberId: FIXTURE_WG.memberId,
		intervalMonths: 1,
		nextDueAt: '2020-01-01T00:00:00.000Z',
		lastCreatedAt: null,
		splits: [{ debtorMemberId: FIXTURE_WG.memberId, amountCents: 1234 }],
		...overrides,
	};
}

type RequestAttempt = { key: string | null; body: unknown };

async function mockReads(
	page: Page,
	recurring: ReturnType<typeof recurringExpense>[] = [],
	readExpenses: () => ReturnType<typeof expense>[] = () => [],
	readRecurring: () => ReturnType<typeof recurringExpense>[] = () => recurring,
): Promise<void> {
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() === 'GET') {
			return route.fulfill({ json: { expenses: readExpenses(), payments: [] } });
		}
		return route.fallback();
	});
	await page.route(`**${API}/recurring-expenses`, async (route) => {
		if (route.request().method() === 'GET') {
			return route.fulfill({ json: { recurringExpenses: readRecurring() } });
		}
		if (route.request().method() === 'PATCH') {
			return route.fulfill({
				json: {
					recurringExpense: recurringExpense({ nextDueAt: '2026-10-01T00:00:00.000Z' }),
				},
			});
		}
		return route.fallback();
	});
}

function recordAttempt(route: Route): RequestAttempt {
	const request = route.request();
	return {
		key: request.headers()['idempotency-key'] ?? null,
		body: request.postDataJSON(),
	};
}

test('expense retries keep the key for the same payload and change it when the payload changes', async ({
	page,
}) => {
	await setupMember(page);
	let serverCommitted = false;
	await mockReads(page, [], () =>
		serverCommitted ? [expense('committed-expense', 'Wocheneinkauf')] : [],
	);
	const attempts: RequestAttempt[] = [];
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		attempts.push(recordAttempt(route));
		if (attempts.length === 1) serverCommitted = true;
		if (attempts.length < 3) {
			return route.fulfill({ status: 500, json: { error: 'temporarily_unavailable' } });
		}
		return route.fulfill({
			json: { expense: expense('created-expense', 'Neue Beschreibung'), warning: null },
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?new=1`);
	await dismissOnboarding(page);
	const form = page.getByRole('dialog');
	await form.getByLabel('Beschreibung').fill('Wocheneinkauf');
	await form.getByLabel('Betrag').fill('12,35');
	const submit = form.getByRole('button', { name: 'Ausgabe speichern' });

	await submit.click();
	await expect.poll(() => attempts.length).toBe(1);
	await expect(form).toBeVisible();
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(page.getByText('1 Eintrag', { exact: true })).toBeVisible();
	await submit.click();
	await expect.poll(() => attempts.length).toBe(2);
	await expect(form).toBeVisible();
	await form.getByLabel('Beschreibung').fill('Neue Beschreibung');
	await submit.click();
	await expect.poll(() => attempts.length).toBe(3);

	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts[1]?.key).toBe(attempts[0]?.key);
	expect(attempts[1]?.body).toEqual(attempts[0]?.body);
	expect(attempts[2]?.key).not.toBe(attempts[1]?.key);
});

test('discarding an ambiguous expense starts a new request key for identical form data', async ({
	page,
}) => {
	await setupMember(page);
	await mockReads(page);
	const attempts: RequestAttempt[] = [];
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		attempts.push(recordAttempt(route));
		if (attempts.length === 1) {
			return route.fulfill({ status: 500, json: { error: 'temporarily_unavailable' } });
		}
		return route.fulfill({
			json: { expense: expense('new-expense', 'Wocheneinkauf'), warning: null },
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?new=1`);
	await dismissOnboarding(page);
	const form = page.getByRole('dialog');
	await form.getByLabel('Beschreibung').fill('Wocheneinkauf');
	await form.getByLabel('Betrag').fill('12,35');
	await form.getByRole('button', { name: 'Ausgabe speichern' }).click();
	await expect.poll(() => attempts.length).toBe(1);
	await form.getByRole('button', { name: 'Ausgabe abbrechen' }).click();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Entwurf verwerfen' }).click();
	await expect(form).toBeHidden();
	await page
		.getByRole('toolbar', { name: 'Ausgaben-Aktionen' })
		.getByRole('button', { name: 'Ausgabe erfassen' })
		.click();

	const newForm = page.getByRole('dialog');
	await newForm.getByLabel('Beschreibung').fill('Wocheneinkauf');
	await newForm.getByLabel('Betrag').fill('12,35');
	await newForm.getByRole('button', { name: 'Ausgabe speichern' }).click();
	await expect.poll(() => attempts.length).toBe(2);

	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts[1]?.key).not.toBe(attempts[0]?.key);
});

test('recurring template retries preserve key, due date, and splits after refreshed data', async ({
	page,
}) => {
	await setupMember(page);
	let serverCommitted = false;
	let committedTemplate: ReturnType<typeof recurringExpense> | null = null;
	await mockReads(
		page,
		[],
		() => (serverCommitted ? [expense('committed-expense', 'Strom')] : []),
		() => (committedTemplate ? [committedTemplate] : []),
	);
	const attempts: RequestAttempt[] = [];
	await page.route(`**${API}/recurring-expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		const attempt = recordAttempt(route);
		attempts.push(attempt);
		if (attempts.length === 1) {
			serverCommitted = true;
			const body = attempt.body as { nextDueAt: string };
			committedTemplate = recurringExpense({
				description: 'Internet',
				amountCents: 1235,
				nextDueAt: body.nextDueAt,
			});
			return route.fulfill({ status: 500, json: { error: 'temporarily_unavailable' } });
		}
		return route.fulfill({
			json: { recurringExpense: recurringExpense({ description: 'Internet' }) },
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?new=1&filter=recurring`);
	await dismissOnboarding(page);
	const form = page.getByRole('dialog');
	await form.getByLabel('Beschreibung').fill('Internet');
	await form.getByLabel('Betrag').fill('12,35');
	await form.getByRole('button', { name: /Fixkosten-Vorlage/ }).click();
	const saveTemplate = form.getByRole('button', { name: 'Als Vorlage merken' });
	await saveTemplate.click();
	await expect.poll(() => attempts.length).toBe(1);
	await expect(form).toBeVisible();
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(page.getByText('1 Eintrag', { exact: true })).toBeVisible();
	await saveTemplate.click();
	await expect.poll(() => attempts.length).toBe(2);
	await expect(saveTemplate).toBeEnabled();
	await expect(page.locator('[id="recurring-recurring-rent"]')).toHaveCount(1);

	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts[1]?.key).toBe(attempts[0]?.key);
	expect(attempts[1]?.body).toEqual(attempts[0]?.body);
	await saveTemplate.click();
	await expect.poll(() => attempts.length).toBe(3);
	expect(attempts[2]?.key).not.toBe(attempts[1]?.key);
});

test('creating an expense from a recurring template reuses its key after a server error', async ({
	page,
}) => {
	await setupMember(page);
	await mockReads(page, [recurringExpense()]);
	const attempts: RequestAttempt[] = [];
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		attempts.push(recordAttempt(route));
		if (attempts.length === 1) {
			return route.fulfill({ status: 500, json: { error: 'temporarily_unavailable' } });
		}
		return route.fulfill({
			json: { expense: expense('created-recurring-expense', 'Miete'), warning: null },
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?filter=recurring`);
	await dismissOnboarding(page);
	const create = page.getByRole('button', { name: 'Fixkosten-Ausgabe direkt erstellen: Miete' });
	await create.click();
	await expect.poll(() => attempts.length).toBe(1);
	await expect(create).toBeVisible();
	await create.click();
	await expect.poll(() => attempts.length).toBe(2);

	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts[1]?.key).toBe(attempts[0]?.key);
});
