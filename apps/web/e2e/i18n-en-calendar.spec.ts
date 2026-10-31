// English calendar: agenda, month grid, event drawers, feed section and load errors.
// Why: Every calendar string ships in two languages; a missed one would show German chrome in English.

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
	dismissOnboarding,
	FIXTURE_WG,
	mockUnreadCount,
	navigateToFeature,
	setupMember,
	skipUnlessFixtures,
} from './support/helpers';
import { expectNoGermanChrome, expectNoHorizontalOverflow, setEnglishLocale } from './support/i18n';

const BASE = `/api/wg/${FIXTURE_WG.shareCode}`;
const CALENDAR = `/wg/${FIXTURE_WG.shareCode}/calendar`;
const WIDTHS = [320, 390] as const;
const SCHEMES = ['light', 'dark'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Noon UTC of a day from today, so a one-hour event never runs into the next Berlin day.
function noonIn(offsetDays: number): number {
	const today = new Date();
	return Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offsetDays, 12);
}

const CLEANING_ROTA_DUE_AT = new Date(noonIn(2));

function calendarEvent(overrides: Record<string, unknown>) {
	const startsAt = new Date(noonIn(1)).toISOString();
	return {
		id: 'event',
		title: 'Event',
		description: null,
		startsAt,
		endsAt: null,
		allDay: false,
		location: null,
		recurrence: null,
		wgId: FIXTURE_WG.id,
		createdByMemberId: FIXTURE_WG.memberId,
		createdAt: startsAt,
		updatedAt: startsAt,
		...overrides,
	};
}

function allDayStart(offsetDays: number): string {
	const date = new Date(Date.now() + offsetDays * DAY_MS);
	return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())).toISOString();
}

async function prepare(
	page: Page,
	context: BrowserContext,
	baseURL: string | undefined,
	width: number,
	colorScheme: 'light' | 'dark',
	events = [
		calendarEvent({
			id: 'meeting',
			title: 'Flat meeting',
			endsAt: new Date(noonIn(1) + HOUR_MS).toISOString(),
			location: 'Kitchen',
			recurrence: 'FREQ=WEEKLY',
		}),
		calendarEvent({
			id: 'birthday',
			title: 'Lena’s birthday',
			startsAt: allDayStart(3),
			allDay: true,
		}),
	],
): Promise<void> {
	await setEnglishLocale(context, baseURL ?? 'http://localhost:3101');
	await setupMember(page);
	await mockUnreadCount(page, BASE);
	await page.route(`**${BASE}/events*`, (route) =>
		route.request().method() === 'GET' ? route.fulfill({ json: { events } }) : route.fallback(),
	);
	await page.route(`**${BASE}/chores*`, (route) =>
		route.fulfill({
			json: {
				chores: [
					{
						id: 'bathroom',
						title: 'Clean the bathroom',
						nextDueAt: CLEANING_ROTA_DUE_AT.toISOString(),
					},
				],
			},
		}),
	);
	await page.route(`**${BASE}/calendar-subscription*`, (route) =>
		route.fulfill({ json: { subscription: null } }),
	);
	await page.setViewportSize({ width, height: 780 });
	await page.emulateMedia({ colorScheme });
}

async function expectNoSidewaysScroll(page: Page, width: number): Promise<void> {
	if (width === 320) return expectNoHorizontalOverflow(page);
	const widths = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth,
	}));
	expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

test.describe('English calendar', () => {
	skipUnlessFixtures();

	for (const width of WIDTHS) {
		for (const scheme of SCHEMES) {
			const where = `${width}px ${scheme}`;

			test(`agenda, month grid and drawers ${where}`, async ({ page, context, baseURL }) => {
				await prepare(page, context, baseURL, width, scheme);
				await navigateToFeature(page, CALENDAR);
				await dismissOnboarding(page);

				await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
				await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toHaveText(
					'Calendar',
				);
				await expect(page.getByText('2 flat events')).toBeAttached();
				await expect(page.getByRole('heading', { name: 'Next 30 days', level: 2 })).toBeAttached();
				await expect(page.getByRole('tab', { name: 'Agenda' })).toBeVisible();
				await expect(page.getByRole('tab', { name: 'Month' })).toBeVisible();
				await expect(page.getByRole('button', { name: 'Flat meeting' }).first()).toContainText(
					'weekly',
				);
				await expect(page.getByRole('button', { name: 'Lena’s birthday' })).toContainText(
					'all day',
				);
				await expect(
					page.getByRole('link', {
						name: 'Clean the bathroom',
					}),
				).toContainText('Cleaning rota');
				await expect(page.getByRole('button', { name: 'Add event' })).toBeVisible();
				await expect(page.getByText('Subscribe to calendar')).toBeVisible();
				await expectNoGermanChrome(page);
				await expectNoSidewaysScroll(page, width);

				await page.getByRole('tab', { name: 'Month' }).click();
				const grid = page.getByRole('grid');
				await expect(grid.getByRole('columnheader').first()).toHaveText('Mon');
				await expect(grid.getByRole('columnheader').nth(6)).toHaveText('Sun');
				await expect(page.getByRole('button', { name: 'Previous month' })).toBeVisible();
				await expect(page.getByRole('button', { name: 'Next month' })).toBeVisible();
				const choreMonth = new Intl.DateTimeFormat('en-GB', {
					month: 'long',
					year: 'numeric',
					timeZone: 'Europe/Berlin',
				}).format(CLEANING_ROTA_DUE_AT);
				if (!(await page.getByText(choreMonth, { exact: true }).isVisible())) {
					await page.getByRole('button', { name: 'Next month', exact: true }).click();
				}
				await expect(page.getByText(choreMonth, { exact: true })).toBeVisible();
				await expect(page.locator('[data-day-cell][aria-label$=", cleaning rota"]')).toHaveCount(1);
				await page.locator('[data-day-cell][aria-label$=", cleaning rota"]').click();
				const dayList = page.getByRole('region', {
					name: 'Events on the selected day',
				});
				await expect(dayList.getByText('1 entry')).toBeVisible();
				await expect(dayList.getByText('Cleaning rota')).toBeVisible();
				await expectNoGermanChrome(page);
				await expectNoSidewaysScroll(page, width);

				await page.getByRole('tab', { name: 'Agenda' }).click();
				await page.getByRole('button', { name: 'Flat meeting' }).first().click();
				const edit = page.getByRole('dialog');
				await expect(edit.getByText('Edit event')).toBeVisible();
				await expect(edit.getByText('Change applies to')).toBeVisible();
				await expect(edit.getByRole('button', { name: 'Whole series' })).toBeVisible();
				await expect(edit.getByLabel('Title', { exact: true })).toHaveValue('Flat meeting');
				await expect(edit.getByLabel('All day')).toBeVisible();
				await expect(edit.getByLabel('Starts')).toBeVisible();
				await expect(edit.getByLabel('Ends (optional)')).toBeVisible();
				await expect(edit.getByLabel('Location (optional)')).toBeVisible();
				await expect(edit.getByLabel('Repeats')).toHaveValue('WEEKLY');
				await expect(edit.getByLabel('Note (optional)')).toBeVisible();
				await expect(edit.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
				await expect(edit.getByRole('button', { name: 'Delete event' })).toBeVisible();
				await expect(edit.getByRole('button', { name: 'Add to calendar app' })).toBeVisible();
				await expectNoGermanChrome(page);
				await edit.getByLabel('Title', { exact: true }).fill('Flat meeting moved');
				await edit.getByRole('button', { name: 'Cancel' }).click();
				const discard = page.getByRole('alertdialog');
				await expect(discard.getByText('Discard changes?')).toBeVisible();
				await expect(discard.getByText('Your changes have not been saved yet.')).toBeVisible();
				await discard.getByRole('button', { name: 'Keep editing' }).click();
				await edit.getByRole('button', { name: 'Delete event' }).click();
				await expect(
					page.getByRole('alertdialog').getByText('“Flat meeting” is deleted permanently, along'),
				).toBeVisible();
				await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
			});

			test(`new event drawer and feed section ${where}`, async ({ page, context, baseURL }) => {
				await prepare(page, context, baseURL, width, scheme);
				await navigateToFeature(page, CALENDAR);
				await dismissOnboarding(page);

				await page.getByRole('button', { name: 'Add event' }).click();
				const drawer = page.getByRole('dialog');
				await expect(drawer.getByText('New event')).toBeVisible();
				for (const template of [
					'Birthday',
					'Heating reading',
					'Meter reader',
					'Flat meeting',
					'Rubbish out',
				]) {
					await expect(drawer.getByRole('button', { name: template })).toBeVisible();
				}
				await drawer.getByRole('button', { name: 'Rubbish out' }).click();
				await expect(drawer.getByLabel('Title', { exact: true })).toHaveValue(
					'Take out the rubbish',
				);
				await expect(drawer.getByLabel('Repeats')).toHaveValue('WEEKLY');
				await drawer.getByLabel('Title', { exact: true }).fill('');
				await drawer.getByRole('button', { name: 'Save event' }).click();
				await expect(drawer.getByText('The title is missing.')).toBeInViewport();
				await expectNoGermanChrome(page);
				await expectNoSidewaysScroll(page, width);
				await drawer.getByRole('button', { name: 'Cancel' }).click();

				await page.getByText('Subscribe to calendar').click();
				await expect(
					page.getByText('Get new flat events in Apple Calendar or Google Calendar automatically.'),
				).toBeVisible();
				await page.getByRole('button', { name: 'Create calendar feed' }).scrollIntoViewIfNeeded();
				await expect(page.getByRole('button', { name: 'Create calendar feed' })).toBeVisible();
				await expectNoGermanChrome(page);
				await expectNoSidewaysScroll(page, width);
			});
		}
	}

	test('the end-before-start error stays above the create footer', async ({
		page,
		context,
		baseURL,
	}) => {
		await prepare(page, context, baseURL, 390, 'light');
		await page.setViewportSize({ width: 390, height: 844 });
		await navigateToFeature(page, CALENDAR);
		await dismissOnboarding(page);
		await page.getByRole('button', { name: 'Add event' }).click();
		const drawer = page.getByRole('dialog');
		await drawer.getByLabel('Title', { exact: true }).fill('Plant swap');
		await drawer.getByLabel('Starts').fill('2030-01-10T10:00');
		await drawer.getByLabel('Ends (optional)').fill('2030-01-10T09:00');
		await drawer.getByRole('button', { name: 'Save event' }).click();
		await expect(drawer.getByText('The end time is before the start time.')).toBeInViewport();
	});

	test('the end-before-start error stays above the edit footer', async ({
		page,
		context,
		baseURL,
	}) => {
		await prepare(page, context, baseURL, 390, 'light');
		await page.setViewportSize({ width: 390, height: 640 });
		await navigateToFeature(page, CALENDAR);
		await dismissOnboarding(page);
		await page.getByRole('tab', { name: 'Agenda' }).click();
		await page.getByRole('button', { name: 'Flat meeting' }).first().click();
		const edit = page.getByRole('dialog');
		await edit.getByLabel('Starts').fill('2030-01-10T10:00');
		await edit.getByLabel('Ends (optional)').fill('2030-01-10T09:00');
		await edit.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(edit.getByText('The end time is before the start time.')).toBeInViewport();
	});

	test('a failed save names the event in English', async ({ page, context, baseURL }) => {
		await prepare(page, context, baseURL, 390, 'light');
		await page.route(`**${BASE}/events*`, (route) =>
			route.request().method() === 'POST'
				? route.fulfill({ status: 500, json: { error: 'unexpected_error' } })
				: route.fallback(),
		);
		await navigateToFeature(page, CALENDAR);
		await dismissOnboarding(page);
		await page.getByRole('button', { name: 'Add event' }).click();
		const drawer = page.getByRole('dialog');
		await drawer.getByLabel('Title', { exact: true }).fill('Plant swap');
		await drawer.getByRole('button', { name: 'Save event' }).click();
		await expect(
			drawer.getByText('The event could not be saved: Try again in a moment.'),
		).toBeVisible();
		await expectNoGermanChrome(page);
	});

	test('a failed load and the empty agenda are English', async ({ page, context, baseURL }) => {
		await prepare(page, context, baseURL, 390, 'light', []);
		await page.route(`**${BASE}/chores*`, (route) => route.fulfill({ json: { chores: [] } }));
		await navigateToFeature(page, CALENDAR);
		await dismissOnboarding(page);
		await expect(page.getByText('No events in the next 30 days')).toBeVisible();
		await expect(page.getByText('Tap + to add an event.')).toBeVisible();
		await expectNoGermanChrome(page);

		await page.route(`**${BASE}/events*`, (route) =>
			route.fulfill({ status: 500, json: { error: 'unexpected_error' } }),
		);
		await page.reload();
		await dismissOnboarding(page);
		await expect(page.getByText('Events could not be loaded.').first()).toBeVisible();
		await expect(page.getByRole('button', { name: 'Reload calendar' })).toBeVisible();
		await expectNoGermanChrome(page);
	});

	test('an active feed, its guide and the renew and revoke dialogs are English', async ({
		page,
		context,
		baseURL,
	}) => {
		await prepare(page, context, baseURL, 390, 'light');
		const stamp = new Date().toISOString();
		const subscription = {
			feedUrl: 'https://example.com/feed/abc.ics',
			createdAt: stamp,
			updatedAt: stamp,
		};
		await page.route(`**${BASE}/calendar-subscription*`, (route) => {
			const method = route.request().method();
			if (method === 'DELETE') return route.fulfill({ json: { ok: true } });
			return route.fulfill({ json: { subscription } });
		});
		await navigateToFeature(page, CALENDAR);
		await dismissOnboarding(page);

		await page.getByText('Subscribe to calendar').click();
		await expect(page.getByText('Your personal feed link')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Subscribe in calendar app' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Open feed' })).toBeVisible();
		await page.getByRole('button', { name: 'Copy link' }).click();
		await expect(page.getByRole('button', { name: /^(Copied|Copy link)$/ })).toBeVisible();
		await page.getByText('Apple and Android instructions').click();
		await expect(page.getByText('Apple (iPhone/iPad)')).toBeVisible();
		await expect(page.getByText('Android (Google Calendar)')).toBeVisible();
		await expect(page.getByText(/^The feed contains flat events\./)).toBeAttached();
		await expectNoGermanChrome(page);
		await expectNoSidewaysScroll(page, 390);

		await page.getByRole('button', { name: 'Renew link' }).click();
		const renew = page.getByRole('dialog');
		await expect(renew.getByText('Renew feed link?')).toBeVisible();
		await expect(renew.getByText(/^The current link stops working straight away\./)).toBeVisible();
		await expectNoGermanChrome(page);
		await renew.getByRole('button', { name: 'Cancel' }).click();

		await page.getByRole('button', { name: 'Revoke calendar feed' }).click();
		const revoke = page.getByRole('dialog');
		await expect(revoke.getByText('Revoke calendar feed?')).toBeVisible();
		await expectNoGermanChrome(page);
		await revoke.getByRole('button', { name: 'Revoke', exact: true }).click();
		await expect(page.getByText('Calendar feed revoked.')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Create calendar feed' })).toBeVisible();
		await expectNoGermanChrome(page);
	});

	test('deleting a single date of a series is English', async ({ page, context, baseURL }) => {
		await prepare(page, context, baseURL, 390, 'light');
		await navigateToFeature(page, CALENDAR);
		await dismissOnboarding(page);

		await page.getByRole('button', { name: 'Flat meeting' }).first().click();
		const edit = page.getByRole('dialog');
		await expect(edit.getByRole('button', { name: /^Only .+/ })).toBeVisible();
		await edit.getByRole('button', { name: /^Only .+/ }).click();
		await edit.getByRole('button', { name: 'Delete this date only' }).click();
		const confirm = page.getByRole('alertdialog');
		await expect(confirm.getByText('Delete this date?')).toBeVisible();
		await expect(
			confirm.getByText(
				'Only this date of “Flat meeting” is deleted. The other dates in the series stay.',
			),
		).toBeVisible();
		await expectNoGermanChrome(page);
		await expectNoSidewaysScroll(page, 390);
	});

	test.describe('on a device outside Berlin time', () => {
		test.use({ timezoneId: 'America/New_York' });

		test('the time zone notice is English', async ({ page, context, baseURL }) => {
			await prepare(page, context, baseURL, 390, 'light');
			await navigateToFeature(page, CALENDAR);
			await dismissOnboarding(page);
			await expect(
				page.getByText(
					'This device uses the time zone America/New_York. Times appear in that zone, while repeating events and reminders follow Berlin time.',
				),
			).toBeVisible();
			await expectNoGermanChrome(page);
			await expectNoSidewaysScroll(page, 390);
		});
	});
});
