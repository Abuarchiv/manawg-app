import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const { ModuleKind, ScriptTarget, transpileModule } = requireFromWeb('typescript');

function loadTypeScriptModule(sourcePath, mocks) {
	const source = readFileSync(path.join(process.cwd(), sourcePath), 'utf8');
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
	return module.exports;
}

function harness({ serverAvailable = true, unsubscribeResult = true } = {}) {
	const events = [];
	let subscriptionActive = true;
	const endpoint = 'https://push.example.test/browser-endpoint';
	const subscription = {
		endpoint,
		unsubscribe: async () => {
			events.push({ type: 'local-unsubscribe' });
			if (unsubscribeResult) subscriptionActive = false;
			return unsubscribeResult;
		},
	};
	const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: {
			serviceWorker: {
				getRegistration: async () => ({
					pushManager: { getSubscription: async () => subscription },
				}),
			},
		},
	});
	const pushSubscriptions = loadTypeScriptModule('src/core/notifications/push-subscribe.ts', {
		'@/core/infra/api-client': {
			apiFetch: async (url, init) => {
				events.push({ type: 'server-unsubscribe', url, init });
				return serverAvailable
					? { ok: true, data: { ok: true } }
					: { ok: false, status: 503, error: 'server_error' };
			},
		},
	});
	const auth = {
		signOut: async () => {
			events.push({ type: 'sign-out' });
			return { error: null };
		},
	};
	const client = loadTypeScriptModule('src/core/auth/client.ts', {
		'@supabase/ssr': { createBrowserClient: () => ({ auth }) },
		'./env': {
			getSupabaseEnv: () => ({ url: 'https://auth.example.test', publishableKey: 'test' }),
		},
		'./next-path': { safeNextPath: (value) => value },
		'@/core/notifications/push-subscribe': pushSubscriptions,
	});
	return {
		client,
		events,
		endpoint,
		isSubscriptionActive: () => subscriptionActive,
		cleanup: () => {
			if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
			else Reflect.deleteProperty(globalThis, 'navigator');
		},
	};
}

test('shared logout retires this browser endpoint before clearing its local subscription and auth', async () => {
	const state = harness();
	try {
		const result = await state.client.signOutSocialAccount([
			{ code: 'ABCD2345', memberId: 'member-a', memberToken: 'token-a' },
			{ code: 'BCDE2345', memberId: 'member-b' },
		]);
		const serverCleanups = state.events.filter((event) => event.type === 'server-unsubscribe');
		assert.equal(serverCleanups.length, 2);
		assert.equal(serverCleanups[0].url, '/api/wg/ABCD2345/notifications');
		assert.equal(serverCleanups[0].init.method, 'POST');
		assert.deepEqual(JSON.parse(serverCleanups[0].init.body), {
			action: 'push_unsubscribe',
			endpoint: state.endpoint,
		});
		assert.equal(serverCleanups[0].init.memberId, 'member-a');
		assert.equal(serverCleanups[0].init.memberToken, 'token-a');
		assert.equal(serverCleanups[1].url, '/api/wg/BCDE2345/notifications');
		assert.equal(JSON.parse(serverCleanups[1].init.body).endpoint, state.endpoint);
		assert.equal(serverCleanups[1].init.memberId, 'member-b');
		assert.equal(state.isSubscriptionActive(), false);
		assert.deepEqual(result, { pushCleanup: 'unsubscribed' });
		assert.equal(state.events.at(-1).type, 'sign-out');
	} finally {
		state.cleanup();
	}
});

test('logout still unsubscribes locally and signs out when the server is offline', async () => {
	const state = harness({ serverAvailable: false });
	try {
		const result = await state.client.signOutSocialAccount([
			{ code: 'ABCD2345', memberId: 'member-a', memberToken: 'token-a' },
		]);
		assert.equal(state.isSubscriptionActive(), false);
		assert.deepEqual(result, { pushCleanup: 'unsubscribed' });
		assert.equal(state.events.at(-1).type, 'sign-out');
	} finally {
		state.cleanup();
	}
});

test('logout reports when browser unsubscribe failed but still clears the auth session', async () => {
	const state = harness({ unsubscribeResult: false });
	try {
		const result = await state.client.signOutSocialAccount([
			{ code: 'ABCD2345', memberId: 'member-a', memberToken: 'token-a' },
		]);
		assert.deepEqual(result, { pushCleanup: 'failed' });
		assert.equal(state.events.at(-1).type, 'sign-out');
		assert.equal(state.isSubscriptionActive(), true);
	} finally {
		state.cleanup();
	}
});
