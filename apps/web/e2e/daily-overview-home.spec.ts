import { expect, test } from '@playwright/test';
import { getBerlinWeekWindow } from '../src/core/reads/dashboard-insights';
import { instantAtBerlinWallTime } from '../src/core/utils/berlin-day';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

const BASE = '/api/wg/MTE8PZAT';

function dayKeyOffset(dayKey: string, offset: number): string {
	const [year, month, day] = dayKey.split('-').map(Number);
	return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + offset))
		.toISOString()
		.slice(0, 10);
}

function nextAgendaDay(todayKey: string): string {
	const weekday = new Date(`${todayKey}T00:00:00.000Z`).getUTCDay();
	const daysUntilSunday = (7 - weekday) % 7;
	return dayKeyOffset(todayKey, Math.min(1, daysUntilSunday));
}

function atBerlin(dayKey: string, minutes: number): string {
	const date = instantAtBerlinWallTime(dayKey, minutes);
	if (!date) throw new Error(`Invalid Berlin wall time: ${dayKey} ${minutes}`);
	return date.toISOString();
}

function fixtureDashboard(dueChores: unknown[] = []) {
	return {
		balances: [
			{
				memberId: FIXTURE_WG.memberId,
				memberName: FIXTURE_WG.memberName,
				color: null,
				paidCents: 0,
				owedCents: 1250,
				balanceCents: -1250,
				currency: 'EUR',
			},
			{
				memberId: 'anna',
				memberName: 'Anna',
				color: null,
				paidCents: 1250,
				owedCents: 0,
				balanceCents: 1250,
				currency: 'EUR',
			},
			{
				memberId: FIXTURE_WG.memberId,
				memberName: FIXTURE_WG.memberName,
				color: null,
				paidCents: 300,
				owedCents: 0,
				balanceCents: 300,
				currency: 'CHF',
			},
			{
				memberId: 'anna',
				memberName: 'Anna',
				color: null,
				paidCents: 0,
				owedCents: 300,
				balanceCents: -300,
				currency: 'CHF',
			},
		],
		spendByDay: [],
		totalSpendByCurrency: {},
		weekSpendByCurrency: {},
		monthSpendByCurrency: {},
		totalSpendCents: null,
		weekSpendCents: null,
		monthSpendCents: null,
		openShoppingCount: 3,
		openShoppingTop: ['Milch'],
		dueChores,
		activity: [],
		latestAnnouncement: null,
		myOpenAnnouncements: [
			{
				id: 'request-1',
				kind: 'request',
				content: 'Paket abholen',
				createdAt: new Date().toISOString(),
			},
		],
		wgHealth: { score: 100, label: 'ruhig', items: [] },
		dueRecurringExpenses: [
			{
				id: 'internet',
				description: 'Internet',
				amountCents: 2990,
				currency: 'EUR',
				nextDueAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			},
		],
		absentMembers: [],
		setup: {
			choreCount: dueChores.length,
			hasExpense: true,
			hasShoppingItem: true,
			hasAnnouncement: true,
			notificationsEnabled: false,
		},
	};
}

async function mockDashboard(page: import('@playwright/test').Page, dueChores: unknown[]) {
	await page.route(`**${BASE}/dashboard`, (route) =>
		route.fulfill({ status: 200, json: fixtureDashboard(dueChores) }),
	);
	await page.route(`**${BASE}/chat/unread-count`, (route) =>
		route.fulfill({ status: 200, json: { count: 0, overflow: false } }),
	);
}

test('shows personal actions and a separate Berlin week agenda', async ({ page }, testInfo) => {
	const fixtureNow = Date.parse('2026-09-27T10:00:00.000Z');
	await page.clock.install({ time: new Date(fixtureNow) });
	await setupMember(page);
	const window = getBerlinWeekWindow(fixtureNow);
	const agendaDay = nextAgendaDay(window.todayKey);
	const previousWeek = dayKeyOffset(agendaDay, -7);
	const yesterday = dayKeyOffset(window.todayKey, -1);
	const chores = [
		{
			id: 'mine',
			title: 'Bad putzen',
			nextDueAt: atBerlin(window.todayKey, 23 * 60),
			overdue: false,
			assignedMemberId: FIXTURE_WG.memberId,
			assignedMemberName: FIXTURE_WG.memberName,
			assignedColor: null,
		},
		{
			id: 'overdue',
			title: 'Flur reinigen',
			nextDueAt: atBerlin(yesterday, 10 * 60),
			overdue: true,
			assignedMemberId: 'anna',
			assignedMemberName: 'Anna',
			assignedColor: null,
		},
		{
			id: 'other',
			title: 'Küche putzen',
			nextDueAt: atBerlin(agendaDay, 11 * 60),
			overdue: false,
			assignedMemberId: 'anna',
			assignedMemberName: 'Anna',
			assignedColor: null,
		},
	];
	await mockDashboard(page, chores);
	await page.route(/\/api\/wg\/MTE8PZAT\/events\?/, (route) =>
		route.fulfill({
			status: 200,
			json: {
				events: [
					{
						id: 'all-day',
						title: 'WG-Frühstück',
						description: null,
						startsAt: `${agendaDay}T00:00:00.000Z`,
						endsAt: null,
						allDay: true,
						location: 'Küche',
						recurrence: null,
					},
					{
						id: 'weekly',
						title: 'WG-Abendessen',
						description: null,
						startsAt: atBerlin(previousWeek, 18 * 60),
						endsAt: null,
						allDay: false,
						location: 'Küche',
						recurrence: 'FREQ=WEEKLY',
					},
				],
			},
		}),
	);

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
	await dismissOnboarding(page);

	const personal = page.getByRole('region', { name: 'Für dich' });
	await expect(personal.getByText('Bad putzen', { exact: true })).toBeVisible();
	await expect(personal.getByText('Flur reinigen', { exact: true })).toHaveCount(0);
	await personal.getByRole('button', { name: 'Weitere anzeigen (2)' }).click();
	await page.waitForTimeout(300);
	await expect(personal.getByText('WG · 3 offene Artikel')).toBeVisible();
	await expect(personal.getByText(/WG-Fixkosten/)).toBeVisible();
	await expect(personal.getByText('An Anna', { exact: true })).toBeVisible();
	await expect(personal.getByText('Von Anna', { exact: true })).toBeVisible();
	await expect(personal.getByText(/12,50/)).toBeVisible();
	const euroAmount = personal.locator('span.font-mono.tabular-nums').filter({ hasText: '12,50' });
	const chfAmount = personal.locator('span.font-mono.tabular-nums').filter({ hasText: '3,00' });
	await expect(euroAmount).toHaveCount(1);
	await expect(euroAmount).toHaveClass(/font-medium/);
	await expect(euroAmount).toHaveText(/-12,50\s*€/);
	await expect(chfAmount).toHaveCount(1);
	await expect(chfAmount).toHaveClass(/font-medium/);
	await expect(chfAmount).toHaveText(/\+3,00\s*CHF/);

	const agenda = page.getByRole('region', { name: 'Diese Woche' });
	await expect(agenda.getByRole('heading', { name: 'Überfällig' })).toBeVisible();
	await expect(agenda.getByText('Flur reinigen', { exact: true })).toBeVisible();
	await expect(agenda.getByText('Küche putzen', { exact: true })).toBeVisible();
	await expect(agenda.getByText('WG-Frühstück', { exact: true })).toBeVisible();
	await expect(agenda.getByText('WG-Abendessen', { exact: true })).toBeVisible();
	await expect(agenda.getByText('Bad putzen', { exact: true })).toHaveCount(0);

	const weekHeader = agenda.locator(':scope > div').first();
	const weekHeading = agenda.getByRole('heading', { name: 'Diese Woche' });
	const calendarLink = agenda.getByRole('link', { name: 'Kalender' });
	for (const theme of ['light', 'dark'] as const) {
		for (const width of [320, 360, 390]) {
			await page.setViewportSize({ width, height: 844 });
			await page.emulateMedia({ colorScheme: theme });
			await expect
				.poll(() => page.locator('html').evaluate((node) => node.classList.contains('dark')))
				.toBe(theme === 'dark');
			await page.evaluate(() => window.scrollTo(0, 0));
			const layout = await page.evaluate(() => ({
				viewport: document.documentElement.clientWidth,
				page: document.documentElement.scrollWidth,
			}));
			expect(layout.page).toBeLessThanOrEqual(layout.viewport);
			await expect(calendarLink).toBeVisible();
			const [rootFontSize, hitTarget] = await Promise.all([
				page.locator('html').evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
				calendarLink.evaluate((node) => {
					const target = getComputedStyle(node, '::after');
					return {
						height: Number.parseFloat(target.height),
						minWidth: Number.parseFloat(target.minWidth),
					};
				}),
			]);
			expect(rootFontSize).toBeLessThan(32);
			expect(hitTarget.height).toBeGreaterThanOrEqual(44);
			expect(hitTarget.minWidth).toBeGreaterThanOrEqual(44);
			await calendarLink.focus();
			await expect(calendarLink).toBeFocused();
			await weekHeader.screenshot({
				path: testInfo.outputPath(`week-header-${width}-${theme}.png`),
				animations: 'disabled',
			});
			await page.screenshot({
				path: testInfo.outputPath(`home-${width}-${theme}.png`),
				animations: 'disabled',
			});

			const lastAgendaRow = agenda.getByText('WG-Abendessen', { exact: true });
			// Ganz nach unten scrollen wie ein Nutzer: die Seite hält unten Platz für die Navigation frei.
			// `instant`: html has scroll-behavior:smooth, so a plain scrollTo would still be animating.
			await page.evaluate(() =>
				window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }),
			);
			const [rowBounds, navBounds] = await Promise.all([
				lastAgendaRow.evaluate((node) => node.getBoundingClientRect().toJSON()),
				page
					.locator('nav[data-app-chrome]')
					.evaluate((node) => node.getBoundingClientRect().toJSON()),
			]);
			expect(rowBounds.bottom).toBeLessThanOrEqual(navBounds.top);
			await page.screenshot({
				path: testInfo.outputPath(`home-agenda-${width}-${theme}.png`),
				animations: 'disabled',
			});
		}
	}

	for (const theme of ['light', 'dark'] as const) {
		for (const width of [320, 360, 390]) {
			await page.setViewportSize({ width, height: 844 });
			await page.emulateMedia({ colorScheme: theme });
			await expect
				.poll(() => page.locator('html').evaluate((node) => node.classList.contains('dark')))
				.toBe(theme === 'dark');
			await page.locator('html').evaluate((node) => {
				node.style.fontSize = '32px';
			});
			await page.evaluate(() => window.scrollTo(0, 0));

			await expect(calendarLink).toBeVisible();
			const [rootFontSize, headingFontSize, hitTarget] = await Promise.all([
				page.locator('html').evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
				weekHeading.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
				calendarLink.evaluate((node) => {
					const target = getComputedStyle(node, '::after');
					return {
						height: Number.parseFloat(target.height),
						minWidth: Number.parseFloat(target.minWidth),
					};
				}),
			]);
			expect(rootFontSize).toBe(32);
			expect(headingFontSize).toBeGreaterThanOrEqual(26);
			expect(hitTarget.height).toBeGreaterThanOrEqual(44);
			expect(hitTarget.minWidth).toBeGreaterThanOrEqual(44);
			await calendarLink.focus();
			await expect(calendarLink).toBeFocused();

			const layout = await page.evaluate(() => ({
				viewport: document.documentElement.clientWidth,
				page: document.documentElement.scrollWidth,
			}));
			expect(layout.page).toBeLessThanOrEqual(layout.viewport);
			await weekHeader.screenshot({
				path: testInfo.outputPath(`week-header-32px-${width}-${theme}.png`),
				animations: 'disabled',
			});
			await page.screenshot({
				path: testInfo.outputPath(`home-32px-${width}-${theme}.png`),
				animations: 'disabled',
			});
		}
	}
});

test('keeps chores visible when the independent event read fails', async ({ page }) => {
	await setupMember(page);
	const window = getBerlinWeekWindow(Date.now());
	const agendaDay = nextAgendaDay(window.todayKey);
	await mockDashboard(page, [
		{
			id: 'other',
			title: 'Küche putzen',
			nextDueAt: atBerlin(agendaDay, 11 * 60),
			overdue: false,
			assignedMemberId: 'anna',
			assignedMemberName: 'Anna',
			assignedColor: null,
		},
	]);
	await page.route(/\/api\/wg\/MTE8PZAT\/events\?/, (route) =>
		route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } }),
	);

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
	await dismissOnboarding(page);

	const agenda = page.getByRole('region', { name: 'Diese Woche' });
	await expect(agenda.getByText('Küche putzen', { exact: true })).toBeVisible();
	await expect(agenda.getByText('Termine konnten nicht geladen werden.')).toBeVisible();
	await expect(agenda.getByText(/keine Termine oder Putzaufgaben/i)).toHaveCount(0);
});

test('keeps one completion key across 5xx, 429, and offline retries', async ({ page }) => {
	await setupMember(page);
	const window = getBerlinWeekWindow(Date.now());
	const chore = {
		id: 'mine',
		title: 'Bad putzen',
		nextDueAt: atBerlin(window.todayKey, 23 * 60),
		overdue: false,
		assignedMemberId: FIXTURE_WG.memberId,
		assignedMemberName: FIXTURE_WG.memberName,
		assignedColor: null,
	};
	let dashboardReads = 0;
	await page.route(`**${BASE}/dashboard`, (route) => {
		dashboardReads += 1;
		return route.fulfill({
			status: 200,
			json: fixtureDashboard(dashboardReads === 1 ? [chore] : []),
		});
	});
	await page.route(`**${BASE}/chat/unread-count`, (route) =>
		route.fulfill({ status: 200, json: { count: 0, overflow: false } }),
	);
	await page.route(/\/api\/wg\/MTE8PZAT\/events\?/, (route) =>
		route.fulfill({ status: 200, json: { events: [] } }),
	);
	const attempts: Array<number | 'offline'> = [503, 429, 'offline', 200];
	const idempotencyKeys: string[] = [];
	await page.route(/\/api\/wg\/MTE8PZAT\/chores\/mine\/complete$/, async (route) => {
		const response = attempts[idempotencyKeys.length];
		idempotencyKeys.push(route.request().headers()['idempotency-key'] ?? '');
		if (response === 'offline') return route.abort('failed');
		return route.fulfill({
			status: response ?? 500,
			json: response === 200 ? { ok: true } : { error: 'temporarily_unavailable' },
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
	await dismissOnboarding(page);
	const confirmCompletion = async (): Promise<void> => {
		await page.getByRole('button', { name: 'Abhaken: Bad putzen' }).click();
		await page.getByRole('button', { name: 'Bestätigen: Bad putzen erledigt' }).click();
	};

	await confirmCompletion();
	await expect(
		page.getByText('Erledigt konnte nicht gespeichert werden. Versuche es gleich erneut.'),
	).toBeVisible();
	await confirmCompletion();
	await expect(
		page.getByText('Erledigt konnte nicht gespeichert werden. Versuche es gleich erneut.'),
	).toBeVisible();
	await confirmCompletion();
	await expect(
		page.getByText('Offline: Öffne den Putzplan, dort wird die Erledigung vorgemerkt.'),
	).toBeVisible();
	await confirmCompletion();
	await expect(page.getByText('Bad putzen erledigt.')).toBeVisible();
	await expect.poll(() => idempotencyKeys.length).toBe(4);
	expect(new Set(idempotencyKeys).size).toBe(1);
	await expect(page.getByText('Bad putzen', { exact: true })).toHaveCount(0);
});

test('shows a saving label instead of "tap again" while a completion request is in flight', async ({
	page,
}) => {
	await setupMember(page);
	const chore = {
		id: 'mine',
		title: 'Bad putzen',
		nextDueAt: atBerlin(getBerlinWeekWindow(Date.now()).todayKey, 23 * 60),
		overdue: false,
		assignedMemberId: FIXTURE_WG.memberId,
		assignedMemberName: FIXTURE_WG.memberName,
		assignedColor: null,
	};
	await mockDashboard(page, [chore]);
	await page.route(/\/api\/wg\/MTE8PZAT\/events\?/, (route) =>
		route.fulfill({ status: 200, json: { events: [] } }),
	);
	let resolveComplete: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		resolveComplete = resolve;
	});
	await page.route(/\/api\/wg\/MTE8PZAT\/chores\/mine\/complete$/, async (route) => {
		await held;
		return route.fulfill({ status: 200, json: { ok: true } });
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: 'Abhaken: Bad putzen' }).click();
	await page.getByRole('button', { name: 'Bestätigen: Bad putzen erledigt' }).click();

	// While the request is in flight the button is disabled (still labelled
	// as the armed "confirm" action for a11y) but the subtitle must say it is
	// saving, not repeat the now-stale "tap again to confirm" instruction.
	await expect(
		page.getByRole('button', { name: 'Bestätigen: Bad putzen erledigt' }),
	).toBeDisabled();
	await expect(page.getByText('Wird gespeichert …')).toBeVisible();
	await expect(page.getByText('Nochmal tippen zum Bestätigen')).toHaveCount(0);

	resolveComplete?.();
	await expect(page.getByText('Bad putzen erledigt.')).toBeVisible();
});

test('does not show a settled or empty state when the dashboard read fails', async ({ page }) => {
	await setupMember(page);
	await page.route(`**${BASE}/dashboard`, (route) =>
		route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } }),
	);
	await page.route(`**${BASE}/chat/unread-count`, (route) =>
		route.fulfill({ status: 200, json: { count: 0, overflow: false } }),
	);
	await page.route(/\/api\/wg\/MTE8PZAT\/events\?/, (route) =>
		route.fulfill({ status: 200, json: { events: [] } }),
	);

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
	await dismissOnboarding(page);

	const personal = page.getByRole('region', { name: 'Für dich' });
	await expect(
		personal.getByText('Deine persönlichen Aufgaben konnten nicht geladen werden.'),
	).toBeVisible();
	await expect(page.getByText('Alles erledigt.', { exact: false })).toHaveCount(0);
	await expect(page.getByText('Ausgeglichen', { exact: true })).toHaveCount(0);
});

test('refreshes the agenda range after Berlin midnight on resume', async ({ page }) => {
	await page.clock.install({ time: new Date('2026-09-27T21:59:30.000Z') });
	await setupMember(page);
	await mockDashboard(page, []);
	await page.route(`**${BASE}/chat/unread-count`, (route) =>
		route.fulfill({ status: 200, json: { count: 0, overflow: false } }),
	);
	const eventRangeStarts: string[] = [];
	await page.route(/\/api\/wg\/MTE8PZAT\/events\?/, (route) => {
		const url = new URL(route.request().url());
		eventRangeStarts.push(url.searchParams.get('from') ?? '');
		return route.fulfill({ status: 200, json: { events: [] } });
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}`);
	await dismissOnboarding(page);
	await expect.poll(() => eventRangeStarts.length).toBe(1);
	await expect(eventRangeStarts[0]).toBe('2026-09-26T22:00:00.000Z');

	await page.clock.fastForward(60_000);
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect.poll(() => eventRangeStarts.includes('2026-09-27T22:00:00.000Z')).toBe(true);
});
