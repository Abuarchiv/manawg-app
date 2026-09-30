import { expect, test } from '@playwright/test';
import { getTodayImportantItems } from '../src/core/reads/dashboard-insights';

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

test.describe('Start overview read model', () => {
	test('ranks all chore candidates before the visible limit and keeps ownership context', () => {
		const items = getTodayImportantItems(overviewInput());

		expect(items).toHaveLength(10);
		expect(items.slice(0, 7).map((item) => item.entityId)).toEqual([
			'own-overdue',
			'shared-overdue',
			'own-today',
			'recurring-1',
			'shared-today',
			'own-next',
			'shared-next',
		]);
		expect(items.some((item) => item.entityId === 'later')).toBe(false);
		expect(items[0]).toMatchObject({
			isPersonal: true,
			detail: expect.stringContaining('Für dich'),
			href: '/wg/WG%2F1/putzen?highlight=own-overdue',
		});
		expect(items[1]).toMatchObject({
			isPersonal: false,
			detail: expect.stringContaining('Mina'),
			href: '/wg/WG%2F1/putzen?highlight=shared-overdue',
		});

		const shopping = items.find((item) => item.kind === 'shopping');
		expect(shopping).toMatchObject({
			detail: 'WG · 7 offene Artikel',
			href: '/wg/WG%2F1/einkauf',
		});
		expect(items.some((item) => item.kind === 'debt')).toBe(false);
	});

	test('uses stable destination links', () => {
		const items = getTodayImportantItems(overviewInput());
		expect(items.find((item) => item.kind === 'announcement')).toMatchObject({
			entityId: 'announcement-1',
			href: '/wg/WG%2F1/pinnwand#announcement-announcement-1',
		});
		expect(items.find((item) => item.kind === 'recurring')).toMatchObject({
			entityId: 'recurring-1',
			href: '/wg/WG%2F1/ausgaben?recurring=recurring-1',
		});
		expect(items.find((item) => item.kind === 'absence')).toMatchObject({
			entityId: 'absence-1',
			href: '/wg/WG%2F1/putzen?panel=absences&absence=absence-1',
		});
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

		expect(items[0]).toMatchObject({ entityId: 'previous-berlin-day', tone: 'danger' });
		expect(items[1]).toMatchObject({
			entityId: 'same-berlin-day',
			tone: 'accent',
			detail: expect.stringContaining('heute fällig'),
		});
	});
});
