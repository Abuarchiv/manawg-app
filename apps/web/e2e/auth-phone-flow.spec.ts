import { expect, test } from '@playwright/test';

test.describe('phone authentication fixture', () => {
	test.skip(process.env.AUTH_UI_E2E !== 'true', 'Requires the isolated fake Supabase fixture.');

	test('keeps the SMS tab selected and reports incomplete codes on the code field', async ({
		page,
	}) => {
		await page.setViewportSize({ width: 320, height: 780 });
		await page.route('**/auth/v1/**', async (route) => {
			const { pathname } = new URL(route.request().url());
			if (pathname.endsWith('/settings')) {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ external: { phone: true } }),
				});
				return;
			}
			if (pathname.endsWith('/otp')) {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ message_id: 'fixture-message' }),
				});
				return;
			}
			await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
		});

		await page.goto('/neu');
		const phoneTab = page.getByRole('tab', { name: 'Telefon / SMS' });
		await phoneTab.click();

		const phone = page.getByLabel('Telefonnummer');
		await phone.fill('+491701234567');
		await page.getByRole('button', { name: 'SMS-Code anfordern' }).click();

		const otp = page.getByLabel('6-stelliger SMS-Code');
		await expect(otp).toBeVisible();
		await expect(phoneTab).toHaveAttribute('aria-selected', 'true');

		await otp.fill('123');
		await page.getByRole('button', { name: 'Code bestätigen' }).click();
		await expect(
			page.getByText('Gib einen sechsstelligen SMS-Code ein.', { exact: true }),
		).toBeVisible();
		await expect(otp).toHaveAttribute('aria-invalid', 'true');
		await expect(phone).not.toHaveAttribute('aria-invalid', 'true');
	});
});
