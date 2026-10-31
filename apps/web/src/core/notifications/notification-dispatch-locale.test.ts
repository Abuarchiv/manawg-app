import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { withEnv } from '../../../tests/support/env';

const pushSubscriptions = { __table: 'push_subscriptions' };
const wgMembers = { __table: 'wg_members' };
const sent: { endpoint: string; payload: { title: string; body: string; url: string } }[] = [];

mock.module('@/core/db', {
	namedExports: {
		pushSubscriptions,
		wgMembers,
		db: {
			select: () => ({
				from: (table: unknown) => ({
					where: async () =>
						table === wgMembers
							? [member('m-de', 'de'), member('m-en', 'en'), member('m-old', undefined)]
							: [
									{
										id: 's',
										endpoint: 'https://push.test',
										p256dh: 'p',
										authKey: 'a',
										createdAt: new Date(0),
									},
								],
				}),
			}),
		},
	},
});
mock.module('web-push', {
	namedExports: {
		setVapidDetails: () => {},
		sendNotification: async (sub: { endpoint: string }, body: string) => {
			sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body) });
		},
	},
});

const { dispatchNotification } = await import('./notification-dispatch');

function member(id: string, locale: string | undefined) {
	return {
		id,
		locale,
		deactivatedAt: null,
		pushOptIn: true,
		notifyExpenses: true,
		quietStartHour: null,
		quietEndHour: null,
	};
}

test('each recipient gets the push text in their own locale', async () => {
	await withEnv(
		{
			NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'public',
			VAPID_PRIVATE_KEY: 'private',
			VAPID_SUBJECT: 'mailto:ops@example.test',
		},
		async () => {
			const result = await dispatchNotification({
				wg: { id: 'wg-1', name: 'Flat', shareCode: 'ABC' },
				event: 'expense.payment_voided',
				payload: { actorName: 'Anna', amountCents: 1250, currency: 'EUR' },
			});
			assert.equal(result.sent, 3);
		},
	);
	const titles = sent.map((entry) => entry.payload.title).sort();
	assert.deepEqual(titles, [
		'Barzahlung storniert',
		'Barzahlung storniert',
		'Cash payment reversed',
	]);
	const english = sent.find((entry) => entry.payload.title === 'Cash payment reversed');
	assert.equal(
		english?.payload.body,
		'Anna reversed the cash payment of €12.50. The amount is open again.',
	);
	assert.equal(english?.payload.url, '/wg/ABC/expenses');
});
