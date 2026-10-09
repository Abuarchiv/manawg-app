// Settings access/admin, data summary, legal links, pending switches and tab focus.
// Why: Every tab must stay reachable and readable at 320px / 200% text, and pending switches must not double-submit.

import { type Page, expect, test } from '@playwright/test';
import {
	FIXTURE_WG,
	dismissOnboarding,
	inMinimalMatrix,
	navigateToFeature,
	setupMember,
} from './support/helpers';

test.describe('settings access responsive', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	async function mockMemberRole(page: Page, viewerIsAdmin: () => boolean): Promise<void> {
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/members`, async (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			return route.fulfill({
				json: {
					members: [
						{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName, active: true },
						{ id: 'fixture-other-member', name: 'Mira', active: true },
					],
					viewerIsAdmin: viewerIsAdmin(),
				},
			});
		});
	}

	test('WG-code renewal actions remain visible and usable at phone widths and 200% text', async ({
		page,
	}) => {
		test.setTimeout(120_000);
		await setupMember(page);
		await mockMemberRole(page, () => true);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);

		const trigger = page.getByRole('button', { name: 'Erneuern: WG-Code', exact: true });
		const cancel = page.getByRole('button', { name: 'Abbrechen: WG-Code-Erneuerung' });
		const confirm = page.getByRole('button', { name: 'Bestätigen: WG-Code-Erneuerung' });
		await expect(trigger).toBeVisible({ timeout: 30_000 });
		let rotations = 0;
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}`, async (route) => {
			if (route.request().method() !== 'PATCH') return route.continue();
			rotations += 1;
			return route.fulfill({
				json: { wg: { shareCode: FIXTURE_WG.shareCode, joiningEnabled: true } },
			});
		});
		let expectedRotations = 0;

		for (const width of [320, 360, 390]) {
			for (const fontSize of [16, 32]) {
				for (const dark of [false, true]) {
					await page.setViewportSize({ width, height: 900 });
					await page.evaluate(
						({ fontSize: size, dark: useDark }) => {
							document.documentElement.style.fontSize = `${size}px`;
							document.documentElement.classList.toggle('dark', useDark);
						},
						{ fontSize, dark },
					);
					expect(
						await page.locator('html').evaluate((element) => getComputedStyle(element).fontSize),
					).toBe(`${fontSize}px`);

					await expect(trigger).toBeVisible();
					await trigger.click();
					await expect(cancel).toBeVisible();
					await expect(confirm).toBeVisible();

					const actions = [cancel, confirm];
					const actionBounds = await Promise.all(
						actions.map((action) =>
							action.evaluate((button) => {
								const buttonBounds = button.getBoundingClientRect();
								const sectionBounds = button
									.closest('section[aria-label="Zugang"]')
									?.getBoundingClientRect();
								if (!sectionBounds) throw new Error('Zugang section not found');
								return {
									left: buttonBounds.left,
									right: buttonBounds.right,
									sectionLeft: sectionBounds.left,
									sectionRight: sectionBounds.right,
								};
							}),
						),
					);
					for (const bounds of actionBounds) {
						expect(bounds.left).toBeGreaterThanOrEqual(bounds.sectionLeft);
						expect(bounds.right).toBeLessThanOrEqual(bounds.sectionRight);
					}

					await cancel.click();
					await expect(trigger).toBeVisible();
					await trigger.click();
					if (width === 320 && fontSize === 32 && dark) {
						await cancel.focus();
						await page.keyboard.press('Tab');
						await expect(confirm).toBeFocused();
						await page.keyboard.press('Enter');
					} else {
						await confirm.click();
					}
					expectedRotations += 1;
					await expect.poll(() => rotations).toBe(expectedRotations);
					await expect(trigger).toBeVisible();
				}
			}
		}
	});

	test('WG access controls match admin permissions and explain deactivation accurately', async ({
		page,
	}) => {
		await setupMember(page);
		let viewerIsAdmin = false;
		await mockMemberRole(page, () => viewerIsAdmin);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);

		const joiningToggle = page.getByRole('switch');
		const renewCode = page.getByRole('button', { name: 'Erneuern: WG-Code', exact: true });
		const deleteWg = page.getByRole('button', { name: 'Komplette WG für alle löschen' });
		const leaveWg = page.getByRole('button', { name: 'WG verlassen', exact: true });
		await expect(joiningToggle).toBeDisabled();
		await expect(renewCode).toBeDisabled();
		await expect(deleteWg).toBeDisabled();
		await expect(leaveWg).toBeEnabled();
		await expect(page.getByText('Nur Admins können den WG-Code verwalten.')).toBeVisible();

		viewerIsAdmin = true;
		await page.reload();
		await expect(joiningToggle).toBeEnabled();
		await expect(renewCode).toBeEnabled();
		await expect(deleteWg).toBeEnabled();
		await expect(leaveWg).toHaveCount(0);
		await expect(page.getByText('Übergib zuerst die Admin-Rolle', { exact: false })).toBeVisible();

		await page.getByRole('button', { name: 'Ausziehen: Mira' }).click();
		await expect(
			page.getByText(
				'Mira verliert den Zugriff auf diese WG. Historie und offene Salden bleiben erhalten. Ein aktives Admin-Mitglied kann den Zugang später wieder aktivieren.',
			),
		).toBeVisible();
		await expect(page.getByText(/behält aber Zugriff auf dieses Gerät/)).toHaveCount(0);
	});

	test('admin_required explains why an admin cannot leave the WG', async ({ page }) => {
		await setupMember(page);
		await mockMemberRole(page, () => false);
		let patchRequests = 0;
		await page.route(
			`**/api/wg/${FIXTURE_WG.shareCode}/members/${FIXTURE_WG.memberId}`,
			async (route) => {
				if (route.request().method() === 'GET')
					return route.fulfill({ json: { openBalances: [] } });
				if (route.request().method() === 'PATCH') {
					patchRequests += 1;
					return route.fulfill({
						status: 403,
						json: { code: 'admin_required', error: 'admin_required' },
					});
				}
				return route.continue();
			},
		);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);

		await page.getByRole('button', { name: 'WG verlassen', exact: true }).click();
		const confirmLeave = page.getByRole('button', {
			name: 'Verlassen: WG verlassen',
		});
		await expect(confirmLeave).toBeEnabled();
		await confirmLeave.click();
		await expect.poll(() => patchRequests).toBe(1);
		await expect(
			page.getByText(
				'Übergib zuerst die Admin-Rolle an ein aktives Mitglied, dann kannst du die WG verlassen. Wenn du nur dieses Gerät abmelden möchtest, nutze oben „Konto abmelden“.',
			),
		).toBeVisible();
		await expect(page.getByText(/Bitte erneut versuchen/)).toHaveCount(0);
	});

	test('admin can hand over the admin role after a confirmation', async ({ page }) => {
		await setupMember(page);
		await mockMemberRole(page, () => true);
		let transfers = 0;
		await page.route(
			`**/api/wg/${FIXTURE_WG.shareCode}/members/fixture-other-member/admin`,
			async (route) => {
				transfers += 1;
				return route.fulfill({ json: { member: { id: 'fixture-other-member', name: 'Mira' } } });
			},
		);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);

		await page.getByRole('button', { name: 'Admin übergeben: Mira' }).click();
		await expect(page.getByText('Mira wird Admin dieser WG.')).toBeVisible();
		await page.getByRole('button', { name: 'Übergeben', exact: true }).click();
		await expect.poll(() => transfers).toBe(1);
		await expect(page.getByText(/Mira ist jetzt Admin/)).toBeVisible();
	});
});

test.describe('settings data summary responsive', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	const width = 320;
	for (const colorScheme of ['light', 'dark'] as const) {
		for (const textScale of ['normal', '32px'] as const) {
			if (!inMinimalMatrix({ width, dark: colorScheme === 'dark', large: textScale !== 'normal' }))
				continue;
			test(`export summary fits ${width}px ${colorScheme} ${textScale}`, async ({ page }) => {
				await page.setViewportSize({ width, height: 844 });
				await page.emulateMedia({ colorScheme });
				await setupMember(page);
				await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#daten`);
				await expect(page.getByRole('heading', { name: 'Datenexport' })).toBeVisible({
					timeout: 30_000,
				});

				if (textScale === '32px') {
					await page.evaluate(() => {
						document.documentElement.style.fontSize = '200%';
					});
				}

				const summary = page
					.getByRole('region', { name: 'Datenexport' })
					.locator('div.border-b')
					.first();
				const labels = await summary.locator('span').evaluateAll((spans) =>
					spans
						.filter((span) =>
							['Ausgaben', 'Abwesenheiten'].includes(span.textContent?.trim() ?? ''),
						)
						.map((span) => {
							const { left, right } = span.getBoundingClientRect();
							return { text: span.textContent?.trim(), left, right };
						}),
				);

				expect(labels).toHaveLength(2);
				for (const label of labels) {
					expect(label.left).toBeGreaterThanOrEqual(-1);
					expect(label.right).toBeLessThanOrEqual(width + 1);
				}
				const overflow = await summary.evaluate(
					(element) => element.scrollWidth - element.clientWidth,
				);
				expect(overflow).toBeLessThanOrEqual(1);
				if (colorScheme === 'dark' && textScale === '32px') {
					await page.screenshot({
						path: test.info().outputPath('export-summary-320-dark-32.png'),
					});
				}
			});
		}
	}
});

test.describe('settings legal links responsive', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	test('legal links fit at 320px with normal and 200% text sizes', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 760 });
		await page.emulateMedia({ colorScheme: 'light' });
		await setupMember(page);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen`);
		await page.getByRole('tab', { name: 'Daten', exact: true }).click();

		const privacyLink = page.getByRole('link', {
			name: 'Datenschutz (öffnet in neuem Tab)',
			exact: true,
		});
		await expect(privacyLink).toBeVisible();
		const label = privacyLink.locator(':scope > span');
		const chevron = privacyLink.locator(':scope > svg');

		const width = 320;
		for (const fontSize of [16, 32]) {
			for (const colorScheme of ['light', 'dark'] as const) {
				await page.setViewportSize({ width, height: 760 });
				await page.emulateMedia({ colorScheme });
				await page.locator('html').evaluate((html, size) => {
					html.style.setProperty('font-size', `${size}px`, 'important');
				}, fontSize);

				await expect(page.locator('html')).toHaveCSS('font-size', `${fontSize}px`);
				if (colorScheme === 'dark') {
					await expect(page.locator('html')).toHaveClass(/dark/);
				} else {
					await expect(page.locator('html')).not.toHaveClass(/dark/);
				}

				const geometry = await privacyLink.evaluate((link) => {
					const anchor = link.getBoundingClientRect();
					return {
						anchor: {
							x: anchor.x,
							right: anchor.right,
							height: anchor.height,
							clientWidth: link.clientWidth,
							scrollWidth: link.scrollWidth,
						},
					};
				});
				const labelBox = await label.boundingBox();
				const chevronBox = await chevron.boundingBox();
				if (!labelBox || !chevronBox)
					throw new Error('Legal link label or chevron has no layout box');
				expect(geometry.anchor.x).toBeGreaterThanOrEqual(0);
				expect(geometry.anchor.right).toBeLessThanOrEqual(width);
				expect(geometry.anchor.height).toBeGreaterThanOrEqual(44);
				expect(geometry.anchor.scrollWidth).toBeLessThanOrEqual(geometry.anchor.clientWidth);
				expect(labelBox.x).toBeGreaterThanOrEqual(geometry.anchor.x);
				expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(geometry.anchor.right);
				expect(chevronBox.x).toBeGreaterThanOrEqual(geometry.anchor.x);
				expect(chevronBox.x + chevronBox.width).toBeLessThanOrEqual(geometry.anchor.right);

				if (fontSize === 32 && colorScheme === 'dark') {
					await page.evaluate(() => {
						if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
					});
					let reachedByKeyboard = false;
					for (let tab = 0; tab < 40; tab += 1) {
						await page.keyboard.press('Tab');
						if (await privacyLink.evaluate((link) => document.activeElement === link)) {
							reachedByKeyboard = true;
							break;
						}
					}
					expect(reachedByKeyboard).toBe(true);
					await expect(privacyLink).toBeFocused();
					const focusStyle = await privacyLink.evaluate((link) => ({
						isVisibleFocus: link.matches(':focus-visible'),
						boxShadow: getComputedStyle(link).boxShadow,
					}));
					expect(focusStyle.isVisibleFocus).toBe(true);
					expect(focusStyle.boxShadow).not.toBe('none');
				}
			}
		}
	});
});

test.describe('settings pending switches', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	test('notification switches reject additional changes until the pending save completes', async ({
		page,
	}) => {
		await setupMember(page);
		const status = {
			pushOptIn: false,
			pushConfigured: true,
			notifyAnnouncements: true,
			notifyChores: true,
			notifyExpenses: true,
			notifyReminders: true,
			notifyShopping: true,
			notifyInventory: true,
			notifyChat: true,
			notifyEvents: true,
			quietStartHour: null,
			quietEndHour: null,
		};
		let releaseSave = () => {};
		const saveGate = new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		const patches: unknown[] = [];
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/notifications`, async (route) => {
			if (route.request().method() !== 'PATCH') return route.fulfill({ json: status });
			patches.push(route.request().postDataJSON());
			await saveGate;
			return route.fulfill({ json: { ok: true } });
		});
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#benachrichtigungen`);
		const chores = page.getByRole('switch', { name: 'Putzplan', exact: true });
		const expenses = page.getByRole('switch', { name: 'Ausgaben', exact: true });
		const push = page.getByRole('switch', { name: 'Web Push', exact: true });
		await expect(chores).toBeEnabled();
		// Regression: the switch's <button> must declare type="button" (via nativeButton),
		// otherwise it defaults to type="submit" and submits any enclosing <form>.
		await expect(chores).toHaveAttribute('type', 'button');
		await expect(expenses).toBeChecked();
		const originalThumbPosition = await expenses
			.locator('[data-slot="switch-thumb"]')
			.evaluate((thumb) => getComputedStyle(thumb).left);
		await chores.click();
		// A quick tap still plays the liquid-glass lift before the thumb settles.
		await expect(chores.locator('[data-slot="switch-thumb"]')).toHaveAttribute('data-pressed', '');
		try {
			await expect.poll(() => patches.length).toBe(1);
			await expect(chores).toBeDisabled();
			await expect(expenses).toBeDisabled();
			await expect(push).toBeDisabled();
			// Native activation must not move the thumb while its save handler is locked.
			await expenses.evaluate((button) => (button as HTMLButtonElement).click());
			await expect(expenses).toBeChecked();
		} finally {
			releaseSave();
		}
		await expect(chores).toBeEnabled();
		await expect(chores).not.toBeChecked();
		await expect(chores.locator('[data-slot="switch-thumb"]')).not.toHaveAttribute('data-pressed');
		await expect(expenses).toBeEnabled();
		await expect(expenses).toBeChecked();
		await expect(expenses.locator('[data-slot="switch-thumb"]')).toHaveCSS(
			'left',
			originalThumbPosition,
		);
		expect(patches).toEqual([{ notifyChores: false }]);
		// iOS 26 geometry: checked thumb 2.5px inside the right edge, vertically centred.
		const [button, thumb] = await Promise.all([
			expenses.boundingBox(),
			expenses.locator('[data-slot="switch-thumb"]').boundingBox(),
		]);
		if (!button || !thumb) throw new Error('switch not rendered');
		expect(button.x + button.width - (thumb.x + thumb.width)).toBeCloseTo(2.5, 1);
		expect(button.y + button.height / 2 - (thumb.y + thumb.height / 2)).toBeCloseTo(0, 1);
	});
});

test.describe('settings tabs focus obscured', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	// WCAG 2.4.11: the settings page's sticky tab strip (TabsList) must not cover
	// content that gets scrolled/focused into view right beneath it, e.g. when a
	// user tabs backward (Shift+Tab) into the panel.
	test('sticky settings tab strip keeps focused content clear', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await setupMember(page);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);
		await dismissOnboarding(page);

		const target = page.getByRole('button', { name: 'Einladungslink kopieren' });
		await expect(target).toBeVisible();
		await page.waitForLoadState('networkidle');

		// Park the target right under the tab strip: still inside the viewport, so
		// focus only scrolls it clear if scroll-padding marks the strip as obscured.
		await target.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 10));
		await target.focus();

		const tabsBox = await page.getByRole('tablist').boundingBox();
		const targetBox = await target.boundingBox();
		if (!tabsBox || !targetBox) throw new Error('tab strip or target not measurable');
		const tabsBottom = tabsBox.y + tabsBox.height;
		expect(targetBox.y).toBeGreaterThanOrEqual(tabsBottom);
	});
});
