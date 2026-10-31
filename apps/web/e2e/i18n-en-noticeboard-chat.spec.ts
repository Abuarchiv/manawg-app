// English noticeboard and chat: cards, menus, dialogs, composers, system notices and load errors.
// Why: Every noticeboard and chat string ships in two languages; a missed one would show German chrome in English.

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { Announcement } from '../src/features/announcements/components/announcement-types';
import {
	dismissOnboarding,
	FIXTURE_WG,
	mockUnreadCount,
	navigateToFeature,
	setupMember,
	skipUnlessFixtures,
} from './support/helpers';
import { expectNoGermanChrome, expectNoHorizontalOverflow, setEnglishLocale } from './support/i18n';

const BASE = `/api/wg/${FIXTURE_WG.shareCode}`;
const PINBOARD = `/wg/${FIXTURE_WG.shareCode}/pinboard`;
const CHAT = `/wg/${FIXTURE_WG.shareCode}/chat`;
const MINA_ID = '0ab8c8f2-5d03-4a84-aadc-4c5d7e8abf55';
const FIXTURE_MESSAGE_ID = '8c1bb4a9-4722-42fe-bb86-aebf2e2d5b11';
const WIDTHS = [320, 390] as const;
const SCHEMES = ['light', 'dark'] as const;
const MINUTE_MS = 60 * 1000;
const POLL_WAIT_MS = 20_000;

function post(id: string, content: string, extra: Partial<Announcement> = {}): Announcement {
	return {
		id,
		authorMemberId: MINA_ID,
		content,
		imageUrl: null,
		kind: 'question',
		status: 'open',
		source: 'manual',
		sourcePath: null,
		pinnedAt: null,
		resolvedAt: null,
		resolvedByMemberId: null,
		createdAt: new Date(Date.now() - 5 * MINUTE_MS).toISOString(),
		reactionCounts: {},
		myReactions: [],
		takers: [],
		comments: [],
		...extra,
	};
}

async function prepare(
	page: Page,
	context: BrowserContext,
	baseURL: string | undefined,
	width: number,
	colorScheme: 'light' | 'dark',
): Promise<void> {
	await setEnglishLocale(context, baseURL ?? 'http://localhost:3101');
	await setupMember(page);
	await mockUnreadCount(page, BASE);
	await page.setViewportSize({ width, height: 780 });
	await page.emulateMedia({ colorScheme });
}

async function expectNoSidewaysScroll(page: Page, width: number): Promise<void> {
	if (width === 320) return expectNoHorizontalOverflow(page);
	const widths = await page.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth,
	}));
	expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

async function mockAnnouncements(page: Page, announcements: Announcement[]): Promise<void> {
	await page.route(`**${BASE}/announcements*`, (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ json: { announcements } })
			: route.fallback(),
	);
}

const LONG_TEXT = `${'The heating schedule needs a new plan for the winter. '.repeat(7)}End.`;

test.describe('English noticeboard', () => {
	skipUnlessFixtures();

	for (const width of WIDTHS) {
		for (const scheme of SCHEMES) {
			const where = `${width}px ${scheme}`;

			test(`board, cards, menu and dialogs ${where}`, async ({ page, context, baseURL }) => {
				await prepare(page, context, baseURL, width, scheme);
				await mockAnnouncements(page, [
					post('pinned', 'Bathroom light is flickering', {
						authorMemberId: FIXTURE_WG.memberId,
						kind: 'problem',
						pinnedAt: new Date().toISOString(),
						myReactions: ['take'],
						reactionCounts: { take: 1 },
						takers: [{ memberId: FIXTURE_WG.memberId, name: FIXTURE_WG.memberName, color: null }],
					}),
					post('question', 'Who has the spare key?', {
						comments: [
							{
								id: 'c1',
								announcementId: 'question',
								memberId: FIXTURE_WG.memberId,
								content: 'I have it',
								createdAt: new Date(Date.now() - 2 * MINUTE_MS).toISOString(),
								authorName: FIXTURE_WG.memberName,
								authorColor: null,
							},
						],
					}),
					post('swap', 'Swap request for the bathroom', {
						kind: 'request',
						source: 'chore_swap',
						sourcePath: '/chores',
					}),
					post('long', LONG_TEXT, { kind: 'decision' }),
					post('done', 'Resolved topic', {
						status: 'resolved',
						resolvedAt: new Date().toISOString(),
					}),
				]);
				await navigateToFeature(page, PINBOARD);
				await dismissOnboarding(page);

				await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
				await expect(page).toHaveTitle(/Noticeboard/);
				await expect(page.getByRole('heading', { name: 'Noticeboard', level: 1 })).toBeAttached();
				const board = page.getByRole('list', { name: 'Noticeboard posts' });
				await expect(board.getByText('Bathroom light is flickering')).toBeVisible();
				await expect(board.getByText('Resolved topic')).toHaveCount(0);
				await expect(board.getByText('Problem').first()).toBeVisible();
				await expect(board.getByText('Cleaning rota')).toBeVisible();
				await expect(board.getByText('5 min ago').first()).toBeVisible();
				await expect(board.getByText('Jonas is taking this')).toBeVisible();
				await expect(board.getByLabel('Pinned')).toBeVisible();
				await expect(page.getByRole('heading', { name: 'My open items' })).toBeVisible();
				await expect(
					board.getByRole('button', {
						name: 'Reaction “I’ll take it”: Bathroom light is flickering',
					}),
				).toBeVisible();
				await expect(
					board.getByRole('button', { name: /^Reaction “Seen”: Who has the spare key\?/ }),
				).toBeVisible();
				await expect(board.getByRole('button', { name: /^Show more: / })).toBeVisible();
				await expect(page.getByRole('button', { name: 'Add post' })).toBeVisible();
				await expectNoGermanChrome(page);
				await expectNoSidewaysScroll(page, width);

				await board.getByRole('button', { name: /^Show replies: Who has the spare key\?/ }).click();
				await expect(board.getByText('I have it')).toBeVisible();
				await expect(
					board.getByRole('textbox', { name: 'Write a reply: Who has the spare key?' }),
				).toBeVisible();
				await expect(board.getByRole('button', { name: 'Edit reply: I have it' })).toBeVisible();
				await expect(board.getByRole('button', { name: 'Remove reply: I have it' })).toBeVisible();
				await board.getByRole('button', { name: 'Remove reply: I have it' }).click();
				const replyDialog = page.getByRole('alertdialog');
				await expect(replyDialog.getByText('Remove reply?')).toBeVisible();
				await expect(replyDialog.getByText('“I have it” will be removed.')).toBeVisible();
				await expect(replyDialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
				await expectNoGermanChrome(page);
				await replyDialog.getByRole('button', { name: 'Cancel' }).click();

				await board
					.getByRole('button', { name: 'Post actions: Bathroom light is flickering' })
					.click();
				const menu = page.getByRole('menu');
				await expect(menu.getByRole('menuitem', { name: /^Add to shopping list/ })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: /^Add to cleaning rota/ })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: /^Add as expense/ })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: /^Edit post/ })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: /^Unpin post/ })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: /^Mark as resolved/ })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: /^Remove post/ })).toBeVisible();
				await expectNoGermanChrome(page);

				await menu.getByRole('menuitem', { name: /^Remove post/ }).click();
				const deleteDialog = page.getByRole('alertdialog');
				await expect(deleteDialog.getByText('Remove post?')).toBeVisible();
				await expect(
					deleteDialog.getByText('“Bathroom light is flickering” and its replies will be removed.'),
				).toBeVisible();
				await expect(
					deleteDialog.getByRole('button', {
						name: 'Confirm removing post: Bathroom light is flickering',
					}),
				).toBeVisible();
				await expectNoGermanChrome(page);
				await deleteDialog.getByRole('button', { name: 'Cancel' }).click();

				await board
					.getByRole('button', { name: 'Post actions: Bathroom light is flickering' })
					.click();
				await page.getByRole('menuitem', { name: /^Edit post/ }).click();
				const editor = page.getByRole('dialog');
				await expect(editor.getByText('Edit post').first()).toBeVisible();
				await expect(editor.getByRole('button', { name: 'Problem' })).toBeVisible();
				await expect(editor.getByRole('textbox')).toHaveValue('Bathroom light is flickering');
				await expect(editor.getByRole('button', { name: 'Save' })).toBeVisible();
				await expect(editor.getByRole('button', { name: 'Cancel' })).toBeVisible();
				await expectNoGermanChrome(page);
				await expectNoSidewaysScroll(page, width);
			});

			test(`composer, send error and states ${where}`, async ({ page, context, baseURL }) => {
				await prepare(page, context, baseURL, width, scheme);
				await mockAnnouncements(page, []);
				await page.route(`**${BASE}/announcements`, (route) =>
					route.request().method() === 'POST'
						? route.fulfill({ status: 500, json: { error: 'insert_failed' } })
						: route.fallback(),
				);
				await navigateToFeature(page, PINBOARD);
				await dismissOnboarding(page);

				await expect(page.getByText('No posts yet')).toBeVisible();
				await expect(page.getByText('Share a note or a question with your flat.')).toBeVisible();
				await expectNoGermanChrome(page);

				await page.getByRole('button', { name: 'Add post' }).click();
				const composer = page.getByRole('dialog');
				await expect(composer.getByText('New post').first()).toBeVisible();
				for (const kind of ['Info', 'Question', 'Problem', 'Request', 'Decision']) {
					await expect(composer.getByRole('button', { name: kind })).toBeVisible();
				}
				await expect(composer.getByPlaceholder('What’s new, Jonas?')).toBeVisible();
				await expect(composer.getByRole('button', { name: 'Attach image' })).toBeVisible();
				await expect(composer.getByRole('button', { name: 'Post', exact: true })).toBeDisabled();
				await expectNoGermanChrome(page);

				await composer.getByPlaceholder('What’s new, Jonas?').fill('Is anyone home tonight?');
				await composer.getByRole('button', { name: 'Post', exact: true }).click();
				await expect(
					composer.getByText('The post could not be saved: Check the noticeboard and try again.'),
				).toBeVisible();
				await expect(composer.getByRole('button', { name: 'Cancel' })).toBeVisible();
				await expectNoGermanChrome(page);
				await expectNoSidewaysScroll(page, width);
				await composer.getByRole('button', { name: 'Cancel' }).click();

				await expect(page.getByRole('button', { name: 'Continue draft' })).toBeVisible();
			});
		}
	}

	test('nothing open and load errors are English', async ({ page, context, baseURL }) => {
		await prepare(page, context, baseURL, 390, 'light');
		await mockAnnouncements(page, [
			post('done', 'Resolved topic', { status: 'resolved', resolvedAt: new Date().toISOString() }),
		]);
		await navigateToFeature(page, PINBOARD);
		await dismissOnboarding(page);
		await expect(page.getByText('Nothing open')).toBeVisible();
		await expect(
			page.getByText('Anything resolved or ticked off disappears from the noticeboard.'),
		).toBeVisible();
		await expectNoGermanChrome(page);

		await page.unroute(`**${BASE}/announcements*`);
		await page.route(`**${BASE}/announcements*`, (route) =>
			route.fulfill({ status: 500, json: { error: 'server_error' } }),
		);
		await page.reload();
		await expect(
			page.getByText('The noticeboard could not be loaded: Try again in a moment.'),
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Reload noticeboard' })).toBeVisible();
		await expect(page.getByText('No posts loaded yet.')).toBeVisible();
		await expect(page.getByText('Try again once the connection is back.')).toBeVisible();
		await expectNoGermanChrome(page);
	});

	test('a link to a resolved post explains that it left the board', async ({
		page,
		context,
		baseURL,
	}) => {
		await prepare(page, context, baseURL, 390, 'light');
		await mockAnnouncements(page, [
			post('open', 'Open question'),
			post('done', 'Resolved topic', { status: 'resolved', resolvedAt: new Date().toISOString() }),
		]);
		await navigateToFeature(page, `${PINBOARD}#announcement-done`);
		await dismissOnboarding(page);
		await expect(
			page.getByText('This post is resolved or ticked off and is no longer on the noticeboard.'),
		).toBeVisible();
	});
});

function chatMessage(overrides: Record<string, unknown>) {
	return {
		wgId: FIXTURE_WG.id,
		senderMemberId: null,
		kind: 'text',
		body: null,
		imageUrl: null,
		replyToMessageId: null,
		systemKind: null,
		systemPayload: null,
		createdAt: new Date(Date.now() - 3 * MINUTE_MS).toISOString(),
		editedAt: null,
		deletedAt: null,
		...overrides,
	};
}

async function mockChatMessages(page: Page, messages: unknown[]): Promise<void> {
	await page.route(`**${BASE}/chat/messages*`, (route) =>
		route.request().method() === 'GET'
			? route.fulfill({
					json: {
						messages,
						refreshedMessages: [],
						reactions: [],
						reads: [{ memberId: MINA_ID, lastReadAt: new Date().toISOString() }],
					},
				})
			: route.fallback(),
	);
}

test.describe('English chat', () => {
	skipUnlessFixtures();

	for (const width of WIDTHS) {
		for (const scheme of SCHEMES) {
			const where = `${width}px ${scheme}`;

			test(`messages, notices, menu and dialogs ${where}`, async ({ page, context, baseURL }) => {
				await prepare(page, context, baseURL, width, scheme);
				await page.route(`**${BASE}/chat/read`, (route) => route.fulfill({ json: { ok: true } }));
				await mockChatMessages(page, [
					chatMessage({
						id: 'joined',
						kind: 'system',
						systemKind: 'member.joined',
						systemPayload: { name: 'Mina' },
					}),
					chatMessage({
						id: 'expense',
						kind: 'system',
						systemKind: 'expense.created',
						systemPayload: {
							expenseId: 'exp-1',
							actorMemberId: MINA_ID,
							actorName: 'Mina',
							description: 'Oat milk',
							amount: '18,90 €',
							amountCents: 1890,
							currency: 'EUR',
						},
					}),
					chatMessage({
						id: 'old-expense',
						kind: 'system',
						systemKind: 'expense.created',
						systemPayload: { actorName: 'Mina', description: 'Rice', amount: '4,20 €' },
					}),
					chatMessage({
						id: 'chore',
						kind: 'system',
						systemKind: 'chore.completed',
						systemPayload: { actorName: 'Mina', title: 'Bathroom' },
					}),
					chatMessage({
						id: 'mine',
						senderMemberId: FIXTURE_WG.memberId,
						body: 'Thanks, see you later',
						editedAt: new Date().toISOString(),
					}),
					chatMessage({
						id: 'gone',
						senderMemberId: MINA_ID,
						deletedAt: new Date().toISOString(),
					}),
				]);
				await navigateToFeature(page, CHAT);
				await dismissOnboarding(page);

				await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
				await expect(page).toHaveTitle(/Chat/);
				await expect(page.getByRole('heading', { name: 'Chat', level: 1 })).toBeAttached();
				const log = page.getByRole('log', { name: 'Chat messages' });
				// The message scroller exposes exactly one log; the focusable viewport stays a region.
				await expect(page.getByRole('log')).toHaveCount(1);
				await expect(page.locator('[role=log] [role=log]')).toHaveCount(0);
				// Messages a few minutes old fall on the previous day right after midnight.
				await expect(log.getByText(/^(Today|Yesterday)$/).first()).toBeVisible();
				// The fixture page lists its own messages first; the mocked page arrives with the next poll.
				await expect(log.getByText('Mina joined the flat.')).toBeVisible({ timeout: POLL_WAIT_MS });
				await expect(log.getByText('Mina added Oat milk for €18.90.')).toBeVisible();
				await expect(log.getByText('Mina added Rice for 4,20 €.')).toBeVisible();
				await expect(log.getByText('Mina completed “Bathroom”.')).toBeVisible();
				await expect(log.getByText('This message was deleted.')).toBeVisible();
				await expect(log.getByText(/edited · /)).toBeVisible();
				await expect(log.getByRole('img', { name: 'Read by everyone' }).first()).toBeVisible();
				await expect(page.getByRole('textbox', { name: 'Chat message' })).toBeVisible();
				await expect(page.getByPlaceholder('Write a message')).toBeVisible();
				await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
				await expect(
					page.getByRole('button', { name: 'Scroll to the end' }).first(),
				).toBeAttached();
				await expectNoGermanChrome(page);
				await expectNoSidewaysScroll(page, width);

				const own = page.locator(`#message-${FIXTURE_MESSAGE_ID}`);
				await own.getByRole('button', { name: /^Actions for message from / }).click();
				const menu = page.getByRole('menu');
				await expect(menu.getByRole('menuitem', { name: 'React with 👍' })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: 'More reactions' })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: 'Reply' })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
				await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
				await expectNoGermanChrome(page);

				await menu.getByRole('menuitem', { name: 'More reactions' }).click();
				const picker = page.getByRole('dialog');
				await expect(picker.getByText('Choose a reaction')).toBeVisible();
				await expect(picker.getByText('One emoji for this message.')).toBeVisible();
				await expect(picker.getByRole('button', { name: 'Reaction 👍' })).toBeVisible();
				await expect(picker.getByRole('textbox', { name: 'Custom emoji' })).toBeVisible();
				await expect(picker.getByRole('button', { name: 'Close' })).toBeVisible();
				await expectNoGermanChrome(page);
				await picker.getByRole('button', { name: 'Close' }).click();

				await own.getByRole('button', { name: /^Actions for message from / }).click();
				await page.getByRole('menuitem', { name: 'Delete' }).click();
				const dialog = page.getByRole('alertdialog');
				await expect(dialog.getByText('Delete message?')).toBeVisible();
				await expect(
					dialog.getByText(
						'The content is removed for everyone. The message stays marked as deleted.',
					),
				).toBeVisible();
				await expect(dialog.getByRole('button', { name: 'Delete now' })).toBeVisible();
				await expectNoGermanChrome(page);
				await dialog.getByRole('button', { name: 'Cancel' }).click();

				await own.getByRole('button', { name: /^Actions for message from / }).click();
				await page.getByRole('menuitem', { name: 'Edit' }).click();
				await expect(own.getByRole('textbox', { name: 'Edit message' })).toBeVisible();
				await expect(own.getByRole('button', { name: 'Save' })).toBeVisible();
				await expect(own.getByRole('button', { name: 'Cancel' })).toBeVisible();
				await expectNoGermanChrome(page);
				await expectNoSidewaysScroll(page, width);
			});

			test(`reply, send error and banners ${where}`, async ({ page, context, baseURL }) => {
				await prepare(page, context, baseURL, width, scheme);
				await page.route(`**${BASE}/chat/read`, (route) =>
					route.fulfill({ status: 500, json: { error: 'server_error' } }),
				);
				await page.route(`**${BASE}/chat/messages*`, (route) =>
					route.request().method() === 'POST'
						? route.fulfill({ status: 400, json: { error: 'reply_to_not_found' } })
						: route.fulfill({ status: 500, json: { error: 'server_error' } }),
				);
				await navigateToFeature(page, CHAT);
				await dismissOnboarding(page);

				await expect(page.getByText('Chat is out of date right now.')).toBeVisible({
					timeout: POLL_WAIT_MS,
				});
				await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
				await expectNoGermanChrome(page);

				const own = page.locator(`#message-${FIXTURE_MESSAGE_ID}`);
				await own.getByRole('button', { name: /^Actions for message from / }).click();
				await page.getByRole('menuitem', { name: 'Reply' }).click();
				await expect(page.getByText('Reply to Jonas')).toBeVisible();
				await expect(page.getByRole('button', { name: 'Cancel reply' })).toBeVisible();
				const composer = page.getByRole('textbox', { name: 'Chat message' });
				await composer.fill('Hello back');
				await page.getByRole('button', { name: 'Send message' }).click();
				await expect(
					page.getByText(
						'The message you are replying to no longer exists. Cancel the reply and send again. Your text is still there.',
					),
				).toBeVisible();
				await expect(composer).toHaveValue('Hello back');
				await expectNoGermanChrome(page);
				await expectNoSidewaysScroll(page, width);
			});
		}
	}
});

const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEKDAY_PILL = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;

test.describe('English noticeboard extras', () => {
	skipUnlessFixtures();

	test('loading skeleton, new posts banner and conversion links', async ({
		page,
		context,
		baseURL,
	}) => {
		test.setTimeout(90_000);
		await prepare(page, context, baseURL, 390, 'light');
		const first = post('first', 'Internet bill €1,234.50 this month');
		const second = post('second', 'Freshly added post');
		let calls = 0;
		await page.route(`**${BASE}/announcements*`, async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			calls += 1;
			if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 1500));
			return route.fulfill({ json: { announcements: calls === 1 ? [first] : [second, first] } });
		});
		await navigateToFeature(page, PINBOARD);
		await expect(page.getByRole('status', { name: 'Loading noticeboard' })).toBeVisible();
		await dismissOnboarding(page);
		await expect(page.getByText('Internet bill')).toBeVisible();
		await expectNoGermanChrome(page);

		await expect(page.getByRole('button', { name: '1 new post' })).toBeVisible({
			timeout: POLL_WAIT_MS * 3,
		});
		await expectNoGermanChrome(page);
		await page.getByRole('button', { name: '1 new post' }).click();
		await expect(page.getByText('Freshly added post')).toBeVisible();

		const actions = page.getByRole('button', { name: /^Post actions: Internet bill/ });
		await actions.click();
		await page.getByRole('menuitem', { name: /^Add as expense/ }).click();
		await page.waitForURL(/\/expenses\?.*amount=1234\.50/);
	});
});

test.describe('English chat extras', () => {
	skipUnlessFixtures();

	for (const [width, scheme] of [
		[320, 'dark'],
		[390, 'light'],
	] as const) {
		test(`day pills, unread divider, reactions and mentions ${width}px ${scheme}`, async ({
			page,
			context,
			baseURL,
		}) => {
			await prepare(page, context, baseURL, width, scheme);
			await page.route(`**${BASE}/chat/read`, (route) => route.fulfill({ json: { ok: true } }));
			const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
			await page.route(`**${BASE}/chat/messages*`, (route) =>
				route.request().method() === 'GET'
					? route.fulfill({
							json: {
								messages: [
									chatMessage({
										id: 'weekday',
										senderMemberId: MINA_ID,
										body: 'Earlier this week',
										createdAt: ago(3 * DAY_MS),
									}),
									chatMessage({
										id: 'yesterday',
										senderMemberId: MINA_ID,
										body: 'Yesterday evening',
										createdAt: ago(DAY_MS),
									}),
									chatMessage({
										id: 'today',
										senderMemberId: MINA_ID,
										body: 'Fresh message',
										imageUrl: '/icon.png',
									}),
								],
								refreshedMessages: [],
								reactions: [{ messageId: 'today', memberId: MINA_ID, emoji: '👍' }],
								reads: [{ memberId: MINA_ID, lastReadAt: new Date().toISOString() }],
								readMarker: { messageId: 'weekday', createdAt: ago(3 * DAY_MS) },
							},
						})
					: route.fallback(),
			);
			await navigateToFeature(page, CHAT);
			await dismissOnboarding(page);

			const log = page.getByRole('log', { name: 'Chat messages' });
			await expect(log.getByText('Yesterday', { exact: true })).toBeVisible({
				timeout: POLL_WAIT_MS,
			});
			await expect(log.getByText(WEEKDAY_PILL)).toBeVisible();
			await expect(log.getByText('New messages')).toBeVisible();
			await expect(
				log.getByRole('button', { name: /^Add reaction 👍 \(1, from Mina\) on message from / }),
			).toBeVisible();
			await expect(log.getByRole('img', { name: /^Image from / })).toBeAttached();
			await expectNoGermanChrome(page);

			await page.getByRole('textbox', { name: 'Chat message' }).fill('@Mi');
			await expect(page.getByRole('listbox', { name: 'Mention a flatmate' })).toBeVisible();
			await expectNoGermanChrome(page);
			await expectNoSidewaysScroll(page, width);
		});
	}
});
