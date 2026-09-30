import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

// Colored avatars are an intentional brand exception (docs/brand/design-language.md).
test('member avatars get distinct, stable colors per person', async ({ page }) => {
	await setupMember(page);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/members`, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		return route.fulfill({
			json: {
				members: [
					{ id: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName, color: null, active: true },
					{ id: '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55', name: 'Mina', color: null, active: true },
				],
				viewerIsAdmin: true,
			},
		});
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);
	const own = page.locator('span[aria-hidden]', { hasText: /^DS$/ }).first();
	const other = page.locator('span[aria-hidden]', { hasText: /^MI$/ }).first();
	await expect(other).toBeVisible();

	const bg = (el: typeof own) => el.evaluate((node) => getComputedStyle(node).backgroundColor);
	const muted = await page.evaluate(() => {
		const probe = document.createElement('div');
		probe.className = 'bg-muted';
		document.body.append(probe);
		const color = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return color;
	});

	const [ownBg, otherBg] = [await bg(own), await bg(other)];
	expect(ownBg).not.toBe(otherBg);
	expect(ownBg).not.toBe(muted);
	expect(otherBg).not.toBe(muted);
	// Same person, same color: every avatar of the viewer on the page matches.
	for (const avatar of await page.locator('span[aria-hidden]', { hasText: /^DS$/ }).all()) {
		expect(await bg(avatar)).toBe(ownBg);
	}
});
