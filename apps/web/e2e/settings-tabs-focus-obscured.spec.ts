import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

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
