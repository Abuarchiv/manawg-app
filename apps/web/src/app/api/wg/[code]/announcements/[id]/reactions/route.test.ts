import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const announcementId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const authorId = '33333333-3333-4333-8333-333333333333';
const wgId = '44444444-4444-4444-8444-444444444444';
const keyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const keyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Cached = unknown;

const announcements = {
	id: 'id',
	wgId: 'wg_id',
	authorMemberId: 'author_member_id',
	content: 'content',
	status: 'status',
};
const announcementReactions = {
	id: 'id',
	announcementId: 'announcement_id',
	memberId: 'member_id',
	reaction: 'reaction',
};
const announcement = {
	id: announcementId,
	authorMemberId: authorId,
	content: 'Post',
};

const state = {
	reaction: null as { id: string } | null,
	status: 'open',
	locks: 0,
	audits: [] as string[],
	activeMember: true,
	deactivateAfterGuard: false,
	replayLockedWgId: undefined as string | undefined,
};
let cache = new Map<string, Cached>();
let prior: Promise<void> = Promise.resolve();

const withIdempotentReplay = async (
	req: Request,
	scope: string,
	mutate: (tx: unknown) => Promise<{ response: Cached }>,
	wgIdForLock?: string,
) => {
	state.replayLockedWgId = wgIdForLock;
	const key = req.headers.get('idempotency-key');
	const cacheKey = `${scope}:${key}`;
	const waitFor = prior;
	let release: () => void = () => undefined;
	prior = new Promise<void>((resolve) => {
		release = resolve;
	});
	await waitFor;
	try {
		const cached = cache.get(cacheKey);
		if (cached) return { response: cached, effect: null, key };
		const tx = {
			select: () => ({
				from: (table: unknown) => ({
					where: () => ({
						limit: () =>
							table === announcements
								? {
										for: async () => {
											state.locks++;
											return [{ ...announcement, status: state.status }];
										},
									}
								: Promise.resolve(state.reaction ? [state.reaction] : []),
					}),
				}),
			}),
			delete: (table: unknown) => ({
				where: () => ({
					returning: async () => {
						assert.equal(table, announcementReactions);
						const removed = state.reaction;
						state.reaction = null;
						return removed ? [removed] : [];
					},
				}),
			}),
			insert: (table: unknown) => ({
				values: () => ({
					onConflictDoNothing: () => ({
						returning: async () => {
							assert.equal(table, announcementReactions);
							if (state.reaction) return [];
							state.reaction = { id: 'reaction-1' };
							return [state.reaction];
						},
					}),
				}),
			}),
		};
		const outcome = await mutate(tx);
		cache.set(cacheKey, outcome.response);
		return { ...outcome, key };
	} finally {
		release();
	}
};

mock.module('@/core/audit', {
	namedExports: {
		recordAuditEvent: async (event: { eventType: string }) => state.audits.push(event.eventType),
	},
});
mock.module('@/core/db', { namedExports: { announcements, announcementReactions } });
mock.module('@/core/db/account-deletion', {
	namedExports: {
		lockActiveAccountMember: async () =>
			state.activeMember
				? {
						id: memberId,
						name: 'Member',
						role: 'member',
						authUserId: 'auth-1',
						deactivatedAt: null,
					}
				: null,
	},
});
mock.module('@/core/guards/api-auth', { namedExports: { UUID_PATTERN: /^[0-9a-f-]{36}$/i } });
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => {
			const auth = {
				ok: true,
				wg: { id: wgId, name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId, name: 'Member' },
				authUserId: 'auth-1',
			};
			if (state.deactivateAfterGuard) {
				state.deactivateAfterGuard = false;
				state.activeMember = false;
			}
			return auth;
		},
	},
});
mock.module('@/core/infra/observability', {
	namedExports: { captureException: () => undefined, logApiError: () => undefined },
});
mock.module('@/core/rate-limit', {
	namedExports: { wgWriteLimiter: {}, checkRateLimit: async () => ({ success: true }) },
});
mock.module('@/core/db/with-replay', {
	namedExports: { withIdempotentReplay },
});
mock.module('@/features/announcements/announcement-workflow', {
	namedExports: { ANNOUNCEMENT_REACTIONS: ['seen', 'take', 'ok'] },
});
mock.module('drizzle-orm', {
	namedExports: {
		and: (...parts: unknown[]) => parts,
		eq: (...parts: unknown[]) => parts,
	},
});

const { POST } = await import('./route');

function harness() {
	state.reaction = null;
	state.status = 'open';
	state.locks = 0;
	state.audits = [];
	state.activeMember = true;
	state.deactivateAfterGuard = false;
	state.replayLockedWgId = undefined;
	cache = new Map();
	prior = Promise.resolve();
	return {
		state,
		post: (key: string, active = true) =>
			POST(
				new Request('https://example.invalid', {
					method: 'POST',
					headers: { 'Idempotency-Key': key },
					body: JSON.stringify({ reaction: 'seen', active }),
				}) as never,
				{ params: Promise.resolve({ code: 'MTE8PZAT', id: announcementId }) } as never,
			),
	};
}

test('same key replays an added reaction without toggling it off', async () => {
	const { state, post } = harness();
	const first = (await (await post(keyA)).json()) as { active: boolean };
	const replay = await (await post(keyA)).json();
	assert.deepEqual(first, replay);
	assert.equal(first.active, true);
	assert.equal(state.reaction?.id, 'reaction-1');
	assert.deepEqual(state.audits, ['announcement.reaction.added']);
	assert.equal(state.locks, 1);
});

test('distinct keys for add then remove serialize on the announcement lock', async () => {
	const { state, post } = harness();
	const [added, removed] = await Promise.all([post(keyA, true), post(keyB, false)]);
	assert.equal(((await added.json()) as { active: boolean }).active, true);
	assert.equal(((await removed.json()) as { active: boolean }).active, false);
	assert.equal(state.reaction, null);
	assert.deepEqual(state.audits, ['announcement.reaction.added', 'announcement.reaction.removed']);
	assert.equal(state.locks, 2);
});
test('explicit active true with a new key is a no-op when already active', async () => {
	const { state, post } = harness();
	await post(keyA, true);
	const second = (await (await post(keyB, true)).json()) as { active: boolean };
	assert.equal(second.active, true);
	assert.equal(state.reaction?.id, 'reaction-1');
	assert.deepEqual(state.audits, ['announcement.reaction.added']);
});

test('a reaction is not saved after a concurrent move-out', async () => {
	const { state, post } = harness();
	state.deactivateAfterGuard = true;

	const response = await post(keyA);
	assert.equal(response.status, 401);
	assert.equal((await response.json()).error, 'member_deactivated');
	assert.equal(state.reaction, null);
	assert.deepEqual(state.audits, []);
	assert.equal(state.locks, 0);
	assert.equal(state.replayLockedWgId, wgId);
});
