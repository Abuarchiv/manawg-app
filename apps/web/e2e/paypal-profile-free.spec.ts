import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

test('profile connects a PayPal recipient only after explicit consent and server confirmation', async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 320, height: 800 });
	await setupMember(page);

	let connected = false;
	let connectGets = 0;
	const connectPosts: Array<{ action?: string; consent?: boolean; merchantId?: string }> = [];
	const connectEndpoint = `**/api/wg/${FIXTURE_WG.shareCode}/paypal/connect`;
	const actionUrl = 'https://www.paypal.com/connect?trackingId=fixture-provider-hint';
	await page.route(connectEndpoint, async (route) => {
		if (route.request().method() === 'GET') {
			connectGets += 1;
			return route.fulfill({ json: { available: true, connected } });
		}
		const body = route.request().postDataJSON() as {
			action?: string;
			consent?: boolean;
			merchantId?: string;
		};
		connectPosts.push(body);
		if (body.action === 'start') return route.fulfill({ json: { url: actionUrl } });
		if (body.action === 'confirm') {
			connected = true;
			return route.fulfill({ json: { connected: true } });
		}
		return route.fulfill({ status: 400, json: { error: 'invalid_action' } });
	});
	await page.route('https://www.paypal.com/**', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<title>PayPal fixture</title>' }),
	);

	const profileMemberPath = `/api/wg/${FIXTURE_WG.shareCode}/members/${FIXTURE_WG.memberId}`;
	const profileMemberGets: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'GET' && new URL(request.url()).pathname === profileMemberPath) {
			profileMemberGets.push(request.url());
		}
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen`);
	await dismissOnboarding(page);
	await expect(page.getByRole('heading', { name: 'Dein Profil', exact: true })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByText(FIXTURE_WG.memberName, { exact: true })).toBeVisible();
	await expect(page.getByText('PayPal Merchant-ID', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('textbox', { name: /merchant.?id/i })).toHaveCount(0);
	await expect.poll(() => connectGets).toBeGreaterThan(0);
	await expect(
		page.getByText(
			'Mit „PayPal verbinden“ stimmst du zu, dass die für die Verknüpfung nötigen Kontodaten zwischen ManaWG und PayPal ausgetauscht werden.',
			{ exact: true },
		),
	).toBeVisible();

	const light = page.getByRole('button', { name: 'Hell', exact: true });
	const dark = page.getByRole('button', { name: 'Dunkel', exact: true });
	await expect(light).toBeVisible();
	await expect(dark).toBeVisible();
	await light.click();
	await expect(page.locator('html')).not.toHaveClass(/dark/);
	await expect(dark).toHaveAttribute('aria-pressed', 'false');
	await page.screenshot({
		path: testInfo.outputPath('paypal-connect-light-320.png'),
		animations: 'disabled',
	});
	await dark.click();
	await expect(page.locator('html')).toHaveClass(/dark/);
	await expect(dark).toHaveAttribute('aria-pressed', 'true');
	await page.screenshot({
		path: testInfo.outputPath('paypal-connect-dark-320.png'),
		animations: 'disabled',
	});

	await page.getByRole('button', { name: 'PayPal verbinden', exact: true }).click();
	await expect(page).toHaveURL(actionUrl);
	expect(connectPosts[0]).toEqual({ action: 'start', consent: true });

	await page.goto(
		`/wg/${FIXTURE_WG.shareCode}/einstellungen?keep=1&paypal=return&merchantIdInPayPal=untrusted-hint&trackingId=untrusted&consentStatus=granted`,
	);
	await dismissOnboarding(page);
	await expect(page.getByText('PayPal verbunden', { exact: true })).toBeVisible();
	expect(connectPosts.at(-1)).toEqual({
		action: 'confirm',
		merchantId: 'untrusted-hint',
	});
	const cleanUrl = new URL(page.url());
	expect(cleanUrl.searchParams.get('keep')).toBe('1');
	for (const hint of ['paypal', 'merchantIdInPayPal', 'trackingId', 'consentStatus']) {
		expect(cleanUrl.searchParams.has(hint)).toBe(false);
	}

	await page.waitForLoadState('networkidle');
	expect(profileMemberGets).toEqual([]);
});

test('pending and cancelled PayPal returns never show the recipient as connected', async ({
	page,
}) => {
	await setupMember(page);
	let confirmCalls = 0;
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/paypal/connect`, async (route) => {
		if (route.request().method() === 'GET') {
			return route.fulfill({ json: { available: true, connected: false } });
		}
		const body = route.request().postDataJSON() as { action?: string };
		if (body.action === 'confirm') {
			confirmCalls += 1;
			return route.fulfill({ status: 409, json: { error: 'paypal_onboarding_pending' } });
		}
		return route.fulfill({ status: 400, json: { error: 'invalid_action' } });
	});

	await navigateToFeature(
		page,
		`/wg/${FIXTURE_WG.shareCode}/einstellungen?keep=1&paypal=return&merchantIdInPayPal=hint`,
	);
	await dismissOnboarding(page);
	await expect(page.getByRole('heading', { name: 'Dein Profil', exact: true })).toBeVisible();
	await expect(page.getByText('PayPal-Verbindung wartet noch auf Bestätigung.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Verbindung prüfen', exact: true })).toBeVisible();
	await expect(page.getByText('PayPal verbunden', { exact: true })).toHaveCount(0);
	expect(confirmCalls).toBe(1);
	let cleanUrl = new URL(page.url());
	expect(cleanUrl.searchParams.get('keep')).toBe('1');
	expect(cleanUrl.searchParams.has('merchantIdInPayPal')).toBe(false);

	await page.goto(
		`/wg/${FIXTURE_WG.shareCode}/einstellungen?keep=1&paypal=cancel&trackingId=untrusted`,
	);
	await dismissOnboarding(page);
	await expect(page.getByText('PayPal-Verbindung wurde abgebrochen.')).toBeVisible();
	await expect(page.getByText('PayPal verbunden', { exact: true })).toHaveCount(0);
	expect(confirmCalls).toBe(1);
	cleanUrl = new URL(page.url());
	expect(cleanUrl.searchParams.get('keep')).toBe('1');
	expect(cleanUrl.searchParams.has('paypal')).toBe(false);
	expect(cleanUrl.searchParams.has('trackingId')).toBe(false);
});

test('shows a plain unavailable state when PayPal connection is not configured', async ({
	page,
}) => {
	await setupMember(page);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/paypal/connect`, (route) =>
		route.fulfill({ json: { available: false, connected: false } }),
	);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen`);
	await dismissOnboarding(page);
	await expect(page.getByRole('heading', { name: 'Dein Profil', exact: true })).toBeVisible();
	await expect(
		page.getByText('PayPal ist derzeit nicht verfügbar.', { exact: true }),
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'PayPal verbinden', exact: true })).toHaveCount(0);
});

test('does not redirect to an untrusted PayPal action host', async ({ page }) => {
	await setupMember(page);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/paypal/connect`, async (route) => {
		if (route.request().method() === 'GET') {
			return route.fulfill({ json: { available: true, connected: false } });
		}
		return route.fulfill({ json: { url: 'https://www.paypal.com.attacker.example/connect' } });
	});
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/einstellungen`);
	await dismissOnboarding(page);
	await expect(page.getByRole('heading', { name: 'Dein Profil', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'PayPal verbinden', exact: true }).click();
	await expect(
		page.getByText(
			'PayPal hat einen ungültigen Verbindungslink zurückgegeben. Bitte versuche es erneut.',
		),
	).toBeVisible();
	expect(new URL(page.url()).pathname).toBe(`/wg/${FIXTURE_WG.shareCode}/einstellungen`);
});

test('retries a return after status and provider confirmation failures', async ({ page }) => {
	await setupMember(page);
	let connectGets = 0;
	let confirmCalls = 0;
	let statusReady = false;
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/paypal/connect`, async (route) => {
		if (route.request().method() === 'GET') {
			connectGets += 1;
			if (!statusReady) {
				return route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } });
			}
			return route.fulfill({ json: { available: true, connected: false } });
		}
		const body = route.request().postDataJSON() as { action?: string };
		if (body.action === 'confirm') {
			confirmCalls += 1;
			if (confirmCalls === 1) {
				return route.fulfill({ status: 502, json: { error: 'provider_unavailable' } });
			}
			if (confirmCalls === 2) {
				return route.fulfill({ status: 409, json: { error: 'paypal_payment_pending' } });
			}
			return route.fulfill({ json: { connected: true } });
		}
		return route.fulfill({ status: 400, json: { error: 'invalid_action' } });
	});

	await navigateToFeature(
		page,
		`/wg/${FIXTURE_WG.shareCode}/einstellungen?keep=1&paypal=return&merchantIdInPayPal=retry-hint&trackingId=private`,
	);
	await dismissOnboarding(page);
	await expect(page.getByRole('heading', { name: 'Dein Profil', exact: true })).toBeVisible();
	await expect(
		page.getByText('PayPal-Verbindung konnte nicht geprüft werden. Bitte versuche es erneut.'),
	).toBeVisible();
	statusReady = true;
	await page.getByRole('button', { name: 'Verbindung prüfen', exact: true }).click();
	await expect.poll(() => confirmCalls).toBe(1);
	await expect(
		page.getByText('PayPal-Verbindung konnte nicht geprüft werden. Bitte versuche es erneut.'),
	).toBeVisible();
	await page.getByRole('button', { name: 'Verbindung prüfen', exact: true }).click();
	await expect.poll(() => confirmCalls).toBe(2);
	await expect(page.getByText('Eine Zahlung läuft noch. Versuche es danach erneut.')).toBeVisible();
	await page.getByRole('button', { name: 'Verbindung prüfen', exact: true }).click();
	await expect(page.getByText('PayPal verbunden', { exact: true })).toBeVisible();
	expect(connectGets).toBeGreaterThan(3);
	expect(confirmCalls).toBe(3);
	const cleanUrl = new URL(page.url());
	expect(cleanUrl.searchParams.get('keep')).toBe('1');
	expect(cleanUrl.searchParams.has('merchantIdInPayPal')).toBe(false);
	expect(cleanUrl.searchParams.has('trackingId')).toBe(false);
});
