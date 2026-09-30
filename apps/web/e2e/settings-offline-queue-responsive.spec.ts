import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const queuedAction = {
	id: `shopping:${FIXTURE_WG.shareCode}:responsive-test`,
	idempotencyKey: '11111111-1111-4111-8111-111111111111',
	type: 'shopping.create',
	wgId: FIXTURE_WG.id,
	shareCode: FIXTURE_WG.shareCode,
	memberId: FIXTURE_WG.memberId,
	createdAt: new Date().toISOString(),
	payload: { name: 'Milch', quantity: '1L' },
};

test('manual review explains the uncertain result and opens the WG list', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 844 });
	await setupMember(page);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#daten`);
	const section = page.getByRole('region', { name: 'Offline-Warteschlange' });
	await expect(section).toBeVisible();
	const warning =
		'Server prüfen: Die erste Version kann bereits gespeichert sein. Die Bearbeitung wurde nicht gesendet. Vergleiche den WG-Eintrag und verwirf diese Aktion erst danach; lege benötigte Änderungen neu an.';
	await page.evaluate(
		({ action, warningText }) => {
			localStorage.setItem(
				'manawg:offline-actions',
				JSON.stringify([
					{
						...action,
						id: `announcement:${action.shareCode}:manual-review`,
						type: 'announcement.create',
						lastError: warningText,
						payload: { content: 'Geänderter Beitrag', kind: 'info', imageUrl: null },
					},
				]),
			);
			window.dispatchEvent(new Event('manawg:offline-queue'));
		},
		{ action: queuedAction, warningText: warning },
	);
	const alert = section.getByRole('alert').filter({ hasText: warning });
	await expect(alert).toBeVisible();
	await expect(alert).toContainText(warning);
	const size = await alert.evaluate((element) => ({
		client: element.clientHeight,
		scroll: element.scrollHeight,
	}));
	expect(size.scroll).toBeLessThanOrEqual(size.client + 1);
	await expect(
		section.getByRole('button', { name: 'Offline-Warteschlange erneut synchronisieren' }),
	).toHaveCount(0);
	await expect(section.getByRole('button', { name: /Server prüfen:/ })).toHaveCount(0);
	await expect(section.getByRole('button', { name: /Offline-Aktion bearbeiten:/ })).toHaveCount(0);
	await expect(section.getByRole('button', { name: /Offline-Aktion verwerfen:/ })).toBeVisible();
	await section.getByRole('link', { name: /WG-Eintrag prüfen:/ }).click();
	await expect(page).toHaveURL(new RegExp(`/wg/${FIXTURE_WG.shareCode}/pinnwand$`));
});

const width = 320;
for (const colorScheme of ['light', 'dark'] as const) {
	for (const textScale of ['normal', '32px'] as const) {
		test(`offline retry fits ${width}px ${colorScheme} ${textScale}`, async ({ page }) => {
			await page.setViewportSize({ width, height: 844 });
			await page.emulateMedia({ colorScheme });
			await setupMember(page);
			await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#daten`);
			await expect(page.getByRole('heading', { name: 'Offline-Warteschlange' })).toBeVisible({
				timeout: 30_000,
			});
			const html = page.locator('html');
			if (colorScheme === 'dark') await expect(html).toHaveClass(/dark/);
			else await expect(html).not.toHaveClass(/dark/);
			await page.evaluate((action) => {
				localStorage.setItem('manawg:offline-actions', JSON.stringify([action]));
				window.dispatchEvent(new Event('manawg:offline-queue'));
			}, queuedAction);

			if (textScale === '32px') {
				await page.evaluate(() => {
					document.documentElement.style.fontSize = '200%';
				});
				expect(await html.evaluate((element) => getComputedStyle(element).fontSize)).toBe('32px');
			}

			const section = page.getByRole('region', { name: 'Offline-Warteschlange' });
			const retry = section.getByRole('button', {
				name: 'Offline-Warteschlange erneut synchronisieren',
			});
			await expect(retry).toBeEnabled();
			const bounds = await retry.locator('xpath=..').evaluate((row) => {
				const status = row.querySelector('p');
				const button = row.querySelector('button');
				if (!status || !button) throw new Error('Retry row is missing status or button');
				return {
					statusLeft: status.getBoundingClientRect().left,
					statusRight: status.getBoundingClientRect().right,
					buttonLeft: button.getBoundingClientRect().left,
					buttonRight: button.getBoundingClientRect().right,
				};
			});

			expect(bounds.statusLeft).toBeGreaterThanOrEqual(-1);
			expect(bounds.statusRight).toBeLessThanOrEqual(width + 1);
			expect(bounds.buttonLeft).toBeGreaterThanOrEqual(-1);
			expect(bounds.buttonRight).toBeLessThanOrEqual(width + 1);
			if (colorScheme === 'dark' && textScale === '32px') {
				await retry.scrollIntoViewIfNeeded();
				await page.screenshot({
					path: test.info().outputPath('offline-retry-320-dark-32.png'),
				});
			}
		});
	}
}
