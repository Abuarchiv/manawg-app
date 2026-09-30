import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routePath = path.join(process.cwd(), 'src/app/api/cron/maintenance/route.ts');
const keys = [
	'manawg/11111111-1111-4111-8111-111111111111/expense/22222222-2222-4222-8222-222222222222.jpg',
	'manawg/11111111-1111-4111-8111-111111111111/expense/33333333-3333-4333-8333-333333333333.jpg',
	'manawg/11111111-1111-4111-8111-111111111111/announcement/44444444-4444-4444-8444-444444444444.png',
];

function harness() {
	const state = {
		keys: [],
		referenced: new Set(),
		pending: 0,
		removeError: null,
		removed: [],
		marked: [],
		events: [],
	};
	const source = transpileModule(readFileSync(routePath, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	class NextResponse extends Response {
		static json(body, init) {
			return Response.json(body, init);
		}
	}
	const overrides = {
		'@/core/auth/delete-user': { deleteAuthUser: async () => true },
		'@/core/auth/env': { getSupabaseEnv: () => null, hasSupabaseEnv: () => false },
		'@/core/db/account-deletion': {
			retryPendingAccountDeletions: async (deleteAuthUser) => {
				assert.equal(deleteAuthUser, null);
				return { attempted: 0, completed: 0, failed: 0, pending: 0 };
			},
		},
		'@/core/db/private-image-deletions': {
			claimPrivateImageCleanupBatch: async () => {
				state.events.push('claim');
				return state.keys;
			},
			findLivePrivateImageReferenceKeys: async (objectKeys) => {
				state.events.push('references');
				assert.deepEqual(objectKeys, state.keys);
				return state.referenced;
			},
			markPrivateImageStorageDeleted: async (objectKeys) => {
				state.events.push('mark');
				state.marked = objectKeys;
			},
			countPendingPrivateImageDeletions: async () => {
				state.events.push('pending');
				return state.pending;
			},
		},
		'@/core/idempotency': {
			purgeExpiredIdempotencyResponses: async () => 0,
		},
		'@/core/infra/cron-auth': { verifyCronSecret: () => true },
		'@/core/infra/observability': {
			logApiError: (message) => state.events.push(`log:${message}`),
			withCronLogging: (_name, handler) => handler,
		},
		'@/core/infra/supabase-storage': {
			removeSupabaseImages: async (objectKeys) => {
				state.events.push('remove');
				state.removed = objectKeys;
				if (state.removeError) throw state.removeError;
			},
		},
		'next/server': { NextResponse },
	};
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return {
		state,
		get: () =>
			loaded.exports.GET(
				new Request('https://app.example/api/cron/maintenance', {
					headers: { authorization: 'Bearer test' },
				}),
			),
	};
}

test('maintenance reports reference violations and provider failures while keeping grace-period backlog healthy', async () => {
	const previousSecret = process.env.CRON_SECRET;
	process.env.CRON_SECRET = 'test';
	try {
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
		assert.deepEqual(body.privateImageCleanup, {
			attempted: 3,
			completed: 0,
			failed: 2,
			skippedReferenced: 1,
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
	} finally {
		if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'CRON_SECRET');
		else process.env.CRON_SECRET = previousSecret;
	}
});
