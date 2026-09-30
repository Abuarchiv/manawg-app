import { expect, test } from '@playwright/test';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

// Regression: a field whose keyboard key reads "next" submitted the whole form
// and flagged the still-empty fields below it.
test('the "next" key moves to the following field instead of submitting', async ({ page }) => {
	await page.route('**/api/wg/mine', (route) => route.fulfill({ json: { wgs: [] } }));
	let submitted = false;
	await page.route('**/api/wg', (route) => {
		if (route.request().method() === 'POST') submitted = true;
		return route.fulfill({ status: 500, json: { error: 'unexpected' } });
	});

	await page.goto('/neu');
	await page.getByRole('button', { name: 'Neue WG erstellen', exact: true }).click();
	const wgName = page.getByLabel('WG-Name');
	await expect(wgName).toHaveAttribute('enterkeyhint', 'next');
	await wgName.fill('Sonnenallee');
	await wgName.press('Enter');

	await expect(page.getByLabel('Dein Anzeigename')).toBeFocused();
	await expect(page.locator('#create-wg-error, #create-wg-form-error')).toHaveCount(0);
	expect(submitted).toBe(false);
});
