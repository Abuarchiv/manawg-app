import { type Page, expect, test } from '@playwright/test';
import { E2E_CREATED_WG } from '../src/core/infra/e2e-db-down';
import { navigateToFeature } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

async function setupCreatedWgOwner(page: Page): Promise<void> {
	await page.addInitScript(
		({ wgId, memberId, memberName }) => {
			try {
				localStorage.setItem(
					`manawg_identity:${wgId}`,
					JSON.stringify({ memberId, name: memberName, memberToken: 'fixture-member-token' }),
				);
				localStorage.removeItem('manawg:offline-actions');
			} catch {
				window.__manawgStorageBlocked = true;
				document.documentElement?.setAttribute('data-manawg-storage-blocked', 'true');
			}
		},
		{
			wgId: E2E_CREATED_WG.id,
			memberId: E2E_CREATED_WG.member.id,
			memberName: 'Smoke Tester',
		},
	);
	await page.route(`**/api/wg/${E2E_CREATED_WG.shareCode}/members`, async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		if (!body.members?.some((member: { id: string }) => member.id === E2E_CREATED_WG.member.id)) {
			throw new Error('Expected the created-WG owner in the member fixture');
		}
		await route.fulfill({ response, json: { ...body, viewerIsAdmin: true } });
	});
}

test('WG-code renewal actions remain visible and usable at phone widths and 200% text', async ({
	page,
}) => {
	test.setTimeout(120_000);
	await setupCreatedWgOwner(page);
	await navigateToFeature(page, `/wg/${E2E_CREATED_WG.shareCode}/einstellungen#zugang`);

	const trigger = page.getByRole('button', { name: 'Erneuern: WG-Code', exact: true });
	const cancel = page.getByRole('button', { name: 'Abbrechen: WG-Code-Erneuerung' });
	const confirm = page.getByRole('button', { name: 'Bestätigen: WG-Code-Erneuerung' });
	await expect(trigger).toBeVisible({ timeout: 30_000 });
	let rotations = 0;
	await page.route(`**/api/wg/${E2E_CREATED_WG.shareCode}`, async (route) => {
		if (route.request().method() !== 'PATCH') return route.continue();
		rotations += 1;
		return route.fulfill({
			json: { wg: { shareCode: E2E_CREATED_WG.shareCode, joiningEnabled: true } },
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
