import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.setTimeout(120_000);
test.skip(
	process.env.PILOT_FIXES_WORKER !== 'chores',
	'requires the dedicated pilot chores database worker',
);

test('completing a chore resolves only its linked swap post and shows the next due date', async ({
	page,
}) => {
	const shareCode = process.env.PILOT_WG_CODE?.trim().toUpperCase() ?? '';
	const runtimeBaseUrl =
		test.info().project.use.baseURL?.toString() ?? process.env.BASE_URL ?? 'http://127.0.0.1:3291';
	const runtimeHost = new URL(runtimeBaseUrl).hostname;
	if (!['127.0.0.1', 'localhost', '::1'].includes(runtimeHost)) {
		throw new Error('Pilot chore coordination E2E requires a loopback BASE_URL.');
	}
	if (!shareCode) {
		throw new Error('Set PILOT_WG_CODE for the pilot chores worker.');
	}
	const request = page.request;
	const title = `Pilot coordination ${Date.now()}`;
	const createdAnnouncementIds: string[] = [];
	const createdChoreIds: string[] = [];
	let choreId: string | undefined;

	const createChore = async (choreTitle: string) => {
		const response = await request.post(`/api/wg/${shareCode}/chores`, {
			data: {
				title: choreTitle,
				intervalDays: 7,
				recurrenceType: 'days',
				assignedMemberId: null,
			},
		});
		expect(response.ok()).toBe(true);
		return (await response.json()) as {
			chore: {
				id: string;
				nextDueAt: string;
				assignedMemberId: string | null;
				createdAt: string;
			};
		};
	};

	try {
		const choreBody = await createChore(title);
		choreId = choreBody.chore.id;
		createdChoreIds.push(choreId);
		expect(Date.parse(choreBody.chore.nextDueAt)).toBeGreaterThan(
			Date.parse(choreBody.chore.createdAt),
		);

		// A second chore whose swap request must NOT be resolved by completing
		// the first one. Swap posts go through the chore route because their
		// provenance (`source: 'chore_swap'` + highlight link) is server-
		// generated; the public announcements POST can only store `manual` (#517).
		const otherChoreBody = await createChore(`${title} unrelated`);
		const otherChoreId = otherChoreBody.chore.id;
		createdChoreIds.push(otherChoreId);

		const linkedSourcePath = `/putzen?highlight=${encodeURIComponent(choreId)}`;
		const unrelatedSourcePath = `/putzen?highlight=${encodeURIComponent(otherChoreId)}`;
		const linkedSwapEndpoint = `/api/wg/${shareCode}/chores/${encodeURIComponent(choreId)}/swap-request`;
		const keylessSwapResponse = await request.post(linkedSwapEndpoint);
		expect(keylessSwapResponse.status()).toBe(400);
		expect(await keylessSwapResponse.json()).toMatchObject({ error: 'idempotency_key_required' });
		const linkedIdempotencyKey = randomUUID();
		const linkedSwapResponse = await request.post(linkedSwapEndpoint, {
			headers: { 'Idempotency-Key': linkedIdempotencyKey },
		});
		expect(linkedSwapResponse.ok()).toBe(true);
		const linkedSwapBody = (await linkedSwapResponse.json()) as { announcement: { id: string } };
		createdAnnouncementIds.push(linkedSwapBody.announcement.id);

		const replayedSwapResponse = await request.post(linkedSwapEndpoint, {
			headers: { 'Idempotency-Key': linkedIdempotencyKey },
		});
		expect(replayedSwapResponse.ok()).toBe(true);
		const replayedSwapBody = (await replayedSwapResponse.json()) as {
			announcement: { id: string };
		};
		expect(replayedSwapBody.announcement.id).toBe(linkedSwapBody.announcement.id);

		const unrelatedSwapResponse = await request.post(
			`/api/wg/${shareCode}/chores/${encodeURIComponent(otherChoreId)}/swap-request`,
			{ headers: { 'Idempotency-Key': randomUUID() } },
		);
		expect(unrelatedSwapResponse.ok()).toBe(true);
		const unrelatedSwapBody = (await unrelatedSwapResponse.json()) as {
			announcement: { id: string };
		};
		createdAnnouncementIds.push(unrelatedSwapBody.announcement.id);

		const manualResponse = await request.post(`/api/wg/${shareCode}/announcements`, {
			data: { content: `${title} manueller Beitrag`, kind: 'info' },
		});
		expect(manualResponse.ok()).toBe(true);
		const manualBody = (await manualResponse.json()) as { announcement: { id: string } };
		createdAnnouncementIds.push(manualBody.announcement.id);

		const completeResponse = await request.post(
			`/api/wg/${shareCode}/chores/${encodeURIComponent(choreId)}/complete`,
			{
				data: {
					expectedNextDueAt: choreBody.chore.nextDueAt,
					expectedAssignedMemberId: choreBody.chore.assignedMemberId,
				},
			},
		);
		expect(completeResponse.ok()).toBe(true);

		const announcementsResponse = await request.get(`/api/wg/${shareCode}/announcements`, {});
		expect(announcementsResponse.ok()).toBe(true);
		const announcementsBody = (await announcementsResponse.json()) as {
			announcements: Array<{
				id: string;
				status: string;
				resolvedAt: string | null;
				resolvedByMemberId: string | null;
				source: string;
				sourcePath: string | null;
			}>;
		};
		const linked = announcementsBody.announcements.find(
			(announcement) => announcement.sourcePath === linkedSourcePath,
		);
		const unrelated = announcementsBody.announcements.find(
			(announcement) => announcement.sourcePath === unrelatedSourcePath,
		);
		const manual = announcementsBody.announcements.find(
			(announcement) => announcement.id === manualBody.announcement.id,
		);
		expect(linked).toMatchObject({
			status: 'resolved',
			resolvedAt: expect.any(String),
			source: 'chore_swap',
		});
		expect(linked?.resolvedByMemberId).toBeTruthy();
		expect(unrelated).toMatchObject({
			status: 'open',
			resolvedAt: null,
			resolvedByMemberId: null,
			source: 'chore_swap',
		});
		expect(manual).toMatchObject({
			status: 'open',
			resolvedAt: null,
			resolvedByMemberId: null,
			source: 'manual',
			sourcePath: null,
		});
		if (!linked || !unrelated)
			throw new Error('Pilot announcements were not returned after completion.');
		const staleTakeResponse = await request.post(
			`/api/wg/${shareCode}/announcements/${linked.id}/reactions`,
			{ data: { reaction: 'take' } },
		);
		expect(staleTakeResponse.status()).toBe(400);
		expect(await staleTakeResponse.json()).toMatchObject({ error: 'reaction_invalid' });
		const resolvedOkResponse = await request.post(
			`/api/wg/${shareCode}/announcements/${linked.id}/reactions`,
			{ data: { reaction: 'ok' } },
		);
		expect(resolvedOkResponse.ok()).toBe(true);

		await page.goto(`/wg/${shareCode}/pinnwand`);
		const linkedCard = page.locator(`li#announcement-${linked.id}`);
		const unrelatedCard = page.locator(`li#announcement-${unrelated.id}`);
		await expect(linkedCard).toContainText('Geklärt');
		await expect(linkedCard).not.toContainText('Übernehme ich');
		await expect(unrelatedCard).toContainText('Übernehme ich');
		await page.screenshot({
			path: test.info().outputPath('pinnwand-resolved.png'),
			fullPage: true,
		});

		await page.goto(`/wg/${shareCode}/putzen`);
		await expect(page.locator(`li#chore-${choreId}`)).toContainText('wöchentlich');
		await page.getByRole('button', { name: 'Putzaufgabe erfassen' }).click();
		await expect(page.getByText('Erste Fälligkeit: in 7 Tagen.', { exact: false })).toBeVisible();
	} finally {
		for (const announcementId of createdAnnouncementIds) {
			await request
				.delete(`/api/wg/${shareCode}/announcements/${announcementId}`)
				.catch(() => undefined);
		}
		for (const createdChoreId of createdChoreIds) {
			await request.delete(`/api/wg/${shareCode}/chores/${createdChoreId}`).catch(() => undefined);
		}
	}
});
