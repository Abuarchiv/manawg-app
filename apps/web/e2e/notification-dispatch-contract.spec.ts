import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, test } from '@playwright/test';
import {
	type DispatchInput,
	dispatchNotificationSafely,
} from '../src/core/notifications/notification-dispatch';

const input: DispatchInput = {
	wg: { id: 'wg-id', name: 'Test WG', shareCode: 'test-code' },
	event: 'notification.test',
	payload: {},
};

test('returns sent and no warning when delivery succeeds', async () => {
	await expect(
		dispatchNotificationSafely(input, {
			timeoutMs: 100,
			dispatch: async () => ({ sent: 2, failures: [] }),
		}),
	).resolves.toEqual({ sent: 2, warning: null });
});

test('returns a failed warning for partial delivery failures', async () => {
	await expect(
		dispatchNotificationSafely(input, {
			timeoutMs: 100,
			dispatch: async () => ({ sent: 1, failures: [new Error('provider failed')] }),
		}),
	).resolves.toEqual({ sent: 1, warning: 'notification_delivery_failed' });
});

test('returns an unknown warning when dispatch throws', async () => {
	await expect(
		dispatchNotificationSafely(input, {
			timeoutMs: 100,
			dispatch: async () => {
				throw new Error('provider unavailable');
			},
		}),
	).resolves.toEqual({ sent: 0, warning: 'notification_delivery_unknown' });
});

test('returns an unknown warning when dispatch exceeds the total budget', async () => {
	await expect(
		dispatchNotificationSafely(input, {
			timeoutMs: 10,
			dispatch: () => new Promise(() => undefined),
		}),
	).resolves.toEqual({ sent: 0, warning: 'notification_delivery_unknown' });
});

async function clickWorkerNotification(
	existingUrl: string,
	notificationUrl: string,
): Promise<string[]> {
	const actions: string[] = [];
	let onNotificationClick: ((event: unknown) => void) | undefined;
	let pending: Promise<unknown> | undefined;
	const existingWindow = {
		url: existingUrl,
		navigate: async (url: string) => {
			actions.push(`navigate ${url}`);
			existingWindow.url = url;
			return existingWindow;
		},
		focus: async () => {
			actions.push(`focus ${existingWindow.url}`);
			return existingWindow;
		},
	};
	const clients = {
		matchAll: async () => [existingWindow],
		openWindow: async (url: string) => {
			actions.push(`open ${url}`);
			return null;
		},
	};
	const self = {
		location: { origin: 'https://example.test' },
		addEventListener(name: string, handler: (event: unknown) => void) {
			if (name === 'notificationclick') onNotificationClick = handler;
		},
	};
	runInNewContext(readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8'), {
		self,
		clients,
		URL,
	});
	onNotificationClick?.({
		notification: { close() {}, data: { url: notificationUrl } },
		waitUntil(operation: Promise<unknown>) {
			pending = operation;
		},
	});
	await pending;
	return actions;
}

test('notification click navigates a matching same-origin window before focusing it', async () => {
	const target = 'https://example.test/wg/ABCD/pinnwand?highlight=event#announcement-new';
	await expect(
		clickWorkerNotification('https://example.test/wg/ABCD/pinnwand#announcement-old', target),
	).resolves.toEqual([`navigate ${target}`, `focus ${target}`]);
});

test('notification click never navigates an existing window to an external URL', async () => {
	await expect(
		clickWorkerNotification(
			'https://example.test/wg/ABCD/pinnwand#announcement-old',
			'https://evil.example/wg/ABCD/pinnwand#announcement-new',
		),
	).resolves.toEqual(['open /']);
});
