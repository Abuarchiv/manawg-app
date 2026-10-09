// Chat: compose/Enter semantics, edit focus, iOS keyboard, read-marker retry and 200% reflow.
// Why: the composer must never lose a draft and must stay usable above the iOS keyboard.

import { type Page, expect, test } from '@playwright/test';
import {
	FIXTURE_WG,
	dismissOnboarding,
	mockUnreadCount,
	navigateToFeature,
	setupMember,
} from './support/helpers';

test.describe('chat edit focus', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	const MESSAGE_ID = '8c1bb4a9-4722-42fe-bb86-aebf2e2d5b11';

	async function openEditorFromKeyboard(page: import('@playwright/test').Page) {
		const message = page.locator(`#message-${MESSAGE_ID}`);
		const actions = message.getByRole('button', { name: /Aktionen für Nachricht/ });
		await actions.focus();
		await page.keyboard.press('Enter');
		// The reaction bar (six emojis and "+"), reply and copy come before edit.
		await expect(page.getByRole('menuitem', { name: 'Mit 👍 reagieren' })).toBeFocused();
		for (let step = 0; step < 9; step++) await page.keyboard.press('ArrowDown');
		const editAction = page.getByRole('menuitem', { name: 'Bearbeiten' });
		await expect(editAction).toBeFocused();
		await page.keyboard.press('Enter');
		const editor = message.getByRole('textbox', { name: 'Nachricht bearbeiten' });
		await expect(editor).toBeVisible();
		return { actions, editor, message };
	}

	// Minimal matrix: 320px light at 16px and 320px dark at 32px text.
	for (const [colorScheme, width, fontSize] of [
		['light', 320, 16],
		['dark', 320, 32],
	] as const) {
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

	test('saving unchanged text sends no PATCH and a deleted message drops its edited marker', async ({
		page,
	}) => {
		await setupMember(page);
		let patches = 0;
		await page.route(
			`**/api/wg/${FIXTURE_WG.shareCode}/chat/messages/${MESSAGE_ID}`,
			async (route) => {
				const method = route.request().method();
				if (method === 'DELETE') return route.fulfill({ json: { ok: true } });
				if (method !== 'PATCH') return route.fallback();
				patches += 1;
				const { body } = route.request().postDataJSON() as { body: string };
				await route.fulfill({
					json: { message: { id: MESSAGE_ID, body, editedAt: new Date().toISOString() } },
				});
			},
		);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
		await dismissOnboarding(page);

		const first = await openEditorFromKeyboard(page);
		await first.editor.press('ControlOrMeta+Enter');
		await expect(first.editor).toBeHidden();
		expect(patches).toBe(0);
		await expect(first.message).not.toContainText('bearbeitet');

		const second = await openEditorFromKeyboard(page);
		await second.editor.fill('Geänderte Chat-Nachricht');
		await second.editor.press('ControlOrMeta+Enter');
		await expect(second.message).toContainText('bearbeitet');
		expect(patches).toBe(1);

		await second.actions.click();
		await page.getByRole('menuitem', { name: 'Löschen' }).click();
		await page.getByRole('button', { name: 'Nachricht endgültig löschen' }).click();
		await expect(second.message).toContainText('gelöscht');
		await expect(second.message).not.toContainText('bearbeitet');
	});

	test('a vanished reply target tells how to continue and keeps the text', async ({ page }) => {
		await page.setViewportSize({ width: 360, height: 740 });
		await setupMember(page);
		await mockUnreadCount(page, `/api/wg/${FIXTURE_WG.shareCode}`);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/chat/messages*`, (route) =>
			route.request().method() === 'POST'
				? route.fulfill({ status: 400, json: { error: 'reply_to_not_found' } })
				: route.fulfill({
						json: { messages: [], refreshedMessages: [], reactions: [], mentions: [] },
					}),
		);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
		await dismissOnboarding(page);

		await page
			.locator(`#message-${MESSAGE_ID}`)
			.getByRole('button', { name: /Aktionen für Nachricht/ })
			.click();
		await page.getByRole('menuitem', { name: 'Antworten' }).click();
		const composer = page.getByRole('textbox', { name: 'Chat-Nachricht' });
		await composer.fill('Hallo zurück');
		await page.getByRole('button', { name: 'Nachricht senden' }).click();
		await expect(page.getByText('Entferne die Antwort und sende erneut.')).toBeVisible();
		await expect(composer).toHaveValue('Hallo zurück');
	});
});

test.describe('chat ios keyboard', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	test('chat composer sits on the iOS keyboard after Safari pans the page', async ({ page }) => {
		await page.setViewportSize({ width: 393, height: 659 });
		// iOS Safari keeps the layout viewport, shrinks the visual viewport and pans it.
		await page.addInitScript(() => {
			const state = { height: window.innerHeight, offsetTop: 0 };
			const viewport = new EventTarget();
			Object.defineProperties(viewport, {
				height: { get: () => state.height },
				width: { get: () => window.innerWidth },
				offsetTop: { get: () => state.offsetTop },
				offsetLeft: { get: () => 0 },
				scale: { get: () => 1 },
			});
			Object.defineProperty(window, 'visualViewport', { get: () => viewport });
			Object.assign(window, { __iosKeyboard: { state, viewport } });
		});
		await setupMember(page);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
		await dismissOnboarding(page);
		const composer = page.getByRole('textbox', { name: 'Chat-Nachricht' });
		await expect(composer).toBeVisible();

		const result = await page.evaluate(async () => {
			const { state, viewport } = (
				window as unknown as {
					__iosKeyboard: { state: { height: number; offsetTop: number }; viewport: EventTarget };
				}
			).__iosKeyboard;
			const field = document.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Chat-Nachricht"]',
			);
			if (!field) throw new Error('composer missing');
			field.focus();
			state.height = window.innerHeight - 336;
			state.offsetTop = field.getBoundingClientRect().bottom + 8 - state.height;
			viewport.dispatchEvent(new Event('resize'));
			viewport.dispatchEvent(new Event('scroll'));
			await new Promise((resolve) => requestAnimationFrame(resolve));
			return {
				keyboardTop: state.offsetTop + state.height,
				composerBottom: field.closest('[data-chat-composer]')?.getBoundingClientRect().bottom ?? 0,
			};
		});
		expect(Math.abs(result.keyboardTop - result.composerBottom)).toBeLessThan(1);
	});

	test('chat document does not overshoot the viewport at rest', async ({ page }) => {
		// The WG shell reserves padding-bottom for the fixed bottom nav so normal
		// scrolling pages clear it. Chat already ends above the nav via its own
		// height calc, so that reserve must be cancelled — otherwise the whole
		// page (not just the message list) rubber-bands on iOS.
		await page.setViewportSize({ width: 390, height: 844 });
		await setupMember(page);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
		await dismissOnboarding(page);
		await expect(page.getByRole('textbox', { name: 'Chat-Nachricht' })).toBeVisible();
		const overshoot = await page.evaluate(
			() => document.documentElement.scrollHeight - window.innerHeight,
		);
		expect(overshoot).toBeLessThanOrEqual(0);
	});

	test('chat composer stays above the nav while the offline banner is shown', async ({
		page,
		context,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await setupMember(page);
		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
		await dismissOnboarding(page);
		await expect(page.getByRole('textbox', { name: 'Chat-Nachricht' })).toBeVisible();
		await page.waitForLoadState('networkidle');
		await context.setOffline(true);
		await expect(page.locator('[data-offline-banner]')).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(() => {
					const nav = document.querySelector('nav[data-app-chrome]')?.getBoundingClientRect();
					const field = document
						.querySelector('textarea[aria-label="Chat-Nachricht"]')
						?.closest('[data-chat-composer]')
						?.getBoundingClientRect();
					return nav && field ? Math.round(nav.top - field.bottom) : null;
				}),
			)
			.toBeGreaterThanOrEqual(0);
		await context.setOffline(false);
	});
});

test.describe('chat read retry', () => {
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
				if (receipts.length === 2)
					return route.fulfill({ status: 503, json: { error: 'db_down' } });
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
});

test.describe('chat compose', () => {
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
		await mockUnreadCount(page, `/api/wg/${SHARE_CODE}`);
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
});

test.describe('chat pinnwand reflow 200', () => {
	test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

	// WCAG 1.4.10 Reflow + 1.4.4 Resize Text: existing specs cover Chat's edit-focus
	// behaviour and Pinnwand's individual comment layout at 320px/32px root font-size, but
	// nothing asserted the *whole page* (composer, filter bar, message list together)
	// never grows a horizontal scrollbar once every element inherits a doubled root
	// font-size. This closes that gap for the two routes that didn't already have a
	// page-level scrollWidth assertion at 200% text.
	function announcement(id: string, content: string) {
		return {
			id,
			authorMemberId: FIXTURE_WG.memberId,
			content,
			imageUrl: null,
			kind: 'info',
			status: 'open',
			source: 'manual',
			sourcePath: null,
			pinnedAt: null,
			resolvedAt: null,
			resolvedByMemberId: null,
			createdAt: new Date().toISOString(),
			reactionCounts: {},
			myReactions: [],
			takers: [],
			comments: [],
		};
	}

	for (const colorScheme of ['light', 'dark'] as const) {
		test(`chat page reflows without horizontal scroll at 320px/200% text (${colorScheme})`, async ({
			page,
		}) => {
			await page.setViewportSize({ width: 320, height: 740 });
			await page.emulateMedia({ colorScheme });
			await setupMember(page);
			await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/chat`);
			await dismissOnboarding(page);
			await expect(page.getByRole('textbox').last()).toBeVisible();

			await page.evaluate(() => {
				document.documentElement.style.fontSize = '32px';
			});
			expect(await page.locator('html').evaluate((el) => getComputedStyle(el).fontSize)).toBe(
				'32px',
			);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			).toBe(true);
			await expect(page.getByRole('textbox').last()).toBeVisible();
		});

		test(`pinnwand page reflows without horizontal scroll at 320px/200% text (${colorScheme})`, async ({
			page,
		}) => {
			await page.setViewportSize({ width: 320, height: 740 });
			await page.emulateMedia({ colorScheme });
			await setupMember(page);
			await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/announcements*`, async (route) => {
				if (route.request().method() !== 'GET') return route.continue();
				return route.fulfill({
					json: {
						announcements: [
							announcement(
								'post-reflow',
								'Ein etwas längerer Pinnwand-Beitrag, der bei 200% Textgröße nicht umbrechen darf',
							),
						],
					},
				});
			});
			await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/pinnwand`);
			await dismissOnboarding(page);
			await expect(
				page.getByText('Ein etwas längerer Pinnwand-Beitrag', { exact: false }),
			).toBeVisible();

			await page.evaluate(() => {
				document.documentElement.style.fontSize = '32px';
			});
			expect(await page.locator('html').evaluate((el) => getComputedStyle(el).fontSize)).toBe(
				'32px',
			);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			).toBe(true);
			await expect(
				page.getByText('Ein etwas längerer Pinnwand-Beitrag', { exact: false }),
			).toBeVisible();
		});
	}
});
