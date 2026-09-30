import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const file = path.join(process.cwd(), 'src/app/api/wg/[code]/announcements/route.ts');
const key = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';

function harness() {
	const state = {
		created: [],
		audits: 0,
		notifications: 0,
		warning: null,
		warningUpdateSucceeds: true,
		legacy: null,
		rejectImageAttachment: false,
		replayWgId: null,
		existingChoreId: null,
		announcementResults: [],
		announcementQueries: 0,
	};
	class TransactionAbort extends Error {
		constructor(code) {
			super(code);
			this.code = code;
		}
	}
	const cache = new Map();
	let prior = Promise.resolve();
	const announcements = { id: 'id' };
	const chores = { id: 'chore-id', wgId: 'chore-wg' };
	const withAnnouncementReplay = async (req, scope, mutate, legacyResponse, wgIdForLock) => {
		state.replayWgId = wgIdForLock ?? null;
		const replayKey = req.headers.get('idempotency-key');
		const cacheKey = `${scope}:${replayKey}`;
		const waitFor = prior;
		let release = () => undefined;
		prior = new Promise((resolve) => {
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
					from: (table) => {
						assert.equal(table, chores);
						return {
							where: () => ({
								limit: async () => (state.existingChoreId ? [{ id: state.existingChoreId }] : []),
							}),
						};
					},
				}),
				insert: (table) => ({
					values: (value) => ({
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
	const source = transpileModule(readFileSync(file, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	const z = requireFromWeb('zod').z;
	const overrides = {
		'@/core/audit': { recordAuditEvent: async () => state.audits++ },
		'@/core/db': {
			announcements,
			chores,
			announcementComments: {},
			announcementReactions: {},
			db: {
				select: () => ({
					from: (table) => {
						const rows =
							table === announcements
								? (state.announcementResults[state.announcementQueries++] ?? [])
								: [];
						const query = Object.assign(Promise.resolve(rows), {
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
		'@/core/db/private-image-deletions': {
			assertPrivateImageCanBeAttached: async () => {
				if (state.rejectImageAttachment) throw new TransactionAbort('image_removed');
			},
		},
		'@/core/db/transaction': { TransactionAbort },
		'@/core/errors': {
			badRequest: (error) => Response.json({ error }, { status: 400 }),
			conflict: (error, code) =>
				Response.json({ error, ...(code ? { code } : {}) }, { status: 409 }),
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId, name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId, name: 'Member' },
			}),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
		'@/core/http/read-json': {
			readJsonBody: async (req) => ({ ok: true, body: await req.json() }),
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/notifications/notification-dispatch': {
			dispatchNotificationSafely: async () => {
				assert.equal(state.created.length, 1, 'push must run after create');
				state.notifications++;
				return { warning: state.warning };
			},
		},
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }) },
		'@/core/validators/image-url': {
			imageUrlSchema: z.string().nullable().optional(),
			isAllowedImageUrlForWg: () => true,
		},
		'@/features/pinnwand/announcement-replay': {
			withAnnouncementReplay,
			persistAnnouncementReplayWarning: async (scope, replayKey, entityId, warning) => {
				if (!state.warningUpdateSucceeds) return false;
				const response = cache.get(`${scope}:${replayKey}`);
				if (response?.entityId !== entityId) return false;
				response.body.warning = warning;
				return true;
			},
		},
		'@/features/pinnwand/announcement-workflow': {
			ANNOUNCEMENT_KINDS: ['info', 'question', 'problem', 'request', 'decision'],
			ANNOUNCEMENT_SOURCES: ['manual', 'system', 'chore_swap', 'expense', 'shopping'],
			summarizeAnnouncementReactions: () => new Map(),
		},
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	};
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return {
		state,
		get: () => module.exports.GET(new Request('https://example.invalid'), { code: 'MTE8PZAT' }),
		post: (imageUrl = null, extra = {}) =>
			module.exports.POST(
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
				}),
				{ code: 'MTE8PZAT' },
			),
	};
}

test('concurrent create retry returns one announcement and runs push once', async () => {
	const { state, post } = harness();
	const [first, replay] = await Promise.all([post(), post()]);
	assert.deepEqual(await first.json(), await replay.json());
	assert.equal(state.created.length, 1);
	assert.equal(state.created[0].authorMemberId, memberId);
	assert.equal(state.created[0].source, 'manual');
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
	const first = await (await saved.post()).json();
	const replay = await (await saved.post()).json();
	assert.equal(first.warning, saved.state.warning);
	assert.equal(replay.warning, saved.state.warning);
	assert.equal(saved.state.notifications, 1);

	const failed = harness();
	failed.state.warning = 'notification_delivery_failed';
	failed.state.warningUpdateSucceeds = false;
	assert.equal((await (await failed.post()).json()).warning, null);
	assert.equal((await (await failed.post()).json()).warning, null);
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
		assert.equal(state.created[0].source, 'manual');
		assert.equal(state.created[0].sourcePath, null);
	}
});

test('public announcement POST cannot forge server-managed chore swap provenance', async () => {
	const { state, post } = harness();
	state.existingChoreId = choreId;
	const response = await post(null, {
		source: 'chore_swap',
		choreId,
		sourcePath: `/putzen?highlight=${choreId}`,
	});
	assert.equal(response.status, 200);
	assert.equal(state.created[0].source, 'manual');
	assert.equal(state.created[0].sourcePath, null);
});

test('GET keeps open member posts that system notices pushed out of the newest window', async () => {
	const { state, get } = harness();
	const post = (id, createdAt, extra = {}) => ({
		id,
		createdAt: new Date(createdAt),
		pinnedAt: null,
		status: 'open',
		source: 'manual',
		...extra,
	});
	const pinned = post('pinned', '2026-01-01T00:00:00Z', { pinnedAt: new Date('2026-09-01') });
	const notice = post('notice', '2026-09-20T00:00:00Z', { source: 'shopping' });
	const recentOpen = post('recent-open', '2026-09-10T00:00:00Z');
	const oldOpen = post('old-open', '2026-02-01T00:00:00Z');
	state.announcementResults = [
		[pinned, notice, recentOpen],
		[recentOpen, oldOpen],
	];

	const response = await get();
	assert.equal(response.status, 200);
	const { announcements: items } = await response.json();
	assert.deepEqual(
		items.map((item) => item.id),
		['pinned', 'notice', 'recent-open', 'old-open'],
	);
	assert.equal(state.announcementQueries, 2);
});
