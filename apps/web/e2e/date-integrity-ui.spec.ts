import { type Page, expect, test } from '@playwright/test';
import { dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires the local fixture server');

const SHARE_CODE = 'MTE8PZAT';
const MOBILE_VIEWPORT = { width: 320, height: 740 } as const;

type CapturedPost = {
	bodies: unknown[];
	statuses: number[];
};

function berlinCalendarDate(value: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en', {
			timeZone: 'Europe/Berlin',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		})
			.formatToParts(new Date(value))
			.map(({ type, value: part }) => [type, part]),
	);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

async function interceptValidationPost(page: Page, endpoint: string): Promise<CapturedPost> {
	const captured: CapturedPost = { bodies: [], statuses: [] };
	await page.route(`**/api/wg/${SHARE_CODE}/${endpoint}`, async (route) => {
		if (route.request().method() !== 'POST') {
			await route.continue();
			return;
		}
		captured.bodies.push(route.request().postDataJSON());
		await route.fulfill({
			status: 422,
			contentType: 'application/json',
			body: JSON.stringify({ error: 'deliberate_validation' }),
		});
		captured.statuses.push(422);
	});
	return captured;
}

async function openAboCreate(
	page: Page,
	viewport: { width: number; height: number },
): Promise<void> {
	await page.setViewportSize(viewport);
	await setupMember(page);
	await navigateToFeature(page, `/wg/${SHARE_CODE}/abos`);
	await dismissOnboarding(page);
	await expect(page.getByRole('heading', { name: 'Fixkosten', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Neue Fixkosten', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Neue Fixkosten', exact: true })).toBeVisible();
}

async function openCalendarCreate(
	page: Page,
	viewport: { width: number; height: number },
): Promise<void> {
	await page.setViewportSize(viewport);
	await setupMember(page);
	await navigateToFeature(page, `/wg/${SHARE_CODE}/kalender`);
	await dismissOnboarding(page);
	await expect(page.getByRole('heading', { name: 'Kalender', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Termin hinzufügen', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Neuer Termin', exact: true })).toBeVisible();
}

test('Abo blocks a missing due date and preserves a valid calendar date', async ({ page }) => {
	const post = await interceptValidationPost(page, 'recurring-expenses');
	await openAboCreate(page, MOBILE_VIEWPORT);

	await page.getByLabel('Beschreibung').fill('Netflix');
	await page.getByLabel('Betrag').fill('12,34');
	const dueDate = page.getByLabel('Erste Fälligkeit');
	await dueDate.fill('');
	await page.getByRole('button', { name: 'Fixkosten anlegen', exact: true }).click();

	expect(post.bodies).toHaveLength(0);
	await expect(dueDate).toBeFocused();
	await expect(dueDate).toHaveValue('');
	await expect
		.poll(() => dueDate.evaluate((input) => (input as HTMLInputElement).validity.valid))
		.toBe(false);

	await dueDate.fill('2026-09-22');
	await expect(dueDate).toHaveValue('2026-09-22');
	await page.getByRole('button', { name: 'Fixkosten anlegen', exact: true }).click();
	await expect.poll(() => post.bodies.length).toBe(1);
	await expect.poll(() => post.statuses.length).toBe(1);

	const payload = post.bodies[0] as { nextDueAt: string };
	expect(berlinCalendarDate(payload.nextDueAt)).toBe('2026-09-22');
});

test('calendar all-day creation keeps start and end on the same calendar day', async ({ page }) => {
	const post = await interceptValidationPost(page, 'events');
	await openCalendarCreate(page, MOBILE_VIEWPORT);

	await page.getByLabel('Titel').fill('WG-Termin');
	const start = page.getByLabel('Beginn');
	const end = page.getByLabel('Ende (optional)');
	await start.fill('2026-09-22T14:00');
	await end.fill('2026-09-22T15:00');
	await page.getByRole('checkbox', { name: 'Ganztägig', exact: true }).click();

	await expect(start).toHaveValue('2026-09-22');
	await expect(end).toHaveValue('2026-09-22');
	await page.getByRole('button', { name: 'Termin speichern', exact: true }).click();
	await expect.poll(() => post.bodies.length).toBe(1);
	await expect.poll(() => post.statuses.length).toBe(1);

	const payload = post.bodies[0] as {
		allDay: boolean;
		startsAt: string;
		endsAt: string | null;
	};
	expect(payload.allDay).toBe(true);
	expect(payload.endsAt).not.toBeNull();
	expect(berlinCalendarDate(payload.startsAt)).toBe('2026-09-22');
	expect(berlinCalendarDate(payload.endsAt as string)).toBe('2026-09-22');
	await expect(page.getByText('Endzeit liegt vor Startzeit.', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Neuer Termin', exact: true })).toBeVisible();
	await expect(page.getByText('0 WG-Termine', { exact: true })).toBeVisible();
});

test.describe('absence dates outside Berlin', () => {
	test.use({ timezoneId: 'America/Los_Angeles' });

	test('uses Berlin day boundaries across the spring clock change', async ({ page }) => {
		const post = await interceptValidationPost(page, 'absences');
		await setupMember(page);
		await navigateToFeature(page, `/wg/${SHARE_CODE}/putzen?panel=absences`);
		await dismissOnboarding(page);

		await page.getByLabel('Abwesenheit von').fill('2026-03-29');
		await page.getByLabel('Abwesenheit bis').fill('2026-03-30');
		await page.getByRole('button', { name: 'Abwesenheit speichern' }).click();
		await expect.poll(() => post.bodies.length).toBe(1);

		expect(post.bodies[0]).toMatchObject({
			startDate: '2026-03-28T23:00:00.000Z',
			endDate: '2026-03-30T21:59:59.999Z',
		});
	});
});

test('new calendar event starts at the next full hour', async ({ page }) => {
	await page.clock.setFixedTime(new Date('2026-09-22T08:20:00Z'));
	await openCalendarCreate(page, MOBILE_VIEWPORT);
	await expect(page.getByLabel('Beginn')).toHaveValue('2026-09-22T11:00');
});

test('picking a past day in the month view keeps that day for the new event', async ({ page }) => {
	await page.clock.setFixedTime(new Date('2026-09-22T08:20:00Z'));
	await page.setViewportSize(MOBILE_VIEWPORT);
	await setupMember(page);
	await navigateToFeature(page, `/wg/${SHARE_CODE}/kalender`);
	await dismissOnboarding(page);
	await page.getByRole('tab', { name: 'Monat', exact: true }).click();
	await page.getByRole('button', { name: 'Donnerstag, 10. September 2026', exact: false }).click();
	await page.getByRole('button', { name: 'Termin hinzufügen', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Neuer Termin', exact: true })).toBeVisible();
	// The day picked in the calendar (in the past) must not be silently
	// discarded back to "today" — only the time-of-day defaults.
	await expect(page.getByLabel('Beginn')).toHaveValue('2026-09-10T11:00');
});

test('calendar reports a missing start only on save and leaves the end unchanged', async ({
	page,
}) => {
	const post = await interceptValidationPost(page, 'events');
	await openCalendarCreate(page, MOBILE_VIEWPORT);
	await page.getByLabel('Titel').fill('WG-Termin');

	const start = page.getByLabel('Beginn');
	const end = page.getByLabel('Ende (optional)');
	await start.fill('2026-09-22T14:00');
	await end.fill('2026-09-22T15:00');
	await start.fill('');

	await expect(end).toHaveValue('2026-09-22T15:00');
	await expect(page.getByText('Startzeitpunkt fehlt.', { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Termin speichern', exact: true }).click();

	expect(post.bodies).toHaveLength(0);
	await expect(start).toBeFocused();
	await expect
		.poll(() => start.evaluate((input) => (input as HTMLInputElement).validity.valueMissing))
		.toBe(true);
	await expect(start).toHaveValue('');
	await expect(end).toHaveValue('2026-09-22T15:00');
});

test('legacy all-day title-only edit preserves the displayed date and both stored timestamps', async ({
	page,
}) => {
	await page.clock.setFixedTime(new Date('2026-09-20T10:00:00Z'));
	await setupMember(page);
	const legacy = {
		id: 'legacy-date',
		title: 'Alter Geburtstag',
		description: null,
		startsAt: '2026-09-21T22:00:00.000Z',
		endsAt: '2026-09-22T21:00:00.000Z',
		allDay: true,
		location: null,
		recurrence: null,
	};
	let saved: unknown;
	await page.route(`**/api/wg/${SHARE_CODE}/events*`, (route) =>
		route.fulfill({ json: { events: [legacy] } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/events/${legacy.id}`, (route) => {
		saved = route.request().postDataJSON();
		return route.fulfill({ json: { event: { ...legacy, ...route.request().postDataJSON() } } });
	});
	await navigateToFeature(page, `/wg/${SHARE_CODE}/kalender`);
	await expect(
		page
			.getByRole('list', { name: /Dienstag, 22\. September$/ })
			.getByText('ganztägig', { exact: true }),
	).toBeVisible();
	await page.getByRole('button', { name: 'Termin bearbeiten: Alter Geburtstag' }).click();
	await expect(page.getByLabel('Beginn')).toHaveValue('2026-09-22');
	await expect(page.getByLabel('Ende (optional)')).toHaveValue('2026-09-22');
	await page.getByLabel('Titel').fill('Neuer Titel');
	await page.getByRole('button', { name: 'Speichern', exact: true }).click();
	await expect
		.poll(() => saved)
		.toMatchObject({
			title: 'Neuer Titel',
			startsAt: legacy.startsAt,
			endsAt: legacy.endsAt,
		});
});

for (const timezoneId of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
	test.describe(`agenda in ${timezoneId}`, () => {
		test.use({ timezoneId });
		test('today all-day event remains in the agenda after browsing a future month', async ({
			page,
		}) => {
			await page.clock.setFixedTime(
				new Date(
					timezoneId === 'Pacific/Kiritimati' ? '2026-09-21T22:00:00Z' : '2026-09-22T19:00:00Z',
				),
			);
			await setupMember(page);
			const event = {
				id: 'today-date',
				title: 'Heute ganztägig',
				description: null,
				startsAt: '2026-09-22T00:00:00.000Z',
				endsAt: null,
				allDay: true,
				location: null,
				recurrence: null,
			};
			const finalDay = {
				...event,
				id: 'final-date',
				title: 'Letzter Agendatag',
				startsAt: '2026-10-22T00:00:00.000Z',
			};
			await page.route(`**/api/wg/${SHARE_CODE}/events*`, (route) => {
				const query = new URL(route.request().url()).searchParams;
				const events = [event, finalDay].filter(
					(row) =>
						Date.parse(row.startsAt) >= Date.parse(query.get('from') ?? '') &&
						Date.parse(row.startsAt) <= Date.parse(query.get('to') ?? ''),
				);
				return route.fulfill({ json: { events } });
			});
			await navigateToFeature(page, `/wg/${SHARE_CODE}/kalender`);
			await expect(page.getByText(event.title, { exact: true })).toBeVisible();
			await expect(page.getByText(finalDay.title, { exact: true })).toBeVisible();
			await page.getByRole('tab', { name: 'Monat', exact: true }).click();
			const loaded = page.waitForResponse((response) => response.url().includes('/events?'));
			await page.getByRole('button', { name: 'Nächster Monat', exact: true }).click();
			await loaded;
			await page.getByRole('tab', { name: 'Agenda', exact: true }).click();
			await expect(page.getByText(event.title, { exact: true })).toBeVisible();
			await expect(
				page
					.getByRole('list', { name: /Dienstag, 22\. September$/ })
					.getByText('ganztägig', { exact: true }),
			).toBeVisible();
		});
	});
}
