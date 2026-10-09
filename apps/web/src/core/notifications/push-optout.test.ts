import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

const calls: Array<{ url: string; body: string }> = [];
let responses: unknown[] = [];

mock.module('@/core/infra/api-client', {
	namedExports: {
		apiFetch: async (url: string, init: { body?: string }) => {
			calls.push({ url, body: init.body ?? '' });
			return responses.shift() ?? { ok: true, data: { ok: true } };
		},
	},
});

const { isPushOptedOut, shouldAutoResubscribePush } = await import('./push-priming');
const { subscribeWebPush, unsubscribeWebPush } = await import('./push-subscribe');

const store = new Map<string, string>();
const localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
};

function makeSubscription(endpoint: string, log: string[]) {
	return {
		endpoint,
		toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
		unsubscribe: async () => {
			log.push(`unsubscribe:${endpoint}`);
			return true;
		},
	};
}

function setBrowser(opts: { existing: ReturnType<typeof makeSubscription> | null; log: string[] }) {
	let current = opts.existing;
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			localStorage,
			Notification: { permission: 'granted', requestPermission: async () => 'granted' },
			PushManager: {},
			atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
		},
	});
	Object.defineProperty(globalThis, 'Notification', {
		configurable: true,
		value: { permission: 'granted', requestPermission: async () => 'granted' },
	});
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: {
			serviceWorker: {
				ready: Promise.resolve({
					pushManager: {
						getSubscription: async () => current,
						subscribe: async () => {
							current = makeSubscription('https://push.example.test/new', opts.log);
							opts.log.push('subscribe');
							return current;
						},
					},
				}),
			},
		},
	});
	process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'AAAA';
}

afterEach(() => {
	calls.length = 0;
	responses = [];
	store.clear();
	for (const key of ['window', 'navigator', 'Notification'])
		Reflect.deleteProperty(globalThis, key);
});

test('auto resubscribe respects an explicit opt-out', () => {
	const base = { supported: true, configured: true, permission: 'granted' as const };
	assert.equal(
		shouldAutoResubscribePush({ ...base, hasSubscription: false, optedOut: false }),
		true,
	);
	assert.equal(
		shouldAutoResubscribePush({ ...base, hasSubscription: false, optedOut: true }),
		false,
	);
});

test('opt-out is remembered after turning push off and cleared after turning it on', async () => {
	const log: string[] = [];
	setBrowser({ existing: makeSubscription('https://push.example.test/old', log), log });
	await unsubscribeWebPush('CODE', 'member-a');
	assert.equal(isPushOptedOut('member-a'), true);
	await subscribeWebPush('CODE', 'member-a');
	assert.equal(isPushOptedOut('member-a'), false);
});

test('turning push off on a device without subscription sends no wipe-all PATCH', async () => {
	setBrowser({ existing: null, log: [] });
	await unsubscribeWebPush('CODE', 'member-a');
	assert.equal(calls.length, 0);
	assert.equal(isPushOptedOut('member-a'), true);
});

test('endpoint owned by another account: resubscribes with a fresh endpoint once', async () => {
	const log: string[] = [];
	setBrowser({ existing: makeSubscription('https://push.example.test/old', log), log });
	responses = [
		{ ok: false, status: 403, error: 'endpoint_owned' },
		{ ok: true, data: { ok: true } },
	];
	await subscribeWebPush('CODE', 'member-a');
	assert.deepEqual(log, ['unsubscribe:https://push.example.test/old', 'subscribe']);
	assert.equal(calls.length, 2);
	assert.match(calls[1]?.body ?? '', /push\.example\.test\/new/);
});
