import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
test.use({ hasTouch: true, isMobile: true });

// WCAG 2.2.1 (Timing Adjustable): an auto-dismissing toast must pause while the
// user is hovering or focusing it, and only resume counting down afterwards.
// The toast's dismiss timer (Toast.tsx: TOAST_DURATION_MS = 4000) used to be a
// single un-pausable setTimeout, so this test must fail against that version.
const TOAST_DURATION_MS = 4000;
const PAST_DURATION_MS = TOAST_DURATION_MS + 400;

test('a toast pauses its auto-dismiss timer while hovered or focused', async ({ page }) => {
	const abo = {
		id: 'abo-netflix',
		description: 'Netflix',
		amountCents: 1499,
		currency: 'EUR',
		paidByMemberId: FIXTURE_WG.memberId,
		intervalMonths: 1,
		nextDueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
		lastCreatedAt: null,
		pausedAt: null,
		splits: [{ debtorMemberId: FIXTURE_WG.memberId, amountCents: 1499 }],
	};

	await setupMember(page);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/recurring-expenses`, (route) => {
		if (route.request().method() === 'GET') {
			return route.fulfill({ json: { recurringExpenses: [abo] } });
		}
		return route.continue();
	});
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/recurring-expenses/*`, (route) => {
		if (route.request().method() === 'DELETE') {
			return route.fulfill({ status: 500, json: { error: 'delete_failed' } });
		}
		return route.continue();
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/abos`);
	await dismissOnboarding(page);

	await page.getByRole('button', { name: /^Details öffnen: Netflix/ }).click();
	await page.getByRole('button', { name: 'Netflix löschen' }).click();
	await page.getByRole('button', { name: 'Löschen' }).last().click();

	const toast = page
		.getByRole('region', { name: 'Benachrichtigungen' })
		.getByRole('alert')
		.filter({ hasText: 'Fixkosten konnten nicht gelöscht werden' });
	await expect(toast).toBeVisible();
	const closeButton = toast.getByRole('button', { name: 'Benachrichtigung schließen' });

	// WCAG 2.4.3 (Focus Order): the toast stack must sit after the bottom nav
	// in the DOM so Tab reaches a toast's dismiss button right after whatever
	// the user just did, instead of jumping back to the page top.
	const navHandle = await page
		.getByRole('navigation', { name: 'WG Hauptnavigation' })
		.elementHandle();
	const toastComesAfterNav = await toast.evaluate((toastEl, navEl) => {
		// Node.DOCUMENT_POSITION_FOLLOWING = 4: navEl precedes toastEl in the DOM.
		if (!navEl) return false;
		return Boolean(navEl.compareDocumentPosition(toastEl) & 4);
	}, navHandle);
	expect(toastComesAfterNav).toBe(true);

	// Hover pause: still visible well past the normal auto-dismiss point.
	await toast.hover();
	await page.waitForTimeout(PAST_DURATION_MS);
	await expect(toast).toBeVisible();

	// Leaving restarts a fresh countdown; focusing the close button before it
	// elapses must pause it again.
	await page.mouse.move(5, 5);
	await closeButton.focus();
	await page.waitForTimeout(PAST_DURATION_MS);
	await expect(toast).toBeVisible();

	// Blurring resumes the timer, which then dismisses the toast normally.
	await closeButton.evaluate((el) => el.blur());
	await page.waitForTimeout(PAST_DURATION_MS);
	await expect(toast).toBeHidden();
});
