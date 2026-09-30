import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

// WCAG 2.4.11: the sticky offline banner must not cover focused content or the
// sticky settings tabs.
test('offline banner keeps focused content and sticky tabs clear', async ({ page, context }) => {
	await page.setViewportSize({ width: 320, height: 640 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await setupMember(page);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen#zugang`);
	await dismissOnboarding(page);

	const target = page.getByRole('button', { name: 'Einladungslink kopieren' });
	await expect(target).toBeVisible();
	await page.waitForLoadState('networkidle');

	await context.setOffline(true);
	const banner = page.locator('[data-offline-banner]');
	await expect(banner).toBeVisible();

	// Park the target under the banner: still inside the viewport, so focus only
	// scrolls it clear if scroll-padding marks the banner area as obscured.
	await target.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 10));
	await target.focus();

	const bannerBox = await banner.boundingBox();
	const targetBox = await target.boundingBox();
	const tabsBox = await page.getByRole('tablist').boundingBox();
	const checkBox = await banner
		.getByRole('link', { name: 'Offline-Übersicht prüfen' })
		.boundingBox();
	if (!bannerBox || !targetBox || !tabsBox || !checkBox)
		throw new Error('banner parts not measurable');
	const bannerBottom = bannerBox.y + bannerBox.height;
	expect(bannerBox.height).toBeGreaterThanOrEqual(44);
	expect(checkBox.x + checkBox.width).toBeLessThanOrEqual(320);
	expect(tabsBox.y).toBeGreaterThanOrEqual(bannerBottom);
	expect(targetBox.y).toBeGreaterThanOrEqual(bannerBottom);

	await context.setOffline(false);
});
