import { type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires the local fixture server');

const SHARE_CODE = 'MTE8PZAT';

async function useLargeText(page: Page): Promise<void> {
	await page.evaluate(() => {
		document.documentElement.style.setProperty('font-size', '32px', 'important');
	});
	await page.waitForFunction(() => getComputedStyle(document.documentElement).fontSize === '32px');
}

for (const width of [320, 360]) {
	for (const colorScheme of ['light', 'dark'] as const) {
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
			const actionButton = page.getByRole('button', { name: 'Neue Fixkosten', exact: true });
			await expect(actionButton).toBeVisible();
			await expect(actionButton).toHaveAccessibleName('Neue Fixkosten');

			const geometry = {
				rootFontSize: await page.evaluate(
					() => getComputedStyle(document.documentElement).fontSize,
				),
				actionFontSize: await actionButton.evaluate((button) => getComputedStyle(button).fontSize),
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
		['pinnwand', 'Beitrag erstellen'],
		['putzen', 'Putzaufgabe erfassen'],
		['ausgaben', 'Ausgabe erfassen'],
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

	// Eine offene Forderung blendet auf „Erinnerungen“ den reinen Text-Button „Erinnern“ ein.
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
	// RemindButton legt den Button in einen Wrapper; das FAB-CSS greift nur auf direkte Kinder.
	const textAction = page.locator('[data-page-primary-action] button');
	await expect(textAction).toHaveCount(1);
	await expect(textAction).toBeVisible();
	expect(await textAction.evaluate((button) => getComputedStyle(button).fontSize)).not.toBe('0px');
});
