// Regression checks for the SEMANTICS/NAVIGATION/LOCALE audit: single <h1> per
// page, WCAG 2.5.3 label-in-name on icon+text buttons, and SPA route-change
// focus (Next's AppRouterAnnouncer never fires across sibling `/wg/[code]/*`
// routes because `document.title` and the page's single <h1> never change).
import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const BASE = `/api/wg/${FIXTURE_WG.shareCode}`;
// Fixture WG name (src/core/infra/e2e-db-down.ts E2E_EXISTING_WG.name) — not
// exported via FIXTURE_WG, so it is duplicated here like the other specs do.
const WG_NAME = 'sadf';

const emptyDashboard = {
	balances: [],
	spendByDay: [],
	totalSpendByCurrency: {},
	weekSpendByCurrency: {},
	monthSpendByCurrency: {},
	totalSpendCents: 0,
	weekSpendCents: 0,
	monthSpendCents: 0,
	openShoppingCount: 0,
	openShoppingTop: [],
	dueChores: [],
	dueRecurringExpenses: [],
	activity: [],
	latestAnnouncement: null,
	myOpenAnnouncements: [],
	absentMembers: [],
	wgHealth: { score: 100, label: 'Alles im Griff', items: [] },
	setup: {
		choreCount: 0,
		hasExpense: false,
		hasShoppingItem: false,
		hasAnnouncement: false,
		notificationsEnabled: false,
	},
};

test('Start page has exactly one <h1>, named after the WG', async ({ page }) => {
	await setupMember(page);
	await page.route(`**${BASE}/dashboard`, (route) => route.fulfill({ json: emptyDashboard }));
	await page.route(`**${BASE}/chat/unread-count`, (route) =>
		route.fulfill({ json: { count: 0, overflow: false } }),
	);

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
	await dismissOnboarding(page);

	// WCAG 1.3.1 / 2.4.6 — WgAppHeader's WG-name heading must be the page's
	// only level-1 heading; the date line below it is a <h2>.
	await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
	await expect(
		page.getByRole('heading', { level: 1, name: `${WG_NAME} – Start`, exact: true }),
	).toBeVisible();
});

test('bottom-nav navigation moves focus to the main landmark', async ({ page }) => {
	await setupMember(page);
	await page.route(`**${BASE}/dashboard`, (route) => route.fulfill({ json: emptyDashboard }));
	await page.route(`**${BASE}/chat/unread-count`, (route) =>
		route.fulfill({ json: { count: 0, overflow: false } }),
	);

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
	await dismissOnboarding(page);

	const nav = page.getByRole('navigation', { name: 'WG Hauptnavigation' });
	const haushalt = nav.getByRole('link', { name: 'Haushalt', exact: true });
	await haushalt.click();

	// Without RouteFocusOnNavigate, the just-activated <a> keeps focus because
	// the shared <main> never remounts across sibling `/wg/[code]/*` routes.
	await expect(page.locator('#main')).toBeFocused();
});

test('new-WG invite card names the visible action first', async ({ page }) => {
	await setupMember(page);
	await page.route(`**${BASE}/dashboard`, (route) => route.fulfill({ json: emptyDashboard }));
	await page.route(`**${BASE}/chat/unread-count`, (route) =>
		route.fulfill({ json: { count: 0, overflow: false } }),
	);

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
	await dismissOnboarding(page);

	// WCAG 2.5.3 — the visible "Mitbewohner einladen" text must be the whole
	// accessible name, not a differently-worded aria-label.
	await expect(
		page.getByRole('button', { name: 'Mitbewohner einladen', exact: true }),
	).toBeVisible();
});

test('subscription pause button names the visible action first, then the subscription', async ({
	page,
}) => {
	await setupMember(page);
	await page.route(`**${BASE}/members*`, (route) =>
		route.fulfill({
			json: {
				members: [
					{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName, color: null, active: true },
				],
			},
		}),
	);
	await page.route(`**${BASE}/recurring-expenses*`, (route) =>
		route.fulfill({
			json: {
				recurringExpenses: [
					{
						id: 'abo-label-audit',
						description: 'Musik-Abo',
						amountCents: 999,
						currency: 'EUR',
						paidByMemberId: FIXTURE_WG.memberId,
						intervalMonths: 1,
						nextDueAt: '2026-10-01T12:00:00.000Z',
						lastCreatedAt: null,
						pausedAt: null,
						splits: [{ debtorMemberId: FIXTURE_WG.memberId, amountCents: 999 }],
					},
				],
			},
		}),
	);

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/abos`);
	await page.getByRole('button', { name: /Details öffnen: Musik-Abo/ }).click();

	// WCAG 2.5.3 — "Pausieren"/"Fortsetzen" must lead the accessible name,
	// disambiguated by the subscription's description.
	await expect(
		page.getByRole('button', { name: 'Pausieren: Musik-Abo', exact: true }),
	).toBeVisible();
});

test('expense settle button names the visible action first, then the debtor', async ({ page }) => {
	const { memberId, memberName, shareCode } = FIXTURE_WG;
	const otherMemberId = '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55';
	await setupMember(page);
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
		route.fulfill({
			json: {
				expenses: [
					{
						id: 'expense-label-audit',
						paidByMemberId: memberId,
						amountCents: 2000,
						currency: 'EUR',
						description: 'Wocheneinkauf',
						imageUrl: null,
						occurredAt: '2026-09-24T17:00:00.000Z',
						createdAt: '2026-09-24T17:00:00.000Z',
						updatedAt: '2026-09-24T17:00:00.000Z',
						splits: [
							{
								id: 'split-label-audit',
								debtorMemberId: otherMemberId,
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

	await navigateToFeature(page, `/wg/${shareCode}/ausgaben`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: /Details öffnen/ }).click();

	// WCAG 2.5.3 — "Als bezahlt eintragen"/"Wieder öffnen" must lead the
	// accessible name, disambiguated by the debtor's name.
	await expect(
		page.getByRole('button', { name: 'Als bezahlt eintragen: Mina', exact: true }),
	).toBeVisible();
});
