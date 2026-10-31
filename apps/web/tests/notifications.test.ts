// Push notification contracts: dispatch routing and subscription validation.
// Malformed endpoints/keys must be rejected server-side, transient push failures must not drop subscriptions.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
	type DispatchInput,
	dispatchNotificationSafely,
} from '../src/core/notifications/notification-dispatch';
import {
	pushAuthKeySchema,
	pushEndpointSchema,
	pushP256dhSchema,
} from '../src/core/validators/push-endpoint';

describe('notification dispatch contract', () => {
	const input: DispatchInput = {
		wg: { id: 'wg-id', name: 'Test WG', shareCode: 'test-code' },
		event: 'notification.test',
		payload: {},
	};

	test('returns sent and no warning when delivery succeeds', async () => {
		assert.deepEqual(
			await dispatchNotificationSafely(input, {
				timeoutMs: 100,
				dispatch: async () => ({ sent: 2, failures: [] }),
			}),
			{ sent: 2, warning: null },
		);
	});

	test('returns a failed warning for partial delivery failures', async () => {
		assert.deepEqual(
			await dispatchNotificationSafely(input, {
				timeoutMs: 100,
				dispatch: async () => ({ sent: 1, failures: [new Error('provider failed')] }),
			}),
			{ sent: 1, warning: 'notification_delivery_failed' },
		);
	});

	test('returns an unknown warning when dispatch throws', async () => {
		assert.deepEqual(
			await dispatchNotificationSafely(input, {
				timeoutMs: 100,
				dispatch: async () => {
					throw new Error('provider unavailable');
				},
			}),
			{ sent: 0, warning: 'notification_delivery_unknown' },
		);
	});

	test('returns an unknown warning when dispatch exceeds the total budget', async () => {
		assert.deepEqual(
			await dispatchNotificationSafely(input, {
				timeoutMs: 10,
				dispatch: () => new Promise(() => undefined),
			}),
			{ sent: 0, warning: 'notification_delivery_unknown' },
		);
	});
});

describe('push validator', () => {
	test('push subscription fields reject malformed and oversized values', () => {
		assert.equal(
			pushEndpointSchema.safeParse('https://fcm.googleapis.com/fcm/send/token').success,
			true,
		);
		assert.equal(pushP256dhSchema.safeParse('A'.repeat(87)).success, true);
		assert.equal(pushAuthKeySchema.safeParse('A'.repeat(22)).success, true);
		assert.equal(pushP256dhSchema.safeParse('A'.repeat(86)).success, false);
		assert.equal(pushAuthKeySchema.safeParse('A'.repeat(23)).success, false);
		assert.equal(pushAuthKeySchema.safeParse('!'.repeat(22)).success, false);
	});
});
