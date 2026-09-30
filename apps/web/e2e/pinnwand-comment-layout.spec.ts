import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const ANNOUNCEMENT_ID = 'comment-layout';
const AUTHOR_NAME = 'MaximilianMustermannLangname';
const REPLY_TEXT = 'Ich kümmere mich darum.';
const LONG_COMMENT =
	'Dieser lange Kommentar bleibt vollständig lesbar und läuft auch bei vergrößertem Text nicht aus der Pinnwand. '.repeat(
		3,
	) + 'UnunterbrochenesKommentarwort'.repeat(6);

function announcement() {
	return {
		id: ANNOUNCEMENT_ID,
		authorMemberId: FIXTURE_WG.memberId,
		content: 'Langer Kommentar Layout-Test',
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
		comments: [
			{
				id: 'comment-long-name',
				announcementId: ANNOUNCEMENT_ID,
				memberId: FIXTURE_WG.memberId,
				content: LONG_COMMENT,
				createdAt: new Date().toISOString(),
				authorName: AUTHOR_NAME,
				authorColor: null,
			},
		],
	};
}

for (const width of [320, 360, 390] as const) {
	for (const largeText of [false, true] as const) {
		for (const colorScheme of ['light', 'dark'] as const) {
			test(`keeps Pinnwand comments usable at ${width}px, ${largeText ? '32px' : 'normal'} text, ${colorScheme}`, async ({
				page,
			}) => {
				await page.setViewportSize({ width, height: 844 });
				await page.emulateMedia({ colorScheme });
				await setupMember(page);
				await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/announcements*`, (route) => {
					if (route.request().method() !== 'GET') return route.continue();
					return route.fulfill({ json: { announcements: [announcement()] } });
				});

				await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/pinnwand`);
				await dismissOnboarding(page);
				if (largeText) {
					await page.evaluate(() => {
						document.documentElement.style.setProperty('font-size', '32px', 'important');
					});
				}
				await expect
					.poll(async () =>
						page.locator('html').evaluate((element) => element.classList.contains('dark')),
					)
					.toBe(colorScheme === 'dark');

				const openReplies = page.getByRole('button', { name: /^Antworten anzeigen:/ });
				await openReplies.focus();
				await page.keyboard.press('Enter');
				const panel = page.locator(`#announcement-comments-${ANNOUNCEMENT_ID}`);
				await expect(panel).toBeVisible();
				const row = panel.locator('li').filter({ hasText: AUTHOR_NAME });
				await expect(row).toBeVisible();

				const geometry = await row.evaluate((element, authorName) => {
					const author = [...element.querySelectorAll('span')].find(
						(span) => span.textContent === authorName,
					);
					if (!author) throw new Error('Comment author name not found');
					const { x, right } = author.getBoundingClientRect();
					return {
						x,
						right,
						scrollWidth: author.scrollWidth,
						clientWidth: author.clientWidth,
						viewportWidth: document.documentElement.clientWidth,
					};
				}, AUTHOR_NAME);
				expect(geometry.viewportWidth).toBe(width);
				expect(geometry.x).toBeGreaterThanOrEqual(0);
				expect(geometry.right).toBeLessThanOrEqual(width + 1);
				expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
				const commentMetrics = await row.locator('p').evaluate((element) => ({
					right: element.getBoundingClientRect().right,
					clientWidth: element.clientWidth,
					scrollWidth: element.scrollWidth,
				}));
				expect(commentMetrics.right).toBeLessThanOrEqual(width + 1);
				expect(commentMetrics.scrollWidth).toBeLessThanOrEqual(commentMetrics.clientWidth + 1);

				const editButton = row.getByRole('button', { name: /^Kommentar bearbeiten:/ });
				const removeButton = row.getByRole('button', { name: /^Kommentar entfernen:/ });
				for (const action of [editButton, removeButton]) {
					await expect(action).toBeVisible();
					const bounds = await action.boundingBox();
					expect(bounds).not.toBeNull();
					if (bounds) {
						expect(bounds.x).toBeGreaterThanOrEqual(0);
						expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
					}
				}
				await editButton.focus();
				await page.keyboard.press('Enter');
				await expect(row.getByRole('textbox', { name: 'Kommentar bearbeiten' })).toBeVisible();
				await row.getByRole('button', { name: 'Später', exact: true }).click();

				const replyInput = panel.getByRole('textbox', { name: /^Antwort verfassen:/ });
				await expect(replyInput).toBeVisible();
				await replyInput.fill(REPLY_TEXT);
				const sendReply = panel.getByRole('button', { name: /^Antwort senden:/ });
				await expect(sendReply).toBeEnabled();
				const replyBounds = await sendReply.boundingBox();
				expect(replyBounds).not.toBeNull();
				if (replyBounds) expect(replyBounds.x + replyBounds.width).toBeLessThanOrEqual(width + 1);
			});
		}
	}
}
