// Calendar all-day/timed events across Berlin DST and extreme time zones, recurrence, ICS, month grid.
// Why: A calendar day must be identical for every device time zone.

import { type Route, expect, test } from '@playwright/test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
	type EventInput,
	expandAgendaRecurrence,
	expandRecurrence,
} from '../src/features/events/events';
import { computeTomorrowUtcWindow } from '../src/features/events/server/event-reminder-window';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './support/helpers';

test.describe('calendar fixes', () => {
	const ALL_DAY_EVENT: EventInput = {
		id: 'all-day-pilot',
		title: 'Pilottag',
		description: null,
		startsAt: '2026-09-29T00:00:00.000Z',
		endsAt: null,
		allDay: true,
		location: null,
		recurrence: null,
	};

	function expandAgenda(event: EventInput, from: string | Date, to: string | Date) {
		return expandAgendaRecurrence(event, new Date(from), new Date(to));
	}

	test('keeps inclusive multi-day all-day overlap across the Berlin fall DST date', () => {
		const occurrences = expandAgenda(
			{
				...ALL_DAY_EVENT,
				id: 'multi-day-pilot',
				startsAt: '2026-10-24T00:00:00.000Z',
				endsAt: '2026-10-25T00:00:00.000Z',
				recurrence: null,
			},
			'2026-10-25T18:00:00.000Z',
			'2026-10-25T22:00:00.000Z',
		);

		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]).toMatchObject({
			startsAt: '2026-10-24T00:00:00.000Z',
			endsAt: '2026-10-25T00:00:00.000Z',
		});
	});

	test('matches event display dates and query windows using inclusive overlap', async () => {
		const eventHelpers = (await import('../src/features/events/events')) as unknown as {
			eventOverlapsCalendarDay?: (
				event: { startsAt: string; endsAt: string | null; allDay: boolean },
				day: Date,
			) => boolean;
		};
		const windowHelpers = (await import(
			'../src/features/events/server/event-reminder-window'
		)) as unknown as {
			buildEventsWindowFilter?: (from: Date, to: Date) => SQL | undefined;
		};
		const eventOverlapsCalendarDay = eventHelpers.eventOverlapsCalendarDay;
		const buildEventsWindowFilter = windowHelpers.buildEventsWindowFilter;
		expect(eventOverlapsCalendarDay).toBeDefined();
		expect(buildEventsWindowFilter).toBeDefined();
		if (!eventOverlapsCalendarDay || !buildEventsWindowFilter) return;

		const event = {
			startsAt: '2026-09-22T00:00:00.000Z',
			endsAt: '2026-09-24T00:00:00.000Z',
			allDay: true,
		};
		expect(
			[22, 23, 24, 25].map((day) => eventOverlapsCalendarDay(event, new Date(2026, 8, day))),
		).toEqual([true, true, true, false]);

		const from = new Date('2026-09-23T12:00:00.000Z');
		const to = new Date('2026-09-26T00:00:00.000Z');
		const filter = buildEventsWindowFilter(from, to);
		expect(filter).toBeDefined();
		if (!filter) return;
		const query = new PgDialect().sqlToQuery(filter);
		const startsAtUpperBound = query.sql.match(/starts_at"\s*<=\s*\$(\d+)/);
		expect(startsAtUpperBound).not.toBeNull();
		expect(query.params[Number(startsAtUpperBound?.[1]) - 1]).toBe(to.toISOString());
		const allDayBoundary = query.sql.match(
			/"wg_events"\."all_day"\s*=\s*\$(\d+)\s+and\s+"wg_events"\."ends_at"\s*>=\s*\$(\d+)/,
		);
		expect(allDayBoundary).not.toBeNull();
		expect(query.params[Number(allDayBoundary?.[1]) - 1]).toBe(true);
		expect(query.params[Number(allDayBoundary?.[2]) - 1]).toBe(from.toISOString());
		const timedBoundary = query.sql.match(
			/"wg_events"\."all_day"\s*=\s*\$(\d+)\s+and\s+"wg_events"\."ends_at"\s*>\s*\$(\d+)/,
		);
		expect(timedBoundary).not.toBeNull();
		expect(query.params[Number(timedBoundary?.[1]) - 1]).toBe(false);
		expect(query.params[Number(timedBoundary?.[2]) - 1]).toBe(from.toISOString());
	});

	test('shows a fetched multi-day event on every overlapping month-grid day', async ({ page }) => {
		test.skip(
			process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
			'requires the local fixture server',
		);

		const now = new Date();
		const year = Number(
			new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', year: 'numeric' }).format(now),
		);
		const month = Number(
			new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', month: 'numeric' }).format(now),
		);
		const startsAt = new Date(Date.UTC(year, month - 1, 2)).toISOString();
		const endsAt = new Date(Date.UTC(year, month - 1, 4)).toISOString();
		const selectedDayLabel = new Intl.DateTimeFormat('de-DE', {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'Europe/Berlin',
		}).format(new Date(Date.UTC(year, month - 1, 3)));
		const event = {
			id: '33333333-3333-4333-8333-333333333333',
			title: 'Mehrtagestermin',
			description: null,
			startsAt,
			endsAt,
			allDay: true,
			location: null,
			recurrence: null,
			wgId: FIXTURE_WG.id,
			createdByMemberId: FIXTURE_WG.memberId,
			createdAt: startsAt,
			updatedAt: startsAt,
		};

		await setupMember(page);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/events*`, (route) =>
			route.fulfill({ json: { events: [event] } }),
		);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/chores*`, (route) =>
			route.fulfill({ json: { chores: [] } }),
		);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/kalender`);
		await dismissOnboarding(page);
		await page.getByRole('tab', { name: 'Monat' }).click();
		const occupiedDays = page.locator('[data-day-cell][aria-label$=", 1 Termin"]');
		await expect(occupiedDays).toHaveCount(3);
		await page.getByRole('button', { name: selectedDayLabel }).click();
		await expect(
			page
				.getByRole('region', { name: 'Termine am ausgewählten Tag' })
				.getByText('Mehrtagestermin'),
		).toBeVisible();
	});

	test('keeps the month grid accessible and keyboard focus after paging at 320px', async ({
		page,
	}) => {
		test.skip(
			process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
			'requires the local fixture server',
		);

		await page.setViewportSize({ width: 320, height: 812 });
		await setupMember(page);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/events*`, (route) =>
			route.fulfill({ json: { events: [] } }),
		);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/chores*`, (route) =>
			route.fulfill({ json: { chores: [] } }),
		);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/kalender`);
		await dismissOnboarding(page);
		await page.getByRole('tab', { name: 'Monat' }).click();

		const grid = page.getByRole('grid');
		const rows = grid.getByRole('row');
		await expect(rows.first().getByRole('columnheader')).toHaveCount(7);
		await expect(rows.nth(1).getByRole('gridcell')).toHaveCount(7);
		const gridCells = grid.getByRole('gridcell');
		const cellCount = await gridCells.count();
		expect(cellCount).toBeGreaterThanOrEqual(28);
		expect(cellCount).toBeLessThanOrEqual(42);
		expect(cellCount % 7).toBe(0);
		await expect(grid.locator('[role="gridcell"][aria-selected]')).toHaveCount(cellCount);

		const dayButtons = page.locator('[data-day-cell]');
		const assertPhoneLayout = async (colorScheme: 'light' | 'dark', fontSize: number) => {
			await expect
				.poll(() => page.locator('html').evaluate((html) => html.classList.contains('dark')))
				.toBe(colorScheme === 'dark');
			const pageState = await page.evaluate(() => ({
				viewport: document.documentElement.clientWidth,
				scroll: document.documentElement.scrollWidth,
				fontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
				prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
				darkClass: document.documentElement.classList.contains('dark'),
			}));
			expect(pageState.scroll).toBeLessThanOrEqual(pageState.viewport);
			expect(pageState.fontSize).toBe(fontSize);
			expect(pageState.prefersDark).toBe(colorScheme === 'dark');
			expect(pageState.darkClass).toBe(colorScheme === 'dark');
			const widths = await dayButtons.evaluateAll((buttons) =>
				buttons.map((button) => button.getBoundingClientRect().width),
			);
			expect(Math.min(...widths)).toBeGreaterThanOrEqual(44);
			const tabsFit = await page
				.getByRole('tab')
				.evaluateAll((tabs) => tabs.every((tab) => tab.scrollWidth <= tab.clientWidth));
			expect(tabsFit).toBe(true);
		};
		const baseFontSize = await page.evaluate(() =>
			Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
		);

		const firstMonth = await grid.getAttribute('aria-label');
		await page.locator('[data-day-cell][tabindex="0"]').press('PageDown');
		await expect.poll(() => grid.getAttribute('aria-label')).not.toBe(firstMonth);
		const focusedDay = page.locator('[data-day-cell]:focus');
		await expect(focusedDay).toHaveCount(1);
		await expect(focusedDay).toHaveAttribute('tabindex', '0');
		const focusedLabel = await focusedDay.getAttribute('aria-label');
		await focusedDay.press('ArrowRight');
		await expect
			.poll(() => page.locator('[data-day-cell]:focus').getAttribute('aria-label'))
			.not.toBe(focusedLabel);
		await expect(page.locator('[data-day-cell]:focus')).toHaveAttribute('tabindex', '0');

		for (const width of [320, 360]) {
			await page.setViewportSize({ width, height: 812 });
			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme });
				await assertPhoneLayout(colorScheme, baseFontSize);
			}
		}

		await page.route('**/__e2e-font-scale-200.css', (route) =>
			route.fulfill({ contentType: 'text/css', body: ':root { font-size: 32px !important; }' }),
		);
		await page.addStyleTag({
			url: new URL('/__e2e-font-scale-200.css', page.url()).toString(),
		});
		for (const width of [320, 360]) {
			await page.setViewportSize({ width, height: 812 });
			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme });
				await assertPhoneLayout(colorScheme, 32);
			}
		}
		await expect(page.getByRole('tab', { name: 'Agenda' })).toBeVisible();
		await expect(page.getByRole('tab', { name: 'Monat' })).toBeVisible();
	});

	test('uses Berlin calendar boundaries for all-day overlap and recurrence search', () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = 'Europe/Berlin';
		try {
			expect(
				expandAgenda(ALL_DAY_EVENT, '2026-09-28T22:01:00.000Z', '2026-09-28T23:00:00.000Z'),
			).toHaveLength(1);
			expect(
				expandAgenda(ALL_DAY_EVENT, '2026-09-29T22:30:00.000Z', '2026-09-29T23:00:00.000Z'),
			).toHaveLength(0);

			const fallDstEvent = { ...ALL_DAY_EVENT, startsAt: '2026-10-25T00:00:00.000Z' };
			expect(
				expandAgenda(fallDstEvent, '2026-10-24T22:30:00.000Z', '2026-10-24T23:00:00.000Z'),
			).toHaveLength(1);
			expect(
				expandAgenda(fallDstEvent, '2026-10-25T23:30:00.000Z', '2026-10-26T00:00:00.000Z'),
			).toHaveLength(0);

			const daily = {
				...ALL_DAY_EVENT,
				recurrence: 'FREQ=DAILY;COUNT=2',
			};
			expect(
				expandAgenda(daily, '2026-09-29T22:30:00.000Z', '2026-09-29T23:00:00.000Z').map(
					(occurrence) => occurrence.startsAt,
				),
			).toEqual(['2026-09-30T00:00:00.000Z']);
		} finally {
			if (previousTimezone === undefined) Reflect.deleteProperty(process.env, 'TZ');
			else process.env.TZ = previousTimezone;
		}
	});

	test('uses the runtime local calendar date before a UTC+14 event marker', () => {
		const previousTimezone = process.env.TZ;
		process.env.TZ = 'Pacific/Kiritimati';
		try {
			expect(
				expandAgenda(
					{ ...ALL_DAY_EVENT, startsAt: '2026-01-01T00:00:00.000Z' },
					'2025-12-31T10:30:00.000Z',
					'2025-12-31T11:00:00.000Z',
				),
			).toHaveLength(1);
			expect(
				expandAgenda(
					{ ...ALL_DAY_EVENT, startsAt: '2026-01-01T00:00:00.000Z' },
					'2026-01-01T10:30:00.000Z',
					'2026-01-01T11:00:00.000Z',
				),
			).toHaveLength(0);
		} finally {
			if (previousTimezone === undefined) Reflect.deleteProperty(process.env, 'TZ');
			else process.env.TZ = previousTimezone;
		}
	});

	test('cron Berlin window excludes a finished all-day event on a UTC host', () => {
		const window = computeTomorrowUtcWindow(new Date('2026-09-29T09:00:00.000Z'));
		expect(window.start.toISOString()).toBe('2026-09-29T22:00:00.000Z');
		expect(expandRecurrence(ALL_DAY_EVENT, window.start, window.end)).toHaveLength(0);
	});

	test('edit recurrence uses the canonical select and sends an RFC rule', async ({ page }) => {
		test.skip(
			process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
			'requires the local fixture server',
		);

		const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		const event = {
			id: '11111111-1111-4111-8111-111111111111',
			title: 'WG-Meeting',
			description: null,
			startsAt,
			endsAt: null,
			allDay: false,
			location: null,
			recurrence: 'FREQ=WEEKLY',
			wgId: FIXTURE_WG.id,
			createdByMemberId: FIXTURE_WG.memberId,
			createdAt: startsAt,
			updatedAt: startsAt,
		};
		let patchBody: Record<string, unknown> | null = null;
		let patchMethod: string | null = null;
		const handleEventsRoute = async (route: Route): Promise<void> => {
			patchMethod = route.request().method();
			if (patchMethod === 'PATCH') {
				patchBody = route.request().postDataJSON() as Record<string, unknown>;
				await route.fulfill({ json: { event: { ...event, ...patchBody } } });
				return;
			}
			await route.fulfill({ json: { events: [event] } });
		};

		await setupMember(page);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/events*`, handleEventsRoute);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/events/**`, handleEventsRoute);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/chores*`, (route) =>
			route.fulfill({ json: { chores: [] } }),
		);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/kalender`);
		await dismissOnboarding(page);
		await page
			.getByRole('button', { name: 'Termin bearbeiten: WG-Meeting', exact: true })
			.first()
			.click();

		const recurrence = page.locator('#event-edit-recurrence');
		await expect(recurrence).toHaveValue('WEEKLY');
		await recurrence.selectOption('DAILY');
		await page.getByRole('button', { name: 'Speichern', exact: true }).click();
		await expect.poll(() => patchMethod).toBe('PATCH');
		await expect
			.poll(() => patchBody)
			.toEqual(expect.objectContaining({ recurrence: 'FREQ=DAILY' }));
	});

	test('successful deletion removes an event restored by a concurrent refresh', async ({
		page,
	}) => {
		test.skip(
			process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
			'requires the local fixture server',
		);
		const event: EventInput = {
			id: '33333333-3333-4333-8333-333333333333',
			title: 'Termin mit laufender Aktualisierung',
			description: null,
			startsAt: new Date(Date.now() + 86_400_000).toISOString(),
			endsAt: null,
			allDay: false,
			location: null,
			recurrence: null,
		};
		let markDeleteStarted: () => void = () => {};
		let releaseDelete: () => void = () => {};
		const deleteStarted = new Promise<void>((resolve) => {
			markDeleteStarted = resolve;
		});
		const deleteGate = new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});
		await setupMember(page);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/events*`, (route) =>
			route.fulfill({ json: { events: [event] } }),
		);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/events/${event.id}`, async (route) => {
			markDeleteStarted();
			await deleteGate;
			await route.fulfill({ json: { deleted: true } });
		});
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/chores*`, (route) =>
			route.fulfill({ json: { chores: [] } }),
		);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/kalender`);
		await dismissOnboarding(page);
		const eventButton = page.getByRole('button', {
			name: `Termin bearbeiten: ${event.title}`,
			exact: true,
			includeHidden: true,
		});
		await eventButton.click();
		await page.getByRole('button', { name: 'Termin löschen', exact: true }).click();
		await page
			.getByRole('alertdialog')
			.getByRole('button', { name: 'Löschen', exact: true })
			.click();
		await deleteStarted;
		try {
			await expect(eventButton).toHaveCount(0);
			await page.evaluate(() => window.dispatchEvent(new Event('focus')));
			await expect(eventButton).toHaveCount(1);
		} finally {
			releaseDelete();
		}
		await expect(page.getByRole('heading', { name: 'Termin bearbeiten', exact: true })).toHaveCount(
			0,
		);
		await expect(eventButton).toHaveCount(0);
		await expect(page.getByText('Termin gelöscht.')).toBeVisible();
	});

	test('push link highlights its event and a 403 names who may change it', async ({ page }) => {
		test.skip(
			process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
			'requires the local fixture server',
		);
		const event = {
			id: '44444444-4444-4444-8444-444444444444',
			title: 'Termin aus Push-Link',
			description: null,
			startsAt: new Date(Date.now() + 86_400_000).toISOString(),
			endsAt: null,
			allDay: false,
			location: null,
			recurrence: null,
			// Own event, so the UI offers delete; the 403 simulates a server-side role change.
			createdByMemberId: FIXTURE_WG.memberId,
		};
		await setupMember(page);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/events*`, (route) =>
			route.fulfill({ json: { events: [event] } }),
		);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/events/${event.id}`, (route) =>
			route.fulfill({ status: 403, json: { error: 'not_owner' } }),
		);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/chores*`, (route) =>
			route.fulfill({ json: { chores: [] } }),
		);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/kalender?highlight=${event.id}`);
		await dismissOnboarding(page);
		await expect(page.locator(`#event-${event.id}`)).toBeVisible();
		await page
			.getByRole('button', { name: `Termin bearbeiten: ${event.title}`, exact: true })
			.click();
		await page.getByRole('button', { name: 'Termin löschen', exact: true }).click();
		await page
			.getByRole('alertdialog')
			.getByRole('button', { name: 'Löschen', exact: true })
			.click();
		await expect(
			page.getByRole('alert').filter({ hasText: 'Das dürfen nur WG-Admins' }).first(),
		).toBeVisible();
	});

	test('keeps complex recurrence on title-only save and replaces it explicitly', async ({
		page,
	}) => {
		test.skip(
			process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
			'requires the local fixture server',
		);
		await page.setViewportSize({ width: 320, height: 740 });
		await page.addInitScript(() => localStorage.setItem('manawg-theme', 'light'));

		const complexRule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=4';
		const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
		let event = {
			id: '22222222-2222-4222-8222-222222222222',
			title: 'WG-Meeting',
			description: null,
			startsAt,
			endsAt: null,
			allDay: false,
			location: null,
			recurrence: complexRule,
			wgId: FIXTURE_WG.id,
			createdByMemberId: FIXTURE_WG.memberId,
			createdAt: startsAt,
			updatedAt: startsAt,
		};
		const patches: Array<Record<string, unknown>> = [];
		const handleEventsRoute = async (route: Route): Promise<void> => {
			if (route.request().method() === 'PATCH') {
				const patch = route.request().postDataJSON() as Record<string, unknown>;
				patches.push(patch);
				event = { ...event, ...patch };
				await route.fulfill({ json: { event } });
				return;
			}
			await route.fulfill({ json: { events: [event] } });
		};

		await setupMember(page);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/events*`, handleEventsRoute);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/events/**`, handleEventsRoute);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/chores*`, (route) =>
			route.fulfill({ json: { chores: [] } }),
		);

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/kalender`);
		await dismissOnboarding(page);
		const openEdit = (title: string) =>
			page.getByRole('button', { name: `Termin bearbeiten: ${title}`, exact: true }).first();
		await openEdit('WG-Meeting').click();

		const recurrence = page.locator('#event-edit-recurrence');
		await expect(recurrence).toHaveValue('__keep__');
		await recurrence.scrollIntoViewIfNeeded();
		await page.screenshot({ path: test.info().outputPath('calendar-edit-light.png') });
		await page.evaluate(() => {
			localStorage.setItem('manawg-theme', 'dark');
		});
		await page.addInitScript(() => localStorage.setItem('manawg-theme', 'dark'));
		await page.reload({ waitUntil: 'domcontentloaded' });
		await dismissOnboarding(page);
		await openEdit('WG-Meeting').click();
		await expect(page.locator('html')).toHaveClass(/dark/);
		await expect(recurrence).toHaveValue('__keep__');
		await recurrence.scrollIntoViewIfNeeded();
		await page.screenshot({ path: test.info().outputPath('calendar-edit-dark.png') });
		await page.locator('#event-edit-title').fill('WG-Meeting umbenannt');
		await page.getByRole('button', { name: 'Speichern', exact: true }).click();
		await expect.poll(() => patches).toHaveLength(1);
		expect(patches[0]?.recurrence).toBe(complexRule);

		await openEdit('WG-Meeting umbenannt').click();
		await recurrence.selectOption('WEEKLY');
		await page.getByRole('button', { name: 'Speichern', exact: true }).click();
		await expect.poll(() => patches).toHaveLength(2);
		expect(patches[1]?.recurrence).toBe('FREQ=WEEKLY');
	});

	test('members who did not create an event get a read-only view', async ({ page }) => {
		test.skip(
			process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
			'requires the local fixture server',
		);
		const event = {
			id: '55555555-5555-4555-8555-555555555555',
			title: 'Fremder Termin',
			description: null,
			startsAt: new Date(Date.now() + 86_400_000).toISOString(),
			endsAt: null,
			allDay: false,
			location: null,
			recurrence: null,
			createdByMemberId: '99999999-9999-4999-8999-999999999999',
		};
		await setupMember(page);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/events*`, (route) =>
			route.fulfill({ json: { events: [event] } }),
		);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/chores*`, (route) =>
			route.fulfill({ json: { chores: [] } }),
		);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/kalender`);
		await dismissOnboarding(page);
		await page
			.getByRole('button', { name: `Termin bearbeiten: ${event.title}`, exact: true })
			.click();
		await expect(page.getByRole('heading', { name: 'Termin', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Termin löschen', exact: true })).toHaveCount(0);
	});
});
