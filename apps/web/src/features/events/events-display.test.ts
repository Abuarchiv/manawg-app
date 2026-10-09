import assert from 'node:assert/strict';
import test from 'node:test';

const { getMonthBounds, formatEventTimeOfDay } = await import('./events');
const { occurrenceToIcs, calendarFeedToIcs } = await import('./ics');

const DAY = 24 * 60 * 60 * 1000;

test('month bounds cover the leading and trailing days of the visible grid', () => {
	// October 2026 starts on a Thursday and ends on a Saturday: the grid runs 28 Sep to 1 Nov.
	const { start, end } = getMonthBounds(new Date(2026, 9, 15));
	const gridStart = new Date(2026, 8, 28).getTime();
	const gridEnd = new Date(2026, 10, 2).getTime() - 1;
	assert.ok(start.getTime() <= gridStart && start.getTime() > gridStart - DAY);
	assert.ok(end.getTime() >= gridEnd && end.getTime() < gridEnd + DAY);
});

test('month bounds of a month that starts on Monday and ends on Sunday add no extra days', () => {
	// February 2027: Mon 1 Feb to Sun 28 Feb.
	const { start, end } = getMonthBounds(new Date(2027, 1, 10));
	const gridStart = new Date(2027, 1, 1).getTime();
	const gridEnd = new Date(2027, 2, 1).getTime() - 1;
	assert.ok(start.getTime() <= gridStart && start.getTime() > gridStart - DAY);
	assert.ok(end.getTime() >= gridEnd && end.getTime() < gridEnd + DAY);
});

test('a multi-day all-day event names its last day', () => {
	const base = { eventId: 'e', title: 't', description: null, location: null, recurring: false };
	assert.equal(
		formatEventTimeOfDay({
			...base,
			allDay: true,
			startsAt: '2026-10-05T00:00:00.000Z',
			endsAt: '2026-10-05T00:00:00.000Z',
			occurrenceIndex: 0,
		}),
		'ganztägig',
	);
	assert.match(
		formatEventTimeOfDay({
			...base,
			allDay: true,
			startsAt: '2026-10-05T00:00:00.000Z',
			endsAt: '2026-10-09T00:00:00.000Z',
			occurrenceIndex: 0,
		}),
		/^ganztägig · bis \S+ 09\.10\.$/,
	);
});

test('a timed event without an end exports the one-hour default the app shows', () => {
	const ics = occurrenceToIcs({
		eventId: 'e',
		title: 'Meeting',
		description: null,
		location: null,
		recurring: false,
		allDay: false,
		startsAt: '2026-10-05T18:00:00.000Z',
		endsAt: null,
		occurrenceIndex: 0,
	});
	assert.match(ics, /DTSTART:20261005T180000Z\r\nDTEND:20261005T190000Z\r\n/);
});

test('the subscribed feed asks clients to refresh hourly', () => {
	const ics = calendarFeedToIcs([], 'ManaWG', '2026-10-05T00:00:00.000Z');
	assert.match(ics, /REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n/);
	assert.match(ics, /X-PUBLISHED-TTL:PT1H\r\n/);
});

test('a single event export carries no refresh hint', () => {
	const ics = occurrenceToIcs({
		eventId: 'e',
		title: 'Meeting',
		description: null,
		location: null,
		recurring: false,
		allDay: false,
		startsAt: '2026-10-05T18:00:00.000Z',
		endsAt: null,
		occurrenceIndex: 0,
	});
	assert.doesNotMatch(ics, /REFRESH-INTERVAL|X-PUBLISHED-TTL/);
});
