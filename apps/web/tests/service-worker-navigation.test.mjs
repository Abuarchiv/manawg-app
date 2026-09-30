import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const APP_ORIGIN = 'https://app.manawg.test';
const TARGET = `${APP_ORIGIN}/ausgaben?highlight=new#message-1`;
const serviceWorkerSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

async function clickNotification(url, windows) {
	const handlers = new Map();
	const opened = [];
	const self = {
		location: { origin: APP_ORIGIN },
		addEventListener: (type, handler) => handlers.set(type, handler),
	};
	const clients = {
		matchAll: async () => windows,
		openWindow: async (target) => {
			opened.push(target);
			return null;
		},
	};
	vm.runInNewContext(serviceWorkerSource, { clients, self, URL });

	let completion;
	handlers.get('notificationclick')({
		notification: { data: { url }, close() {} },
		waitUntil: (promise) => {
			completion = promise;
		},
	});
	await completion;
	return opened;
}

test('navigates a same-path window to the notification query and fragment before focusing', async () => {
	const calls = [];
	const windowClient = {
		url: `${APP_ORIGIN}/ausgaben?highlight=old`,
		focus: async () => calls.push(['focus', windowClient.url]),
		navigate: async (target) => {
			calls.push(['navigate', target]);
			windowClient.url = target;
			return windowClient;
		},
	};

	const opened = await clickNotification('/ausgaben?highlight=new#message-1', [windowClient]);

	assert.deepEqual(calls, [
		['navigate', TARGET],
		['focus', TARGET],
	]);
	assert.deepEqual(opened, []);
});

test('focuses an exact full-URL match without navigating', async () => {
	const calls = [];
	const windowClient = {
		url: TARGET,
		focus: async () => calls.push('focus'),
		navigate: async () => calls.push('navigate'),
	};

	const opened = await clickNotification('/ausgaben?highlight=new#message-1', [windowClient]);

	assert.deepEqual(calls, ['focus']);
	assert.deepEqual(opened, []);
});

for (const result of ['null', 'reject']) {
	test(`opens the target when a matching tab ${result === 'null' ? 'closes' : 'cannot navigate'}`, async () => {
		const calls = [];
		const windowClient = {
			url: `${APP_ORIGIN}/ausgaben?highlight=old`,
			focus: async () => calls.push('focus'),
			navigate: async () => {
				calls.push('navigate');
				if (result === 'reject') throw new Error('window closed');
				return null;
			},
		};

		const opened = await clickNotification('/ausgaben?highlight=new#message-1', [windowClient]);

		assert.deepEqual(calls, ['navigate']);
		assert.deepEqual(opened, [TARGET]);
	});
}

test('does not navigate to a foreign target and opens the app root', async () => {
	const calls = [];
	const windowClient = {
		url: `${APP_ORIGIN}/ausgaben?highlight=old`,
		focus: async () => calls.push('focus'),
		navigate: async () => calls.push('navigate'),
	};

	const opened = await clickNotification(
		'https://foreign.example/ausgaben?highlight=new#message-1',
		[windowClient],
	);

	assert.deepEqual(calls, []);
	assert.deepEqual(opened, ['/']);
});
