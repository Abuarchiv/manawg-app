import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

// WCAG 1.4.10 Reflow + 1.4.4 Resize Text: existing specs cover Chat's edit-focus
// behaviour and Pinnwand's individual comment layout at 320px/32px root font-size, but
// nothing asserted the *whole page* (composer, filter bar, message list together)
// never grows a horizontal scrollbar once every element inherits a doubled root
// font-size. This closes that gap for the two routes that didn't already have a
// page-level scrollWidth assertion at 200% text.
function announcement(id: string, content: string) {
	return {
		id,
		authorMemberId: FIXTURE_WG.memberId,
		content,
		imageUrl: null,
		kind: 'info',
		status: 'open',
		source: 'manual',
		sourcePath: null,
		pinnedAt: null,
		resolvedAt: null,
		resolvedByMemberId: null,
		createdAt: new Date().toISOString(),
		reactionCounts: {},
		myReactions: [],
		takers: [],
		comments: [],
	};
}

for (const colorScheme of ['light', 'dark'] as const) {
	test(`chat page reflows without horizontal scroll at 320px/200% text (${colorScheme})`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 320, height: 740 });
		await page.emulateMedia({ colorScheme });
		await setupMember(page);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
		await dismissOnboarding(page);
		await expect(page.getByRole('textbox').last()).toBeVisible();

		await page.evaluate(() => {
			document.documentElement.style.fontSize = '32px';
		});
		expect(await page.locator('html').evaluate((el) => getComputedStyle(el).fontSize)).toBe('32px');
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await expect(page.getByRole('textbox').last()).toBeVisible();
	});

	test(`pinnwand page reflows without horizontal scroll at 320px/200% text (${colorScheme})`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 320, height: 740 });
		await page.emulateMedia({ colorScheme });
		await setupMember(page);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/announcements*`, async (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			return route.fulfill({
				json: {
					announcements: [
						announcement(
							'post-reflow',
							'Ein etwas längerer Pinnwand-Beitrag, der bei 200% Textgröße nicht umbrechen darf',
						),
					],
				},
			});
		});
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/pinnwand`);
		await dismissOnboarding(page);
		await expect(
			page.getByText('Ein etwas längerer Pinnwand-Beitrag', { exact: false }),
		).toBeVisible();

		await page.evaluate(() => {
			document.documentElement.style.fontSize = '32px';
		});
		expect(await page.locator('html').evaluate((el) => getComputedStyle(el).fontSize)).toBe('32px');
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await expect(
			page.getByText('Ein etwas längerer Pinnwand-Beitrag', { exact: false }),
		).toBeVisible();
	});
}
