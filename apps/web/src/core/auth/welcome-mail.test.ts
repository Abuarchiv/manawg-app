import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { User } from '@supabase/supabase-js';

const sent: Array<{ mail: { subject: string } }> = [];
mock.module('@/core/infra/after-response', {
	namedExports: { afterResponse: (task: () => Promise<unknown>) => void task() },
});
mock.module('@/core/mail/send-mail', {
	namedExports: {
		sendMailSafely: async (input: { mail: { subject: string } }) => {
			sent.push(input);
		},
	},
});
const { queueWelcomeMail } = await import('./welcome-mail');
const { renderWelcomeMail } = await import('@/core/mail/templates');

const newUser = (locale: unknown, createdAt = new Date()): User =>
	({
		id: 'u1',
		email: 'a@example.test',
		email_confirmed_at: new Date().toISOString(),
		created_at: createdAt.toISOString(),
		user_metadata: { full_name: 'Anna', locale },
	}) as unknown as User;

test('the welcome mail uses the language stored at sign-up, not the one of the opening browser', () => {
	sent.length = 0;
	queueWelcomeMail(newUser('en'), 'de');
	assert.equal(
		sent[0]?.mail.subject,
		renderWelcomeMail({ firstName: 'Anna', locale: 'en' }).subject,
	);
});

test('the request language is the fallback when the account stores none', () => {
	sent.length = 0;
	queueWelcomeMail(newUser(undefined), 'en');
	assert.equal(
		sent[0]?.mail.subject,
		renderWelcomeMail({ firstName: 'Anna', locale: 'en' }).subject,
	);
});

test('a sign-up confirmed days later still gets the welcome mail', () => {
	sent.length = 0;
	queueWelcomeMail(newUser('de', new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)), 'de');
	assert.equal(sent.length, 1);
});
