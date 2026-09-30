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

function normalizeExpenseCreateBody(body: unknown): unknown {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
	const payload = body as Record<string, unknown>;
	// The expense API accepts missing or null imageUrl and stores both as null.
	return { ...payload, imageUrl: payload.imageUrl ?? null };
}

async function queuedRecurringExpenseCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		const queue = JSON.parse(localStorage.getItem('manawg:offline-actions') ?? '[]');
		return queue.filter(
			(action: {
				type?: string;
				payload?: { recurringExpenseId?: string; expectedRecurringNextDueAt?: string };
			}) =>
				action.type === 'expense.create' &&
				action.payload?.recurringExpenseId === 'recurring-rent' &&
				action.payload.expectedRecurringNextDueAt === '2020-01-01T00:00:00.000Z',
		).length;
	});
}

async function queuedActionCount(page: Page, type: string): Promise<number> {
	return page.evaluate((actionType) => {
		const queue = JSON.parse(localStorage.getItem('manawg:offline-actions') ?? '[]');
		return queue.filter((action: { type?: string }) => action.type === actionType).length;
	}, type);
}

const OFFLINE_RETRY_ERROR =
	'Noch keine Verbindung: Die Aktion bleibt gespeichert und wird erneut versucht, sobald das Netz zurück ist.';

type QueuedRetryState = {
	idempotencyKey: string | null;
	attempts: number;
	lastAttemptAt: string | null;
	lastError: string | null;
};

async function queuedRetryState(page: Page, type: string): Promise<QueuedRetryState | null> {
	return page.evaluate((actionType) => {
		const queue = JSON.parse(localStorage.getItem('manawg:offline-actions') ?? '[]');
		const action = queue.find((entry: { type?: string }) => entry.type === actionType);
		if (!action) return null;
		return {
			idempotencyKey: action.idempotencyKey ?? null,
			attempts: action.attempts ?? 0,
			lastAttemptAt: action.lastAttemptAt ?? null,
			lastError: action.lastError ?? null,
		};
	}, type);
}

async function expectOfflineAutoSyncBackoff(
	page: Page,
	type: string,
	blockedAttempts: RequestAttempt[],
	originalKey: string | null,
): Promise<void> {
	await expect.poll(() => blockedAttempts.length).toBeGreaterThan(0);
	await expect
		.poll(async () => {
			const state = await queuedRetryState(page, type);
			return Boolean(
				state &&
					state.idempotencyKey === originalKey &&
					state.attempts > 0 &&
					state.lastAttemptAt &&
					state.lastError === OFFLINE_RETRY_ERROR,
			);
		})
		.toBe(true);
	expect(blockedAttempts.every((attempt) => attempt.key === originalKey)).toBe(true);
}

async function sendQueueIfStillPending(
	page: Page,
	countQueued: () => Promise<number>,
): Promise<void> {
	const sendButton = page.getByRole('button', { name: 'Offline-Aktionen jetzt senden' }).first();
	await page.evaluate(() => {
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
		window.dispatchEvent(new Event('online'));
	});
	await expect
		.poll(async () => (await countQueued()) === 0 || sendButton.isVisible().catch(() => false))
		.toBe(true);
	if ((await countQueued()) > 0) {
		await expect(sendButton).toBeVisible();
		await sendButton.click();
	}
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
	expect(attempts[0]?.body).not.toHaveProperty('recurringExpenseId');
	expect(attempts[0]?.body).not.toHaveProperty('expectedRecurringNextDueAt');
	expect(attempts[2]?.key).not.toBe(attempts[1]?.key);
});

test('an ambiguously acknowledged expense replays its queued request with the original key', async ({
	page,
}) => {
	await setupMember(page);
	let committedExpense: ReturnType<typeof expense> | null = null;
	await mockReads(page, [], () => (committedExpense ? [committedExpense] : []));
	const attempts: RequestAttempt[] = [];
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		const attempt = recordAttempt(route);
		attempts.push(attempt);
		if (!committedExpense) {
			committedExpense = expense('created-expense', 'Wocheneinkauf');
			await page.evaluate(() => {
				Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
			});
			return route.fulfill({
				status: 200,
				headers: { 'content-type': 'application/json' },
				body: '{"expense":',
			});
		}
		return route.fulfill({ json: { expense: committedExpense, warning: null } });
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?new=1`);
	await dismissOnboarding(page);
	const form = page.getByRole('dialog');
	await form.getByLabel('Beschreibung').fill('Wocheneinkauf');
	await form.getByLabel('Betrag').fill('12,35');
	await form.getByRole('button', { name: 'Ausgabe speichern' }).click();
	await expect.poll(() => attempts.length).toBe(1);
	await expect(form).toBeHidden();
	await expect.poll(() => queuedActionCount(page, 'expense.create')).toBe(1);

	const replayPage = await page.context().newPage();
	await replayPage.addInitScript(() => {
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
	});
	await mockReads(replayPage, [], () => (committedExpense ? [committedExpense] : []));
	let replayEnabled = false;
	const blockedAttempts: RequestAttempt[] = [];
	await replayPage.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		if (!replayEnabled) {
			blockedAttempts.push(recordAttempt(route));
			return route.abort();
		}
		attempts.push(recordAttempt(route));
		return route.fulfill({
			json: {
				expense: committedExpense ?? expense('created-expense', 'Wocheneinkauf'),
				warning: null,
			},
		});
	});
	await replayPage.goto(`/wg/${FIXTURE_WG.shareCode}/ausgaben`);
	await dismissOnboarding(replayPage);
	await expect.poll(() => queuedActionCount(replayPage, 'expense.create')).toBe(1);
	await expectOfflineAutoSyncBackoff(
		replayPage,
		'expense.create',
		blockedAttempts,
		attempts[0]?.key ?? null,
	);
	await expect(replayPage.locator('[data-offline-banner]')).toContainText(
		'Offline. 1 Aktion wartet.',
	);
	replayEnabled = true;
	await sendQueueIfStillPending(replayPage, () => queuedActionCount(replayPage, 'expense.create'));
	await expect.poll(() => attempts.length).toBe(2);
	await expect.poll(() => queuedActionCount(replayPage, 'expense.create')).toBe(0);
	expect(attempts).toHaveLength(2);

	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts[1]?.key).toBe(attempts[0]?.key);
	expect(normalizeExpenseCreateBody(attempts[1]?.body)).toEqual(
		normalizeExpenseCreateBody(attempts[0]?.body),
	);
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
		.locator('[data-page-primary-action]')
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
			await page.evaluate(() => {
				Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
			});
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

test('malformed recurring-template success queues once across split rotation, draft restore, and replay', async ({
	page,
}) => {
	await setupMember(page);
	const members = [
		{ id: FIXTURE_WG.memberId, name: 'Alexandra Beispiel', color: null, active: true },
		{ id: FIXTURE_WG.id, name: 'Max Mustermann', color: null, active: true },
	];
	await page.route(`**${API}/members`, (route) =>
		route.fulfill({ json: { members, viewerIsAdmin: false } }),
	);

	let serverCommitted = false;
	let committedTemplate: ReturnType<typeof recurringExpense> | null = null;
	const concurrentExpense = expense('committed-expense', 'Bürobedarf');
	await mockReads(
		page,
		[],
		() => (serverCommitted ? [concurrentExpense] : []),
		() => (committedTemplate ? [committedTemplate] : []),
	);
	const attempts: RequestAttempt[] = [];
	await page.route(`**${API}/recurring-expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		const attempt = recordAttempt(route);
		attempts.push(attempt);
		if (attempts.length === 1) {
			serverCommitted = true;
			await page.evaluate(() => {
				Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
			});
			const body = attempt.body as {
				description: string;
				amountCents: number;
				nextDueAt: string;
				splits: Array<{ debtorMemberId: string; amountCents: number }>;
			};
			committedTemplate = {
				...recurringExpense({
					description: body.description,
					amountCents: body.amountCents,
					nextDueAt: body.nextDueAt,
				}),
				splits: body.splits,
			};
			return route.fulfill({
				status: 200,
				headers: { 'content-type': 'application/json' },
				body: '{"recurringExpense":',
			});
		}
		return route.fulfill({
			json: {
				recurringExpense: committedTemplate ?? recurringExpense({ description: 'Internet' }),
			},
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?new=1&filter=recurring`);
	await dismissOnboarding(page);
	const form = page.getByRole('dialog');
	await form.getByLabel('Beschreibung').fill('Internet');
	await form.getByLabel('Betrag').fill('12,01');
	await form.getByRole('button', { name: /Fixkosten-Vorlage/ }).click();
	const saveTemplate = form.getByRole('button', { name: 'Als Vorlage merken' });

	await saveTemplate.click();
	await expect.poll(() => attempts.length).toBe(1);
	await expect(form).toBeVisible();
	await expect.poll(() => queuedActionCount(page, 'recurring.create')).toBe(1);

	const originalBody = attempts[0]?.body as {
		amountCents: number;
		splits: Array<{ debtorMemberId: string; amountCents: number }>;
	};
	expect(originalBody.amountCents).toBe(1201);
	expect(originalBody.splits.map((split) => split.amountCents).sort()).toEqual([600, 601]);
	expect(originalBody.splits.map((split) => split.debtorMemberId)).toEqual([
		FIXTURE_WG.memberId,
		FIXTURE_WG.id,
	]);

	await saveTemplate.click();
	await expect(page.getByText(/Fixkosten-Vorlage ist bereits offline vorgemerkt/)).toBeVisible();
	await expect.poll(() => queuedActionCount(page, 'recurring.create')).toBe(1);
	expect(attempts).toHaveLength(1);

	const restoredPage = await page.context().newPage();
	await restoredPage.addInitScript(() => {
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
	});
	await mockReads(
		restoredPage,
		[],
		() => [concurrentExpense],
		() => (committedTemplate ? [committedTemplate] : []),
	);
	await restoredPage.route(`**${API}/members`, (route) =>
		route.fulfill({ json: { members, viewerIsAdmin: false } }),
	);
	await restoredPage.route(`**${API}/shopping`, (route) =>
		route.request().method() === 'GET' ? route.fulfill({ json: { items: [] } }) : route.fallback(),
	);
	await restoredPage.route(`**${API}/inventory`, (route) => route.fulfill({ json: { items: [] } }));
	let replayEnabled = false;
	const blockedAttempts: RequestAttempt[] = [];
	await restoredPage.route(`**${API}/recurring-expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		if (!replayEnabled) {
			blockedAttempts.push(recordAttempt(route));
			return route.abort();
		}
		attempts.push(recordAttempt(route));
		return route.fulfill({
			json: {
				recurringExpense: committedTemplate ?? recurringExpense({ description: 'Internet' }),
			},
		});
	});
	await navigateToFeature(restoredPage, `/wg/${FIXTURE_WG.shareCode}/ausgaben?filter=recurring`);
	await dismissOnboarding(restoredPage);
	const restoredForm = restoredPage.getByRole('dialog');
	await expect(restoredForm).toBeVisible();
	await expect(restoredForm.getByLabel('Beschreibung')).toHaveValue('Internet');
	await expect(restoredForm.getByLabel('Betrag')).toHaveValue('12,01');
	await expectOfflineAutoSyncBackoff(
		restoredPage,
		'recurring.create',
		blockedAttempts,
		attempts[0]?.key ?? null,
	);
	const blockedAttemptCountBeforeClick = blockedAttempts.length;
	await restoredForm.getByRole('button', { name: /Fixkosten-Vorlage/ }).click();
	await restoredForm.getByRole('button', { name: 'Als Vorlage merken' }).click();
	await expect(
		restoredPage.getByText(/Fixkosten-Vorlage ist bereits offline vorgemerkt/),
	).toBeVisible();
	await expect.poll(() => queuedActionCount(restoredPage, 'recurring.create')).toBe(1);
	expect(
		blockedAttempts
			.slice(blockedAttemptCountBeforeClick)
			.every((attempt) => attempt.key === attempts[0]?.key),
	).toBe(true);
	expect(attempts).toHaveLength(1);

	await navigateToFeature(restoredPage, `/wg/${FIXTURE_WG.shareCode}/einkauf`);
	await expect.poll(() => queuedActionCount(restoredPage, 'recurring.create')).toBe(1);
	await expect(restoredPage.locator('[data-offline-banner]')).toContainText(
		'Offline. 1 Aktion wartet.',
	);
	replayEnabled = true;
	await sendQueueIfStillPending(restoredPage, () =>
		queuedActionCount(restoredPage, 'recurring.create'),
	);
	await expect.poll(() => attempts.length).toBe(2);
	await expect.poll(() => queuedActionCount(restoredPage, 'recurring.create')).toBe(0);
	expect(attempts).toHaveLength(2);

	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts[1]?.key).toBe(attempts[0]?.key);
	expect(attempts[1]?.body).toEqual(attempts[0]?.body);
});

test('creating an expense from a recurring template reuses its key after a server error', async ({
	page,
}) => {
	await setupMember(page);
	const expectedRecurringNextDueAt = '2026-09-01T00:00:00.000Z';
	let currentTemplate = recurringExpense({ nextDueAt: expectedRecurringNextDueAt });
	let serverCommitted = false;
	let refreshedTemplate = false;
	await mockReads(
		page,
		[currentTemplate],
		() => (serverCommitted ? [expense('committed-recurring-expense', 'Miete')] : []),
		() => {
			if (serverCommitted) refreshedTemplate = true;
			return [currentTemplate];
		},
	);
	const attempts: RequestAttempt[] = [];
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		attempts.push(recordAttempt(route));
		if (attempts.length === 1) {
			serverCommitted = true;
			currentTemplate = recurringExpense({ nextDueAt: '2026-09-24T00:00:00.000Z' });
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
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect.poll(() => refreshedTemplate).toBe(true);
	await expect(create).toBeVisible();
	await create.click();
	await expect.poll(() => attempts.length).toBe(2);

	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts[1]?.key).toBe(attempts[0]?.key);
	expect(attempts[0]?.body).toMatchObject({
		recurringExpenseId: 'recurring-rent',
		expectedRecurringNextDueAt,
	});
	expect(attempts[1]?.body).toEqual(attempts[0]?.body);
});

test('a malformed recurring-expense success replays the queued request with its original key', async ({
	page,
}) => {
	await setupMember(page);
	const expectedRecurringNextDueAt = '2020-01-01T00:00:00.000Z';
	const currentTemplate = recurringExpense({ nextDueAt: expectedRecurringNextDueAt });
	let committedExpense: ReturnType<typeof expense> | null = null;
	await mockReads(
		page,
		[currentTemplate],
		() => (committedExpense ? [committedExpense] : []),
		() => [currentTemplate],
	);
	const attempts: RequestAttempt[] = [];
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		const attempt = recordAttempt(route);
		attempts.push(attempt);
		if (attempts.length === 1) {
			committedExpense = expense('created-recurring-expense', 'Miete');
			await page.evaluate(() => {
				Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
			});
			return route.fulfill({
				status: 200,
				headers: { 'content-type': 'application/json' },
				body: '{"expense":',
			});
		}
		return route.fulfill({
			json: {
				expense: committedExpense ?? expense('created-recurring-expense', 'Miete'),
				warning: null,
			},
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?filter=recurring`);
	await dismissOnboarding(page);
	const create = page.getByRole('button', { name: 'Fixkosten-Ausgabe direkt erstellen: Miete' });

	await create.click();
	await expect.poll(() => attempts.length).toBe(1);
	await expect.poll(() => queuedRecurringExpenseCount(page)).toBe(1);
	await create.click();
	await expect(
		page.getByText(
			'Fixkosten-Ausgabe offline vorgemerkt. Die Vorlage bleibt bis zur Synchronisierung unverändert.',
		),
	).toBeVisible();
	await expect.poll(() => queuedRecurringExpenseCount(page)).toBe(1);
	expect(attempts).toHaveLength(1);

	const replayPage = await page.context().newPage();
	await replayPage.addInitScript(() => {
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
	});
	await mockReads(
		replayPage,
		[currentTemplate],
		() => (committedExpense ? [committedExpense] : []),
		() => [currentTemplate],
	);
	let replayEnabled = false;
	const blockedAttempts: RequestAttempt[] = [];
	await replayPage.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		if (!replayEnabled) {
			blockedAttempts.push(recordAttempt(route));
			return route.abort();
		}
		attempts.push(recordAttempt(route));
		return route.fulfill({
			json: {
				expense: committedExpense ?? expense('created-recurring-expense', 'Miete'),
				warning: null,
			},
		});
	});
	await navigateToFeature(replayPage, `/wg/${FIXTURE_WG.shareCode}/ausgaben?filter=recurring`);
	await dismissOnboarding(replayPage);
	await expect.poll(() => queuedRecurringExpenseCount(replayPage)).toBe(1);
	await expectOfflineAutoSyncBackoff(
		replayPage,
		'expense.create',
		blockedAttempts,
		attempts[0]?.key ?? null,
	);
	await expect(replayPage.locator('[data-offline-banner]')).toContainText(
		'Offline. 1 Aktion wartet.',
	);

	replayEnabled = true;
	await sendQueueIfStillPending(replayPage, () => queuedRecurringExpenseCount(replayPage));
	await expect.poll(() => attempts.length).toBe(2);
	await expect.poll(() => queuedRecurringExpenseCount(replayPage)).toBe(0);
	expect(attempts).toHaveLength(2);

	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts[1]?.key).toBe(attempts[0]?.key);
	expect(attempts[0]?.body).toMatchObject({
		recurringExpenseId: 'recurring-rent',
		expectedRecurringNextDueAt,
	});
	expect(attempts[1]?.body).toEqual(attempts[0]?.body);
});

test('recurring-source form retries keep the original due date and POST body', async ({ page }) => {
	await setupMember(page);
	const expectedRecurringNextDueAt = '2026-09-01T00:00:00.000Z';
	let currentTemplate = recurringExpense({ nextDueAt: expectedRecurringNextDueAt });
	let serverCommitted = false;
	let refreshedTemplate = false;
	await mockReads(
		page,
		[currentTemplate],
		() => (serverCommitted ? [expense('committed-recurring-expense', 'Miete')] : []),
		() => {
			if (serverCommitted) refreshedTemplate = true;
			return [currentTemplate];
		},
	);
	const attempts: RequestAttempt[] = [];
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		attempts.push(recordAttempt(route));
		if (attempts.length === 1) {
			serverCommitted = true;
			currentTemplate = recurringExpense({ nextDueAt: '2026-09-24T00:00:00.000Z' });
			return route.fulfill({ status: 500, json: { error: 'temporarily_unavailable' } });
		}
		return route.fulfill({
			json: { expense: expense('created-recurring-expense', 'Miete'), warning: null },
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?recurring=recurring-rent`);
	await dismissOnboarding(page);
	const form = page.getByRole('dialog');
	const save = form.getByRole('button', { name: 'Ausgabe speichern' });
	await save.click();
	await expect.poll(() => attempts.length).toBe(1);
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect.poll(() => refreshedTemplate).toBe(true);
	await save.click();
	await expect.poll(() => attempts.length).toBe(2);

	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts[1]?.key).toBe(attempts[0]?.key);
	expect(attempts[0]?.body).toMatchObject({
		recurringExpenseId: 'recurring-rent',
		expectedRecurringNextDueAt,
	});
	expect(attempts[1]?.body).toEqual(attempts[0]?.body);
});

test('recurring template retries keep separate keys when requests are interleaved', async ({
	page,
}) => {
	await setupMember(page);
	await mockReads(page, [
		recurringExpense({ id: 'recurring-rent', description: 'Miete' }),
		recurringExpense({ id: 'recurring-internet', description: 'Internet' }),
	]);
	const attempts: RequestAttempt[] = [];
	const releaseResponses: Array<() => void> = [];
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		attempts.push(recordAttempt(route));
		await new Promise<void>((resolve) => releaseResponses.push(resolve));
		return route.fulfill({ status: 500, json: { error: 'temporarily_unavailable' } });
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?filter=recurring`);
	await dismissOnboarding(page);
	const rent = page.getByRole('button', { name: 'Fixkosten-Ausgabe direkt erstellen: Miete' });
	const internet = page.getByRole('button', {
		name: 'Fixkosten-Ausgabe direkt erstellen: Internet',
	});
	try {
		for (const [index, button] of [rent, internet, rent].entries()) {
			// Keep WebKit's smooth scrolling from moving the target during the click.
			await button.evaluate((element) =>
				element.scrollIntoView({ block: 'center', behavior: 'instant' }),
			);
			await button.click();
			await expect.poll(() => attempts.length).toBe(index + 1);
			await expect(rent).toBeDisabled();
			await expect(internet).toBeDisabled();
			releaseResponses[index]?.();
			await expect(rent).toBeEnabled();
			await expect(internet).toBeEnabled();
		}
	} finally {
		for (const release of releaseResponses) release();
	}

	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts[1]?.key).not.toBe(attempts[0]?.key);
	expect(attempts[2]?.key).toBe(attempts[0]?.key);
	expect(attempts[2]?.body).toEqual(attempts[0]?.body);
});

test('recurring expense retry keeps its key until template advance succeeds', async ({ page }) => {
	await setupMember(page);
	let serverCommitted = false;
	const committedExpense = expense('committed-recurring-expense', 'Miete');
	await mockReads(page, [recurringExpense()], () => (serverCommitted ? [committedExpense] : []));
	const attempts: RequestAttempt[] = [];
	let advanceAttempts = 0;
	await page.route(`**${API}/recurring-expenses`, async (route) => {
		if (route.request().method() !== 'PATCH') return route.fallback();
		advanceAttempts += 1;
		if (advanceAttempts === 1) {
			return route.fulfill({ status: 500, json: { error: 'temporarily_unavailable' } });
		}
		return route.fulfill({
			json: { recurringExpense: recurringExpense({ nextDueAt: '2026-10-01T00:00:00.000Z' }) },
		});
	});
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		attempts.push(recordAttempt(route));
		serverCommitted = true;
		return route.fulfill({ json: { expense: committedExpense, warning: null } });
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?filter=recurring`);
	await dismissOnboarding(page);
	const create = page.getByRole('button', { name: 'Fixkosten-Ausgabe direkt erstellen: Miete' });
	await create.click();
	await expect.poll(() => attempts.length).toBe(1);
	await expect.poll(() => advanceAttempts).toBe(1);
	await expect(create).toBeEnabled();
	await create.click();
	await expect.poll(() => attempts.length).toBe(2);
	await expect.poll(() => advanceAttempts).toBe(2);

	expect(attempts[0]?.key).toBeTruthy();
	expect(attempts[1]?.key).toBe(attempts[0]?.key);
	await expect(page.locator('#expense-committed-recurring-expense')).toHaveCount(1);
});

test('an already-advanced period gets a new key and due date on the next create', async ({
	page,
}) => {
	await setupMember(page);
	const originalDueAt = '2026-09-01T00:00:00.000Z';
	const advancedDueAt = '2026-09-24T00:00:00.000Z';
	let currentTemplate = recurringExpense({ nextDueAt: originalDueAt });
	let serverCommitted = false;
	let refreshedAdvancedTemplate = false;
	await mockReads(
		page,
		[currentTemplate],
		() => (serverCommitted ? [expense('prior-period-expense', 'Miete')] : []),
		() => {
			if (currentTemplate.nextDueAt === advancedDueAt) refreshedAdvancedTemplate = true;
			return [currentTemplate];
		},
	);
	const postAttempts: RequestAttempt[] = [];
	const advanceAttempts: RequestAttempt[] = [];
	await page.route(`**${API}/recurring-expenses`, async (route) => {
		if (route.request().method() !== 'PATCH') return route.fallback();
		advanceAttempts.push(recordAttempt(route));
		if (advanceAttempts.length === 1) {
			currentTemplate = recurringExpense({ nextDueAt: advancedDueAt });
			return route.fulfill({
				status: 409,
				json: { error: 'recurring_expense_already_advanced' },
			});
		}
		currentTemplate = recurringExpense({ nextDueAt: '2026-10-24T00:00:00.000Z' });
		return route.fulfill({ json: { recurringExpense: currentTemplate } });
	});
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		postAttempts.push(recordAttempt(route));
		serverCommitted = true;
		return route.fulfill({
			json: {
				expense: expense(`recurring-period-${postAttempts.length}`, 'Miete'),
				warning: null,
			},
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?filter=recurring`);
	await dismissOnboarding(page);
	const create = page.getByRole('button', { name: 'Fixkosten-Ausgabe direkt erstellen: Miete' });
	await create.click();
	await expect.poll(() => postAttempts.length).toBe(1);
	await expect.poll(() => advanceAttempts.length).toBe(1);
	await expect.poll(() => refreshedAdvancedTemplate).toBe(true);
	await expect(create).toBeEnabled();
	await create.click();
	await expect.poll(() => postAttempts.length).toBe(2);

	expect(postAttempts[0]?.key).toBeTruthy();
	expect(postAttempts[1]?.key).not.toBe(postAttempts[0]?.key);
	expect(postAttempts[0]?.body).toMatchObject({
		recurringExpenseId: 'recurring-rent',
		expectedRecurringNextDueAt: originalDueAt,
	});
	expect(postAttempts[1]?.body).toMatchObject({
		recurringExpenseId: 'recurring-rent',
		expectedRecurringNextDueAt: advancedDueAt,
	});
});

test('an accepted offline recurring expense is not queued again after reload', async ({ page }) => {
	await setupMember(page);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
	});
	await mockReads(page, [recurringExpense()]);
	await page.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		return route.abort();
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/ausgaben?filter=recurring`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Fixkosten-Ausgabe direkt erstellen: Miete' }).click();
	await expect(page.getByText(/Fixkosten-Ausgabe offline vorgemerkt/)).toBeVisible();
	await expect.poll(() => queuedRecurringExpenseCount(page)).toBe(1);

	// A fresh page in the same context preserves localStorage without the
	// setupMember init script that intentionally clears the queue on reload.
	const reloadedPage = await page.context().newPage();
	await reloadedPage.addInitScript(() => {
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
	});
	await mockReads(reloadedPage, [recurringExpense()]);
	let replayEnabled = false;
	const replayAttempts: RequestAttempt[] = [];
	await reloadedPage.route(`**${API}/expenses`, async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		if (!replayEnabled) return route.abort();
		replayAttempts.push(recordAttempt(route));
		return route.fulfill({
			json: { expense: expense('synced-recurring-expense', 'Miete'), warning: null },
		});
	});
	await reloadedPage.goto(`/wg/${FIXTURE_WG.shareCode}/ausgaben?filter=recurring`);
	await dismissOnboarding(reloadedPage);
	await expect.poll(() => queuedRecurringExpenseCount(reloadedPage)).toBe(1);
	const create = reloadedPage.getByRole('button', {
		name: 'Fixkosten-Ausgabe direkt erstellen: Miete',
	});
	await expect(create).toBeVisible();
	await create.click();
	await expect.poll(() => queuedRecurringExpenseCount(reloadedPage)).toBe(1);

	replayEnabled = true;
	await reloadedPage.evaluate(() => {
		Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
		window.dispatchEvent(new Event('online'));
	});
	await reloadedPage.getByRole('button', { name: 'Offline-Aktionen jetzt senden' }).click();
	await expect.poll(() => replayAttempts.length).toBe(1);
	await expect.poll(() => queuedRecurringExpenseCount(reloadedPage)).toBe(0);
	expect(replayAttempts[0]?.key).toBeTruthy();
	expect(replayAttempts[0]?.body).toMatchObject({
		recurringExpenseId: 'recurring-rent',
		expectedRecurringNextDueAt: '2020-01-01T00:00:00.000Z',
	});
});
