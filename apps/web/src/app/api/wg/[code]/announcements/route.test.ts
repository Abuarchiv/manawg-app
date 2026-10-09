import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TransactionAbort } from '@/core/db/transaction-abort';
import { z } from 'zod';

const key = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';

type Row = Record<string, unknown>;
type Cached = { entityId?: unknown; body: Record<string, unknown> };

const announcements = { id: 'id' };
const chores = { id: 'chore-id', wgId: 'chore-wg' };

const state = {
	created: [] as Row[],
	audits: 0,
	notifications: 0,
	warning: null as string | null,
	warningUpdateSucceeds: true,
	legacy: null as unknown,
	rejectImageAttachment: false,
	replayWgId: null as string | null,
	existingChoreId: null as string | null,
	existingSwapPosts: [] as Row[],
	announcementResults: [] as Row[][],
	announcementQueries: 0,
};
let cache = new Map<string, Cached>();
let prior: Promise<void> = Promise.resolve();

const withAnnouncementReplay = async (
	req: Request,
	scope: string,
	mutate: (tx: unknown) => Promise<{ response: Cached }>,
	legacyResponse: (value: unknown) => unknown,
	wgIdForLock?: string,
) => {
	state.replayWgId = wgIdForLock ?? null;
	const replayKey = req.headers.get('idempotency-key');
	const cacheKey = `${scope}:${replayKey}`;
	const waitFor = prior;
	let release: () => void = () => undefined;
	prior = new Promise<void>((resolve) => {
		release = resolve;
	});
	await waitFor;
	try {
		if (state.legacy) {
			return { response: legacyResponse(state.legacy), effect: null, key: replayKey };
		}
		const cached = cache.get(cacheKey);
		if (cached) return { response: cached, effect: null, key: replayKey };
		const tx = {
			select: () => ({
				from: (table: unknown) => {
					if (table === announcements) {
						return { where: () => ({ limit: async () => state.existingSwapPosts }) };
					}
					assert.equal(table, chores);
					return {
						where: () => ({
							limit: async () => (state.existingChoreId ? [{ id: state.existingChoreId }] : []),
						}),
					};
				},
			}),
			insert: (table: unknown) => ({
				values: (value: Row) => ({
					returning: async () => {
						assert.equal(table, announcements);
						const row = { ...value, id: `announcement-${state.created.length + 1}` };
						state.created.push(row);
						return [row];
					},
				}),
			}),
		};
		const outcome = await mutate(tx);
		cache.set(cacheKey, outcome.response);
		return { ...outcome, key: replayKey };
	} finally {
		release();
	}
};

mock.module('@/core/audit', {
	namedExports: { recordAuditEvent: async () => state.audits++ },
});
mock.module('@/core/db', {
	namedExports: {
		announcements,
		chores,
		announcementComments: {},
		announcementReactions: {},
		db: {
			select: () => ({
				from: (table: unknown) => {
					const rows =
						table === announcements
							? (state.announcementResults[state.announcementQueries++] ?? [])
							: [];
					const query: Promise<Row[]> & object = Object.assign(Promise.resolve(rows), {
						innerJoin: () => query,
						where: () => query,
						orderBy: () => query,
						limit: () => query,
					});
					return query;
				},
			}),
		},
		wgMembers: {},
	},
});
mock.module('@/core/db/private-image-deletions', {
	namedExports: {
		assertPrivateImageCanBeAttached: async () => {
			if (state.rejectImageAttachment) throw new TransactionAbort('image_removed');
		},
	},
});
mock.module('@/core/db/transaction', { namedExports: { TransactionAbort } });
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: wgId, name: 'WG', shareCode: 'MTE8PZAT' },
			member: { memberId, name: 'Member' },
		}),
	},
});
mock.module('@/core/infra/observability', {
	namedExports: { captureException: () => undefined, logApiError: () => undefined },
});
mock.module('@/core/notifications/notification-dispatch', {
	namedExports: {
		dispatchNotificationSafely: async () => {
			assert.equal(state.created.length, 1, 'push must run after create');
			state.notifications++;
			return { warning: state.warning };
		},
	},
});
mock.module('@/core/rate-limit', {
	namedExports: { wgWriteLimiter: {}, checkRateLimit: async () => ({ success: true }) },
});
mock.module('@/core/validators/image-url', {
	namedExports: {
		imageUrlSchema: z.string().nullable().optional(),
		isAllowedImageUrlForWg: () => true,
	},
});
mock.module('@/features/pinnwand/server/announcement-replay', {
	namedExports: {
		withAnnouncementReplay,
		persistAnnouncementReplayWarning: async (
			scope: string,
			replayKey: string,
			entityId: unknown,
			warning: unknown,
		) => {
			if (!state.warningUpdateSucceeds) return false;
			const response = cache.get(`${scope}:${replayKey}`);
			if (!response || response.entityId !== entityId) return false;
			response.body.warning = warning;
			return true;
		},
	},
});
mock.module('@/features/pinnwand/announcement-workflow', {
	namedExports: {
		ANNOUNCEMENT_KINDS: ['info', 'question', 'problem', 'request', 'decision'],
		ANNOUNCEMENT_SOURCES: ['manual', 'system', 'chore_swap', 'expense', 'shopping'],
		MEMBER_ANNOUNCEMENT_SOURCES: ['manual', 'chore_swap'],
		summarizeAnnouncementReactions: () => new Map(),
	},
});

const { GET, POST } = await import('./route');

function harness() {
	state.created = [];
	state.audits = 0;
	state.notifications = 0;
	state.warning = null;
	state.warningUpdateSucceeds = true;
	state.legacy = null;
	state.rejectImageAttachment = false;
	state.replayWgId = null;
	state.existingChoreId = null;
	state.existingSwapPosts = [];
	state.announcementResults = [];
	state.announcementQueries = 0;
	cache = new Map();
	prior = Promise.resolve();
	const ctx = { params: Promise.resolve({ code: 'MTE8PZAT' }) } as never;
	return {
		state,
		get: () => GET(new Request('https://example.invalid') as never, ctx),
		post: (imageUrl: string | null = null, extra: Row = {}) =>
			POST(
				new Request('https://example.invalid', {
					method: 'POST',
					headers: { 'Idempotency-Key': key },
					body: JSON.stringify({
						content: 'Hello',
						kind: 'info',
						imageUrl,
						source: 'system',
						...extra,
					}),
				}) as never,
				ctx,
			),
	};
}

test('concurrent create retry returns one announcement and runs push once', async () => {
	const { state, post } = harness();
	const [first, replay] = await Promise.all([post(), post()]);
	assert.deepEqual(await first.json(), await replay.json());
	assert.equal(state.created.length, 1);
	assert.equal(state.created[0]?.authorMemberId, memberId);
	assert.equal(state.created[0]?.source, 'manual');
	assert.equal(state.audits, 1);
	assert.equal(state.notifications, 1);
	assert.equal(state.replayWgId, wgId);
});

test('old flat cached response replays without another create', async () => {
	const { state, post } = harness();
	state.legacy = { announcement: { id: 'legacy-id' }, warning: null };
	assert.deepEqual(await (await post()).json(), state.legacy);
	assert.equal(state.created.length, 0);
	assert.equal(state.notifications, 0);
});

test('warning is returned only when its completed response is updated', async () => {
	const saved = harness();
	saved.state.warning = 'notification_delivery_failed';
	const first = (await (await saved.post()).json()) as { warning: unknown };
	const replay = (await (await saved.post()).json()) as { warning: unknown };
	assert.equal(first.warning, saved.state.warning);
	assert.equal(replay.warning, saved.state.warning);
	assert.equal(saved.state.notifications, 1);

	const failed = harness();
	failed.state.warning = 'notification_delivery_failed';
	failed.state.warningUpdateSucceeds = false;
	assert.equal(((await (await failed.post()).json()) as { warning: unknown }).warning, null);
	assert.equal(((await (await failed.post()).json()) as { warning: unknown }).warning, null);
	assert.equal(failed.state.created.length, 1);
});

test('revoked private image attachment returns 409 without creating an announcement', async () => {
	const { state, post } = harness();
	state.rejectImageAttachment = true;
	const response = await post(
		'https://app.example/api/upload/read?key=manawg%2F22222222-2222-4222-8222-222222222222%2Fannouncement%2F33333333-3333-4333-8333-333333333333.jpg',
	);
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: 'image_removed', code: 'image_removed' });
	assert.equal(state.created.length, 0);
	assert.equal(state.notifications, 0);
});

const choreId = '44444444-4444-4444-8444-444444444444';

test('client-chosen provenance is stored as a manual post', async () => {
	for (const extra of [
		{ source: 'chore_swap', sourcePath: '/putzen?highlight=forged' },
		{ source: 'expense', sourcePath: '/ausgaben' },
		{ source: 'shopping', sourcePath: '/einkauf' },
		{ source: 'chore_swap', choreId },
	]) {
		const { state, post } = harness();
		assert.equal((await post(null, extra)).status, 200);
		assert.equal(state.created[0]?.source, 'manual');
		assert.equal(state.created[0]?.sourcePath, null);
	}
});

test('a swap request for a chore of this WG keeps a server-built source path', async () => {
	for (const extra of [
		{ source: 'chore_swap', choreId },
		{ source: 'chore_swap', sourcePath: `/putzen?highlight=${choreId}` },
	]) {
		const { state, post } = harness();
		state.existingChoreId = choreId;
		assert.equal((await post(null, extra)).status, 200);
		assert.equal(state.created[0]?.source, 'chore_swap');
		assert.equal(state.created[0]?.sourcePath, `/putzen?highlight=${choreId}`);
	}
});

test('a repeated swap request returns the open post instead of a duplicate', async () => {
	const { state, post } = harness();
	state.existingChoreId = choreId;
	state.existingSwapPosts = [{ id: 'existing', source: 'chore_swap', status: 'open' }];
	const res = await post(null, { source: 'chore_swap', choreId });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { duplicate: boolean; announcement: { id: string } };
	assert.equal(body.duplicate, true);
	assert.equal(body.announcement.id, 'existing');
	assert.equal(state.created.length, 0);
});

test('GET lists the board in one query, in the order the database returns', async () => {
	const { state, get } = harness();
	const post = (id: string) => ({
		id,
		createdAt: new Date('2026-09-20T00:00:00Z'),
		pinnedAt: null,
		status: 'open',
		source: 'manual',
	});
	state.announcementResults = [[post('pinned'), post('recent'), post('older')]];

	const response = await get();
	assert.equal(response.status, 200);
	const { announcements: items } = await response.json();
	assert.deepEqual(
		(items as { id: string }[]).map((item) => item.id),
		['pinned', 'recent', 'older'],
	);
	assert.equal(state.announcementQueries, 1);
});
