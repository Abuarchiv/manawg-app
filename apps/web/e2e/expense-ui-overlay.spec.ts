// FAB summary overlay and date integrity in the expense UI.
// Why: Overlays and dates must hold at 320px / 200% text.

import { type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './support/helpers';

test.describe('fab summary overlay', () => {
	test.skip(
		process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
		'requires the local fixture server',
	);

	const SHARE_CODE = 'MTE8PZAT';

	async function useLargeText(page: Page): Promise<void> {
		await page.evaluate(() => {
			document.documentElement.style.setProperty('font-size', '32px', 'important');
		});
		await page.waitForFunction(
			() => getComputedStyle(document.documentElement).fontSize === '32px',
		);
	}

	for (const width of [320, 360]) {
		for (const colorScheme of ['light', 'dark'] as const) {
			if (width !== 320) continue;
			test(`floating action leaves the monthly summary visible at ${width}px, ${colorScheme}, 200% text`, async ({
				page,
			}, testInfo) => {
				await page.setViewportSize({ width, height: 740 });
				await page.emulateMedia({ colorScheme });
				await setupMember(page);
				await navigateToFeature(page, `/wg/${SHARE_CODE}/abos`);
				await useLargeText(page);
				await dismissOnboarding(page);
				await expect(page.getByRole('heading', { name: 'Fixkosten', exact: true })).toBeVisible();
				await expect(page.getByText('Dein Anteil', { exact: true })).toBeVisible();
				const actionButton = page.getByRole('button', {
					name: 'Fixkosten hinzufügen',
					exact: true,
				});
				await expect(actionButton).toBeVisible();
				await expect(actionButton).toHaveAccessibleName('Fixkosten hinzufügen');

				const geometry = {
					rootFontSize: await page.evaluate(
						() => getComputedStyle(document.documentElement).fontSize,
					),
					actionFontSize: await actionButton.evaluate(
						(button) => getComputedStyle(button).fontSize,
					),
					actionPointerEvents: await actionButton.evaluate(
						(button) => getComputedStyle(button).pointerEvents,
					),
					wrapperPointerEvents: await page
						.locator('[data-page-primary-action]')
						.evaluate((wrapper) => getComputedStyle(wrapper).pointerEvents),
					hitArea: await actionButton.evaluate((button) => {
						const style = getComputedStyle(button, '::after');
						return { width: style.width, height: style.height, minWidth: style.minWidth };
					}),
					iconAlignment: await actionButton.evaluate((button) => {
						const buttonBox = button.getBoundingClientRect();
						const iconBox = button.querySelector('svg.lucide-plus')?.getBoundingClientRect();
						return iconBox
							? {
									x: Math.abs(
										buttonBox.left + buttonBox.width / 2 - (iconBox.left + iconBox.width / 2),
									),
									y: Math.abs(
										buttonBox.top + buttonBox.height / 2 - (iconBox.top + iconBox.height / 2),
									),
								}
							: null;
					}),
					action: await actionButton.boundingBox().then(
						(box) =>
							box && {
								top: box.y,
								right: box.x + box.width,
								bottom: box.y + box.height,
								left: box.x,
								width: box.width,
								height: box.height,
							},
					),
					pointerTargets: await page.evaluate(() => {
						const wrapper = document.querySelector<HTMLElement>('[data-page-primary-action]');
						const button = wrapper?.querySelector<HTMLElement>('button');
						if (!wrapper || !button) return { centerTargetsButton: false, gapPassesThrough: false };
						const wrapperBox = wrapper.getBoundingClientRect();
						const buttonBox = button.getBoundingClientRect();
						const center = document.elementFromPoint(
							buttonBox.left + buttonBox.width / 2,
							buttonBox.top + buttonBox.height / 2,
						);
						const gap = document.elementFromPoint(
							(wrapperBox.left + buttonBox.left) / 2,
							buttonBox.top + buttonBox.height / 2,
						);
						return {
							centerTargetsButton: center?.closest('button') === button,
							gapPassesThrough: gap?.closest('[data-page-primary-action]') !== wrapper,
						};
					}),
					amounts: await page.evaluate(() => {
						const label = Array.from(document.querySelectorAll('p')).find(
							(element) => element.textContent?.trim() === 'Dein Anteil',
						);
						const textElements = [
							label,
							...Array.from(label?.parentElement?.querySelectorAll('p') ?? []).filter(
								(element) => element !== label,
							),
						].filter(
							(element): element is HTMLParagraphElement => element instanceof HTMLParagraphElement,
						);
						return textElements.flatMap((element) => {
							const range = document.createRange();
							range.selectNodeContents(element);
							return Array.from(range.getClientRects()).map((rect) => {
								const { top, right, bottom, left } = rect;
								return { top, right, bottom, left };
							});
						});
					}),
				};
				await page.screenshot({
					path: testInfo.outputPath(`fab-${width}-${colorScheme}.png`),
					fullPage: true,
				});

				expect(geometry.rootFontSize).toBe('32px');
				expect(geometry.action).not.toBeNull();
				expect(geometry.action?.width).toBe(44);
				expect(geometry.action?.height).toBe(44);
				expect(geometry.amounts.length).toBeGreaterThan(0);
				const overlapsAmount = geometry.amounts.some(
					(amount) =>
						geometry.action !== null &&
						amount.left < geometry.action.right &&
						amount.right > geometry.action.left &&
						amount.top < geometry.action.bottom &&
						amount.bottom > geometry.action.top,
				);
				expect(overlapsAmount, JSON.stringify(geometry)).toBe(false);
				expect(geometry.actionFontSize).toBe('0px');
				expect(geometry.actionPointerEvents).toBe('auto');
				expect(geometry.wrapperPointerEvents).toBe('none');
				expect(geometry.hitArea).toEqual({ width: '44px', height: '44px', minWidth: '44px' });
				expect(geometry.iconAlignment?.x).toBeLessThanOrEqual(1);
				expect(geometry.iconAlignment?.y).toBeLessThanOrEqual(1);
				expect(geometry.pointerTargets.centerTargetsButton).toBe(true);
				expect(geometry.pointerTargets.gapPassesThrough).toBe(true);

				await page.evaluate(() => window.scrollBy(0, 100));
				await expect(actionButton).toBeVisible();
				const scrolledAmounts = await page.evaluate(() => {
					const label = Array.from(document.querySelectorAll('p')).find(
						(element) => element.textContent?.trim() === 'Dein Anteil',
					);
					const textElements = [
						label,
						...Array.from(label?.parentElement?.querySelectorAll('p') ?? []).filter(
							(element) => element !== label,
						),
					].filter(
						(element): element is HTMLParagraphElement => element instanceof HTMLParagraphElement,
					);
					return textElements.flatMap((element) => {
						const range = document.createRange();
						range.selectNodeContents(element);
						return Array.from(range.getClientRects()).map((rect) => {
							const { top, right, bottom, left } = rect;
							return { top, right, bottom, left };
						});
					});
				});
				const actionAfterScroll = await actionButton.boundingBox();
				const overlapsAfterScroll = scrolledAmounts.some(
					(amount) =>
						actionAfterScroll !== null &&
						amount.left < actionAfterScroll.x + actionAfterScroll.width &&
						amount.right > actionAfterScroll.x &&
						amount.top < actionAfterScroll.y + actionAfterScroll.height &&
						amount.bottom > actionAfterScroll.y,
				);
				expect(overlapsAfterScroll, JSON.stringify({ scrolledAmounts, actionAfterScroll })).toBe(
					false,
				);

				await page.keyboard.press('Tab');
				const focusMetrics = await actionButton.evaluate((element) => {
					element.focus();
					const style = getComputedStyle(element);
					return {
						focusVisible: element.matches(':focus-visible'),
						outline: style.outlineStyle,
						boxShadow: style.boxShadow,
					};
				});
				expect(focusMetrics.focusVisible).toBe(true);
				expect(focusMetrics.outline !== 'none' || focusMetrics.boxShadow !== 'none').toBe(true);
			});
		}
	}

	test('compact plus actions keep their names and skip nested and text-only actions', async ({
		page,
	}) => {
		await page.setViewportSize({ width: 320, height: 740 });
		await setupMember(page);
		for (const [feature, label] of [
			['kalender', 'Termin hinzufügen'],
			['vorraete', 'Vorrat hinzufügen'],
			['pinnwand', 'Beitrag hinzufügen'],
			['putzen', 'Putzaufgabe hinzufügen'],
			['ausgaben', 'Ausgabe hinzufügen'],
		] as const) {
			await navigateToFeature(page, `/wg/${SHARE_CODE}/${feature}`);
			await useLargeText(page);
			await dismissOnboarding(page);
			const action = page.getByRole('button', { name: label, exact: true });
			await expect(action).toBeVisible();
			const box = await action.boundingBox();
			expect(box?.width).toBe(44);
			expect(box?.height).toBe(44);
		}

		await navigateToFeature(page, `/wg/${SHARE_CODE}/einkauf`);
		await useLargeText(page);
		await dismissOnboarding(page);
		await expect(page.locator('[data-page-primary-action] > button')).toHaveCount(0);
		const addItem = page.getByRole('button', { name: 'Artikel hinzufügen', exact: true });
		await expect(addItem).toBeVisible();
		const itemName = page.getByRole('textbox', { name: 'Artikel-Name' });
		await itemName.focus();
		await expect(itemName).toBeFocused();

		// An open claim shows the text-only button „Erinnern“ on „Erinnerungen“.
		const createdAt = new Date().toISOString();
		await page.route(`**/api/wg/${SHARE_CODE}/expenses`, (route) =>
			route.request().method() === 'GET'
				? route.fulfill({
						json: {
							payments: [],
							expenses: [
								{
									id: 'fab-text-action-expense',
									paidByMemberId: FIXTURE_WG.memberId,
									amountCents: 2000,
									currency: 'EUR',
									description: 'Einkauf',
									imageUrl: null,
									occurredAt: createdAt,
									createdAt,
									updatedAt: createdAt,
									splits: [
										{
											id: 'fab-text-action-split',
											debtorMemberId: '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55',
											amountCents: 1000,
											settledAt: null,
										},
									],
								},
							],
						},
					})
				: route.continue(),
		);
		await page.route(`**/api/wg/${SHARE_CODE}/reminders`, (route) =>
			route.fulfill({ json: { reminders: [] } }),
		);
		await navigateToFeature(page, `/wg/${SHARE_CODE}/mahnungen`);
		await useLargeText(page);
		await dismissOnboarding(page);
		// RemindButton wraps the button; the FAB CSS only applies to direct children.
		const textAction = page.locator('[data-page-primary-action] button');
		await expect(textAction).toHaveCount(1);
		await expect(textAction).toBeVisible();
		expect(await textAction.evaluate((button) => getComputedStyle(button).fontSize)).not.toBe(
			'0px',
		);
	});
});

test.describe('date integrity ui', () => {
	test.skip(
		process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
		'requires the local fixture server',
	);

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
		await page.getByRole('button', { name: 'Fixkosten hinzufügen', exact: true }).click();
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

	test('calendar all-day creation keeps start and end on the same calendar day', async ({
		page,
	}) => {
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
			// The form rejects past ranges, so the clock is set before the clock change.
			await page.clock.setFixedTime(new Date('2026-03-20T10:00:00Z'));
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

	test('picking a past day in the month view keeps that day for the new event', async ({
		page,
	}) => {
		await page.clock.setFixedTime(new Date('2026-09-22T08:20:00Z'));
		await page.setViewportSize(MOBILE_VIEWPORT);
		await setupMember(page);
		await navigateToFeature(page, `/wg/${SHARE_CODE}/kalender`);
		await dismissOnboarding(page);
		await page.getByRole('tab', { name: 'Monat', exact: true }).click();
		await page
			.getByRole('button', { name: 'Donnerstag, 10. September 2026', exact: false })
			.click();
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
			createdByMemberId: FIXTURE_WG.memberId,
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
});
