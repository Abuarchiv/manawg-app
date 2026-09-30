import { expect, test } from '@playwright/test';

test.skip(
	!process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ||
		!process.env.NEXT_PUBLIC_PAYPAL_PARTNER_ATTRIBUTION_ID,
	'requires the PayPal SDK public configuration used by the application',
);

function directive(csp: string, name: string): string | undefined {
	return csp
		.split(';')
		.map((item) => item.trim())
		.find((item) => item.startsWith(`${name} `))
		?.slice(name.length)
		.trim();
}

for (const path of ['/', '/neu']) {
	test(`PayPal document security works from ${path} and retains the popup opener`, async ({
		page,
	}) => {
		await page.route('https://paypal.test/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'text/html',
				body: '<title>PayPal popup probe</title>',
			}),
		);

		const response = await page.goto(path);
		if (!response) throw new Error(`No document response for ${path}`);
		const headers = response.headers();
		expect(headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');

		const csp = headers['content-security-policy'];
		expect(csp).toBeTruthy();
		const scriptSrc = directive(csp, 'script-src') ?? '';
		const connectSrc = directive(csp, 'connect-src') ?? '';
		const frameSrc = directive(csp, 'frame-src') ?? '';
		const policyNonce = scriptSrc.match(/'nonce-([^']+)'/)?.[1];
		expect(policyNonce).toBeTruthy();
		expect(frameSrc).toContain('https://www.paypal.com');
		expect(frameSrc).toContain('https://www.sandbox.paypal.com');
		expect(connectSrc).toContain('https://www.paypal.com');
		expect(connectSrc).toContain('https://www.sandbox.paypal.com');

		const documentNonce = await page.evaluate(
			() => document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce,
		);
		expect(documentNonce).toBe(policyNonce);

		await page.evaluate(() => {
			const button = document.createElement('button');
			button.type = 'button';
			button.id = 'paypal-popup-probe';
			button.textContent = 'Open PayPal popup';
			button.style.position = 'fixed';
			button.style.top = '16px';
			button.style.right = '16px';
			button.style.zIndex = '2147483647';
			button.addEventListener('click', () =>
				window.open('https://paypal.test/checkout', 'paypal-checkout'),
			);
			document.body.append(button);
		});
		const popupPromise = page.waitForEvent('popup');
		await page.locator('#paypal-popup-probe').click();
		const popup = await popupPromise;
		await popup.waitForLoadState('domcontentloaded');
		expect(await popup.evaluate(() => window.opener !== null)).toBe(true);
	});
}
