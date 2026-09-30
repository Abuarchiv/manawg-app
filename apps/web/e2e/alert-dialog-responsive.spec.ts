import { type Locator, type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

async function expectAlertDialogLayout(page: Page, dialog: Locator) {
	for (const fontSize of ['16px', '32px']) {
		await page.evaluate((size) => {
			document.documentElement.style.fontSize = size;
		}, fontSize);

		for (const theme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expect
				.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
				.toBe(theme === 'dark');

			for (const width of [320, 360, 390]) {
				await page.setViewportSize({ width, height: 740 });
				await dialog.evaluate(async (element) => {
					await Promise.all(
						element
							.getAnimations({ subtree: true })
							.map((animation) => animation.finished.catch(() => undefined)),
					);
				});
				const layout = await dialog.evaluate((element) => {
					const measure = (node: HTMLElement) => {
						const rect = node.getBoundingClientRect();
						const target = getComputedStyle(node, '::after');
						return {
							left: rect.left,
							right: rect.right,
							width: rect.width,
							clientWidth: node.clientWidth,
							scrollWidth: node.scrollWidth,
							touchWidth: Number.parseFloat(target.width),
							touchHeight: Number.parseFloat(target.height),
						};
					};
					const footer = element.querySelector<HTMLElement>('[data-slot="alert-dialog-footer"]');
					const header = element.querySelector<HTMLElement>('[data-slot="alert-dialog-header"]');
					const text = Array.from(
						element.querySelectorAll<HTMLElement>(
							'[data-slot="alert-dialog-title"], [data-slot="alert-dialog-description"]',
						),
					);
					return {
						rootFontSize: getComputedStyle(document.documentElement).fontSize,
						pageWidth: document.documentElement.scrollWidth,
						dialog: measure(element),
						footer: footer ? measure(footer) : null,
						header: header ? measure(header) : null,
						text: text.map(measure),
						buttons: footer
							? Array.from(footer.querySelectorAll<HTMLElement>('button')).map(measure)
							: [],
					};
				});

				expect(layout.rootFontSize).toBe(fontSize);
				expect(layout.pageWidth).toBeLessThanOrEqual(width);
				expect(layout.dialog.width).toBeLessThanOrEqual(width);
				expect(layout.dialog.scrollWidth).toBeLessThanOrEqual(layout.dialog.clientWidth + 1);
				expect(layout.footer).not.toBeNull();
				expect(layout.header).not.toBeNull();
				if (layout.footer) {
					expect(layout.footer.left).toBeGreaterThanOrEqual(layout.dialog.left - 2);
					expect(layout.footer.right).toBeLessThanOrEqual(layout.dialog.right + 2);
					expect(layout.footer.scrollWidth).toBeLessThanOrEqual(layout.footer.clientWidth + 1);
				}
				for (const item of [...(layout.header ? [layout.header] : []), ...layout.text]) {
					expect(item.right).toBeLessThanOrEqual(layout.dialog.right + 2);
					expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth + 1);
				}
				for (const button of layout.buttons) {
					expect(button.right).toBeLessThanOrEqual(layout.dialog.right + 2);
					expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
					expect(button.touchWidth).toBeGreaterThanOrEqual(44);
					expect(button.touchHeight).toBeGreaterThanOrEqual(44);
				}
			}
		}
	}
}

test('keeps chore and subscription confirmations usable at phone widths and 200% text', async ({
	page,
}) => {
	test.setTimeout(90_000);
	const shareCode = FIXTURE_WG.shareCode;
	const viewer = {
		id: FIXTURE_WG.memberId,
		name: FIXTURE_WG.memberName,
		color: null,
		active: true,
	};
	const title = 'Aufgabe alert-layout';
	const chore = {
		id: 'alert-layout',
		title,
		intervalDays: 7,
		recurrenceType: 'days',
		nextDueAt: new Date(Date.now() + 3_600_000).toISOString(),
		assignedMemberId: viewer.id,
		lastCompletedAt: null,
		lastCompletedByName: null,
		openGapCountForAssignee: 0,
	};
	const abo = {
		id: 'alert-layout-abo',
		description: 'Musik-Abo',
		amountCents: 123456,
		currency: 'EUR',
		paidByMemberId: viewer.id,
		intervalMonths: 1,
		nextDueAt: '2026-10-01T12:00:00.000Z',
		lastCreatedAt: null,
		pausedAt: null,
		splits: [{ debtorMemberId: viewer.id, amountCents: 123456 }],
	};

	await setupMember(page);
	await page.route(`**/api/wg/${shareCode}/members*`, (route) =>
		route.fulfill({ json: { members: [viewer], viewerIsAdmin: false } }),
	);
	await page.route(`**/api/wg/${shareCode}/chores*`, (route) =>
		route.fulfill({ json: { chores: [chore], monthCompletions: {} } }),
	);
	await page.route(`**/api/wg/${shareCode}/absences*`, (route) =>
		route.fulfill({ json: { absences: [] } }),
	);
	await page.route(`**/api/wg/${shareCode}/dashboard*`, (route) =>
		route.fulfill({
			json: { openShoppingCount: 0, dueChores: [], dueRecurringExpenses: [] },
		}),
	);
	await page.route(`**/api/wg/${shareCode}/chat/unread-count*`, (route) =>
		route.fulfill({ json: { count: 0, overflow: false } }),
	);
	await page.route(`**/api/wg/${shareCode}/recurring-expenses*`, (route) =>
		route.fulfill({ json: { recurringExpenses: [abo] } }),
	);

	await page.setViewportSize({ width: 320, height: 740 });
	await navigateToFeature(page, `/wg/${shareCode}/putzen`);
	await dismissOnboarding(page);

	const completeTrigger = page.getByRole('button', {
		name: `Als erledigt markieren: ${title}`,
	});
	await completeTrigger.focus();
	await page.keyboard.press('Enter');
	const choreDialog = page.getByRole('alertdialog');
	await expect(choreDialog).toBeVisible();
	await expectAlertDialogLayout(page, choreDialog);
	expect(await choreDialog.evaluate((element) => element.contains(document.activeElement))).toBe(
		true,
	);
	await choreDialog.getByRole('button', { name: 'Abbrechen', exact: true }).focus();
	await page.keyboard.press('Shift+Tab');
	await expect(
		choreDialog.getByRole('button', {
			name: `Erledigt bestätigen: ${title}`,
		}),
	).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(choreDialog).toBeHidden();
	await expect(completeTrigger).toBeFocused();

	await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
	await page.setViewportSize({ width: 320, height: 740 });
	await page.goto(`/wg/${shareCode}/abos`);
	await dismissOnboarding(page);
	await page.getByRole('button', { name: /Details öffnen: Musik-Abo/ }).click();
	const deleteTrigger = page.getByRole('button', { name: 'Musik-Abo löschen' });
	await expect(deleteTrigger).toBeVisible();
	await deleteTrigger.focus();
	await page.keyboard.press('Enter');
	const aboDialog = page.getByRole('alertdialog');
	await expect(aboDialog).toBeVisible();
	await expectAlertDialogLayout(page, aboDialog);
	expect(await aboDialog.evaluate((element) => element.contains(document.activeElement))).toBe(
		true,
	);
	await page.keyboard.press('Escape');
	await expect(aboDialog).toBeHidden();
	await expect(deleteTrigger).toBeFocused();
});
