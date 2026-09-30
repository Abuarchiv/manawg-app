import { expect, test } from '@playwright/test';

test('hydrates the offline fallback in a cold browser', async ({ browser }) => {
	const context = await browser.newContext({ serviceWorkers: 'allow' });
	const page = await context.newPage();
	const failedStaticAssets: string[] = [];
	page.on('requestfailed', (request) => {
		const path = new URL(request.url()).pathname;
		if (path.startsWith('/_next/static/') && /\.(?:js|css)$/i.test(path)) {
			failedStaticAssets.push(path);
		}
	});

	try {
		await page.goto('/');
		await expect
			.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), {
				timeout: 20_000,
			})
			.toBe(true);

		await context.setOffline(true);
		await page.goto('/cold-pwa-never-visited', { waitUntil: 'load' });

		await expect(page).toHaveTitle('Offline — ManaWG');
		await expect(page.locator('h1')).not.toHaveText('Verbindung wird geprüft …', {
			timeout: 15_000,
		});
		await expect(page.getByRole('button', { name: 'Offline-Status erneut prüfen' })).toBeVisible();
		expect(failedStaticAssets).toEqual([]);
	} finally {
		await context.close();
	}
});
