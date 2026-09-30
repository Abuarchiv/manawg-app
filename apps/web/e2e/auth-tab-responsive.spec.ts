import { expect, test } from '@playwright/test';

test.describe('phone authentication tab at large text', () => {
	test.skip(
		process.env.AUTH_UI_E2E !== 'true' || process.env.AUTH_TAB_RESPONSIVE_E2E !== 'true',
		'Requires the isolated fake Supabase server and 32px root-font fixture.',
	);

	for (const scheme of ['light', 'dark'] as const) {
		test(`keeps the phone tab label intact at 320px in ${scheme} mode`, async ({ page }) => {
			await page.setViewportSize({ width: 320, height: 780 });
			await page.emulateMedia({ colorScheme: scheme });
			await page.addInitScript((theme) => localStorage.setItem('manawg-theme', theme), scheme);
			await page.route('**/auth/v1/**', (route) => {
				if (new URL(route.request().url()).pathname.endsWith('/settings')) {
					return route.fulfill({
						status: 200,
						contentType: 'application/json',
						body: JSON.stringify({ external: { phone: true } }),
					});
				}
				return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
			});
			await page.route('**/__auth-test-root32.css', (route) =>
				route.fulfill({
					status: 200,
					contentType: 'text/css',
					body: 'html { font-size: 32px !important; }',
				}),
			);

			await page.goto('/neu');
			await page.evaluate(
				() =>
					new Promise<void>((resolve, reject) => {
						const stylesheet = document.createElement('link');
						stylesheet.rel = 'stylesheet';
						stylesheet.href = '/__auth-test-root32.css';
						stylesheet.onload = () => resolve();
						stylesheet.onerror = () => reject(new Error('root font fixture failed to load'));
						document.head.append(stylesheet);
					}),
			);
			await page.waitForFunction(
				({ dark }) =>
					getComputedStyle(document.documentElement).fontSize === '32px' &&
					document.documentElement.classList.contains('dark') === dark,
				{ dark: scheme === 'dark' },
			);

			const phoneTab = page.getByRole('tab', { name: 'Telefon / SMS', exact: true });
			await expect(phoneTab).toBeVisible();
			const geometry = await phoneTab.evaluate((tab) => {
				const rect = tab.getBoundingClientRect();
				const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
				let telefonRects: Array<{ right: number }> = [];
				while (walker.nextNode()) {
					const text = walker.currentNode.nodeValue ?? '';
					const start = text.indexOf('Telefon');
					if (start < 0) continue;
					const range = document.createRange();
					range.setStart(walker.currentNode, start);
					range.setEnd(walker.currentNode, start + 'Telefon'.length);
					telefonRects = Array.from(range.getClientRects(), (line) => ({ right: line.right }));
					break;
				}
				return {
					rootFontSize: getComputedStyle(document.documentElement).fontSize,
					documentWidth: document.documentElement.scrollWidth,
					tabRight: rect.right,
					telefonRects,
				};
			});

			expect(geometry.rootFontSize).toBe('32px');
			expect(geometry.documentWidth).toBe(320);
			expect(geometry.telefonRects).toHaveLength(1);
			expect(geometry.telefonRects[0].right).toBeLessThanOrEqual(geometry.tabRight);
		});
	}
});
