// Start overview read models: Berlin week agenda, ranking and edge-data helpers.
// Why: Ordering and day edges must be deterministic.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { activityDayRelation, groupActivityItemsByDay } from '../src/composition/activity';
import {
	getBerlinWeekWindow,
	getForYouItems,
	getTodayImportantItems,
	getWeekAgenda,
} from '../src/composition/dashboard-insights';
import { formatShortDate, relativeTimeMessage, weekLabelMessage } from '../src/core/utils/time';
import { previewBody } from '../src/features/chat/chat-pure';
import type { EventInput, EventOccurrence } from '../src/features/events/events';
import { expandRecurrence } from '../src/features/events/events';
import { buildSettlementSummary, simplifyDebts } from '../src/features/expenses/debt-reduction';
import { parseShoppingInput } from '../src/features/shopping/parse-shopping-input';
import { withEnv } from './support/env.ts';

const { renderMessage, serverRootT } = await import('../src/core/i18n/server-t');
const deT = serverRootT('de');

type Tuple<T, N extends number, R extends T[] = []> = R['length'] extends N
	? R
	: Tuple<T, N, [...R, T]>;

/** Asserts that `items` holds exactly `count` entries and types them as a tuple. */
function tuple<T, N extends number>(items: readonly T[], count: N): Tuple<T, N> {
	assert.equal(items.length, count);
	return [...items] as Tuple<T, N>;
}

describe('daily overview model', () => {
	const NOW = Date.parse('2026-09-05T22:30:00.000Z');

	function overview(overrides: Record<string, unknown> = {}) {
		return {
			shareCode: 'WG/1',
			currentMemberId: 'member-me',
			openShoppingCount: 2,
			openShoppingTop: ['Milch'],
			dueChores: [],
			myOpenAnnouncements: [],
			dueRecurringExpenses: [],
			absentMembers: [],
			now: NOW,
			...overrides,
		};
	}

	function event(
		partial: Pick<EventOccurrence, 'eventId' | 'title' | 'startsAt'> & Partial<EventOccurrence>,
	): EventOccurrence {
		return {
			description: null,
			endsAt: null,
			allDay: false,
			location: null,
			recurring: false,
			occurrenceIndex: 0,
			...partial,
		};
	}

	test('separates own chores and labels shared shopping and recurring costs', () => {
		const items = getForYouItems(
			overview({
				dueChores: [
					{
						id: 'mine',
						title: 'Bad',
						nextDueAt: '2026-09-06T09:00:00+02:00',
						overdue: false,
						assignedMemberId: 'member-me',
						assignedMemberName: 'Abu',
					},
					{
						id: 'theirs',
						title: 'Flur',
						nextDueAt: '2026-09-06T10:00:00+02:00',
						overdue: false,
						assignedMemberId: 'member-other',
						assignedMemberName: 'Mina',
					},
				],
				dueRecurringExpenses: [
					{ id: 'internet', description: 'Internet', amountCents: 3000, currency: 'EUR' },
				],
			}),
		);

		assert.equal(
			items.some((item) => item.entityId === 'mine'),
			true,
		);
		assert.equal(
			items.some((item) => item.entityId === 'theirs'),
			false,
		);
		assert.partialDeepStrictEqual(items.find((item) => item.kind === 'shopping')?.detail, {
			key: 'home.today.shoppingDetail',
		});
		assert.partialDeepStrictEqual(items.find((item) => item.kind === 'recurring')?.detail, {
			key: 'home.today.recurring',
		});
	});

	test('keeps personal settlements distinct by counterparty and currency', () => {
		const balances = [
			{
				memberId: 'member-me',
				memberName: 'Abu',
				color: null,
				balanceCents: -1000,
				currency: 'EUR',
			},
			{ memberId: 'anna', memberName: 'Anna', color: null, balanceCents: 600, currency: 'EUR' },
			{ memberId: 'ben', memberName: 'Ben', color: null, balanceCents: 400, currency: 'EUR' },
			{ memberId: 'member-me', memberName: 'Abu', color: null, balanceCents: 300, currency: 'CHF' },
			{ memberId: 'anna', memberName: 'Anna', color: null, balanceCents: -300, currency: 'CHF' },
		];
		const settlements = getForYouItems(overview({ openShoppingCount: 0, balances })).filter(
			(item) => item.kind === 'debt',
		);
		const expected = simplifyDebts(
			balances.map(({ balanceCents, ...balance }) => ({ ...balance, cents: balanceCents })),
		).filter((debt) => debt.fromId === 'member-me' || debt.toId === 'member-me');

		assert.equal(settlements.length, 3);
		assert.deepEqual(
			settlements.map((item) => item.entityId),
			[
				'settlement:member-me:anna:EUR',
				'settlement:member-me:ben:EUR',
				'settlement:anna:member-me:CHF',
			],
		);
		const actualByIdentity = settlements
			.map((item) => [item.entityId, item.title, item.amountCents, item.currency])
			.sort(([left], [right]) => String(left).localeCompare(String(right)));
		const expectedByIdentity = expected
			.map((debt) => [
				`settlement:${debt.fromId}:${debt.toId}:${debt.currency ?? 'EUR'}`,
				debt.fromId === 'member-me'
					? { key: 'home.today.debtTitle', values: { direction: 'outgoing', name: debt.toName } }
					: { key: 'home.today.debtTitle', values: { direction: 'incoming', name: debt.fromName } },
				debt.fromId === 'member-me' ? -debt.cents : debt.cents,
				debt.currency,
			])
			.sort(([left], [right]) => String(left).localeCompare(String(right)));
		assert.deepEqual(actualByIdentity, expectedByIdentity);
	});

	test('keeps settlement partners stable when tied balances and members are reordered', () => {
		const balances = [
			{ memberId: 'debtor-a', memberName: 'Abu', color: null, cents: -500, currency: 'EUR' },
			{ memberId: 'creditor-b', memberName: 'Dana', color: null, cents: 500, currency: 'EUR' },
			{ memberId: 'debtor-b', memberName: 'Bea', color: null, cents: -500, currency: 'EUR' },
			{ memberId: 'creditor-a', memberName: 'Clara', color: null, cents: 500, currency: 'EUR' },
		];
		const [b0, b1, b2, b3] = tuple(balances, 4);
		const reorderedBalances = [b0, b2, b3, b1];
		const expenses = [
			{
				paidByMemberId: 'creditor-a',
				splits: [
					{ debtorMemberId: 'debtor-a', amountCents: 250, settledAt: null },
					{ debtorMemberId: 'debtor-b', amountCents: 250, settledAt: null },
					{ debtorMemberId: 'creditor-b', amountCents: 250, settledAt: null },
				],
			},
			{
				paidByMemberId: 'creditor-b',
				splits: [
					{ debtorMemberId: 'debtor-a', amountCents: 250, settledAt: null },
					{ debtorMemberId: 'debtor-b', amountCents: 250, settledAt: null },
					{ debtorMemberId: 'creditor-a', amountCents: 250, settledAt: null },
				],
			},
		];
		const members = [
			{ id: 'debtor-a', name: 'Abu', color: null },
			{ id: 'creditor-b', name: 'Dana', color: null },
			{ id: 'debtor-b', name: 'Bea', color: null },
			{ id: 'creditor-a', name: 'Clara', color: null },
		];
		const [m0, m1, m2, m3] = tuple(members, 4);
		const reorderedMembers = [m0, m2, m3, m1];
		const expectedTransfers = [
			{
				fromId: 'debtor-a',
				fromName: 'Abu',
				toId: 'creditor-a',
				toName: 'Clara',
				cents: 500,
				currency: 'EUR',
			},
			{
				fromId: 'debtor-b',
				fromName: 'Bea',
				toId: 'creditor-b',
				toName: 'Dana',
				cents: 500,
				currency: 'EUR',
			},
		];
		const simplify = (rows: typeof balances) =>
			simplifyDebts(rows).map(({ fromId, fromName, toId, toName, cents, currency }) => ({
				fromId,
				fromName,
				toId,
				toName,
				cents,
				currency,
			}));
		const summary = (roster: typeof members) => buildSettlementSummary(expenses, roster).simplified;
		const expectedHomeRows = [
			[
				'settlement:debtor-a:creditor-a:EUR',
				{ key: 'home.today.debtTitle', values: { direction: 'outgoing', name: 'Clara' } },
				-500,
				'EUR',
			],
		];
		const homeRows = (rows: typeof balances) =>
			getForYouItems(
				overview({
					currentMemberId: 'debtor-a',
					balances: rows.map(({ cents, ...balance }) => ({ ...balance, balanceCents: cents })),
				}),
			)
				.filter((item) => item.kind === 'debt')
				.map((item) => [item.entityId, item.title, item.amountCents, item.currency]);

		assert.deepEqual(simplify(balances), expectedTransfers);
		assert.deepEqual(simplify(reorderedBalances), expectedTransfers);
		assert.deepEqual(summary(members), expectedTransfers);
		assert.deepEqual(summary(reorderedMembers), expectedTransfers);
		assert.deepEqual(homeRows(balances), expectedHomeRows);
		assert.deepEqual(homeRows(reorderedBalances), expectedHomeRows);
	});

	test('builds the Berlin week agenda with separate overdue context and no own duplicates', () => {
		const window = getBerlinWeekWindow(NOW);
		const rawWeekly: EventInput = {
			id: 'weekly',
			title: 'Sonntagsbrunch',
			description: null,
			startsAt: '2026-08-30T16:00:00.000Z',
			endsAt: null,
			allDay: false,
			location: null,
			recurrence: 'FREQ=WEEKLY',
		};
		const events = [
			event({
				eventId: 'all-day',
				title: 'WG-Putzaktion',
				startsAt: '2026-09-06T00:00:00.000Z',
				allDay: true,
			}),
			event({
				eventId: 'ongoing',
				title: 'Wochenendgäste',
				startsAt: '2026-09-05T20:00:00.000Z',
				endsAt: '2026-09-06T08:00:00.000Z',
			}),
			...expandRecurrence(rawWeekly, window.from, window.to),
			event({
				eventId: 'next-week',
				title: 'Nicht diese Woche',
				startsAt: '2026-09-07T08:00:00.000Z',
			}),
		];
		const agenda = getWeekAgenda({
			shareCode: 'WG/1',
			currentMemberId: 'member-me',
			now: NOW,
			events,
			dueChores: [
				{
					id: 'overdue-other',
					title: 'Flur',
					nextDueAt: '2026-09-05T10:00:00+02:00',
					overdue: true,
					assignedMemberId: 'member-other',
					assignedMemberName: 'Mina',
				},
				{
					id: 'own-today',
					title: 'Bad',
					nextDueAt: '2026-09-06T09:00:00+02:00',
					overdue: false,
					assignedMemberId: 'member-me',
					assignedMemberName: 'Abu',
				},
				{
					id: 'sunday-other',
					title: 'Küche',
					nextDueAt: '2026-09-06T18:00:00+02:00',
					overdue: false,
					assignedMemberId: 'member-other',
					assignedMemberName: 'Mina',
				},
				{
					id: 'next-monday',
					title: 'Keller',
					nextDueAt: '2026-09-07T09:00:00+02:00',
					overdue: false,
					assignedMemberId: 'member-other',
					assignedMemberName: 'Mina',
				},
			],
		});

		assert.partialDeepStrictEqual(window, {
			todayKey: '2026-09-06',
			weekStartKey: '2026-08-31',
			sundayKey: '2026-09-06',
		});
		assert.equal(window.from.toISOString(), '2026-09-05T22:00:00.000Z');
		assert.equal(window.to.toISOString(), '2026-09-06T21:59:59.999Z');
		assert.deepEqual(
			agenda.overdue.map((item) => item.key),
			['chore:overdue-other'],
		);
		assert.deepEqual(
			agenda.upcoming.map((item) => item.key).sort(),
			['event:all-day:0', 'event:ongoing:0', 'event:weekly:1', 'chore:sunday-other'].sort(),
		);
		assert.equal(
			agenda.upcoming.every((item) => item.dayKey === '2026-09-06'),
			true,
		);
		assert.partialDeepStrictEqual(
			agenda.upcoming.find((item) => item.key === 'event:ongoing:0')?.detail,
			{
				key: 'home.agenda.ongoing',
			},
		);
	});

	test('does not label an ended overnight event as running', () => {
		const agenda = getWeekAgenda({
			shareCode: 'WG/1',
			currentMemberId: 'member-me',
			dueChores: [],
			events: [
				event({
					eventId: 'ended-overnight',
					title: 'Wochenendgäste',
					startsAt: '2026-09-05T20:00:00.000Z',
					endsAt: '2026-09-06T06:00:00.000Z',
				}),
			],
			now: Date.parse('2026-09-06T15:00:00.000Z'),
		});

		assert.partialDeepStrictEqual(agenda.upcoming, [
			{
				key: 'event:ended-overnight:0',
				dayKey: '2026-09-06',
				detail: { key: 'home.agenda.endedAt', values: { time: '08:00' } },
			},
		]);
	});

	test('uses Berlin dates across Sundays, Mondays, year boundaries, and DST changes', () => {
		const spring = getBerlinWeekWindow(Date.parse('2026-03-29T01:30:00.000Z'));
		const fall = getBerlinWeekWindow(Date.parse('2026-10-25T01:30:00.000Z'));
		const monday = getBerlinWeekWindow(Date.parse('2026-10-25T23:30:00.000Z'));
		const newYear = getBerlinWeekWindow(Date.parse('2027-01-01T12:00:00.000Z'));

		assert.partialDeepStrictEqual(spring, {
			todayKey: '2026-03-29',
			weekStartKey: '2026-03-23',
			sundayKey: '2026-03-29',
		});
		assert.equal(spring.to.getTime() + 1 - spring.from.getTime(), 23 * 60 * 60 * 1000);
		assert.partialDeepStrictEqual(fall, {
			todayKey: '2026-10-25',
			weekStartKey: '2026-10-19',
			sundayKey: '2026-10-25',
		});
		assert.equal(fall.to.getTime() + 1 - fall.from.getTime(), 25 * 60 * 60 * 1000);
		assert.partialDeepStrictEqual(monday, {
			todayKey: '2026-10-26',
			weekStartKey: '2026-10-26',
			sundayKey: '2026-11-01',
		});
		assert.partialDeepStrictEqual(newYear, {
			todayKey: '2027-01-01',
			weekStartKey: '2026-12-28',
			sundayKey: '2027-01-03',
		});
	});

	test('keeps recurring events at their Berlin wall time over both DST transitions', () => {
		const springWindow = getBerlinWeekWindow(Date.parse('2026-03-29T01:30:00.000Z'));
		const fallWindow = getBerlinWeekWindow(Date.parse('2026-10-25T01:30:00.000Z'));
		const recurringEvent = (startsAt: string): EventInput => ({
			id: 'weekly',
			title: 'Abendessen',
			description: null,
			startsAt,
			endsAt: null,
			allDay: false,
			location: null,
			recurrence: 'FREQ=WEEKLY',
		});

		assert.equal(
			expandRecurrence(
				recurringEvent('2026-03-22T19:00:00.000Z'),
				springWindow.from,
				springWindow.to,
			)[0]?.startsAt,
			'2026-03-29T18:00:00.000Z',
		);
		assert.equal(
			expandRecurrence(
				recurringEvent('2026-10-18T18:00:00.000Z'),
				fallWindow.from,
				fallWindow.to,
			)[0]?.startsAt,
			'2026-10-25T19:00:00.000Z',
		);
	});
});

describe('start overview model', () => {
	const NOW = Date.parse('2026-09-05T22:30:00.000Z');

	function overviewInput() {
		return {
			shareCode: 'WG/1',
			currentMemberId: 'member-me',
			openShoppingCount: 7,
			openShoppingTop: ['Milch', 'Brot', 'Eier'],
			dueChores: [
				{
					id: 'shared-overdue',
					title: 'Flur',
					nextDueAt: '2026-09-04T08:00:00.000Z',
					overdue: true,
					assignedMemberId: 'member-other',
					assignedMemberName: 'Mina',
				},
				{
					id: 'own-overdue',
					title: 'Bad',
					nextDueAt: '2026-09-04T20:00:00.000Z',
					overdue: true,
					assignedMemberId: 'member-me',
					assignedMemberName: 'Abu',
				},
				{
					id: 'own-today',
					title: 'Küche',
					nextDueAt: '2026-09-05T23:00:00.000Z',
					overdue: false,
					assignedMemberId: 'member-me',
					assignedMemberName: 'Abu',
				},
				{
					id: 'shared-today',
					title: 'Treppenhaus',
					nextDueAt: '2026-09-05T23:30:00.000Z',
					overdue: false,
					assignedMemberId: 'member-other',
					assignedMemberName: 'Mina',
				},
				{
					id: 'own-next',
					title: 'Badfenster',
					nextDueAt: '2026-09-07T08:00:00.000Z',
					overdue: false,
					assignedMemberId: 'member-me',
					assignedMemberName: 'Abu',
				},
				{
					id: 'shared-next',
					title: 'Keller',
					nextDueAt: '2026-09-08T08:00:00.000Z',
					overdue: false,
					assignedMemberId: 'member-other',
					assignedMemberName: 'Mina',
				},
				{
					id: 'later',
					title: 'Fenster',
					nextDueAt: '2026-09-20T08:00:00.000Z',
					overdue: false,
					assignedMemberId: null,
					assignedMemberName: null,
				},
			],
			myOpenAnnouncements: [{ id: 'announcement-1', kind: 'request', content: 'Paket im Flur' }],
			dueRecurringExpenses: [
				{
					id: 'recurring-1',
					description: 'Internet',
					amountCents: 3290,
					nextDueAt: '2026-09-06T00:15:00+02:00',
				},
			],
			absentMembers: [
				{
					id: 'absence-1',
					memberId: 'member-me',
					name: 'Abu',
					endDate: '2026-09-08T10:00:00.000Z',
					isCurrentMember: true,
				},
			],
			now: NOW,
		};
	}

	describe('Start overview read model', () => {
		test('ranks all chore candidates before the visible limit and keeps ownership context', () => {
			const items = getTodayImportantItems(overviewInput());

			assert.equal(items.length, 10);
			assert.deepEqual(
				items.slice(0, 7).map((item) => item.entityId),
				[
					'own-overdue',
					'shared-overdue',
					'own-today',
					'recurring-1',
					'shared-today',
					'own-next',
					'shared-next',
				],
			);
			assert.equal(
				items.some((item) => item.entityId === 'later'),
				false,
			);
			assert.partialDeepStrictEqual(items[0], {
				isPersonal: true,
				href: '/wg/WG%2F1/chores?highlight=own-overdue',
			});
			assert.partialDeepStrictEqual(items[0]?.detail, { key: 'home.due.overdue' });
			assert.partialDeepStrictEqual(items[1], {
				isPersonal: false,
				href: '/wg/WG%2F1/chores?highlight=shared-overdue',
			});
			assert.partialDeepStrictEqual(items[1]?.detail, {
				key: 'home.today.choreDetail',
				values: { owner: 'Mina' },
			});

			const shopping = items.find((item) => item.kind === 'shopping');
			assert.partialDeepStrictEqual(shopping, {
				detail: { key: 'home.today.shoppingDetail', values: { count: 7 } },
				href: '/wg/WG%2F1/shopping',
			});
			assert.equal(
				items.some((item) => item.kind === 'debt'),
				false,
			);
		});

		test('uses stable destination links', () => {
			const items = getTodayImportantItems(overviewInput());
			assert.partialDeepStrictEqual(
				items.find((item) => item.kind === 'announcement'),
				{
					entityId: 'announcement-1',
					href: '/wg/WG%2F1/pinboard#announcement-announcement-1',
				},
			);
			assert.partialDeepStrictEqual(
				items.find((item) => item.kind === 'recurring'),
				{
					entityId: 'recurring-1',
					href: '/wg/WG%2F1/expenses?recurring=recurring-1',
				},
			);
			assert.partialDeepStrictEqual(
				items.find((item) => item.kind === 'absence'),
				{
					entityId: 'absence-1',
					href: '/wg/WG%2F1/chores?panel=absences&absence=absence-1',
				},
			);
		});

		test('uses Berlin calendar days at the day edge', () => {
			const items = getTodayImportantItems({
				...overviewInput(),
				dueChores: [
					{
						id: 'same-berlin-day',
						title: 'Heute',
						nextDueAt: '2026-09-06T00:10:00+02:00',
						overdue: true,
						assignedMemberId: 'member-me',
						assignedMemberName: 'Abu',
					},
					{
						id: 'previous-berlin-day',
						title: 'Gestern',
						nextDueAt: '2026-09-05T23:55:00+02:00',
						overdue: true,
						assignedMemberId: 'member-other',
						assignedMemberName: 'Mina',
					},
				],
			});

			assert.partialDeepStrictEqual(items[0], { entityId: 'previous-berlin-day', tone: 'danger' });
			assert.partialDeepStrictEqual(items[1], {
				entityId: 'same-berlin-day',
				tone: 'accent',
			});
			assert.partialDeepStrictEqual(items[1]?.detail, { key: 'home.due.today' });
		});
	});
});

describe('edge data helpers', () => {
	// Pure edge-case regressions (dates around DST/midnight, device zones, emoji, long digits).
	const item = (timestamp: string) => ({
		id: timestamp,
		kind: 'chore' as const,
		timestamp,
		memberName: 'A',
		text: 't',
		completed: true,
	});

	function withTz(tz: string, run: () => void): void {
		withEnv({ TZ: tz }, run);
	}

	test('"Gestern" is the previous Berlin day on the day after spring-forward', () => {
		// 30.03.2026 00:30 CEST; 29.03. had only 23h, so now-24h lands on 28.03.
		const now = Date.parse('2026-03-29T22:30:00Z');
		const [group] = groupActivityItemsByDay([item('2026-03-29T10:00:00Z')]);
		assert.equal(activityDayRelation(group?.date ?? '', now), 'yesterday');
	});

	test('day labels do not shift for devices ahead of Berlin', () => {
		withTz('Pacific/Kiritimati', () => {
			const groups = groupActivityItemsByDay([item('2026-09-20T10:00:00Z')]);
			assert.equal(groups[0]?.date, '2026-09-20');
		});
	});

	test('Berlin short dates ignore the device zone', () => {
		withTz('America/New_York', () => {
			// Berlin 02.10. 00:30 is still 01.10. in New York.
			assert.equal(formatShortDate('2026-10-01T22:30:00Z', 'Europe/Berlin'), '02.10.');
		});
	});

	test('relative labels count calendar days, not 24h blocks', () => {
		const now = new Date(2026, 9, 1, 8, 0).getTime();
		const in47h = new Date(now + 47 * 3_600_000).toISOString();
		const ago47h = new Date(now - 47 * 3_600_000).toISOString();
		assert.equal(renderMessage(deT, relativeTimeMessage(in47h, now)), 'in 2 Tagen');
		assert.equal(renderMessage(deT, relativeTimeMessage(ago47h, now)), 'vor 2 Tagen');
	});

	test('week labels one year apart stay unique', () => {
		const now = new Date(2026, 9, 1);
		const a = renderMessage(deT, weekLabelMessage(new Date(2025, 9, 6), now));
		const b = renderMessage(deT, weekLabelMessage(new Date(2024, 9, 7), now));
		assert.equal(a, 'Woche ab 06.10.2025');
		assert.notEqual(a, b);
	});

	test('chat previews never cut an emoji in half', () => {
		assert.equal(previewBody('😀'.repeat(10), 5), '😀😀😀😀…');
	});

	test('an overlong digit run is a name, not a quantity', () => {
		const name = `${'1'.repeat(45)} Milch`;
		assert.deepEqual(parseShoppingInput(name), { name, quantity: null });
	});
});
