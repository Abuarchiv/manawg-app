// Calendar rows: the accessible name of every labelled link and button contains its visible text.
// Why: WCAG 2.5.3 Label in Name; voice control users say what they see on the row.

import { expect, test } from '@playwright/test';
import {
	dismissOnboarding,
	FIXTURE_WG,
	mockUnreadCount,
	navigateToFeature,
	setupMember,
	showMonthOf,
	skipUnlessFixtures,
} from './support/helpers';
import { setEnglishLocale } from './support/i18n';

const BASE = `/api/wg/${FIXTURE_WG.shareCode}`;
const CHORE_LINK = 'main a[href*="highlight=label-chore"]';

test.describe('calendar label in name', () => {
	skipUnlessFixtures();

	for (const [language, rota, monthTab, nextMonth] of [
		['de', 'Putzplan', 'Monat', 'Nächster Monat'],
		['en', 'cleaning rota', 'Month', 'Next month'],
	] as const) {
		test(`rows keep their visible text in the accessible name (${language})`, async ({
			page,
			context,
			baseURL,
		}) => {
			if (language === 'en') await setEnglishLocale(context, baseURL ?? 'http://localhost:3101');
			await setupMember(page);
			await mockUnreadCount(page, BASE);
			const noon = new Date();
			noon.setUTCDate(noon.getUTCDate() + 2);
			noon.setUTCHours(12, 0, 0, 0);
			const startsAt = noon.toISOString();
			const event = {
				id: 'label-event',
				title: 'Plenum',
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
			};
			await page.route(`**${BASE}/events*`, (route) =>
				route.request().method() === 'GET'
					? route.fulfill({ json: { events: [event] } })
					: route.fallback(),
			);
			await page.route(`**${BASE}/chores*`, (route) =>
				route.fulfill({
					json: { chores: [{ id: 'label-chore', title: 'Bad putzen', nextDueAt: startsAt }] },
				}),
			);
			await page.route(`**${BASE}/calendar-subscription*`, (route) =>
				route.fulfill({ json: { subscription: null } }),
			);

			const expectVisibleTextInName = async () => {
				const rows = await page.locator('main :is(a, button)[aria-label]').evaluateAll((els) =>
					els.map((el) => ({
						name: el.getAttribute('aria-label') ?? '',
						text: (el as HTMLElement).innerText,
					})),
				);
				const norm = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
				for (const row of rows) {
					const text = norm(row.text);
					if (text) expect(norm(row.name), `"${row.name}" must contain "${text}"`).toContain(text);
				}
			};

			await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/calendar`);
			await dismissOnboarding(page);
			await expect(page.locator(CHORE_LINK)).toBeVisible();
			await expectVisibleTextInName();

			await page.getByRole('tab', { name: monthTab }).click();
			await showMonthOf(page, startsAt, nextMonth);
			await page.locator(`[data-day-cell][aria-label$=", ${rota}"]`).click();
			await expect(page.locator(CHORE_LINK)).toBeVisible();
			await expectVisibleTextInName();
		});
	}
});
