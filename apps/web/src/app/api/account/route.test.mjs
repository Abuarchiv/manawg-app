import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const { ModuleKind, ScriptTarget, transpileModule } = requireFromWeb('typescript');
const routePath = path.join(process.cwd(), 'src/app/api/account/route.ts');
const userId = '12d54242-a3ba-47b9-9254-f152f1e44eb0';
const accountDeletions = { authUserId: 'authUserId', completedAt: 'completedAt' };
const auditEvents = { id: 'id' };

function harness({
	outcome = 'commit-then-throw',
	completedAt = null,
	statusReadFails = false,
} = {}) {
	const state = {
		fenceCommitted: false,
		completedAt,
		statusReads: 0,
		authCompletionAttempts: 0,
		clearedCookies: [],
	};
	const tx = {
		select() {
			let table;
			const query = {
				from(value) {
					table = value;
					return query;
				},
				where() {
					return query;
				},
				limit: async () => {
					assert.equal(table, accountDeletions);
					return state.fenceCommitted ? [{ completedAt: state.completedAt }] : [];
				},
			};
			return query;
		},
		insert(table) {
			return {
				values: async () => {
					assert.equal(table, auditEvents);
				},
			};
		},
	};
	const mocks = {
		'@/core/auth/delete-user': {
			deleteAuthUser: async () => {
				state.authCompletionAttempts += 1;
				return true;
			},
		},
		'@/core/auth/env': {
			getSupabaseEnv: () => ({ url: 'https://auth.example.test' }),
			hasSupabaseEnv: () => true,
		},
		'@/core/auth/server': { getAuthenticatedUser: async () => ({ id: userId }) },
		'@/core/db': { accountDeletions, auditEvents },
		'@/core/db/account-deletion': {
			tryCompleteAccountDeletion: async () => {
				state.authCompletionAttempts += 1;
				return false;
			},
			readAccountDeletionStatusWithFreshConnection: async (authUserId) => {
				assert.equal(authUserId, userId);
				state.statusReads += 1;
				if (statusReadFails) throw new Error('status read unavailable');
				return state.fenceCommitted ? { completedAt: state.completedAt } : null;
			},
		},
		'@/core/db/delete-account': {
			removeAccountFromWgs: async () => {
				state.fenceCommitted = true;
				return { left: [], deletedWgIds: [] };
			},
		},
		'@/core/db/transaction': {
			TransactionAbort: class TransactionAbort extends Error {},
			withTransaction: async (operation) => {
				const result = await operation(tx);
				if (outcome === 'commit-then-throw') {
					throw new Error('connection lost after the server committed');
				}
				if (outcome === 'rollback') {
					state.fenceCommitted = false;
					throw new Error('transaction rolled back');
				}
				return result;
			},
		},
		'@/core/errors': {
			apiError: (message, status, code) => Response.json({ error: message, code }, { status }),
			conflict: (message) => Response.json({ error: message }, { status: 409 }),
			serverError: (message) => Response.json({ error: message }, { status: 500 }),
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'drizzle-orm': { eq: (...parts) => ({ parts }) },
		'next/server': {
			NextResponse: {
				json(body, init) {
					const response = Response.json(body, init);
					Object.defineProperty(response, 'cookies', {
						value: { set: (cookie) => state.clearedCookies.push(cookie) },
					});
					return response;
				},
			},
		},
	};
	const source = readFileSync(routePath, 'utf8');
	const compiled = transpileModule(source, {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(
		(name) => (Object.hasOwn(mocks, name) ? mocks[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-service-role-key';
	const request = new Request('https://example.test/api/account', { method: 'DELETE' });
	Object.defineProperty(request, 'cookies', {
		value: { getAll: () => [{ name: 'sb-test-auth-token', value: 'stale-cookie' }] },
	});
	return { state, deleteAccount: () => module.exports.DELETE(request) };
}

test('committed fence followed by a lost COMMIT acknowledgement returns accepted pending', async () => {
	const { state, deleteAccount } = harness();
	const response = await deleteAccount();
	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), { status: 'pending' });
	assert.equal(state.statusReads, 1);
	assert.equal(state.authCompletionAttempts, 0);
	assert.equal(state.clearedCookies.length, 1);
});

test('completed fence followed by a lost COMMIT acknowledgement returns completed', async () => {
	const { state, deleteAccount } = harness({ completedAt: new Date('2026-09-25T00:00:00.000Z') });
	const response = await deleteAccount();
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: 'completed' });
	assert.equal(state.statusReads, 1);
	assert.equal(state.clearedCookies.length, 1);
});

test('confirmed rollback with no fence returns failure and does not attempt Auth deletion', async () => {
	const { state, deleteAccount } = harness({ outcome: 'rollback' });
	const response = await deleteAccount();
	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: 'account_deletion_failed' });
	assert.equal(state.fenceCommitted, false);
	assert.equal(state.statusReads, 1);
	assert.equal(state.authCompletionAttempts, 0);
	assert.equal(state.clearedCookies.length, 0);
});

test('unavailable fence status check returns an explicit unconfirmed outcome', async () => {
	const { state, deleteAccount } = harness({ statusReadFails: true });
	const response = await deleteAccount();
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), {
		status: 'unknown',
		error: 'account_deletion_outcome_unconfirmed',
	});
	assert.equal(state.statusReads, 1);
	assert.equal(state.authCompletionAttempts, 0);
	assert.equal(state.clearedCookies.length, 0);
});
