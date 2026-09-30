import { expect, test } from '@playwright/test';
import { dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');

const SHARE_CODE = 'MTE8PZAT';
const MEMBER_ID = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';

function announcement(id: string, content: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		authorMemberId: MEMBER_ID,
		content,
		imageUrl: null,
		kind: 'question',
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
		...extra,
	};
}

const openPost = announcement('archive-open', 'Offene Frage');
const resolvedPost = announcement('archive-resolved', 'Geklärte Frage', {
	status: 'resolved',
	resolvedAt: '2026-09-20T09:00:00.000Z',
	resolvedByMemberId: MEMBER_ID,
	createdAt: '2026-09-20T08:00:00.000Z',
});
const staleInfo = announcement('archive-stale-info', 'Alte Info', {
	kind: 'info',
	createdAt: '2026-08-01T08:00:00.000Z',
});

for (const colorScheme of ['light', 'dark'] as const) {
	for (const rootFontSize of ['16px', '32px'] as const) {
		const textScale = rootFontSize === '32px' ? '200%' : 'normal';
		for (const width of [320, 390]) {
			test(`Pinnwand archive toggle fits at ${width}px, ${colorScheme} mode, and ${textScale} text`, async ({
				page,
			}) => {
				await page.setViewportSize({ width, height: 800 });
				await page.emulateMedia({ colorScheme });
				await setupMember(page);
				await page.route(`**/api/wg/${SHARE_CODE}/announcements*`, (route) =>
					route.request().method() === 'GET'
						? route.fulfill({ json: { announcements: [openPost, resolvedPost, staleInfo] } })
						: route.continue(),
				);

				await navigateToFeature(page, `/wg/${SHARE_CODE}/pinnwand`);
				await dismissOnboarding(page);
				await page.evaluate((fontSize) => {
					document.documentElement.style.setProperty('font-size', fontSize, 'important');
				}, rootFontSize);

				const board = page.getByRole('list', { name: 'Pinnwand-Beiträge' });
				await expect(board.getByText('Offene Frage')).toBeVisible();
				await expect(board.getByText('Geklärte Frage')).toHaveCount(0);
				await expect(board.getByText('Alte Info')).toHaveCount(0);

				const toggle = page.getByRole('button', { name: 'Geklärt & älter (2)' });
				await expect(toggle).toHaveAttribute('aria-expanded', 'false');
				await expect(page.getByText('Geklärte Frage')).toBeHidden();
				await toggle.click();
				await expect(toggle).toHaveAttribute('aria-expanded', 'true');
				const archive = page.getByRole('list', { name: 'Geklärte und ältere Beiträge' });
				await expect(archive.getByText('Geklärte Frage')).toBeVisible();
				await expect(archive.getByText('Alte Info')).toBeVisible();

				const box = await toggle.boundingBox();
				expect(box?.height).toBeGreaterThanOrEqual(44);
				expect(
					await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
				).toBe(true);
			});
		}
	}
}

test('a hash link to an archived post opens the archive and highlights it', async ({ page }) => {
	await setupMember(page);
	await page.route(`**/api/wg/${SHARE_CODE}/announcements*`, (route) =>
		route.request().method() === 'GET'
			? route.fulfill({ json: { announcements: [openPost, resolvedPost] } })
			: route.continue(),
	);

	await navigateToFeature(page, `/wg/${SHARE_CODE}/pinnwand#announcement-archive-resolved`);
	await dismissOnboarding(page);

	await expect(page.getByRole('button', { name: 'Geklärt & älter (1)' })).toHaveAttribute(
		'aria-expanded',
		'true',
	);
	await expect(page.locator('li#announcement-archive-resolved')).toBeInViewport();
});

test('Erledigt moves an open question into the archive', async ({ page }) => {
	await setupMember(page);
	let current = openPost;
	const patches: unknown[] = [];
	await page.route(`**/api/wg/${SHARE_CODE}/announcements**`, async (route) => {
		const request = route.request();
		if (request.method() === 'GET') {
			return route.fulfill({ json: { announcements: [current] } });
		}
		if (request.method() === 'PATCH') {
			patches.push(request.postDataJSON());
			current = {
				...openPost,
				status: 'resolved',
				resolvedAt: new Date().toISOString(),
				resolvedByMemberId: MEMBER_ID,
			};
			return route.fulfill({ json: { announcement: current, warning: null } });
		}
		return route.continue();
	});

	await navigateToFeature(page, `/wg/${SHARE_CODE}/pinnwand`);
	await dismissOnboarding(page);
	const board = page.getByRole('list', { name: 'Pinnwand-Beiträge' });
	await expect(board.getByText('Offene Frage')).toBeVisible();

	await page.getByRole('button', { name: 'Als erledigt markieren: Offene Frage' }).click();

	await expect.poll(() => patches).toEqual([{ status: 'resolved' }]);
	await expect(page.getByText('Nichts Offenes')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Geklärt & älter (1)' })).toHaveAttribute(
		'aria-expanded',
		'false',
	);
});
