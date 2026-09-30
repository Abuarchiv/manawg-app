import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const MESSAGE_ID = '8c1bb4a9-4722-42fe-bb86-aebf2e2d5b11';

async function openEditorFromKeyboard(page: import('@playwright/test').Page) {
	const message = page.locator(`#message-${MESSAGE_ID}`);
	const actions = message.getByRole('button', { name: /Aktionen für Nachricht/ });
	await actions.focus();
	await page.keyboard.press('Enter');
	// Reagieren, Antworten und Kopieren stehen vor Bearbeiten.
	await expect(page.getByRole('menuitem', { name: 'Reagieren' })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	const editAction = page.getByRole('menuitem', { name: 'Bearbeiten' });
	await expect(editAction).toBeFocused();
	await page.keyboard.press('Enter');
	const editor = message.getByRole('textbox', { name: 'Nachricht bearbeiten' });
	await expect(editor).toBeVisible();
	return { actions, editor, message };
}

for (const colorScheme of ['light', 'dark'] as const) {
	for (const width of [320, 360] as const) {
		for (const fontSize of [16, 32] as const) {
			test(`chat edit keeps keyboard focus through open, Escape, and cancel (${width}px, ${colorScheme}, ${fontSize}px)`, async ({
				page,
			}) => {
				await page.setViewportSize({ width, height: 740 });
				await page.emulateMedia({ colorScheme });
				await setupMember(page);
				await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
				await dismissOnboarding(page);
				const appliedFontSize = await page.evaluate((size) => {
					document.documentElement.style.fontSize = `${size}px`;
					return getComputedStyle(document.documentElement).fontSize;
				}, fontSize);
				expect(appliedFontSize).toBe(`${fontSize}px`);

				const { actions, editor, message } = await openEditorFromKeyboard(page);
				await expect(editor).toBeFocused();
				await page.keyboard.press('Escape');
				await expect(editor).toBeHidden();
				await expect(actions).toBeFocused();

				const reopened = await openEditorFromKeyboard(page);
				await expect(reopened.editor).toBeFocused();
				await page.keyboard.press('Tab');
				const cancel = message.getByRole('button', { name: 'Abbrechen' });
				await expect(cancel).toBeFocused();
				await page.keyboard.press('Enter');
				await expect(reopened.editor).toBeHidden();
				await expect(reopened.actions).toBeFocused();
			});
		}
	}
}

test('saving an edited chat message returns keyboard focus to its actions button', async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 740 });
	await setupMember(page);
	await page.route(
		`**/api/wg/${FIXTURE_WG.shareCode}/chat/messages/${MESSAGE_ID}`,
		async (route) => {
			if (route.request().method() !== 'PATCH') return route.fallback();
			const { body } = route.request().postDataJSON() as { body: string };
			await route.fulfill({
				json: {
					message: { id: MESSAGE_ID, body, editedAt: new Date().toISOString() },
				},
			});
		},
	);
	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
	await dismissOnboarding(page);

	const { actions, editor, message } = await openEditorFromKeyboard(page);
	await editor.fill('Geänderte Chat-Nachricht');
	await editor.press('ControlOrMeta+Enter');
	await expect(editor).toBeHidden();
	await expect(message).toContainText('Geänderte Chat-Nachricht');
	await expect(actions).toBeFocused();
});
