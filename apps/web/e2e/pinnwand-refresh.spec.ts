import { expect, test } from '@playwright/test';
import { dismissOnboarding, navigateToFeature, setupMember } from './_helpers';

test.skip(process.env.NEXT_PUBLIC_E2E_FIXTURE_MODE !== 'true', 'requires local fixture server');
test.use({ serviceWorkers: 'block' });

const SHARE_CODE = 'MTE8PZAT';
const MEMBER_ID = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';

function announcement(id: string, content: string, comments: Record<string, unknown>[] = []) {
	return {
		id,
		authorMemberId: MEMBER_ID,
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
		comments,
	};
}

function createRequestGate() {
	let markStarted: () => void = () => {};
	let release: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { started, gate, markStarted, release };
}

test('keeps the Pinnwand loading skeleton within a 320px viewport at 200% text', async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await setupMember(page);

	let initialReadPending = true;
	const initialRead = createRequestGate();
	await page.route(`**/api/wg/${SHARE_CODE}/announcements*`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		if (initialReadPending) {
			initialReadPending = false;
			initialRead.markStarted();
			await initialRead.gate;
		}
		return route.fulfill({ json: { announcements: [] } });
	});

	await navigateToFeature(page, `/wg/${SHARE_CODE}/pinnwand`);
	await dismissOnboarding(page);
	await initialRead.started;

	const skeleton = page.getByLabel('Pinnwand wird geladen');
	await expect(skeleton).toBeVisible();
	await page.evaluate(() => {
		document.documentElement.style.setProperty('font-size', '200%', 'important');
	});
	const geometry = await skeleton.evaluate((root) => {
		const viewportWidth = document.documentElement.clientWidth;
		return {
			viewportWidth,
			rootFontSize: getComputedStyle(document.documentElement).fontSize,
			elements: [...root.querySelectorAll('*')]
				.filter((element) => element.getBoundingClientRect().right > viewportWidth + 0.5)
				.map((element) => ({
					className: element.className.toString(),
					left: element.getBoundingClientRect().left,
					right: element.getBoundingClientRect().right,
				})),
		};
	});
	initialRead.release();
	await expect(geometry.viewportWidth).toBe(320);
	await expect(geometry.rootFontSize).toBe('32px');
	await expect(geometry.elements).toEqual([]);
});

test('shows refresh error while cached Pinnwand posts stay visible', async ({ page }) => {
	await setupMember(page);
	let failReads = false;
	let failedReads = 0;
	let initialReadPending = true;
	const initialRead = createRequestGate();
	await page.route(`**/api/wg/${SHARE_CODE}/announcements*`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		if (initialReadPending) {
			initialReadPending = false;
			initialRead.markStarted();
			await initialRead.gate;
		}
		if (failReads) {
			failedReads += 1;
			return route.fulfill({ status: 503, json: { error: 'service_unavailable' } });
		}
		return route.fulfill({
			json: { announcements: [announcement('post-cached', 'Cache-Beitrag')] },
		});
	});

	await navigateToFeature(page, `/wg/${SHARE_CODE}/pinnwand`);
	await dismissOnboarding(page);
	await initialRead.started;
	initialRead.release();
	await expect(page.getByText('Cache-Beitrag', { exact: true })).toBeVisible();

	failReads = true;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect.poll(() => failedReads).toBeGreaterThanOrEqual(1);
	const retry = page.getByRole('button', { name: 'Pinnwand erneut laden' });
	await expect(retry).toBeVisible();
	await expect(page.getByText('Cache-Beitrag', { exact: true })).toBeVisible();
	failReads = false;
	await retry.click();
	await expect(retry).toBeHidden();
	await expect(page.getByText('Cache-Beitrag', { exact: true })).toBeVisible();
});

test('removes a cached Pinnwand post missing from the focus refresh', async ({ page }) => {
	await setupMember(page);
	let removeOnNextRead = false;
	let changedReads = 0;
	let initialReadPending = true;
	const initialRead = createRequestGate();
	const retained = announcement('post-retained', 'Bleibt sichtbar');
	const deleted = announcement('post-deleted', 'Serverseitig gelöscht');
	await page.route(`**/api/wg/${SHARE_CODE}/announcements*`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		if (initialReadPending) {
			initialReadPending = false;
			initialRead.markStarted();
			await initialRead.gate;
		}
		// Once the server deleted the post it stays deleted for every later read
		// (a focus can trigger more than one refresh).
		if (removeOnNextRead || changedReads > 0) {
			if (removeOnNextRead) changedReads += 1;
			removeOnNextRead = false;
			return route.fulfill({ json: { announcements: [retained] } });
		}
		return route.fulfill({
			json: { announcements: [retained, deleted] },
		});
	});

	await navigateToFeature(page, `/wg/${SHARE_CODE}/pinnwand`);
	await dismissOnboarding(page);
	await initialRead.started;
	initialRead.release();
	await expect(page.getByText('Bleibt sichtbar', { exact: true })).toBeVisible();
	await expect(page.getByText('Serverseitig gelöscht', { exact: true })).toBeVisible();

	removeOnNextRead = true;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect.poll(() => changedReads).toBe(1);
	await expect(page.getByText('Serverseitig gelöscht', { exact: true })).toBeHidden();
	await expect(page.getByText('Bleibt sichtbar', { exact: true })).toBeVisible();
});

test('does not resurrect a deleted post after two pending refreshes', async ({ page }) => {
	await setupMember(page);
	let nextRefresh: ReturnType<typeof announcement>[] | null = null;
	let refreshReads = 0;
	let markSecondRefreshFulfilled: () => void = () => {};
	const secondRefreshFulfilled = new Promise<void>((resolve) => {
		markSecondRefreshFulfilled = resolve;
	});
	let initialReadPending = true;
	const initialRead = createRequestGate();
	const retained = announcement('post-retained-after-refresh', 'Beitrag A');
	const deleted = announcement('post-deleted-after-refresh', 'Beitrag B gelöscht');
	await page.route(`**/api/wg/${SHARE_CODE}/announcements*`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		if (initialReadPending) {
			initialReadPending = false;
			initialRead.markStarted();
			await initialRead.gate;
		}
		if (nextRefresh) {
			const response = nextRefresh;
			nextRefresh = null;
			refreshReads += 1;
			await route.fulfill({ json: { announcements: response } });
			if (refreshReads === 2) markSecondRefreshFulfilled();
			return;
		}
		return route.fulfill({ json: { announcements: [retained] } });
	});

	await navigateToFeature(page, `/wg/${SHARE_CODE}/pinnwand`);
	await dismissOnboarding(page);
	await initialRead.started;
	initialRead.release();
	await expect(page.getByText('Beitrag A', { exact: true })).toBeVisible();

	const pendingButton = page.getByRole('button', { name: /neue Beitr/ });
	nextRefresh = [retained, deleted];
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect.poll(() => refreshReads).toBe(1);
	await expect(pendingButton).toBeVisible();

	nextRefresh = [retained];
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect.poll(() => refreshReads).toBe(2);
	await secondRefreshFulfilled;
	await expect(pendingButton).toBeHidden();
	await expect(page.getByText('Beitrag A', { exact: true })).toBeVisible();
	await expect(page.getByText('Beitrag B gelöscht', { exact: true })).toBeHidden();
});

test('comment delete requires confirmation and only removes the comment once confirmed', async ({
	page,
}) => {
	await setupMember(page);
	const post = announcement('post-with-comment', 'Beitrag mit Kommentar', [
		{
			id: 'comment-1',
			announcementId: 'post-with-comment',
			memberId: MEMBER_ID,
			content: 'Testkommentar',
			createdAt: new Date().toISOString(),
			authorName: 'dsaf',
			authorColor: null,
		},
	]);
	let deleteRequests = 0;
	await page.route(`**/api/wg/${SHARE_CODE}/announcements*`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		return route.fulfill({ json: { announcements: [post] } });
	});
	await page.route(
		`**/api/wg/${SHARE_CODE}/announcements/post-with-comment/comments/comment-1`,
		async (route) => {
			if (route.request().method() !== 'DELETE') return route.continue();
			deleteRequests += 1;
			post.comments = [];
			return route.fulfill({ json: {} });
		},
	);

	await navigateToFeature(page, `/wg/${SHARE_CODE}/pinnwand`);
	await dismissOnboarding(page);
	await expect(page.getByText('Beitrag mit Kommentar', { exact: true })).toBeVisible();

	await page.getByRole('button', { name: /Antworten anzeigen/ }).click();
	await expect(page.getByText('Testkommentar', { exact: true })).toBeVisible();

	const deleteTrigger = page.getByRole('button', { name: /Kommentar entfernen: Testkommentar/ });
	await deleteTrigger.click();

	const dialog = page.getByRole('alertdialog', { name: 'Kommentar entfernen?' });
	await expect(dialog).toBeVisible();
	await expect(page.getByText('Testkommentar', { exact: true })).toBeVisible();

	// Cancel keeps the comment and never calls the API.
	await dialog.getByRole('button', { name: 'Abbrechen' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText('Testkommentar', { exact: true })).toBeVisible();
	expect(deleteRequests).toBe(0);

	// Confirming removes the comment and calls the delete endpoint exactly once.
	await deleteTrigger.click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: /Kommentar entfernen bestätigen/ }).click();
	await expect.poll(() => deleteRequests).toBe(1);
	await expect(page.getByText('Testkommentar', { exact: true })).toBeHidden();
});
