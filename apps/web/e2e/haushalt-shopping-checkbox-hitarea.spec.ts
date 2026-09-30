import { expect, test } from '@playwright/test';
import { dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

// Regression for a <44px touch target: ShoppingItemRow's checkbox grows its hit
// area with an invisible `after:-inset-2.5` pseudo-element, but the swipe-to-toggle
// row wraps everything in an <li> with `overflow-hidden`. Since the checkbox sits
// flush against the row's left edge (Item used px-0), any leftward hit-area
// extension used to get clipped by that overflow-hidden, leaving an effective
// ~34px target. Fix: `overflow-hidden` only applies while a swipe is in progress.
test('shopping item checkbox keeps its full hit area when not swiping', async ({ page }) => {
	test.skip(
		process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true',
		'requires the local fixture server',
	);
	await page.route('**/api/wg/MTE8PZAT/shopping', async (route) => {
		if (route.request().method() !== 'GET') {
			await route.continue();
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				items: [
					{
						id: 'hitarea-item',
						name: 'Milch',
						quantity: null,
						addedByMemberId: '7d898f9e-5ad7-4f5d-abed-8c3e99a76973',
						boughtAt: null,
						boughtByMemberId: null,
						createdAt: new Date().toISOString(),
					},
				],
			}),
		});
	});
	await setupMember(page);
	await navigateToFeature(page, '/wg/MTE8PZAT/einkauf');
	await dismissOnboarding(page);

	const checkbox = page.getByRole('checkbox', { name: 'Milch erledigen' });
	await expect(checkbox).toBeVisible();

	const li = page.locator('li:has(> :has([aria-label="Milch erledigen"]))').first();
	const overflow = await li.evaluate((el) => getComputedStyle(el).overflow);
	expect(overflow).not.toBe('hidden');

	// A point 5px to the left of the checkbox's own box sits inside the invisible
	// after:-inset-2.5 hit area (10px). It must still resolve to the checkbox, not
	// get clipped by an ancestor.
	const box = await checkbox.boundingBox();
	if (!box) throw new Error('checkbox has no bounding box');
	const hitTarget = await page.evaluate(
		({ x, y }) => {
			const el = document.elementFromPoint(x, y);
			return el?.closest('[data-slot="checkbox"]') !== null;
		},
		{ x: Math.max(0, box.x - 5), y: box.y + box.height / 2 },
	);
	expect(hitTarget).toBe(true);
});
