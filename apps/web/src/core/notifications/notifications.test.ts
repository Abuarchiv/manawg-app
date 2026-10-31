import assert from 'node:assert/strict';
import test from 'node:test';
import { withEnv } from '../../../tests/support/env';
import {
	formatNotificationMessage,
	notificationCategoryForEvent,
	notificationPriorityForEvent,
} from './notifications';

test('event notification times use Europe/Berlin in summer and winter', () => {
	withEnv({ TZ: 'UTC' }, () => {
		const summer = formatNotificationMessage('event.upcoming', {
			wgName: 'WG',
			title: 'Treffen',
			startsAt: '2026-07-01T18:00:00.000Z',
		});
		const winter = formatNotificationMessage('event.created', {
			wgName: 'WG',
			title: 'Treffen',
			startsAt: '2026-01-01T18:00:00.000Z',
		});
		const today = formatNotificationMessage('event.today', {
			wgName: 'WG',
			title: 'Treffen',
			startsAt: '2026-01-01T18:00:00.000Z',
		});
		const allDay = formatNotificationMessage('event.today', {
			wgName: 'WG',
			title: 'Feiertag',
			startsAt: '2026-01-01T23:00:00.000Z',
			allDay: true,
		});
		const ongoing = formatNotificationMessage('event.today', {
			wgName: 'WG',
			title: 'Nachtfahrt',
			startsAt: '2026-01-01T23:00:00.000Z',
			ongoing: true,
		});

		assert.match(summer.body, /01\.07\., 20:00/);
		assert.match(winter.body, /01\.01\., 19:00/);
		assert.equal(today.title, 'Termin heute');
		assert.match(today.body, /^Heute in WG:/);
		assert.match(allDay.body, /ist ganztägig/);
		assert.doesNotMatch(allDay.body, /23:00|00:00/);
		assert.match(ongoing.body, /läuft noch/);
	});
});

test('German timed event reminders never put a date into an "um" slot', () => {
	withEnv({ TZ: 'UTC' }, () => {
		for (const event of ['event.upcoming', 'event.today'] as const) {
			const { body } = formatNotificationMessage(event, {
				wgName: 'WG',
				title: 'Plenum',
				startsAt: '2026-11-03T18:00:00.000Z',
			});
			assert.match(body, /am 03\.11\., 19:00/);
			assert.doesNotMatch(body, /um \d{2}\.\d{2}\./);
		}
	});
});

test('all-day event pushes show the Berlin date without a clock time', () => {
	withEnv({ TZ: 'UTC' }, () => {
		// All-day events are stored at Berlin midnight (22:00/23:00 UTC the day before).
		const created = formatNotificationMessage('event.created', {
			wgName: 'WG',
			actorName: 'Alex',
			title: 'Umzug',
			startsAt: '2026-09-30T22:00:00.000Z',
			allDay: true,
		});
		const upcoming = formatNotificationMessage('event.upcoming', {
			wgName: 'WG',
			title: 'Feiertag',
			startsAt: '2026-01-01T23:00:00.000Z',
			allDay: true,
		});

		assert.equal(created.body, 'Alex hat in WG „Umzug“ am 01.10. (ganztägig) eingetragen.');
		assert.equal(upcoming.body, 'Morgen in WG: „Feiertag“ am 02.01. (ganztägig).');
		for (const message of [created, upcoming]) {
			assert.doesNotMatch(message.body, /\d{2}:\d{2}/);
		}
	});
});

test('chore.due copy follows the Berlin day distance to nextDueAt', (t) => {
	// 2026-09-29 23:30 Berlin (21:30 UTC) — still the 29th on the Berlin wall clock.
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-29T21:30:00.000Z') });
	const body = (nextDueAt: string | undefined) =>
		formatNotificationMessage('chore.due', { wgName: 'WG', title: 'Bad putzen', nextDueAt }).body;

	assert.equal(body('2026-09-29T08:00:00.000Z'), 'Bad putzen ist heute in WG fällig.');
	assert.equal(body('2026-09-29T22:30:00.000Z'), 'Bad putzen ist morgen in WG fällig.');
	assert.equal(body('2026-09-28T08:00:00.000Z'), 'Bad putzen ist in WG seit 1 Tag offen.');
	assert.equal(body('2026-09-24T08:00:00.000Z'), 'Bad putzen ist in WG seit 5 Tagen offen.');
	assert.equal(body('2026-10-03T08:00:00.000Z'), 'Bad putzen ist am 03.10. in WG fällig.');
	assert.equal(body(undefined), 'Bad putzen ist heute in WG fällig.');
});

test('chore.due copy names the missing assignee for unassigned chores', (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-29T09:00:00.000Z') });
	assert.equal(
		formatNotificationMessage('chore.due', {
			wgName: 'WG',
			title: 'Bad putzen',
			nextDueAt: '2026-09-29T08:00:00.000Z',
			unassigned: true,
		}).body,
		'Bad putzen ist heute in WG fällig. Niemand ist zuständig.',
	);
});

test('moved and cancelled event pushes name the actor and follow the calendar preference', () => {
	withEnv({ TZ: 'UTC' }, () => {
		const base = {
			wgName: 'WG',
			actorName: 'Alex',
			title: 'Plenum',
			startsAt: '2026-01-01T18:00:00.000Z',
			eventId: 'e1',
		};
		const moved = formatNotificationMessage('event.moved', base);
		const cancelled = formatNotificationMessage('event.cancelled', base);
		const series = formatNotificationMessage('event.moved', { ...base, recurring: true });
		const seriesCancelled = formatNotificationMessage('event.cancelled', {
			...base,
			recurring: true,
		});
		const gone = formatNotificationMessage('event.cancelled', { ...base, eventId: undefined });

		assert.equal(moved.title, 'Termin verschoben');
		assert.equal(moved.body, 'Alex hat „Plenum“ in WG auf den 01.01., 19:00 verschoben.');
		assert.equal(moved.urlPath, '/calendar?highlight=e1');
		assert.equal(cancelled.title, 'Termin abgesagt');
		assert.equal(cancelled.body, 'Alex hat „Plenum“ am 01.01., 19:00 in WG abgesagt.');
		assert.equal(series.body, 'Alex hat die Terminserie „Plenum“ in WG verschoben.');
		assert.equal(seriesCancelled.body, 'Alex hat die Terminserie „Plenum“ in WG abgesagt.');
		assert.equal(gone.urlPath, '/calendar');
		for (const event of ['event.moved', 'event.cancelled'] as const) {
			assert.equal(notificationCategoryForEvent(event), 'events');
			assert.equal(notificationPriorityForEvent(event), 'normal');
		}
	});
});

test('low-stock push shows German decimals', () => {
	const message = formatNotificationMessage('inventory.low_stock', {
		title: 'Milch',
		quantity: 0.5,
		threshold: 1,
		wgName: 'WG',
	});
	assert.ok(message.body.includes('(0,5 von 1)'));
});

test('a voided cash payment tells the other side that the amount is open again', () => {
	const message = formatNotificationMessage('expense.payment_voided', {
		wgName: 'WG',
		actorName: 'Anna',
		amountCents: 1250,
		currency: 'EUR',
	});
	assert.equal(message.title, 'Barzahlung storniert');
	assert.match(
		message.body,
		/^Anna hat die Barzahlung über 12,50\s€ storniert\. Der Betrag ist wieder offen\.$/,
	);
	assert.equal(notificationCategoryForEvent('expense.payment_voided'), 'expenses');
});

test('English pushes use the catalog, en-GB money and Berlin dates', (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-29T09:00:00.000Z') });
	const en = (event: Parameters<typeof formatNotificationMessage>[0], payload = {}) =>
		formatNotificationMessage(event, { wgName: 'Flat', actorName: 'Anna', ...payload }, 'en');

	const created = en('expense.created', { title: 'Pizza', amountCents: 1250, currency: 'EUR' });
	assert.equal(created.title, 'New expense');
	assert.equal(created.body, 'Anna added Pizza for €12.50 in Flat.');
	assert.equal(
		en('chore.due', { title: 'Bathroom', nextDueAt: '2026-09-24T08:00:00.000Z' }).body,
		'Bathroom has been open in Flat for 5 days.',
	);
	assert.equal(
		en('chore.due', { title: 'Bathroom', nextDueAt: '2026-10-03T08:00:00.000Z', unassigned: true })
			.body,
		'Bathroom is due on 3 Oct in Flat. Nobody is assigned.',
	);
	assert.equal(
		en('event.created', { title: 'Plenum', startsAt: '2026-01-01T18:00:00.000Z' }).body,
		'Anna added “Plenum” in Flat on 1 Jan, 19:00.',
	);
	assert.equal(en('import.completed', { inserted: 1 }).body, 'Anna imported 1 expense into Flat.');
	assert.equal(
		en('inventory.low_stock', { title: 'Milk', quantity: 0.5, threshold: 1 }).body,
		'Running low in Flat: Milk (0.5 of 1).',
	);
	assert.equal(
		en('event.today', { title: 'Plenum', startsAt: '2026-01-01T18:00:00.000Z' }).body,
		'Today in Flat: “Plenum”, 1 Jan, 19:00.',
	);
	assert.equal(en('chat.mention', { preview: 'Hi' }).title, 'Anna mentioned you');
	assert.equal(
		formatNotificationMessage('notification.test', {}, 'en').body,
		'Notifications are working for your flat.',
	);
});

test('every event has a complete message in both locales', () => {
	const events = [
		'expense.created',
		'expense.recurring_charged',
		'expense.reminder',
		'expense.debt_settled',
		'expense.payment_voided',
		'import.completed',
		'notification.test',
		'announcement.posted',
		'announcement.commented',
		'announcement.resolved',
		'chore.due',
		'shopping.added',
		'event.created',
		'event.moved',
		'event.cancelled',
		'event.upcoming',
		'event.today',
		'inventory.low_stock',
		'chat.message',
		'chat.mention',
	] as const;
	for (const event of events) {
		for (const locale of ['de', 'en'] as const) {
			const message = formatNotificationMessage(event, {}, locale);
			assert.ok(message.title.length > 0 && message.body.length > 0, `${event} ${locale}`);
			assert.doesNotMatch(message.body, /\{|undefined|NaN/, `${event} ${locale}`);
		}
	}
});

test('counts of 1000 or more stay ungrouped', () => {
	assert.match(
		formatNotificationMessage('import.completed', { inserted: 1000 }, 'de').body,
		/ 1000 Ausgaben /,
	);
	assert.match(
		formatNotificationMessage(
			'expense.reminder',
			{ oldestDebtAgeDays: 1000, amountFormatted: '1 €' },
			'de',
		).body,
		/1000 Tage alt/,
	);
	assert.doesNotMatch(
		formatNotificationMessage('chore.due', { nextDueAt: '2020-01-01T10:00:00.000Z' }, 'de').body,
		/\d\.\d{3}/,
	);
});
