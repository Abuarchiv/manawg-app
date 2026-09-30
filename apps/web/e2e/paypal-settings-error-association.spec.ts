import { expect, test } from '@playwright/test';
import { FIXTURE_WG, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

test('PayPal status failure is announced and can be retried from the keyboard', async ({
	page,
}) => {
	await setupMember(page);

	let retryRequested = false;
	let statusGets = 0;
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/paypal/connect`, async (route) => {
		if (route.request().method() === 'GET') {
			statusGets += 1;
			if (!retryRequested) {
				return route.fulfill({ status: 503, json: { error: 'temporary_failure' } });
			}
			return route.fulfill({ json: { available: true, connected: false } });
		}
		return route.fulfill({ status: 400, json: { error: 'unexpected_action' } });
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen`);
	const errorAlert = page.getByRole('alert').filter({
		hasText: 'PayPal-Verbindung konnte nicht geprüft werden. Bitte versuche es erneut.',
	});
	await expect(errorAlert).toBeVisible({ timeout: 30_000 });
	expect(statusGets).toBeGreaterThan(0);
	await expect(page.getByRole('textbox', { name: /merchant.?id/i })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'PayPal verbinden', exact: true })).toHaveCount(0);

	const retry = page.getByRole('button', { name: 'Verbindung prüfen', exact: true });
	await expect(retry).toBeVisible();
	const getsBeforeRetry = statusGets;
	await retry.focus();
	retryRequested = true;
	await page.keyboard.press('Enter');

	await expect(errorAlert).toBeHidden();
	await expect(page.getByRole('button', { name: 'PayPal verbinden', exact: true })).toBeEnabled();
	await expect.poll(() => statusGets).toBeGreaterThan(getsBeforeRetry);
});
