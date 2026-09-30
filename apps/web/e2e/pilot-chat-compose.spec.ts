import { type Page, expect, test } from '@playwright/test';
import { dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const SHARE_CODE = 'MTE8PZAT';
const MEMBER = {
	id: '7d898f9e-5ad7-4f5d-abed-8c3e99a76973',
	name: 'dsaf',
	active: true,
};

async function mockChatApi(page: Page, sentBodies: string[]): Promise<void> {
	let sentMessage: Record<string, unknown> | null = null;
	await page.route(`**/api/wg/${SHARE_CODE}`, (route) =>
		route.fulfill({ json: { currentMember: { memberId: MEMBER.id, name: MEMBER.name } } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/members`, (route) =>
		route.fulfill({ json: { members: [MEMBER] } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/chat/unread-count`, (route) =>
		route.fulfill({ json: { count: 0 } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/chat/read`, (route) =>
		route.fulfill({ json: { ok: true } }),
	);
	await page.route(`**/api/wg/${SHARE_CODE}/chat/messages*`, async (route) => {
		if (route.request().method() === 'POST') {
			const payload = route.request().postDataJSON() as { body: string };
			sentBodies.push(payload.body);
			sentMessage = {
				id: `sent-${sentBodies.length}`,
				wgId: '989ac820-58b7-431f-9c65-28721264f333',
				senderMemberId: MEMBER.id,
				kind: 'user',
				body: payload.body,
				imageUrl: null,
				replyToMessageId: null,
				systemKind: null,
				systemPayload: null,
				createdAt: new Date().toISOString(),
				editedAt: null,
				deletedAt: null,
			};
			await route.fulfill({
				json: {
					message: sentMessage,
					warning: null,
				},
			});
			return;
		}
		await route.fulfill({ json: { messages: sentMessage ? [sentMessage] : [], reactions: [] } });
	});
}

for (const colorScheme of ['light'] as const) {
	for (const width of [320] as const) {
		test(`chat keeps Enter as newline, preserves the draft, and reads it after reload (${colorScheme}, ${width}px)`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 740 });
			await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
			await setupMember(page);
			const sentBodies: string[] = [];
			await mockChatApi(page, sentBodies);
			await navigateToFeature(page, `/wg/${SHARE_CODE}/chat`);
			await dismissOnboarding(page);

			const composer = page.getByRole('textbox', { name: 'Chat-Nachricht' });
			const send = page.getByRole('button', { name: 'Nachricht senden' });
			await expect(composer).toBeVisible();
			await expect(send).toBeDisabled();
			await composer.fill('Erste Zeile');
			await composer.press('Enter');
			await composer.type('Zweite Zeile');
			await expect(composer).toHaveValue('Erste Zeile\nZweite Zeile');
			await expect.poll(() => sentBodies.length).toBe(0);

			await page.goto(`/wg/${SHARE_CODE}/einkauf`, { waitUntil: 'domcontentloaded' });
			await expect(page).toHaveURL(new RegExp(`/wg/${SHARE_CODE}/einkauf$`));
			await navigateToFeature(page, `/wg/${SHARE_CODE}/chat`);
			await dismissOnboarding(page);
			await expect(composer).toHaveValue('Erste Zeile\nZweite Zeile');

			await send.click();
			await expect.poll(() => sentBodies).toEqual(['Erste Zeile\nZweite Zeile']);
			await expect(composer).toHaveValue('');

			await page.reload({ waitUntil: 'domcontentloaded' });
			await dismissOnboarding(page);
			const messageBody = page
				.locator('[data-slot="bubble-content"] .whitespace-pre-wrap')
				.filter({ hasText: 'Erste Zeile' });
			// ChatView polls after an SSR history payload, so wait for the mocked readback.
			await expect(messageBody).toHaveText(/Erste Zeile\s+Zweite Zeile/, { timeout: 15_000 });
		});
	}
}

test('desktop chat shortcut sends only on ControlOrMeta+Enter', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	await setupMember(page);
	const sentBodies: string[] = [];
	await mockChatApi(page, sentBodies);
	await navigateToFeature(page, `/wg/${SHARE_CODE}/chat`);
	await dismissOnboarding(page);

	const composer = page.getByRole('textbox', { name: 'Chat-Nachricht' });
	await composer.fill('Desktop shortcut');
	await composer.press('ControlOrMeta+Enter');
	await expect.poll(() => sentBodies).toEqual(['Desktop shortcut']);
});
