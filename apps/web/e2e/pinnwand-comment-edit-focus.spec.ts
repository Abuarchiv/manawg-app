import { expect, test } from '@playwright/test';
import { FIXTURE_WG, dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const ANNOUNCEMENT_ID = 'comment-edit-focus';

function announcement() {
	return {
		id: ANNOUNCEMENT_ID,
		authorMemberId: FIXTURE_WG.memberId,
		content: 'Kommentar für den Fokus-Test',
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
				id: 'comment-focus',
				announcementId: ANNOUNCEMENT_ID,
				memberId: FIXTURE_WG.memberId,
				content: 'Diese Antwort lässt sich bearbeiten.',
				createdAt: new Date().toISOString(),
				authorName: FIXTURE_WG.memberName,
				authorColor: null,
			},
		],
	};
}

for (const colorScheme of ['light', 'dark'] as const) {
	test(`moves focus into comment editor at 320px (${colorScheme})`, async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 844 });
		await page.emulateMedia({ colorScheme });
		await setupMember(page);
		await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/announcements*`, (route) => {
			if (route.request().method() !== 'GET') return route.continue();
			return route.fulfill({ json: { announcements: [announcement()] } });
		});

		await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/pinnwand`);
		await dismissOnboarding(page);
		await expect
			.poll(async () =>
				page.locator('html').evaluate((element) => element.classList.contains('dark')),
			)
			.toBe(colorScheme === 'dark');

		const openReplies = page.getByRole('button', { name: /^Antworten anzeigen:/ });
		await openReplies.focus();
		await page.keyboard.press('Enter');
		const panel = page.locator(`#announcement-comments-${ANNOUNCEMENT_ID}`);
		const row = panel.locator('li').filter({ hasText: 'Diese Antwort lässt sich bearbeiten.' });
		const editButton = row.getByRole('button', { name: /^Kommentar bearbeiten:/ });
		await expect(editButton).toBeVisible();
		await editButton.focus();
		await page.keyboard.press('Enter');

		const editor = row.getByRole('textbox', { name: 'Kommentar bearbeiten' });
		await expect(editor).toBeVisible();
		await expect(editor).toBeFocused();
	});
}

test('restores saved comment and reply drafts without stealing focus', async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 844 });
	await page.emulateMedia({ colorScheme: 'light' });
	await setupMember(page);
	const draftKey = `manawg:draft:${FIXTURE_WG.shareCode}:${FIXTURE_WG.memberId}:announcement:${ANNOUNCEMENT_ID}`;
	await page.addInitScript(
		({ replyKey, editKey }) => {
			localStorage.setItem(replyKey, JSON.stringify({ content: 'Antwort-Entwurf' }));
			localStorage.setItem(editKey, JSON.stringify({ content: 'Bearbeitungs-Entwurf' }));
		},
		{ replyKey: `${draftKey}:reply`, editKey: `${draftKey}:edit:comment-focus` },
	);
	await page.route(`**/api/wg/${FIXTURE_WG.shareCode}/announcements*`, (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		return route.fulfill({ json: { announcements: [announcement()] } });
	});

	await navigateToFeature(page, `/wg/${FIXTURE_WG.shareCode}/pinnwand`);
	await dismissOnboarding(page);
	expect(await page.evaluate((key) => localStorage.getItem(key), `${draftKey}:reply`)).toBe(
		JSON.stringify({ content: 'Antwort-Entwurf' }),
	);
	const panel = page.locator(`#announcement-comments-${ANNOUNCEMENT_ID}`);
	await expect(panel).toBeVisible();
	const row = panel.locator('li').first();
	const editor = row.getByRole('textbox', { name: 'Kommentar bearbeiten' });
	await expect(editor).toHaveValue('Bearbeitungs-Entwurf');
	await expect(panel.getByRole('textbox', { name: /^Antwort verfassen:/ })).toHaveValue(
		'Antwort-Entwurf',
	);
	await expect(editor).not.toBeFocused();
});
