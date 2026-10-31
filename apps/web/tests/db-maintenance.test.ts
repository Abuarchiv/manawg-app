import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// One mutable harness serves both tests; each test resets the parts it uses.
const harness = {
	pools: [] as Array<{ url: string; ended: boolean }>,
	commitError: null as Error | null,
	attempts: 0,
	deleteError: null as Error | null,
	purgeCalls: 0,
	purgeRowCounts: [] as number[],
	imageCleanupRuns: 0,
	retentionPurges: 0,
	retentionError: null as Error | null,
	recoveryCalls: [] as unknown[],
	recoveryResult: { attempted: 1, completed: 0, failed: 1, pending: 1 },
};

mock.module('pg', {
	namedExports: {
		Pool: class {
			url: string;
			ended = false;
			constructor({ connectionString }: { connectionString: string }) {
				this.url = connectionString;
				harness.pools.push(this);
			}
			on() {}
			async end() {
				this.ended = true;
			}
		},
	},
});
mock.module('drizzle-orm/node-postgres', {
	namedExports: {
		drizzle: (pool: { url: string }) => ({
			readUrl: () => pool.url,
			transaction: async (fn: (tx: { url: string }) => unknown) => {
				harness.attempts += 1;
				const result = await fn({ url: pool.url });
				if (harness.commitError) throw harness.commitError;
				return result;
			},
		}),
	},
});

const { db: realDb, withTransaction } = (await import('../src/core/db/index.ts')) as unknown as {
	db: { readUrl: () => string };
	withTransaction: <T>(fn: (tx: { url: string }) => T) => Promise<T>;
};

test('queries and transactions share one pool that follows URL changes without retrying unknown commits', async () => {
	const env = process.env;
	env.POSTGRES_URL = 'postgres://localhost/database_a';
	const transactionUrl = () => withTransaction((tx) => tx.url);
	const { pools } = harness;
	assert.equal(realDb.readUrl(), await transactionUrl());
	assert.equal(pools.length, 1);
	env.POSTGRES_URL = 'postgres://localhost/database_b';
	assert.equal(realDb.readUrl(), await transactionUrl());
	assert.equal(pools.length, 2);
	assert.ok(pools[0]?.ended && !pools[1]?.ended);

	// Direct-connection variables belong to migrations; runtime transactions stay on the pool.
	env.DATABASE_URL_UNPOOLED = 'postgres://localhost/direct_a';
	env.POSTGRES_URL_NON_POOLING = 'postgres://localhost/direct_b';
	assert.equal(await transactionUrl(), realDb.readUrl());
	assert.equal(pools.length, 2);
	env.POSTGRES_URL = '';
	env.DATABASE_URL = 'postgres://localhost/database_c';
	assert.equal(realDb.readUrl(), await transactionUrl());
	assert.equal(pools.length, 3);

	const commitError = new Error('connection lost after COMMIT');
	harness.commitError = commitError;
	const attemptsBefore = harness.attempts;
	await assert.rejects(transactionUrl(), (error) => error === commitError);
	assert.equal(harness.attempts, attemptsBefore + 1);
	harness.commitError = null;
});

const noop = () => {};
mock.module('drizzle-orm', {
	namedExports: { and: noop, eq: noop, gt: noop, lte: noop, or: noop, sql: noop },
});
mock.module('@/core/db', {
	namedExports: {
		idempotencyResponses: {},
		mailLog: {},
		db: {
			execute: async () => {
				if (harness.deleteError) throw harness.deleteError;
				harness.purgeCalls += 1;
				return { rowCount: harness.purgeRowCounts.shift() ?? 1 };
			},
		},
	},
});
mock.module('@/core/guards/api-auth', { namedExports: { UUID_PATTERN: /./ } });
mock.module('@/core/auth/supabase-env', {
	namedExports: { hasSupabaseEnv: () => false, getSupabaseEnv: () => null },
});
mock.module('@/core/auth/delete-user', { namedExports: { deleteAuthUser: async () => false } });
mock.module('@/core/db/account-deletion', {
	namedExports: {
		retryPendingAccountDeletions: async (deleteAuth: unknown) => {
			harness.recoveryCalls.push(deleteAuth);
			return harness.recoveryResult;
		},
	},
});
mock.module('@/core/db/private-image-deletions', {
	namedExports: {
		CLEANUP_BATCH_SIZE: 50,
		claimPrivateImageCleanupBatch: async () => {
			harness.imageCleanupRuns++;
			return [];
		},
		countPendingPrivateImageDeletions: async () => 0,
		dequeueImageDeletions: async () => undefined,
		findLivePrivateImageReferenceKeys: async () => new Set(),
		markPrivateImageStorageDeleted: async () => undefined,
		purgeFinishedPrivateImageDeletions: async () => {
			harness.retentionPurges++;
			if (harness.retentionError) throw harness.retentionError;
			return 0;
		},
	},
});
mock.module('@/core/mail/mail-retention', {
	namedExports: {
		purgeOldMailLog: async () => {
			harness.retentionPurges++;
			return 0;
		},
	},
});
mock.module('@/core/infra/cron-auth', { namedExports: { requireCronSecret: () => null } });
mock.module('@/core/infra/sentry', {
	namedExports: { captureSentryException() {}, logSentryApiError() {} },
});
mock.module('@/core/db/orphan-uploads', { namedExports: { sweepOrphanUploads: async () => null } });
mock.module('@/core/infra/supabase-storage', {
	namedExports: {
		removeSupabaseImages: async () => undefined,
	},
});

const route = await import('../src/app/api/cron/maintenance/route.ts');

test('maintenance attempts deletion recovery when idempotency cleanup fails', async () => {
	const logs: unknown[][] = [];
	mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
	mock.method(console, 'warn', () => {});
	harness.deleteError = new Error('database unavailable');
	harness.imageCleanupRuns = 0;
	harness.recoveryCalls = [];
	harness.recoveryResult = { attempted: 1, completed: 0, failed: 1, pending: 1 };
	const request = new Request('https://example.com/api/cron/maintenance') as never;
	const failedCleanup = await route.GET(request);
	assert.equal(failedCleanup.status, 503);
	assert.deepEqual(await failedCleanup.json(), {
		ok: false,
		purgedIdempotencyRows: null,
		orphanUploads: null,
		accountDeletions: { ...harness.recoveryResult, authAdminAvailable: false },
		privateImageCleanup: {
			attempted: 0,
			completed: 0,
			failed: 0,
			skippedReferenced: 0,
			rescued: 0,
			pending: 0,
			error: null,
		},
	});
	assert.equal(harness.recoveryCalls.length, 1);
	assert.equal(harness.recoveryCalls[0], null);
	assert.equal(harness.imageCleanupRuns, 1);
	assert.deepEqual(logs.at(-1), ['[maintenance] idempotency cleanup failed', 'Error']);
	harness.deleteError = null;
	harness.recoveryResult = { attempted: 1, completed: 1, failed: 0, pending: 0 };
	const response = await route.GET(request);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		ok: true,
		purgedIdempotencyRows: 1,
		orphanUploads: null,
		accountDeletions: { ...harness.recoveryResult, authAdminAvailable: false },
		privateImageCleanup: {
			attempted: 0,
			completed: 0,
			failed: 0,
			skippedReferenced: 0,
			rescued: 0,
			pending: 0,
			error: null,
		},
	});
	assert.equal(harness.recoveryCalls.length, 2);
	assert.equal(harness.imageCleanupRuns, 2);
});

test('maintenance runs the retention purges and a failing purge does not change the result', async () => {
	mock.method(console, 'error', () => {});
	harness.deleteError = null;
	harness.recoveryResult = { attempted: 0, completed: 0, failed: 0, pending: 0 };
	harness.retentionPurges = 0;
	harness.retentionError = new Error('database unavailable');
	const response = await route.GET(
		new Request('https://example.com/api/cron/maintenance') as never,
	);
	assert.equal(harness.retentionPurges, 2);
	assert.equal(response.status, 200);
	harness.retentionError = null;
});

test('idempotency purge deletes in batches until a batch comes back short', async () => {
	const { purgeExpiredIdempotencyResponses } = await import('../src/core/idempotency-store.ts');
	harness.purgeCalls = 0;
	harness.purgeRowCounts = [5000, 5000, 7];
	assert.equal(await purgeExpiredIdempotencyResponses(), 10_007);
	assert.equal(harness.purgeCalls, 3);
});
