import { expect, test } from '@playwright/test';
import { formatNotificationMessage } from '../src/core/notifications/notifications';
import { buildActivityTimeline } from '../src/core/reads/activity';
import { computeMemberBalances, summarizeDashboardSpend } from '../src/core/reads/dashboard-data';
import { getTodayImportantItems, getWgHealth } from '../src/core/reads/dashboard-insights';
import { computeNetBalances } from '../src/features/expenses/debt-reduction';
import { computeBalances, computeOldestDebtAges } from '../src/features/expenses/debts';
import { getDueRecurringExpenses } from '../src/features/expenses/recurring-expenses';
import { canSendReminder, formatReminderMessage } from '../src/features/expenses/reminders';

const alice = '11111111-1111-4111-8111-111111111111';
const ben = '22222222-2222-4222-8222-222222222222';
const members = [
	{ id: alice, name: 'Alice', color: null },
	{ id: ben, name: 'Ben', color: null },
];

test.describe('audit #158 accounting invariants', () => {
	test('keeps balances and payments separate for each currency', () => {
		const expenses = [
			{
				paidByMemberId: alice,
				currency: 'EUR',
				occurredAt: '2026-01-01T12:00:00.000Z',
				splits: [{ debtorMemberId: ben, amountCents: 1000, settledAt: null }],
			},
			{
				paidByMemberId: alice,
				currency: 'CHF',
				occurredAt: '2026-01-02T12:00:00.000Z',
				splits: [{ debtorMemberId: ben, amountCents: 1000, settledAt: null }],
			},
		];
		const payments = [{ fromMemberId: ben, toMemberId: alice, amountCents: 1000, currency: 'EUR' }];

		expect(computeBalances(expenses, payments)).toEqual([
			{ debtorId: ben, creditorId: alice, amountCents: 1000, currency: 'CHF' },
		]);
		expect(computeNetBalances(expenses, members, payments)).toEqual([
			{ memberId: alice, memberName: 'Alice', color: null, cents: 1000, currency: 'CHF' },
			{ memberId: ben, memberName: 'Ben', color: null, cents: -1000, currency: 'CHF' },
			{ memberId: alice, memberName: 'Alice', color: null, cents: 0, currency: 'EUR' },
			{ memberId: ben, memberName: 'Ben', color: null, cents: 0, currency: 'EUR' },
		]);
	});

	test('nets opposite directions into one pair balance', () => {
		const expenses = [
			{
				paidByMemberId: alice,
				currency: 'EUR',
				occurredAt: '2026-01-01T12:00:00.000Z',
				splits: [{ debtorMemberId: ben, amountCents: 4295, settledAt: null }],
			},
			{
				paidByMemberId: ben,
				currency: 'EUR',
				occurredAt: '2026-01-02T12:00:00.000Z',
				splits: [{ debtorMemberId: alice, amountCents: 3852, settledAt: null }],
			},
		];
		expect(computeBalances(expenses)).toEqual([
			{ debtorId: ben, creditorId: alice, amountCents: 443, currency: 'EUR' },
		]);
	});

	test('keeps dashboard gross balances in separate currency rows', () => {
		const expenses = [
			{ id: 'eur', paidByMemberId: alice, amountCents: 1000, currency: 'EUR' },
			{ id: 'chf', paidByMemberId: alice, amountCents: 1000, currency: 'CHF' },
		];
		const splits = [
			{ expenseId: 'eur', debtorMemberId: ben, amountCents: 1000, settledAt: null },
			{ expenseId: 'chf', debtorMemberId: ben, amountCents: 1000, settledAt: null },
		];

		expect(computeMemberBalances(members, expenses, splits)).toEqual([
			{
				memberId: alice,
				memberName: 'Alice',
				color: null,
				currency: 'CHF',
				paidCents: 1000,
				owedCents: 0,
				balanceCents: 1000,
			},
			{
				memberId: ben,
				memberName: 'Ben',
				color: null,
				currency: 'CHF',
				paidCents: 0,
				owedCents: 1000,
				balanceCents: -1000,
			},
			{
				memberId: alice,
				memberName: 'Alice',
				color: null,
				currency: 'EUR',
				paidCents: 1000,
				owedCents: 0,
				balanceCents: 1000,
			},
			{
				memberId: ben,
				memberName: 'Ben',
				color: null,
				currency: 'EUR',
				paidCents: 0,
				owedCents: 1000,
				balanceCents: -1000,
			},
		]);
	});

	test('matches reminder ages by currency as well as member pair', () => {
		const expenses = [
			{
				paidByMemberId: alice,
				currency: 'EUR',
				occurredAt: '2026-01-01T12:00:00.000Z',
				splits: [{ debtorMemberId: ben, amountCents: 1000, settledAt: null }],
			},
			{
				paidByMemberId: alice,
				currency: 'CHF',
				occurredAt: '2026-01-10T12:00:00.000Z',
				splits: [{ debtorMemberId: ben, amountCents: 1000, settledAt: null }],
			},
		];
		const now = new Date('2026-01-11T12:00:00.000Z');

		expect(
			computeOldestDebtAges(
				[
					{ debtorId: ben, creditorId: alice, currency: 'EUR' },
					{ debtorId: ben, creditorId: alice, currency: 'CHF' },
				],
				expenses,
				now,
			),
		).toEqual([10, 1]);
	});
});

test.describe('audit #158 currency consumers', () => {
	test('keeps dashboard spend totals and sparkline rows currency-scoped', () => {
		const summary = summarizeDashboardSpend(
			[
				{
					amountCents: 1000,
					currency: 'EUR',
					occurredAt: '2026-01-15T12:00:00.000Z',
				},
				{
					amountCents: 2500,
					currency: 'CHF',
					occurredAt: '2026-01-15T13:00:00.000Z',
				},
			],
			new Date('2026-01-15T14:00:00.000Z'),
		);

		expect(summary.totalSpendByCurrency).toEqual({ EUR: 1000, CHF: 2500 });
		expect(summary.weekSpendByCurrency).toEqual({ EUR: 1000, CHF: 2500 });
		expect(summary.monthSpendByCurrency).toEqual({ EUR: 1000, CHF: 2500 });
		expect(summary.totalSpendCents).toBeNull();
		expect(summary.spendByDay).toEqual(
			expect.arrayContaining([
				{ date: '2026-01-15', currency: 'EUR', cents: 1000 },
				{ date: '2026-01-15', currency: 'CHF', cents: 2500 },
			]),
		);
	});

	test('scopes reminder cooldown and copy by currency', () => {
		const now = new Date('2026-01-15T12:00:00.000Z');
		const history = [
			{
				debtorMemberId: ben,
				creditorMemberId: alice,
				currency: 'EUR',
				sentAt: '2026-01-15T10:00:00.000Z',
			},
		];

		expect(canSendReminder(ben, alice, history, now, 'EUR').allowed).toBe(false);
		expect(canSendReminder(ben, alice, history, now, 'CHF').allowed).toBe(true);
		expect(
			formatReminderMessage({
				debtorName: 'Ben',
				creditorName: 'Alice',
				amountCents: 2500,
				currency: 'CHF',
				oldestDebtAgeDays: 2,
			}),
		).toContain('CHF');
	});

	test('keeps currency in activity, notifications, and health output', () => {
		const activity = buildActivityTimeline({
			members: members.map(({ id, name }) => ({ id, name })),
			expenses: [
				{
					id: 'expense-chf',
					paidByMemberId: alice,
					description: 'Miete',
					amountCents: 95000,
					currency: 'CHF',
					occurredAt: '2026-01-15T12:00:00.000Z',
				},
			],
			shoppingItems: [],
			announcements: [],
			choreCompletions: [],
		});
		expect(activity[0]).toMatchObject({ amountCents: 95000, currency: 'CHF' });

		const notification = formatNotificationMessage('expense.created', {
			wgName: 'WG',
			actorName: 'Alice',
			title: 'Miete',
			amountCents: 95000,
			currency: 'CHF',
		});
		expect(notification.body).toContain('CHF');
		expect(
			formatNotificationMessage('expense.recurring_charged', {
				description: 'Internet',
				amountCents: 2500,
				currency: 'CHF',
			}),
		).toMatchObject({ body: expect.stringContaining('CHF') });

		const health = getWgHealth({
			shareCode: 'WGCODE01',
			openShoppingCount: 0,
			overdueChoreCount: 0,
			openDebtByCurrency: { EUR: 1000, CHF: 2500 },
			openAnnouncementCount: 0,
			absentMemberCount: 0,
			dueRecurringCount: 0,
		});
		expect(health.items.find((item) => item.label === 'Offene Schulden')?.value).toEqual(
			expect.stringContaining('CHF'),
		);
	});

	test('preserves currency on recurring due items and today cards', () => {
		const due = getDueRecurringExpenses(
			[
				{
					id: 'recurring-chf',
					description: 'Internet',
					amountCents: 2500,
					currency: 'CHF',
					nextDueAt: '2026-01-14T12:00:00.000Z',
				},
			],
			new Date('2026-01-15T12:00:00.000Z').getTime(),
		);
		expect(due[0]?.currency).toBe('CHF');

		const today = getTodayImportantItems({
			shareCode: 'WGCODE01',
			currentMemberId: alice,
			openShoppingCount: 0,
			openShoppingTop: [],
			dueChores: [],
			myOpenAnnouncements: [],
			dueRecurringExpenses: due,
			absentMembers: [],
			now: new Date('2026-01-15T12:00:00.000Z'),
		});
		expect(today[0]?.detail).toContain('CHF');
	});
});
