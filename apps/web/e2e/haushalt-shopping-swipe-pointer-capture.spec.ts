import { expect, test } from '@playwright/test';
import { dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

// Regression: ShoppingItemRow drives its swipe-to-toggle gesture with raw
// pointer events but used to never capture the pointer. Unlike touch events,
// pointer events retarget to whatever element sits under the finger at each
// point, so a fast/diagonal swipe that drifted off the row before lift-off
// meant onPointerUp (which resets swipeX and completes the toggle) never
// fired on that row, leaving it visually stuck mid-swipe. Fixed by calling
// setPointerCapture on pointerdown so move/up stay targeted at the row for
// the whole gesture, matching touch-event semantics.
test('shopping row captures the pointer when a touch swipe starts', async ({ page }) => {
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
						id: 'capture-item',
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

	const row = page.locator('[data-shopping-row]').first();
	await expect(row).toBeVisible();

	const capturedPointerId = await row.evaluate((el) => {
		let seen: number | null = null;
		const original = el.setPointerCapture.bind(el);
		el.setPointerCapture = (pointerId: number) => {
			seen = pointerId;
			return original(pointerId);
		};
		const box = el.getBoundingClientRect();
		el.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				pointerId: 7,
				pointerType: 'touch',
				clientX: box.x + 10,
				clientY: box.y + box.height / 2,
			}),
		);
		return seen;
	});

	expect(capturedPointerId).toBe(7);
});
