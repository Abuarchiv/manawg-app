import { type Page, expect, test } from '@playwright/test';
import { createServerClient } from '@supabase/ssr';

type CreatedWgResponse = {
	wg?: { id?: unknown; shareCode?: unknown };
	creator?: { id?: unknown };
};

type WgManifestResponse = {
	wg?: { id?: unknown; shareCode?: unknown };
	currentMember?: { memberId?: unknown; memberToken?: unknown };
};

type MineWgResponse = {
	wgs?: Array<{ id?: unknown; memberId?: unknown; name?: unknown; code?: unknown }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QaAuthConfig = {
	url: string;
	publishableKey: string;
	email: string;
	password: string;
};

function getQaAuthConfig(env: NodeJS.ProcessEnv = process.env): QaAuthConfig | null {
	const url = env.E2E_SUPABASE_URL?.trim();
	const publishableKey = env.E2E_SUPABASE_PUBLISHABLE_KEY?.trim();
	const email = env.E2E_SUPABASE_TEST_EMAIL?.trim();
	const password = env.E2E_SUPABASE_TEST_PASSWORD?.trim();

	if (!url || !publishableKey || !email || !password) {
		return null;
	}

	return { url, publishableKey, email, password };
}

async function authenticateQaUser(
	page: Page,
	{ url, publishableKey, email, password }: QaAuthConfig,
) {
	const sessionCookies = new Map<string, string>();
	const supabase = createServerClient(url, publishableKey, {
		cookies: {
			getAll: () => [],
			setAll: (cookies) => {
				for (const { name, value } of cookies) sessionCookies.set(name, value);
			},
		},
	});
	const { data, error } = await supabase.auth.signInWithPassword({ email, password });
	if (error || !data.session) {
		throw new Error(
			`The real Supabase QA user could not sign in${error ? `: ${error.message}` : ''}.`,
		);
	}

	if (!sessionCookies.size) {
		throw new Error('Supabase SSR did not emit session cookies for the real QA user.');
	}

	await page.context().addCookies(
		[...sessionCookies].map(([name, value]) => ({
			name,
			value,
			url: new URL(page.url()).origin,
		})),
	);
}

async function gotoWithRetry(page: Page, path: string) {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 120_000 });
			return;
		} catch (err) {
			lastError = err;
			await page.waitForTimeout(1000);
		}
	}
	throw lastError;
}

function getRunNamespace(): string {
	const runId = process.env.GITHUB_RUN_ID?.trim();
	const attempt = process.env.GITHUB_RUN_ATTEMPT?.trim();
	return runId && attempt ? `run-${runId}-${attempt}` : `local-${Date.now()}`;
}

/**
 * Smoke test for the core launch flow:
 * /neu → choose "Neue WG erstellen" → fill form → invite step → /wg/<code> dashboard
 */
test.describe('ManaWG launch smoke', () => {
	test.setTimeout(300_000);
	const qaAuthConfig = getQaAuthConfig();
	const requiresRealProductAuth =
		process.env.PREVIEW_E2E === 'true' || process.env.REAL_PRODUCT_E2E === 'true';

	test('shows joining disabled after a member join attempt', async ({ page }) => {
		let memberPostRequests = 0;
		const fixtureMode = process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE === 'true';
		await page.addInitScript(() => window.localStorage.clear());
		// This existing mocked invite-policy test starts after account authentication.
		await page.route('**/api/wg/mine', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: '{"wgs":[]}' }),
		);
		await page.route('**/api/wg/MTE8PZAT', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					wg: {
						id: '989ac820-58b7-431f-9c65-28721264f333',
						name: 'sadf',
						shareCode: 'MTE8PZAT',
						joiningEnabled: false,
						shareCodeRotatedAt: null,
						createdAt: new Date().toISOString(),
					},
					members: [],
				}),
			});
		});
		await page.route('**/api/wg/MTE8PZAT/members', async (route) => {
			if (route.request().method() === 'POST') memberPostRequests += 1;
			await route.fulfill({
				status: 403,
				contentType: 'application/json',
				body: JSON.stringify({ error: 'joining_disabled' }),
			});
		});

		await gotoWithRetry(page, '/neu?code=MTE8PZAT');
		if (!fixtureMode) {
			if (!qaAuthConfig) {
				test.skip(true, 'non-fixture smoke requires Supabase QA credentials');
				return;
			}
			await authenticateQaUser(page, qaAuthConfig);
			await page.reload();
		}
		await expect(page.getByRole('heading', { name: 'Per Code beitreten' })).toBeVisible({
			timeout: 30_000,
		});
		await page.getByRole('button', { name: 'WG-Code prüfen' }).click();

		if (fixtureMode) {
			await expect(page.getByText('Diese WG nimmt gerade keine neuen Beitritte an.')).toBeVisible();
			await expect(page.getByRole('button', { name: 'WG beitreten' })).toHaveCount(0);
			await expect.poll(() => memberPostRequests).toBe(0);
			return;
		}

		await expect(page.getByRole('heading', { name: 'Dein Name in der WG' })).toBeVisible();
		await page.getByLabel('Dein Anzeigename').fill('Smoke Tester');
		await page.getByRole('button', { name: 'WG beitreten', exact: true }).click();
		await expect(page.getByText('Diese WG nimmt gerade keine neuen Beitritte an.')).toBeVisible();
		await expect.poll(() => memberPostRequests).toBe(1);
	});

	test('404 page provides a valid keyboard skip target', async ({ page }) => {
		await gotoWithRetry(page, '/this-page-does-not-exist');
		await expect(page.getByRole('heading', { name: 'Seite nicht gefunden' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Zum Hauptinhalt springen' })).toHaveAttribute(
			'href',
			'#main',
		);
		await expect(page.locator('main#main')).toHaveCount(1);
	});

	test('create WG → redirect to /wg/<code> → Start overview retains primary navigation', async ({
		page,
	}) => {
		test.skip(
			process.env.E2E_FIXTURE_MODE === 'true',
			'Requires the real-product smoke job; fixture runs never create a live WG.',
		);
		if (!qaAuthConfig) {
			if (!requiresRealProductAuth) {
				test.skip(
					true,
					'real Supabase QA credentials are only required for the real-product smoke job',
				);
				return;
			}
			throw new Error(
				'real-product smoke requires E2E_SUPABASE_URL, E2E_SUPABASE_PUBLISHABLE_KEY, E2E_SUPABASE_TEST_EMAIL, and E2E_SUPABASE_TEST_PASSWORD',
			);
		}

		const runNamespace = getRunNamespace();
		const wgName = `Smoke Test WG ${runNamespace}`;
		let createdShareCode: string | null = null;
		let createdWgId: string | null = null;
		let createdMemberId: string | null = null;
		let memberHeaders: Record<string, string> | null = null;
		let createClicked = false;
		let flowError: unknown = null;
		let cleanupFailure: string | null = null;
		try {
			// Step 1: Land on /neu
			await page.addInitScript(() => window.localStorage.clear());
			await gotoWithRetry(page, '/neu');
			await authenticateQaUser(page, qaAuthConfig);
			await page.reload();
			await expect(
				page.getByRole('heading', { name: 'Deine WG', exact: true, level: 1 }),
			).toBeVisible({
				timeout: 30_000,
			});

			// Step 2: Choose "Neue WG erstellen"
			const createChoice = page.getByRole('button', { name: /Neue WG erstellen/i });
			for (let attempt = 0; attempt < 10; attempt += 1) {
				await createChoice.click();
				if (
					await page
						.getByLabel('WG-Name')
						.isVisible({ timeout: 1_000 })
						.catch(() => false)
				) {
					break;
				}
			}
			await expect(page.getByLabel('WG-Name')).toBeVisible({ timeout: 30_000 });

			// Step 3: Fill WG name + creator name
			await page.getByLabel('WG-Name').fill(wgName);
			await page.getByLabel('Dein Anzeigename').fill('Smoke Tester');

			// Step 4: Submit → invite step with a generated WG code
			const creationResponse = page.waitForResponse(
				(response) => response.url().endsWith('/api/wg') && response.request().method() === 'POST',
				{ timeout: 30_000 },
			);
			createClicked = true;
			await page.getByRole('button', { name: /^WG erstellen$/i }).click();
			const createdResponse = await creationResponse;
			expect(createdResponse.status()).toBe(200);
			const created = (await createdResponse.json()) as CreatedWgResponse;
			createdShareCode = typeof created.wg?.shareCode === 'string' ? created.wg.shareCode : null;
			createdWgId = typeof created.wg?.id === 'string' ? created.wg.id : null;
			createdMemberId = typeof created.creator?.id === 'string' ? created.creator.id : null;
			expect(createdShareCode).toMatch(/^[A-Z0-9]{8}$/);
			expect(created.wg?.id).toMatch(UUID_PATTERN);
			expect(created.creator?.id).toMatch(UUID_PATTERN);

			await expect(page.getByRole('heading', { name: wgName, exact: true, level: 1 })).toBeVisible({
				timeout: 30_000,
			});
			const codeButton = page.getByRole('button', { name: /Code [A-Z0-9]{8} kopieren/ });
			await expect(codeButton).toBeVisible({
				timeout: 30_000,
			});
			const inviteCode =
				(await codeButton.getAttribute('aria-label'))?.match(/\b([A-Z0-9]{8})\b/)?.[1] ?? null;
			expect(inviteCode).toBe(createdShareCode);

			// Step 5: Continue to /wg/<8-char-code>; ManaWG share codes are 8 alphanumeric chars.
			await page.getByRole('button', { name: /direkt zur WG/i }).click();
			await page.waitForURL(/\/wg\/[A-Z0-9]{8}$/, { timeout: 15_000 });
			const manifestResponse = await page.request.get(`/api/wg/${createdShareCode}`);
			expect(manifestResponse.status()).toBe(200);
			const manifest = (await manifestResponse.json()) as WgManifestResponse;
			expect(manifest.wg?.id).toBe(createdWgId);
			expect(manifest.wg?.shareCode).toBe(createdShareCode);
			expect(manifest.currentMember?.memberId).toBe(createdMemberId);
			const memberId =
				typeof manifest.currentMember?.memberId === 'string'
					? manifest.currentMember.memberId
					: null;
			const memberToken =
				typeof manifest.currentMember?.memberToken === 'string'
					? manifest.currentMember.memberToken
					: null;
			if (!memberId || !memberToken) {
				throw new Error('created WG member proof was not returned');
			}
			memberHeaders = {
				'x-manawg-member-id': memberId,
				'x-manawg-member-token': memberToken,
				origin: new URL(page.url()).origin,
			};

			const closeJoining = await page.request.patch(`/api/wg/${createdShareCode}`, {
				headers: memberHeaders,
				data: { joiningEnabled: false },
			});
			expect(closeJoining.status(), await closeJoining.text()).toBe(200);
			const existingMemberJoin = await page.request.post(`/api/wg/${createdShareCode}/members`, {
				headers: memberHeaders,
				data: { name: 'Smoke Tester' },
			});
			expect(existingMemberJoin.status()).toBe(409);
			expect(await existingMemberJoin.json()).toMatchObject({ code: 'already_joined' });

			// Step 6: The focused overview retains access to every primary destination.
			await expect(
				page.getByRole('heading', { name: `${wgName} – Start`, exact: true }),
			).toBeVisible();
			const navigation = page.getByRole('navigation', { name: 'WG Hauptnavigation' });
			for (const label of ['Start', 'Haushalt', 'Finanzen', 'Austausch']) {
				await expect(navigation.getByRole('link', { name: label, exact: true })).toBeVisible();
			}

			// Exercise a real money write and both export formats before the WG is deleted.
			const expenseDescription = `Smoke Expense ${runNamespace}`;
			const expenseResponse = await page.request.post(`/api/wg/${createdShareCode}/expenses`, {
				headers: memberHeaders,
				data: {
					amountCents: 1234,
					currency: 'EUR',
					description: expenseDescription,
					splits: [{ debtorMemberId: memberId, amountCents: 1234 }],
				},
			});
			expect(expenseResponse.status(), await expenseResponse.text()).toBe(200);
			const createdExpense = (await expenseResponse.json()) as {
				expense?: {
					id?: string;
					amountCents?: number;
					currency?: string;
					splits?: Array<{ debtorMemberId?: string; amountCents?: number }>;
				};
			};
			expect(createdExpense.expense?.id).toMatch(UUID_PATTERN);
			expect(createdExpense.expense).toMatchObject({
				amountCents: 1234,
				currency: 'EUR',
				splits: [{ debtorMemberId: memberId, amountCents: 1234 }],
			});

			const expensesResponse = await page.request.get(`/api/wg/${createdShareCode}/expenses`, {
				headers: memberHeaders,
			});
			expect(expensesResponse.status()).toBe(200);
			const listed = (await expensesResponse.json()) as {
				expenses?: Array<{ id?: string; description?: string; amountCents?: number }>;
			};
			expect(listed.expenses?.filter((entry) => entry.description === expenseDescription)).toEqual([
				expect.objectContaining({ id: createdExpense.expense?.id, amountCents: 1234 }),
			]);

			await gotoWithRetry(page, `/wg/${createdShareCode}/ausgaben`);
			await expect(page.getByText(expenseDescription, { exact: true })).toBeVisible({
				timeout: 30_000,
			});
			await page.reload();
			await expect(page.getByText(expenseDescription, { exact: true })).toBeVisible({
				timeout: 30_000,
			});

			const shoppingName = `Smoke Shopping ${runNamespace}`;
			const shoppingCreate = await page.request.post(`/api/wg/${createdShareCode}/shopping`, {
				headers: memberHeaders,
				data: { name: shoppingName, quantity: '2' },
			});
			expect(shoppingCreate.status(), await shoppingCreate.text()).toBe(200);
			const shopping = (await shoppingCreate.json()) as {
				item?: { id?: string; name?: string; quantity?: string };
			};
			expect(shopping.item?.id).toMatch(UUID_PATTERN);
			expect(shopping.item).toMatchObject({ name: shoppingName, quantity: '2' });
			const shoppingId = shopping.item?.id;
			if (!shoppingId) throw new Error('created shopping item ID was not returned');

			await gotoWithRetry(page, `/wg/${createdShareCode}/einkauf`);
			const shoppingCheckbox = page.getByRole('checkbox', { name: `${shoppingName} erledigen` });
			await expect(shoppingCheckbox).toBeVisible({ timeout: 30_000 });
			const shoppingBoughtResponse = page.waitForResponse(
				(response) =>
					response.url().endsWith(`/api/wg/${createdShareCode}/shopping/${shoppingId}`) &&
					response.request().method() === 'PATCH',
			);
			await shoppingCheckbox.click();
			const shoppingBought = await shoppingBoughtResponse;
			expect(shoppingBought.status(), await shoppingBought.text()).toBe(200);
			const shoppingList = await page.request.get(`/api/wg/${createdShareCode}/shopping`, {
				headers: memberHeaders,
			});
			expect(shoppingList.status()).toBe(200);
			const listedShopping = (await shoppingList.json()) as {
				items?: Array<{ id?: string; boughtAt?: string | null }>;
			};
			expect(listedShopping.items?.filter((item) => item.id === shoppingId)).toEqual([
				expect.objectContaining({ boughtAt: expect.any(String) }),
			]);

			const choreTitle = `Smoke Chore ${runNamespace}`;
			const choreCreate = await page.request.post(`/api/wg/${createdShareCode}/chores`, {
				headers: memberHeaders,
				data: { title: choreTitle, intervalDays: 7, assignedMemberId: memberId },
			});
			expect(choreCreate.status(), await choreCreate.text()).toBe(200);
			const createdChore = (await choreCreate.json()) as {
				chore?: { id?: string; title?: string; nextDueAt?: string };
			};
			expect(createdChore.chore?.id).toMatch(UUID_PATTERN);
			expect(createdChore.chore?.title).toBe(choreTitle);
			const choreId = createdChore.chore?.id;
			const firstDueAt = createdChore.chore?.nextDueAt;
			if (!choreId || !firstDueAt) throw new Error('created chore proof was not returned');

			await gotoWithRetry(page, `/wg/${createdShareCode}/putzen`);
			await expect(page.getByText(choreTitle, { exact: true })).toBeVisible({ timeout: 30_000 });
			const completion = await page.request.post(
				`/api/wg/${createdShareCode}/chores/${choreId}/complete`,
				{ headers: memberHeaders },
			);
			expect(completion.status(), await completion.text()).toBe(200);
			const choreList = await page.request.get(`/api/wg/${createdShareCode}/chores`, {
				headers: memberHeaders,
			});
			expect(choreList.status()).toBe(200);
			const listedChores = (await choreList.json()) as {
				chores?: Array<{ id?: string; nextDueAt?: string }>;
				monthCompletions?: Record<string, number>;
			};
			const nextDueAt = listedChores.chores?.find((chore) => chore.id === choreId)?.nextDueAt;
			expect(Date.parse(nextDueAt ?? '')).toBeGreaterThan(Date.parse(firstDueAt));
			expect(listedChores.monthCompletions?.[memberId]).toBe(1);

			const originalMessage = `Smoke Chat ${runNamespace}`;
			const editedMessage = `${originalMessage} edited`;
			const chatCreate = await page.request.post(`/api/wg/${createdShareCode}/chat/messages`, {
				headers: memberHeaders,
				data: { body: originalMessage },
			});
			expect(chatCreate.status(), await chatCreate.text()).toBe(200);
			const createdChat = (await chatCreate.json()) as {
				message?: { id?: string; body?: string };
			};
			expect(createdChat.message?.id).toMatch(UUID_PATTERN);
			expect(createdChat.message?.body).toBe(originalMessage);
			const messageId = createdChat.message?.id;
			if (!messageId) throw new Error('created chat message ID was not returned');
			const chatEdit = await page.request.patch(
				`/api/wg/${createdShareCode}/chat/messages/${messageId}`,
				{ headers: memberHeaders, data: { body: editedMessage } },
			);
			expect(chatEdit.status(), await chatEdit.text()).toBe(200);
			const chatList = await page.request.get(`/api/wg/${createdShareCode}/chat/messages`, {
				headers: memberHeaders,
			});
			expect(chatList.status()).toBe(200);
			const listedChat = (await chatList.json()) as {
				messages?: Array<{ id?: string; body?: string }>;
			};
			expect(listedChat.messages?.filter((message) => message.id === messageId)).toEqual([
				expect.objectContaining({ body: editedMessage }),
			]);
			await gotoWithRetry(page, `/wg/${createdShareCode}/chat`);
			await expect(page.getByText(editedMessage, { exact: true })).toBeVisible({ timeout: 30_000 });
			await page.reload();
			await expect(page.getByText(editedMessage, { exact: true })).toBeVisible({ timeout: 30_000 });

			const eventTitle = `Smoke Event ${runNamespace}`;
			const editedEventTitle = `${eventTitle} edited`;
			const eventStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
			const eventEnd = new Date(eventStart.getTime() + 60 * 60 * 1000);
			const eventCreate = await page.request.post(`/api/wg/${createdShareCode}/events`, {
				headers: memberHeaders,
				data: {
					title: eventTitle,
					startsAt: eventStart.toISOString(),
					endsAt: eventEnd.toISOString(),
				},
			});
			expect(eventCreate.status(), await eventCreate.text()).toBe(200);
			const createdEvent = (await eventCreate.json()) as {
				event?: { id?: string; title?: string; startsAt?: string };
			};
			expect(createdEvent.event?.id).toMatch(UUID_PATTERN);
			expect(createdEvent.event?.startsAt).toBe(eventStart.toISOString());
			const eventId = createdEvent.event?.id;
			if (!eventId) throw new Error('created calendar event ID was not returned');
			const eventEdit = await page.request.patch(`/api/wg/${createdShareCode}/events/${eventId}`, {
				headers: memberHeaders,
				data: { title: editedEventTitle },
			});
			expect(eventEdit.status(), await eventEdit.text()).toBe(200);
			const eventWindow = new URLSearchParams({
				from: new Date(eventStart.getTime() - 60 * 60 * 1000).toISOString(),
				to: new Date(eventEnd.getTime() + 60 * 60 * 1000).toISOString(),
			});
			const eventList = await page.request.get(
				`/api/wg/${createdShareCode}/events?${eventWindow.toString()}`,
				{ headers: memberHeaders },
			);
			expect(eventList.status()).toBe(200);
			const listedEvents = (await eventList.json()) as {
				events?: Array<{ id?: string; title?: string; startsAt?: string }>;
			};
			expect(listedEvents.events?.filter((event) => event.id === eventId)).toEqual([
				expect.objectContaining({ title: editedEventTitle, startsAt: eventStart.toISOString() }),
			]);
			await gotoWithRetry(page, `/wg/${createdShareCode}/kalender`);
			await expect(page.getByText(editedEventTitle, { exact: true })).toBeVisible({
				timeout: 30_000,
			});
			await page.reload();
			await expect(page.getByText(editedEventTitle, { exact: true })).toBeVisible({
				timeout: 30_000,
			});

			const exportUrl = `/api/wg/${createdShareCode}/export`;
			const jsonExport = await page.request.get(`${exportUrl}?format=json`, {
				headers: memberHeaders,
			});
			expect(jsonExport.status()).toBe(200);
			const backup = (await jsonExport.json()) as {
				failedSections?: string[];
				sections?: {
					expenses?: Array<{ id?: string; amountCents?: number }>;
					shoppingItems?: Array<{ id?: string; status?: string }>;
					chores?: Array<{ id?: string; title?: string }>;
				};
			};
			expect(backup.failedSections).toEqual([]);
			expect(
				backup.sections?.expenses?.filter((entry) => entry.id === createdExpense.expense?.id),
			).toEqual([expect.objectContaining({ amountCents: 1234 })]);
			expect(backup.sections?.shoppingItems?.filter((item) => item.id === shoppingId)).toEqual([
				expect.objectContaining({ status: 'erledigt' }),
			]);
			expect(backup.sections?.chores?.filter((chore) => chore.id === choreId)).toEqual([
				expect.objectContaining({ title: choreTitle }),
			]);

			const csvExport = await page.request.get(`${exportUrl}?format=csv&section=expenses`, {
				headers: memberHeaders,
			});
			expect(csvExport.status()).toBe(200);
			expect(csvExport.headers()['content-type']).toContain('text/csv');
			expect(await csvExport.text()).toContain(expenseDescription);
		} catch (error) {
			flowError = error;
		} finally {
			if (!createdShareCode && createClicked) {
				try {
					const mineResponse = await page.request.get('/api/wg/mine');
					if (mineResponse.ok()) {
						const mine = (await mineResponse.json()) as MineWgResponse;
						const recovered = mine.wgs?.find((wg) => wg.name === wgName);
						if (
							recovered &&
							typeof recovered.code === 'string' &&
							/^[A-Z0-9]{8}$/.test(recovered.code) &&
							typeof recovered.id === 'string' &&
							UUID_PATTERN.test(recovered.id) &&
							typeof recovered.memberId === 'string' &&
							UUID_PATTERN.test(recovered.memberId)
						) {
							createdShareCode = recovered.code;
							createdWgId = recovered.id;
							createdMemberId = recovered.memberId;
						}
					}
				} catch {
					// Cleanup below reports the run namespace without leaking response data.
				}
			}
			if (createdShareCode) {
				try {
					if (!memberHeaders) {
						cleanupFailure = `WG cleanup failed run namespace ${runNamespace}, share code ${createdShareCode}.`;
					} else {
						const cleanup = await page.request.delete(`/api/wg/${createdShareCode}`, {
							headers: memberHeaders,
						});
						const [wgAfterCleanup, membersAfterCleanup] = await Promise.all([
							page.request.get(`/api/wg/${createdShareCode}`),
							page.request.get(`/api/wg/${createdShareCode}/members`),
						]);
						const cleanupFailed =
							cleanup.status() !== 200 ||
							wgAfterCleanup.status() !== 404 ||
							membersAfterCleanup.status() !== 404;
						if (cleanupFailed) {
							cleanupFailure = `WG cleanup failed for run namespace ${runNamespace}, share code ${createdShareCode}.`;
						}
					}
				} catch {
					cleanupFailure = `WG cleanup failed for run namespace ${runNamespace}, share code ${createdShareCode}.`;
				}
			} else if (createClicked) {
				cleanupFailure = `WG cleanup failed for run namespace ${runNamespace}, share code unavailable.`;
			}
		}
		if (flowError) throw flowError;
		if (cleanupFailure) throw new Error(cleanupFailure);
	});
});
