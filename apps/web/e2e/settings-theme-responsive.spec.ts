import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
test.use({ viewport: { width: 320, height: 720 }, bypassCSP: true });

test('all theme choices stay reachable at 320px with 200% text', async ({ page }) => {
	await setupMember(page);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen`);
	await expect(page.getByRole('button', { name: 'System', exact: true })).toBeVisible();
	await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
	expect(await page.locator('html').evaluate((element) => getComputedStyle(element).fontSize)).toBe(
		'32px',
	);
	for (const tab of await page.getByRole('tab').all()) {
		const box = await tab.boundingBox();
		expect(box?.width).toBeGreaterThanOrEqual(120);
	}

	for (const name of ['Hell', 'Dunkel', 'System']) {
		const choice = page.getByRole('button', { name, exact: true });
		await expect(choice).toBeVisible();
		const box = await choice.boundingBox();
		if (!box) throw new Error(`${name} has no layout box`);
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(320);
	}
	for (const name of ['Hell', 'Dunkel', 'System']) {
		const choice = page.getByRole('button', { name, exact: true });
		await choice.click();
		await expect(choice).toHaveAttribute('aria-pressed', 'true');
		if (name === 'Dunkel') await expect(page.locator('html')).toHaveClass(/dark/);
		if (name === 'Hell') await expect(page.locator('html')).not.toHaveClass(/dark/);
	}
});
