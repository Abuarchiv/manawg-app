import { expect, test } from '@playwright/test';
import { setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

for (const colorScheme of ['light'] as const) {
	test(`chat read failures remain visible and retryable (${colorScheme}, 320px)`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 320, height: 740 });
		await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
		await setupMember(page);
		const member = { id: '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55', name: 'Test', active: true };
		await page.route('**/api/wg/MTE8PZAT', (route) =>
			route.fulfill({ json: { currentMember: { memberId: member.id, name: member.name } } }),
		);
		await page.route('**/api/wg/MTE8PZAT/members', (route) =>
			route.fulfill({ json: { members: [member] } }),
		);
		await page.route('**/api/wg/MTE8PZAT/chat/unread-count', (route) =>
			route.fulfill({ json: { count: 2 } }),
		);
		const receipts: string[] = [];
		let releaseSuccess = () => {};
		const successGate = new Promise<void>((resolve) => {
			releaseSuccess = resolve;
		});
		await page.route('**/api/wg/MTE8PZAT/chat/read', async (route) => {
			receipts.push(route.request().postDataJSON().lastReadMessageId);
			if (receipts.length === 1) return route.abort('failed');
			if (receipts.length === 2) return route.fulfill({ status: 503, json: { error: 'db_down' } });
			await successGate;
			await route.fulfill({ json: { ok: true } });
		});
		await page.goto('/wg/MTE8PZAT/chat');
		await expect.poll(() => receipts.length).toBe(1);
		const error = page
			.getByRole('alert')
			.filter({ hasText: 'Lesestatus konnte nicht gespeichert werden.' });
		await expect(error).toBeVisible();
		await page.screenshot({ path: test.info().outputPath('read-error.png') });
		const retry = error.getByRole('button', { name: 'Lesestatus erneut speichern' });
		await retry.click();
		await expect.poll(() => receipts.length).toBe(2);
		await expect(error).toBeVisible();
		// Request arrival alone does not mean the 503 response was processed yet.
		await expect
			.poll(async () => {
				await retry.click();
				return receipts.length;
			})
			.toBe(3);
		await retry.click();
		await expect(error).toBeVisible();
		expect(receipts).toEqual(Array(3).fill('8c1bb4a9-4722-42fe-bb86-aebf2e2d5b11'));
		releaseSuccess();
		await expect(error).toBeHidden();
		await expect(page.getByText('Alles klar, ich bringe Hafermilch mit.')).toBeVisible();
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
	});
}
