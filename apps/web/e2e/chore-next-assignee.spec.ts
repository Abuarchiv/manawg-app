import { type Locator, expect, test } from '@playwright/test';
import { chooseNextAvailableMember } from '../src/features/chores/chore-fairness';
import { MEMBER_TOKEN_HEADER } from '../src/shared/lib/member-header';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const SHARE_CODE = FIXTURE_WG.shareCode;
const CURRENT_MEMBER = FIXTURE_WG.memberId;

type FixtureMember = { id: string; name: string; color: string | null; active: boolean };
type FixtureAbsence = {
	id: string;
	memberId: string;
	memberName: string;
	startDate: string;
	endDate: string;
	reason: string;
};

function chore(id: string, assignedMemberId: string) {
	return {
		id,
		title: `Aufgabe ${id}`,
		intervalDays: 7,
		recurrenceType: 'days',
		nextDueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		assignedMemberId,
		lastCompletedAt: null,
		lastCompletedByName: null,
		openGapCountForAssignee: 0,
	};
}

function absence(member: FixtureMember): FixtureAbsence {
	return {
		id: `absence-${member.id}`,
		memberId: member.id,
		memberName: member.name,
		startDate: new Date(Date.now() - 86_400_000).toISOString(),
		// Rotation checks absences on the next due day (one interval ahead), so
		// the absence must cover the whole next round, not just today.
		endDate: new Date(Date.now() + 9 * 86_400_000).toISOString(),
		reason: 'Urlaub',
	};
}

async function openPutzen(
	page: import('@playwright/test').Page,
	members: FixtureMember[],
	chores: ReturnType<typeof chore>[],
	absences: FixtureAbsence[],
	viewerIsAdmin = false,
) {
	await setupMember(page);
	const memberTokens: Array<string | undefined> = [];
	await page.route(`**/api/wg/${SHARE_CODE}/members`, (route) => {
		memberTokens.push(route.request().headers()[MEMBER_TOKEN_HEADER]);
		return route.fulfill({ json: { members, viewerIsAdmin } });
	});
	await page.route(`**/api/wg/${SHARE_CODE}/chores`, (route) =>
		route.fulfill({ json: { chores, monthCompletions: {} } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/absences`, (route) =>
		route.fulfill({ json: { absences } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/dashboard`, (route) =>
		route.fulfill({
			json: { openShoppingCount: 123, dueChores: [], dueRecurringExpenses: [] },
		}),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/chat/unread-count`, (route) =>
		route.fulfill({ json: { count: 0, overflow: false } }),
	);
	await navigateToFeature(page, `/wg/${SHARE_CODE}/putzen`);
	await dismissOnboarding(page);
	await expect.poll(() => memberTokens.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
	expect(memberTokens.every((token) => token === 'fixture-member-token')).toBe(true);
	const household = page.getByRole('navigation', { name: 'Haushalt' });
	const shopping = household.getByRole('link', { name: 'Einkäufe, 123 offen' });
	await expect(shopping).toBeVisible();
	await expect(shopping).toHaveText('Einkäufe99+');
}

async function expectNoOverflow(container: Locator) {
	const hasOverflow = await container.evaluate(
		(element) =>
			element.scrollHeight > element.clientHeight + 1 ||
			element.scrollWidth > element.clientWidth + 1,
	);
	expect(hasOverflow).toBe(false);
}

test('keeps chore action buttons readable and reachable at phone widths and enlarged text', async ({
	page,
}) => {
	test.setTimeout(60_000);
	const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
	const flatmate: FixtureMember = {
		id: '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55',
		name: 'Mina',
		color: null,
		active: true,
	};
	const title = 'Spülmaschinenreinigung mit Entkalkung und gründlicher Küchenhygiene';
	// Übernehmen gibt es nur bei Aufgaben anderer.
	const rows = [{ ...chore('actions-zoom', flatmate.id), title }];

	await openPutzen(page, [viewer, flatmate], rows, []);

	const row = page.locator('#chore-actions-zoom');
	const opener = row.getByRole('button', { name: `Aufgabenaktionen: ${title}` });
	const takeOver = page.getByRole('button', { name: 'Ich übernehme' });
	const swap = page.getByRole('button', { name: `Tausch auf der Pinnwand anfragen: ${title}` });
	const close = page.getByRole('button', { name: 'Schließen' });

	for (const theme of ['light', 'dark'] as const) {
		for (const width of [320, 360]) {
			for (const rootFontSize of [16, 32]) {
				await page.setViewportSize({ width, height: 800 });
				await page.emulateMedia({ colorScheme: theme });
				await page.evaluate((size) => {
					document.documentElement.style.fontSize = `${size}px`;
				}, rootFontSize);

				await opener.click();
				await expect(takeOver).toBeVisible();
				await expect(swap).toBeVisible();

				// Read both rectangles in one frame while the drawer animates.
				const boxes = await takeOver.or(swap).evaluateAll((buttons) =>
					buttons.map((button) => {
						const { y, height } = button.getBoundingClientRect();
						return { text: button.textContent?.replace(/\s+/g, ' ').trim(), y, height };
					}),
				);
				const takeOverBox = boxes.find((box) => box.text === 'Ich übernehme');
				const swapBox = boxes.find((box) => box.text === 'Tausch auf der Pinnwand anfragen');
				expect(takeOverBox).toBeDefined();
				expect(swapBox).toBeDefined();
				if (!takeOverBox || !swapBox) throw new Error('Chore action button is not rendered');
				expect(takeOverBox.height).toBeGreaterThanOrEqual(44);
				expect(swapBox.height).toBeGreaterThanOrEqual(44);
				expect(takeOverBox.y + takeOverBox.height).toBeLessThanOrEqual(swapBox.y + 1);

				for (const button of [takeOver, swap]) {
					await expectNoOverflow(button);
				}

				await takeOver.focus();
				await expect(takeOver).toBeFocused();
				await page.keyboard.press('Tab');
				await expect(swap).toBeFocused();
				if (width === 320 && rootFontSize === 32) {
					const scrollState = await swap.evaluate((button) => {
						const element = button
							.closest('[data-slot="drawer-content"]')
							?.querySelector('div.overflow-y-auto');
						if (!(element instanceof HTMLElement)) return null;
						const area = element.getBoundingClientRect();
						const visibleTop = area.top + element.clientTop;
						const visibleBottom = visibleTop + element.clientHeight;
						const buttonBounds = button.getBoundingClientRect();
						return {
							top: element.scrollTop,
							clientHeight: element.clientHeight,
							scrollHeight: element.scrollHeight,
							visibleHeight: Math.max(
								0,
								Math.min(buttonBounds.bottom, visibleBottom) -
									Math.max(buttonBounds.top, visibleTop),
							),
						};
					});
					expect(scrollState).not.toBeNull();
					if (!scrollState) throw new Error('Chore action scroll area is not rendered');
					if (scrollState.scrollHeight > scrollState.clientHeight) {
						expect(scrollState.top).toBeGreaterThan(0);
					}
					expect(scrollState.visibleHeight).toBeGreaterThanOrEqual(44);
				}
				await page.keyboard.press('Tab');
				await expect(close).toBeFocused();
				await page.keyboard.press('Escape');
				await expect(opener).toHaveAttribute('aria-expanded', 'false');
			}
		}
	}
});

test('keeps the admin remove action and confirmation readable at enlarged text', async ({
	page,
}) => {
	test.setTimeout(60_000);
	const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
	const title = 'Spülmaschinenreinigung mit Entkalkung und gründlicher Küchenhygiene';
	const rows = [{ ...chore('actions-admin-zoom', viewer.id), title }];

	await openPutzen(page, [viewer], rows, [], true);
	await page.setViewportSize({ width: 320, height: 800 });
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.evaluate(() => {
		document.documentElement.style.fontSize = '32px';
	});

	const row = page.locator('#chore-actions-admin-zoom');
	await row.getByRole('button', { name: `Aufgabenaktionen: ${title}` }).click();

	const remove = page.getByRole('button', { name: `Aufgabe entfernen: ${title}` });
	await expect(remove).toBeVisible();
	const removeBox = await remove.boundingBox();
	expect(removeBox).not.toBeNull();
	if (!removeBox) throw new Error('Admin remove action is not rendered');
	expect(removeBox.height).toBeGreaterThanOrEqual(44);
	await expectNoOverflow(remove);

	await remove.click();
	// WCAG 4.1.3: this is a confirmation prompt, not an error — it is a polite
	// status message (role="alert" is reserved for errors).
	const alert = page.getByRole('status').filter({ hasText: 'Diese Aufgabe endgültig entfernen?' });
	await expect(alert).toBeVisible();
	const confirmation = page.getByRole('button', {
		name: `Endgültig entfernen: ${title}`,
	});
	await expect(confirmation).toBeVisible();
	const alertBox = await alert.boundingBox();
	const confirmationBox = await confirmation.boundingBox();
	expect(alertBox).not.toBeNull();
	expect(confirmationBox).not.toBeNull();
	if (!alertBox || !confirmationBox) throw new Error('Admin confirmation is not rendered');
	expect(alertBox.y + alertBox.height).toBeLessThanOrEqual(confirmationBox.y + 1);
	expect(confirmationBox.height).toBeGreaterThanOrEqual(44);
	await expectNoOverflow(alert);
	await expectNoOverflow(confirmation);
});

test('hides permanent chore removal from non-admin members', async ({ page }) => {
	const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
	const title = 'Aufgabe delete-permission';
	const rows = [chore('delete-permission', viewer.id)];

	await openPutzen(page, [viewer], rows, []);
	await page.getByRole('button', { name: `Aufgabenaktionen: ${title}` }).click();
	await expect(page.getByRole('button', { name: `Aufgabe entfernen: ${title}` })).toHaveCount(0);
});

test('shows the authoritative next member and labels the viewer as du', async ({ page }) => {
	const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
	const absentMember: FixtureMember = { id: 'ben', name: 'Ben', color: null, active: true };
	const choreOwner: FixtureMember = { id: 'anna', name: 'Anna', color: null, active: true };
	const departedMember: FixtureMember = { id: 'dora', name: 'Dora', color: null, active: false };
	const members = [viewer, absentMember, choreOwner, departedMember];
	const chores = [chore('viewer-next', 'anna')];
	const absences = [absence(absentMember)];
	const activeMembers = members
		.filter((member) => member.active)
		.map(({ id, name }) => ({ id, name }));
	const nextMember = chooseNextAvailableMember({
		members: activeMembers,
		currentMemberId: 'anna',
		absentMemberIds: ['ben'],
		chores,
	});
	expect(nextMember).toBe(CURRENT_MEMBER);

	await openPutzen(page, members, chores, absences);
	const row = page.locator('#chore-viewer-next');
	await expect(row).toContainText('danach du');
	await expect(row.getByText('Zuständig: Anna')).toBeVisible();
});

test('states when no active member is eligible for the next round', async ({ page }) => {
	const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
	const choreOwner: FixtureMember = { id: 'anna', name: 'Anna', color: null, active: true };
	const departedMember: FixtureMember = { id: 'dora', name: 'Dora', color: null, active: false };
	const members = [viewer, choreOwner, departedMember];
	const chores = [chore('no-successor', 'anna')];
	const absences = [absence(viewer), absence(choreOwner)];
	const activeMembers = members
		.filter((member) => member.active)
		.map(({ id, name }) => ({ id, name }));
	const nextMember = chooseNextAvailableMember({
		members: activeMembers,
		currentMemberId: 'anna',
		absentMemberIds: [CURRENT_MEMBER, 'anna'],
		chores,
	});
	expect(nextMember).toBeNull();

	await openPutzen(page, members, chores, absences);
	const row = page.locator('#chore-no-successor');
	await expect(row).not.toContainText('danach');
	await expect(row.getByText('Dora', { exact: true })).toHaveCount(0);
});

test('wraps a long predicted name at phone widths in both themes', async ({ page }, testInfo) => {
	const owner: FixtureMember = { id: 'anna', name: 'Anna', color: null, active: true };
	const longNext: FixtureMember = {
		id: 'long-next',
		name: 'Alexandria-Winterstein-Schwarzenberg',
		color: null,
		active: true,
	};
	const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
	const members = [owner, longNext, viewer];
	const chores = [chore('long-next', owner.id)];
	const predicted = chooseNextAvailableMember({
		members: members.map(({ id, name }) => ({ id, name })),
		currentMemberId: owner.id,
		absentMemberIds: [],
		chores,
	});
	expect(predicted).toBe(longNext.id);

	await openPutzen(page, members, chores, []);
	const row = page.locator('#chore-long-next');
	await expect(row).toContainText(`danach ${longNext.name}`);

	for (const theme of ['light', 'dark'] as const) {
		for (const width of [320, 390]) {
			await page.setViewportSize({ width, height: 844 });
			await page.emulateMedia({ colorScheme: theme });
			await page.evaluate(() => window.scrollTo(0, 0));
			const layout = await page.evaluate(() => ({
				viewport: document.documentElement.clientWidth,
				page: document.documentElement.scrollWidth,
			}));
			expect(layout.page).toBeLessThanOrEqual(layout.viewport);
			await page.screenshot({
				path: testInfo.outputPath(`putzen-${width}-${theme}.png`),
				animations: 'disabled',
			});
		}
	}
});

test.describe('chore swap request retry', () => {
	test.use({ serviceWorkers: 'block' });

	test('reuses the idempotency key after an unknown response', async ({ page }) => {
		const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
		const owner: FixtureMember = { id: 'anna', name: 'Anna', color: null, active: true };
		const choreId = 'swap-retry';
		const title = 'Aufgabe swap-retry';
		await openPutzen(page, [viewer, owner], [chore(choreId, owner.id)], []);

		const idempotencyKeys: string[] = [];
		let attempts = 0;
		await page.route(`**/api/wg/${SHARE_CODE}/chores/${choreId}/swap-request`, async (route) => {
			if (route.request().method() !== 'POST') return route.fallback();
			attempts += 1;
			idempotencyKeys.push(route.request().headers()['idempotency-key'] ?? '');
			if (attempts === 1) return route.abort();
			return route.fulfill({ json: { announcement: { id: 'swap-post-1' }, warning: null } });
		});

		const row = page.locator(`#chore-${choreId}`);
		const actionButton = row.getByRole('button', { name: `Aufgabenaktionen: ${title}` });
		await actionButton.click();
		await page.getByRole('button', { name: `Tausch auf der Pinnwand anfragen: ${title}` }).click();
		await expect.poll(() => attempts).toBe(1);
		await expect(
			page.getByRole('alert').filter({ hasText: /Tauschanfrage konnte nicht gepostet werden/ }),
		).toBeVisible();

		await actionButton.click();
		await page.getByRole('button', { name: `Tausch auf der Pinnwand anfragen: ${title}` }).click();
		await expect.poll(() => attempts).toBe(2);
		await expect(page.getByText('Tauschanfrage wurde auf der Pinnwand gepostet.')).toBeVisible();
		expect(idempotencyKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
		expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
	});
	test('does not send a swap request when an idempotency key cannot be created', async ({
		page,
	}) => {
		await page.addInitScript(() => {
			Object.defineProperty(globalThis.crypto, 'randomUUID', {
				configurable: true,
				value: () => {
					throw new Error('unavailable');
				},
			});
		});

		const viewer: FixtureMember = { id: CURRENT_MEMBER, name: 'Abu', color: null, active: true };
		const owner: FixtureMember = { id: 'anna', name: 'Anna', color: null, active: true };
		const choreId = 'swap-no-key';
		const title = 'Aufgabe swap-no-key';
		await openPutzen(page, [viewer, owner], [chore(choreId, owner.id)], []);

		let attempts = 0;
		await page.route(`**/api/wg/${SHARE_CODE}/chores/${choreId}/swap-request`, async (route) => {
			if (route.request().method() !== 'POST') return route.fallback();
			attempts += 1;
			return route.fulfill({ json: { announcement: { id: 'unexpected' }, warning: null } });
		});

		const row = page.locator(`#chore-${choreId}`);
		await row.getByRole('button', { name: `Aufgabenaktionen: ${title}` }).click();
		await page.getByRole('button', { name: `Tausch auf der Pinnwand anfragen: ${title}` }).click();
		await expect(
			page.getByRole('alert').filter({ hasText: /nicht sicher gespeichert/ }),
		).toBeVisible();
		expect(attempts).toBe(0);
	});
});
