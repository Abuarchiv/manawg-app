import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { withEnv } from '../../../../../tests/support/env';

const keys = [
	'manawg/11111111-1111-4111-8111-111111111111/expense/22222222-2222-4222-8222-222222222222.jpg',
	'manawg/11111111-1111-4111-8111-111111111111/expense/33333333-3333-4333-8333-333333333333.jpg',
	'manawg/11111111-1111-4111-8111-111111111111/announcement/44444444-4444-4444-8444-444444444444.png',
] as [string, string, string];

const state = {
	keys: [] as string[],
	batches: null as string[][] | null,
	claimed: [] as string[],
	removeCalls: [] as string[][],
	removeFailsOnCall: 0,
	dequeueError: null as Error | null,
	referenced: new Set<string>(),
	pending: 0,
	removeError: null as Error | null,
	removed: [] as string[],
	marked: [] as string[],
	dequeued: [] as string[],
	events: [] as string[],
};

mock.module('@/core/auth/delete-user', { namedExports: { deleteAuthUser: async () => true } });
mock.module('@/core/auth/supabase-env', {
	namedExports: { getSupabaseEnv: () => null, hasSupabaseEnv: () => false },
});
mock.module('@/core/db/account-deletion', {
	namedExports: {
		retryPendingAccountDeletions: async (deleteAuthUser: unknown) => {
			assert.equal(deleteAuthUser, null);
			return { attempted: 0, completed: 0, failed: 0, pending: 0 };
		},
	},
});
mock.module('@/core/db/private-image-deletions', {
	namedExports: {
		CLEANUP_BATCH_SIZE: 50,
		claimPrivateImageCleanupBatch: async () => {
			state.events.push('claim');
			state.claimed = state.batches ? (state.batches.shift() ?? []) : state.keys;
			return state.claimed;
		},
		findLivePrivateImageReferenceKeys: async (objectKeys: string[]) => {
			state.events.push('references');
			assert.deepEqual(objectKeys, state.claimed);
			return state.referenced;
		},
		dequeueImageDeletions: async (objectKeys: string[]) => {
			state.events.push('dequeue');
			if (state.dequeueError) throw state.dequeueError;
			state.dequeued = objectKeys;
		},
		markPrivateImageStorageDeleted: async (objectKeys: string[]) => {
			state.events.push('mark');
			state.marked = objectKeys;
		},
		countPendingPrivateImageDeletions: async () => {
			state.events.push('pending');
			return state.pending;
		},
		purgeFinishedPrivateImageDeletions: async () => 0,
	},
});
mock.module('@/core/mail/mail-retention', {
	namedExports: { purgeOldMailLog: async () => 0 },
});
mock.module('@/core/idempotency-store', {
	namedExports: { purgeExpiredIdempotencyResponses: async () => 0 },
});
mock.module('@/core/infra/cron-auth', { namedExports: { requireCronSecret: () => null } });
mock.module('@/core/infra/observability', {
	namedExports: {
		logApiError: (message: string) => state.events.push(`log:${message}`),
		withCronLogging: (_name: string, handler: unknown) => handler,
	},
});
mock.module('@/core/db/orphan-uploads', {
	namedExports: { sweepOrphanUploads: async () => ({ wgsChecked: 0, queued: 0 }) },
});
mock.module('@/core/infra/supabase-storage', {
	namedExports: {
		removeSupabaseImages: async (objectKeys: string[]) => {
			state.events.push('remove');
			state.removed = objectKeys;
			state.removeCalls.push(objectKeys);
			if (state.removeError && state.removeCalls.length >= state.removeFailsOnCall)
				throw state.removeError;
		},
	},
});

const { GET } = await import('./route');

function harness() {
	Object.assign(state, {
		keys: [],
		batches: null,
		claimed: [],
		removeCalls: [],
		removeFailsOnCall: 0,
		dequeueError: null,
		referenced: new Set<string>(),
		pending: 0,
		removeError: null,
		removed: [],
		marked: [],
		dequeued: [],
		events: [],
	});
	return {
		state,
		get: () =>
			GET(
				new Request('https://app.example/api/cron/maintenance', {
					headers: { authorization: 'Bearer test' },
				}) as never,
			),
	};
}

test('maintenance reports reference violations and provider failures while keeping grace-period backlog healthy', async () => {
	await withEnv({ CRON_SECRET: 'test' }, async () => {
		const { state, get } = harness();
		state.pending = 7;
		const idle = await get();
		assert.equal(idle.status, 200);
		assert.equal((await idle.json()).ok, true, 'not-yet-eligible rows do not fail maintenance');

		state.keys = keys;
		state.referenced = new Set([keys[1]]);
		state.pending = 9;
		state.removeError = new Error('provider unavailable');
		const response = await get();
		const body = await response.json();
		assert.equal(response.status, 503);
		assert.deepEqual(state.removed, [keys[0], keys[2]]);
		assert.deepEqual(state.marked, []);
		assert.deepEqual(state.dequeued, [keys[1]]);
		assert.deepEqual(body.privateImageCleanup, {
			attempted: 3,
			completed: 0,
			failed: 2,
			skippedReferenced: 1,
			rescued: 1,
			pending: 9,
			error: 'storage_remove_failed',
		});
		assert.ok(state.events.indexOf('claim') < state.events.indexOf('remove'));

		state.keys = [keys[0], keys[2]];
		state.referenced = new Set();
		state.pending = 0;
		state.removeError = null;
		state.marked = [];
		state.events = [];
		const completed = await get();
		const completedBody = await completed.json();
		assert.equal(completed.status, 200);
		assert.equal(completedBody.privateImageCleanup.completed, 2);
		assert.deepEqual(state.marked, [keys[0], keys[2]]);
		assert.ok(state.events.indexOf('remove') < state.events.indexOf('mark'));

		state.keys = [keys[1]];
		state.referenced = new Set([keys[1]]);
		state.dequeued = [];
		const rescuedOnly = await get();
		const rescuedBody = await rescuedOnly.json();
		assert.equal(rescuedOnly.status, 200, 'a successful rescue is not a maintenance failure');
		assert.equal(rescuedBody.ok, true);
		assert.equal(rescuedBody.privateImageCleanup.rescued, 1);
		assert.deepEqual(state.dequeued, [keys[1]]);
	});
});

const batchOf = (size: number, tag: string) =>
	Array.from({ length: size }, (_, i) => `manawg/${tag}/expense/${i}.jpg`);

test('maintenance drains the private image queue until a short batch', async () => {
	await withEnv({ CRON_SECRET: 'test' }, async () => {
		const { state, get } = harness();
		state.batches = [batchOf(50, 'a'), batchOf(50, 'b'), batchOf(20, 'c'), batchOf(50, 'd')];
		const response = await get();
		const body = await response.json();
		assert.equal(response.status, 200);
		assert.equal(state.removeCalls.length, 3);
		assert.equal(state.events.filter((event) => event === 'claim').length, 3);
		assert.equal(body.privateImageCleanup.attempted, 120);
		assert.equal(body.privateImageCleanup.completed, 120);
	});
});

test('maintenance stops draining after a storage failure', async () => {
	await withEnv({ CRON_SECRET: 'test' }, async () => {
		const { state, get } = harness();
		state.batches = [batchOf(50, 'a'), batchOf(50, 'b'), batchOf(50, 'c')];
		state.removeError = new Error('provider unavailable');
		state.removeFailsOnCall = 2;
		const response = await get();
		const body = await response.json();
		assert.equal(response.status, 503);
		assert.equal(state.events.filter((event) => event === 'claim').length, 2);
		assert.equal(body.privateImageCleanup.failed, 50);
		assert.equal(body.privateImageCleanup.completed, 50);
		assert.equal(body.privateImageCleanup.error, 'storage_remove_failed');
	});
});

test('maintenance stops draining after a failed live-reference rescue', async () => {
	await withEnv({ CRON_SECRET: 'test' }, async () => {
		const { state, get } = harness();
		const first = batchOf(50, 'a');
		state.batches = [first, batchOf(50, 'b')];
		state.referenced = new Set([first[0] as string]);
		state.dequeueError = new Error('db unavailable');
		const body = await (await get()).json();
		assert.equal(state.events.filter((event) => event === 'claim').length, 1);
		assert.equal(body.privateImageCleanup.error, 'live_reference_rescue_failed');
	});
});
