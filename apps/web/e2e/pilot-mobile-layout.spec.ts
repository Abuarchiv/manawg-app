import { type Locator, type Page, expect, test } from '@playwright/test';
import { dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
test.setTimeout(120_000);
test.use({ hasTouch: true, isMobile: true });

const SHARE_CODE = 'MTE8PZAT';
const MEMBER_ID = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';
const WG_ID = '989ac820-58b7-431f-9c65-28721264f333';
type LayoutRoute = 'home' | 'chores' | 'shopping' | 'inventory';
const LONG_INVENTORY_NAME = 'Spülmaschinenreinigung mit Entkalkung und gründlicher Küchenhygiene';

function fixtureBerlinTodayAtNoon(): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'Europe/Berlin',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(new Date());
	const value = (type: string) => parts.find((part) => part.type === type)?.value;
	const year = value('year');
	const month = value('month');
	const day = value('day');
	if (!year || !month || !day) throw new Error('Could not determine the Berlin fixture date');
	return `${year}-${month}-${day}T12:00:00.000Z`;
}

const FIXTURE_DUE_AT = fixtureBerlinTodayAtNoon();

const shoppingItems = [
	{
		id: 'shopping-open',
		addedByMemberId: MEMBER_ID,
		name: 'Ungesüßte Hafermilch',
		quantity: '1 Packung',
		boughtAt: null,
		boughtByMemberId: null,
		createdAt: '2026-09-20T08:00:00.000Z',
	},
	{
		id: 'shopping-done',
		addedByMemberId: MEMBER_ID,
		name: 'Vollkornnudeln',
		quantity: '2 Packungen',
		boughtAt: '2026-09-20T09:00:00.000Z',
		boughtByMemberId: MEMBER_ID,
		createdAt: '2026-09-20T09:01:00.000Z',
	},
];

const inventoryItems = [
	{
		id: 'inventory-milk',
		wgId: WG_ID,
		name: LONG_INVENTORY_NAME,
		quantity: 1,
		unit: 'Stück',
		threshold: 1,
		category: 'kueche',
		lastDecrementedAt: null,
		decrementCount30d: 0,
		createdAt: '2026-09-20T08:00:00.000Z',
		updatedAt: '2026-09-20T08:00:00.000Z',
	},
	{
		id: 'inventory-paper',
		wgId: WG_ID,
		name: 'Recycling Toilettenpapier',
		quantity: 4,
		unit: 'Rolle',
		threshold: 2,
		category: 'bad',
		lastDecrementedAt: null,
		decrementCount30d: 0,
		createdAt: '2026-09-20T08:01:00.000Z',
		updatedAt: '2026-09-20T08:01:00.000Z',
	},
];

const chores = [
	{
		id: 'chore-bath',
		title: 'Bad putzen',
		intervalDays: 7,
		recurrenceType: 'days' as const,
		nextDueAt: FIXTURE_DUE_AT,
		assignedMemberId: MEMBER_ID,
		lastCompletedAt: null,
		lastCompletedByName: null,
		openGapCountForAssignee: 0,
	},
];

const dashboardData = {
	balances: [
		{
			memberId: MEMBER_ID,
			memberName: 'dsaf',
			color: '#6d5efc',
			currency: 'EUR',
			paidCents: 3290,
			owedCents: 0,
			balanceCents: 3290,
		},
	],
	spendByDay: [],
	totalSpendByCurrency: { EUR: 3290 },
	weekSpendByCurrency: { EUR: 3290 },
	monthSpendByCurrency: { EUR: 3290 },
	totalSpendCents: 3290,
	weekSpendCents: 3290,
	monthSpendCents: 3290,
	openShoppingCount: 1,
	openShoppingTop: ['Ungesüßte Hafermilch'],
	dueChores: [
		{
			id: 'chore-bath',
			title: 'Bad putzen',
			assignedMemberId: MEMBER_ID,
			assignedMemberName: 'dsaf',
			assignedColor: '#6d5efc',
			nextDueAt: FIXTURE_DUE_AT,
			overdue: false,
		},
	],
	activity: [
		{
			kind: 'expense',
			timestamp: '2026-09-21T08:00:00.000Z',
			memberName: 'dsaf',
			text: 'Internet',
			amountCents: 3290,
		},
	],
	latestAnnouncement: null,
	myOpenAnnouncements: [],
	wgHealth: {
		shareCode: SHARE_CODE,
		openShoppingCount: 1,
		overdueChoreCount: 0,
		openDebtCents: 0,
		openAnnouncementCount: 0,
		absentMemberCount: 0,
		dueRecurringCount: 0,
	},
	dueRecurringExpenses: [],
	absentMembers: [],
	setup: {
		choreCount: 1,
		hasExpense: true,
		hasShoppingItem: true,
		hasAnnouncement: false,
		notificationsEnabled: true,
	},
};

async function mockLayoutApis(page: Page): Promise<void> {
	await page.route(`**/api/wg/${SHARE_CODE}/dashboard*`, (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		return route.fulfill({ json: dashboardData });
	});
	await page.route(`**/api/wg/${SHARE_CODE}/shopping*`, (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		return route.fulfill({ json: { items: shoppingItems } });
	});
	await page.route(`**/api/wg/${SHARE_CODE}/inventory*`, (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		return route.fulfill({ json: { items: inventoryItems, grouped: {} } });
	});
	await page.route(`**/api/wg/${SHARE_CODE}/chores*`, (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		return route.fulfill({ json: { chores } });
	});
	await page.route(`**/api/wg/${SHARE_CODE}/absences*`, (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		return route.fulfill({ json: { absences: [] } });
	});
}

async function assertNav(page: Page, width: number) {
	const nav = page.locator('nav[data-app-chrome]').last();
	const navBox = await measureBox(nav);
	expect(navBox).not.toBeNull();
	if (!navBox) throw new Error('bottom navigation is missing');
	expect(navBox.x).toBeGreaterThanOrEqual(0);
	expect(navBox.x + navBox.width).toBeLessThanOrEqual(width + 1);

	const labels = ['Start', 'Haushalt', 'Finanzen', 'Austausch'] as const;
	expect(await nav.getByRole('link').count()).toBe(labels.length);
	for (const label of labels) {
		const link = nav.getByRole('link', { name: label, exact: true });
		await expect(link).toHaveCount(1);
		const linkBox = await link.boundingBox();
		const labelNode = link.locator('span').last();
		const labelBox = await labelNode.boundingBox();
		const labelMetrics = await labelNode.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				lineHeight: Number.parseFloat(style.lineHeight),
				height: element.getBoundingClientRect().height,
				scrollWidth: element.scrollWidth,
				clientWidth: element.clientWidth,
			};
		});
		expect(linkBox).not.toBeNull();
		expect(labelBox).not.toBeNull();
		if (!linkBox || !labelBox) continue;
		expect(linkBox.width).toBeGreaterThanOrEqual(44);
		expect(linkBox.height).toBeGreaterThanOrEqual(44);
		expect(labelMetrics.height).toBeLessThanOrEqual(labelMetrics.lineHeight + 1);
		expect(labelMetrics.scrollWidth).toBeLessThanOrEqual(labelMetrics.clientWidth + 1);
		expect(labelBox.x).toBeGreaterThanOrEqual(linkBox.x);
		expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(linkBox.x + linkBox.width + 1);
	}
	return { nav, navBox };
}

async function measureBox(locator: Locator) {
	if ((await locator.count()) !== 1) return null;
	return locator.evaluate((element) => {
		const box = element.getBoundingClientRect();
		return {
			x: box.x,
			y: box.y,
			width: box.width,
			height: box.height,
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
		};
	});
}

async function assertWholeWordsOnSingleLines(text: Locator, words: string[]): Promise<void> {
	const wordLines = await text.evaluate((element, expectedWords) => {
		const textNode = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
		if (!textNode) throw new Error('layout title text node missing');
		const value = textNode.textContent ?? '';
		const own = element.getBoundingClientRect();
		const container = element.closest('[data-slot="item-title"]')?.getBoundingClientRect() ?? own;
		const bounds = {
			left: Math.max(own.left, container.left),
			right: Math.min(own.right, container.right),
			top: Math.max(own.top, container.top),
			bottom: Math.min(own.bottom, container.bottom),
		};
		return expectedWords.map((word) => {
			const start = value.indexOf(word);
			if (start < 0) throw new Error(`layout title word missing: ${word}`);
			const range = document.createRange();
			range.setStart(textNode, start);
			range.setEnd(textNode, start + word.length);
			const rect = range.getBoundingClientRect();
			return {
				word,
				lineCount: range.getClientRects().length,
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
				boxLeft: bounds.left,
				boxRight: bounds.right,
				boxTop: bounds.top,
				boxBottom: bounds.bottom,
			};
		});
	}, words);
	for (const word of wordLines) {
		expect(word.lineCount, word.word).toBe(1);
		expect(word.left, word.word).toBeGreaterThanOrEqual(word.boxLeft - 1);
		expect(word.right, word.word).toBeLessThanOrEqual(word.boxRight + 1);
		expect(word.top, word.word).toBeGreaterThanOrEqual(word.boxTop - 1);
		expect(word.bottom, word.word).toBeLessThanOrEqual(word.boxBottom + 1);
	}
}

function expectRectsNotToOverlap(
	first: { x: number; y: number; width: number; height: number },
	second: { x: number; y: number; width: number; height: number },
): void {
	expect(
		first.x < second.x + second.width &&
			first.x + first.width > second.x &&
			first.y < second.y + second.height &&
			first.y + first.height > second.y,
	).toBe(false);
}

async function assertInventoryModal(page: Page, width: number): Promise<void> {
	expect(await page.evaluate(() => window.innerWidth)).toBe(width);
	await expect(page.getByRole('heading', { name: 'Neuer Vorrat' })).toBeVisible();
	for (const [label, control] of [
		['Name', page.locator('#inventory-name')],
		['Menge', page.locator('#inventory-qty')],
		['Nachkaufen ab', page.locator('#inventory-threshold')],
		['Einheit', page.locator('#inventory-unit')],
		['Kategorie', page.locator('#inventory-category')],
	] as const) {
		const box = await measureBox(control);
		expect(box).not.toBeNull();
		if (!box) continue;
		expect(box.width, label).toBeGreaterThanOrEqual(240);
		expect(box.x + box.width, label).toBeLessThanOrEqual(width - 16 + 1);
		expect(box.height, label).toBeGreaterThanOrEqual(44);
	}
	const help = page.getByText(
		// Default Menge 0 ≤ Nachkaufen ab 1, so the form warns about the automatic shopping entry.
		'Die Menge liegt nicht über „Nachkaufen ab“ – der Vorrat kommt beim Speichern direkt auf die Einkaufsliste.',
		{ exact: true },
	);
	const helpBox = await measureBox(help);
	expect(helpBox).not.toBeNull();
	if (helpBox) {
		expect(helpBox.x).toBeGreaterThanOrEqual(16);
		expect(helpBox.x + helpBox.width).toBeLessThanOrEqual(width - 16 + 1);
	}
	for (const label of ['Abbrechen', 'Speichern']) {
		const button = page.getByRole('button', { name: label, exact: true });
		const box = await measureBox(button);
		expect(box).not.toBeNull();
		if (!box) continue;
		expect(box.width).toBeGreaterThanOrEqual(240);
		// Buttons stay 36px visually; the ::after layer carries the 44px hit area.
		const hitHeight = await button.evaluate(
			(el) => Number.parseFloat(getComputedStyle(el, '::after').height) || 0,
		);
		expect(Math.max(box.height, hitHeight)).toBeGreaterThanOrEqual(44);
		expect(box.x + box.width).toBeLessThanOrEqual(width - 16 + 1);
		expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
	}
}

async function assertViewportLayout(page: Page, route: LayoutRoute): Promise<void> {
	const viewportWidth = page.viewportSize()?.width ?? 320;
	const metrics = await page.evaluate(() => ({
		innerWidth: window.innerWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}));
	expect(metrics.innerWidth).toBe(viewportWidth);
	const overflow = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('*')]
			.map((element) => ({
				tag: element.tagName,
				id: element.id,
				slot: element.dataset.slot,
				className: element.className,
				rect: element.getBoundingClientRect().toJSON(),
			}))
			.filter(({ rect }) => rect.left < -1 || rect.right > window.innerWidth + 1)
			.slice(0, 10),
	);
	expect(metrics.scrollWidth, `${route} overflow: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(
		viewportWidth,
	);
	const { nav } = await assertNav(page, viewportWidth);

	if (route === 'shopping') {
		const input = await page.locator('#shopping-name').boundingBox();
		const submit = await page.getByRole('button', { name: 'Artikel hinzufügen' }).boundingBox();
		expect(input).not.toBeNull();
		expect(submit).not.toBeNull();
		if (input && submit) {
			// Eine Eingabezeile; bei 200% rutscht die Icon-Aktion darunter.
			expect(input.width).toBeGreaterThanOrEqual(200);
			expect(input.height).toBeGreaterThanOrEqual(44);
			expect(submit.height).toBeGreaterThanOrEqual(44);
			expect(submit.x + submit.width).toBeLessThanOrEqual(viewportWidth - 16 + 1);
		}
		const row = page.locator('[data-shopping-row]').first();
		const title = row.locator('[data-slot="item-title"]');
		const actions = row.locator('[data-slot="item-actions"]');
		const rowBox = await row.boundingBox();
		const titleBox = await title.boundingBox();
		const actionsBox = await actions.boundingBox();
		expect(rowBox).not.toBeNull();
		expect(titleBox).not.toBeNull();
		expect(actionsBox).not.toBeNull();
		if (rowBox && titleBox && actionsBox) {
			const wordLines = await title.evaluate((element) => {
				const textNode = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
				if (!textNode) throw new Error('shopping title text node missing');
				const value = textNode.textContent ?? '';
				return ['Ungesüßte', 'Hafermilch'].map((word) => {
					const start = value.indexOf(word);
					const range = document.createRange();
					range.setStart(textNode, start);
					range.setEnd(textNode, start + word.length);
					return { word, lineCount: range.getClientRects().length };
				});
			});
			for (const word of wordLines) expect(word.lineCount, word.word).toBe(1);
			// Name und Aktionen überlappen nie: nebeneinander oder (bei großer Schrift) untereinander.
			expect(
				titleBox.x + titleBox.width <= actionsBox.x + 1 ||
					titleBox.y + titleBox.height <= actionsBox.y + 1,
			).toBe(true);
			expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
		}
	} else if (route === 'inventory') {
		const row = page.locator('[data-slot="item"]').filter({ hasText: LONG_INVENTORY_NAME }).first();
		const title = row.locator('[data-slot="item-title"]');
		const name = title.locator(`span[title="${LONG_INVENTORY_NAME}"]`);
		const quantity = row.locator('[data-slot="item-description"]');
		const actions = row.locator('[data-slot="item-actions"]');
		const contentRow = row.locator(':scope > div').first();
		const contentRowMetrics = await contentRow.evaluate((element) => ({
			clientWidth: element.clientWidth,
			scrollWidth: element.scrollWidth,
		}));
		// 44px pseudo-element hit areas can extend 4px beyond each 36px icon button.
		expect(contentRowMetrics.scrollWidth - contentRowMetrics.clientWidth).toBeLessThanOrEqual(8);
		for (const text of [name, quantity]) {
			const metrics = await text.evaluate((element) => ({
				clientWidth: element.clientWidth,
				scrollWidth: element.scrollWidth,
			}));
			expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
		}
		await expect(name).toHaveText(LONG_INVENTORY_NAME);
		const rowBox = await row.boundingBox();
		const titleBox = await title.boundingBox();
		const actionsBox = await actions.boundingBox();
		expect(rowBox).not.toBeNull();
		expect(titleBox).not.toBeNull();
		expect(actionsBox).not.toBeNull();
		if (rowBox && titleBox && actionsBox) {
			expect(titleBox.x).toBeGreaterThanOrEqual(rowBox.x);
			expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
			expect(actionsBox.x).toBeGreaterThanOrEqual(rowBox.x);
			expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
			expectRectsNotToOverlap(titleBox, actionsBox);
		}
		const buttons = await row.getByRole('button').all();
		expect(buttons).toHaveLength(4);
		for (const button of buttons) {
			await expect(button).toBeVisible();
			const box = await button.boundingBox();
			const hitTarget = await button.evaluate((element) => {
				const after = getComputedStyle(element, '::after');
				return {
					width: Number.parseFloat(after.width),
					height: Number.parseFloat(after.height),
				};
			});
			expect(box).not.toBeNull();
			expect(hitTarget.width).toBeGreaterThanOrEqual(44);
			expect(hitTarget.height).toBeGreaterThanOrEqual(44);
			if (box && rowBox) {
				expect(box.x).toBeGreaterThanOrEqual(rowBox.x);
				expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
			}
		}
		const firstButton = buttons[0];
		if (!firstButton) throw new Error('inventory row actions are missing');
		await firstButton.focus();
		for (const button of buttons.slice(1)) {
			await page.keyboard.press('Tab');
			await expect(button).toBeFocused();
		}
	} else if (route === 'chores') {
		const row = page.locator('[data-slot="item"]').filter({ hasText: 'Bad putzen' }).first();
		expect(await row.count()).toBe(1);
		const title = row.locator('[data-slot="item-title"]');
		const actions = row.locator('[data-slot="item-actions"]');
		const rowBox = await row.boundingBox();
		const titleBox = await title.boundingBox();
		const actionsBox = await actions.boundingBox();
		expect(rowBox).not.toBeNull();
		expect(titleBox).not.toBeNull();
		expect(actionsBox).not.toBeNull();
		await assertWholeWordsOnSingleLines(title, ['Bad', 'putzen']);
		if (rowBox && titleBox && actionsBox) {
			expect(titleBox.x).toBeGreaterThanOrEqual(rowBox.x);
			expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
			expect(actionsBox.x).toBeGreaterThanOrEqual(rowBox.x);
			expect(actionsBox.x + actionsBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
			expectRectsNotToOverlap(titleBox, actionsBox);
		}
		for (const button of await row.getByRole('button').all()) {
			const box = await button.boundingBox();
			expect(box).not.toBeNull();
			if (!box) continue;
			// Buttons stay 36px visually; the ::after layer carries the 44px hit area.
			const hitHeight = await button.evaluate(
				(el) => Number.parseFloat(getComputedStyle(el, '::after').height) || 0,
			);
			expect(Math.max(box.height, hitHeight)).toBeGreaterThanOrEqual(44);
			expect(box.x + box.width).toBeLessThanOrEqual(viewportWidth + 1);
		}
	} else {
		const contentBox = await page.locator('[data-home-content]').boundingBox();
		expect(contentBox).not.toBeNull();
		if (contentBox) expect(contentBox.x + contentBox.width).toBeLessThanOrEqual(viewportWidth + 1);
		const detail = page.getByText('Für dich · heute fällig', { exact: true });
		await expect(detail).toHaveCount(1);
		const detailMetrics = await detail.evaluate((element) => {
			const card = element.closest('li');
			if (!card) throw new Error('Home today row missing');
			const cardStyle = getComputedStyle(card);
			const cardInnerWidth =
				card.getBoundingClientRect().width -
				Number.parseFloat(cardStyle.paddingLeft) -
				Number.parseFloat(cardStyle.paddingRight) -
				Number.parseFloat(cardStyle.borderLeftWidth) -
				Number.parseFloat(cardStyle.borderRightWidth);
			const textNode = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
			if (!textNode) throw new Error('Home focus detail text missing');
			const value = textNode.textContent ?? '';
			const words = ['heute', 'fällig'].map((word) => {
				const start = value.indexOf(word);
				const range = document.createRange();
				range.setStart(textNode, start);
				range.setEnd(textNode, start + word.length);
				return { word, lineCount: range.getClientRects().length };
			});
			return { cardInnerWidth, detailWidth: element.getBoundingClientRect().width, words };
		});
		expect(detailMetrics.detailWidth).toBeLessThanOrEqual(detailMetrics.cardInnerWidth + 1);
		for (const word of detailMetrics.words) expect(word.lineCount, word.word).toBe(1);
	}

	if (route === 'shopping') await page.getByText(/^Erledigt \(/).click();
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	await page.waitForTimeout(50);
	const lastAction =
		route === 'shopping'
			? page.getByRole('button', { name: /Erledigte Artikel entfernen/ })
			: route === 'inventory'
				? page.locator('a').filter({ hasText: 'Einkaufsliste öffnen' }).last()
				: route === 'chores'
					? page.getByRole('button', { name: /Als erledigt markieren: Bad putzen/ })
					: page.locator('[data-home-content] a').last();
	await expect(lastAction).toHaveCount(1);
	// Aufgeklappte Abschnitte und smooth scroll brauchen einen Moment, bis das Layout steht.
	await expect(async () => {
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		const lastActionBox = await lastAction.boundingBox();
		const finalNavBox = await nav.boundingBox();
		expect(lastActionBox).not.toBeNull();
		expect(finalNavBox).not.toBeNull();
		if (lastActionBox && finalNavBox) {
			expect(lastActionBox.y + lastActionBox.height).toBeLessThanOrEqual(finalNavBox.y - 4);
		}
	}).toPass({ timeout: 5000 });
}

for (const route of ['home', 'chores', 'shopping', 'inventory'] as const) {
	for (const colorScheme of ['light'] as const) {
		for (const textScale of ['normal', '200%'] as const) {
			test(`${route} remains readable at 320px (${colorScheme}, ${textScale} text)`, async ({
				page,
			}) => {
				await page.setViewportSize({ width: 320, height: 740 });
				await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
				await setupMember(page);
				if (route === 'shopping') {
					// Keep the admin-only clear action present for the layout measurement;
					// non-admin visibility is covered by the focused authorization test.
					await page.route(`**/api/wg/${SHARE_CODE}/members*`, (request) =>
						request.fulfill({
							json: {
								members: [{ id: MEMBER_ID, name: 'dsaf', active: true }],
								viewerIsAdmin: true,
							},
						}),
					);
				}
				await mockLayoutApis(page);
				await navigateToFeature(
					page,
					route === 'home'
						? `/wg/${SHARE_CODE}`
						: `/wg/${SHARE_CODE}/${route === 'chores' ? 'putzen' : route === 'shopping' ? 'einkauf' : 'vorraete'}`,
				);
				await dismissOnboarding(page);
				await expect(
					page.getByRole('heading', {
						name:
							route === 'home'
								? 'Für dich'
								: route === 'chores'
									? 'Putzplan'
									: route === 'shopping'
										? 'Einkaufsliste'
										: 'Vorräte',
					}),
				).toBeVisible({ timeout: 30_000 });
				expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
				if (textScale === '200%') {
					await page.evaluate(() => {
						document.documentElement.style.fontSize = '200%';
					});
					await page.setViewportSize({ width: 320, height: 740 });
					await page.waitForTimeout(100);
				}
				const rootFontSize = await page.evaluate(
					() => getComputedStyle(document.documentElement).fontSize,
				);
				// Normale Schrift skaliert auf schmalen Handys fluid (90–100 %), 200 % bleibt exakt.
				if (textScale === '200%') {
					expect(rootFontSize).toBe('32px');
				} else {
					expect(Number.parseFloat(rootFontSize)).toBeGreaterThanOrEqual(14.4);
					expect(Number.parseFloat(rootFontSize)).toBeLessThanOrEqual(16);
				}
				if (route === 'inventory') {
					await page
						.getByRole('button', { name: 'Vorrat hinzufügen', exact: true })
						.first()
						.click();
					await assertInventoryModal(page, page.viewportSize()?.width ?? 320);
					await page.screenshot({
						path: test
							.info()
							.outputPath(`inventory-modal-${colorScheme}-${textScale.replace('%', '')}.png`),
						fullPage: true,
					});
					const modalForm = page.locator('[data-slot="drawer-content"] form').last();
					await modalForm.evaluate((form) => form.scrollTo(0, form.scrollHeight));
					await page.waitForTimeout(100);
					await page.screenshot({
						path: test
							.info()
							.outputPath(
								`inventory-modal-bottom-${colorScheme}-${textScale.replace('%', '')}.png`,
							),
						fullPage: true,
					});
					await page.getByRole('button', { name: 'Abbrechen', exact: true }).click({ force: true });
					await expect(page.getByRole('heading', { name: 'Neuer Vorrat' })).toBeHidden();
					await page.waitForTimeout(500);
				}
				await assertViewportLayout(page, route);
				await page.screenshot({
					path: test.info().outputPath(`${route}-${colorScheme}-${textScale.replace('%', '')}.png`),
					fullPage: true,
				});
			});
		}
	}
}

const extraInventoryLayouts = [320, 360, 390]
	.flatMap((width) =>
		(['light', 'dark'] as const).flatMap((colorScheme) =>
			(['normal', '200%'] as const).map((textScale) => ({ width, colorScheme, textScale })),
		),
	)
	.filter(({ width, colorScheme }) => width !== 320 || colorScheme !== 'light');

for (const { width, colorScheme, textScale } of extraInventoryLayouts) {
	test(`inventory row remains readable at ${width}px (${colorScheme}, ${textScale} text)`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 740 });
		await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
		await setupMember(page);
		await mockLayoutApis(page);
		await navigateToFeature(page, `/wg/${SHARE_CODE}/vorraete`);
		await dismissOnboarding(page);
		await expect(page.getByRole('heading', { name: 'Vorräte' })).toBeVisible({ timeout: 30_000 });
		if (textScale === '200%') {
			await page.evaluate(() => {
				document.documentElement.style.fontSize = '200%';
			});
			await page.setViewportSize({ width, height: 740 });
			await page.waitForTimeout(100);
		}
		const rootFontSize = await page.evaluate(
			() => getComputedStyle(document.documentElement).fontSize,
		);
		if (textScale === '200%') {
			expect(rootFontSize).toBe('32px');
		} else {
			expect(Number.parseFloat(rootFontSize)).toBeGreaterThanOrEqual(14.4);
			expect(Number.parseFloat(rootFontSize)).toBeLessThanOrEqual(16);
		}
		await assertViewportLayout(page, 'inventory');
		await page.screenshot({
			path: test
				.info()
				.outputPath(`inventory-row-${width}-${colorScheme}-${textScale.replace('%', '')}.png`),
			fullPage: true,
		});
	});
}
