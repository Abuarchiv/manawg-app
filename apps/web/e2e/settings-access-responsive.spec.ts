import { type Page, expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

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
	await expect(
		page.getByText(
			'Admins können ihre Mitgliedschaft derzeit nicht beenden, weil die Admin-Rolle nicht übertragen werden kann.',
		),
	).toBeVisible();

	await page.getByRole('button', { name: 'Ausziehen: Mira' }).click();
	await expect(
		page.getByText(
			'Mira verliert den Zugriff auf diese WG. Historie und offene Salden bleiben erhalten. Ein aktives Admin-Mitglied kann sie später wieder aktivieren.',
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
			if (route.request().method() === 'GET') return route.fulfill({ json: { openBalances: [] } });
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
		name: 'Verlassen: WG auf diesem Gerät verlassen',
	});
	await expect(confirmLeave).toBeEnabled();
	await confirmLeave.click();
	await expect.poll(() => patchRequests).toBe(1);
	await expect(
		page.getByText(
			'Admins können ihre Mitgliedschaft derzeit nicht beenden, weil die Admin-Rolle nicht übertragen werden kann. Wenn du nur dieses Gerät abmelden möchtest, nutze oben „Konto abmelden“.',
		),
	).toBeVisible();
	await expect(page.getByText(/Bitte erneut versuchen/)).toHaveCount(0);
});
