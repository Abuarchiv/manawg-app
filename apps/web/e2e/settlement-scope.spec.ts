// Settlement scope and currency-scoped accounting.
// Why: Dashboard, debt list and settlement must agree to the cent and never mix currencies.

import { expect, test } from '@playwright/test';
import { buildActivityTimeline } from '../src/composition/activity';
import { computeMemberBalances, summarizeDashboardSpend } from '../src/composition/dashboard-data';
import { getTodayImportantItems, getWgHealth } from '../src/composition/dashboard-insights';
import { formatNotificationMessage } from '../src/core/notifications/notifications';
import { computeNetBalances } from '../src/features/expenses/debt-reduction';
import { computeBalances, computeOldestDebtAges } from '../src/features/expenses/debts';
import { getDueRecurringExpenses } from '../src/features/expenses/recurring-expenses';
import { canSendReminder, formatReminderMessage } from '../src/features/expenses/reminders';
import {
	type SettlementExpenseInput,
	type SettlementMemberInput,
	parseSettlementConfirmation,
	selectSettlementScope,
	settlementScopeMatches,
} from '../src/features/expenses/settlement-scope';

test.describe('settlement scope', () => {
	const memberA = '11111111-1111-4111-8111-111111111111';
	const memberB = '22222222-2222-4222-8222-222222222222';
	const memberC = '33333333-3333-4333-8333-333333333333';
	const noHttpBaseUrl = 'https://example.invalid';
	const fixtureMemberId = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';

	const members: SettlementMemberInput[] = [
		{ id: memberA, name: 'Anna', color: null },
		{ id: memberB, name: 'Ben', color: null },
		{ id: memberC, name: 'Cem', color: null },
	];

	function expense(
		id: string,
		paidByMemberId: string,
		occurredAt: string,
		debtors: Array<{ id: string; amountCents: number }>,
	): SettlementExpenseInput {
		return {
			id,
			paidByMemberId,
			occurredAt,
			splits: debtors.map(({ id: debtorMemberId, amountCents }) => ({
				id: `${id}-split-${debtorMemberId.slice(0, 4)}`,
				expenseId: id,
				debtorMemberId,
				amountCents,
				settledAt: null,
			})),
		};
	}

	test.describe('Settlement scope', () => {
		test('selects every exact direct split oldest first and ignores other pairs', () => {
			const actual = selectSettlementScope(
				[
					expense('expense-old', memberA, '2026-09-01T10:00:00.000Z', [
						{ id: memberB, amountCents: 700 },
					]),
					expense('expense-new', memberA, '2026-09-02T10:00:00.000Z', [
						{ id: memberB, amountCents: 500 },
					]),
					expense('expense-other-pair', memberC, '2026-09-03T10:00:00.000Z', [
						{ id: memberB, amountCents: 900 },
					]),
				],
				members,
				[],
				memberB,
				memberA,
			);

			expect(actual).toEqual({
				currency: 'EUR',
				netCents: 1200,
				settleableCents: 1200,
				remainingCents: 0,
				splits: [
					{ id: 'expense-old-split-2222', expenseId: 'expense-old', amountCents: 700 },
					{ id: 'expense-new-split-2222', expenseId: 'expense-new', amountCents: 500 },
				],
			});
		});

		test('reports a partial scope when net debt exceeds whole direct splits', () => {
			const actual = selectSettlementScope(
				[
					expense('expense-direct', memberA, '2026-09-01T10:00:00.000Z', [
						{ id: memberB, amountCents: 1000 },
					]),
					expense('expense-through-cem', memberC, '2026-09-02T10:00:00.000Z', [
						{ id: memberB, amountCents: 500 },
					]),
					expense('expense-cem-to-anna', memberA, '2026-09-03T10:00:00.000Z', [
						{ id: memberC, amountCents: 1000 },
					]),
				],
				members,
				[],
				memberB,
				memberA,
			);

			expect(actual).toEqual({
				currency: 'EUR',
				netCents: 1500,
				settleableCents: 1000,
				remainingCents: 500,
				splits: [
					{ id: 'expense-direct-split-2222', expenseId: 'expense-direct', amountCents: 1000 },
				],
			});
		});

		test('caps a 51-split scope and selects the remaining split on the follow-up', () => {
			const expenses = Array.from({ length: 51 }, (_, index) =>
				expense(`expense-${String(index).padStart(2, '0')}`, memberA, '2026-09-01T10:00:00.000Z', [
					{ id: memberB, amountCents: 1 },
				]),
			);

			const firstScope = selectSettlementScope(expenses, members, [], memberB, memberA);

			expect(firstScope.splits).toHaveLength(50);
			expect(firstScope.settleableCents).toBe(50);
			expect(firstScope.remainingCents).toBe(1);

			const firstSplitIds = new Set(firstScope.splits.map((split) => split.id));
			const followUpScope = selectSettlementScope(
				expenses.map((currentExpense) => ({
					...currentExpense,
					splits: currentExpense.splits.map((split) => ({
						...split,
						settledAt: firstSplitIds.has(split.id) ? '2026-09-02T10:00:00.000Z' : split.settledAt,
					})),
				})),
				members,
				[],
				memberB,
				memberA,
			);

			expect(followUpScope).toEqual({
				currency: 'EUR',
				netCents: 1,
				settleableCents: 1,
				remainingCents: 0,
				splits: [{ id: 'expense-50-split-2222', expenseId: 'expense-50', amountCents: 1 }],
			});
		});

		test('reports a net-only debt when no direct split exists', () => {
			const actual = selectSettlementScope(
				[
					expense('expense-ben-to-cem', memberC, '2026-09-01T10:00:00.000Z', [
						{ id: memberB, amountCents: 1000 },
					]),
					expense('expense-cem-to-anna', memberA, '2026-09-02T10:00:00.000Z', [
						{ id: memberC, amountCents: 1000 },
					]),
				],
				members,
				[],
				memberB,
				memberA,
			);

			expect(actual).toEqual({
				currency: 'EUR',
				netCents: 1000,
				settleableCents: 0,
				remainingCents: 1000,
				splits: [],
				reason: 'no_direct_splits',
			});
		});

		test('rejects stale net, record ids, and record amounts', () => {
			const actual = selectSettlementScope(
				[
					expense('expense-old', memberA, '2026-09-01T10:00:00.000Z', [
						{ id: memberB, amountCents: 700 },
					]),
					expense('expense-new', memberA, '2026-09-02T10:00:00.000Z', [
						{ id: memberB, amountCents: 500 },
					]),
					expense('expense-other-pair', memberC, '2026-09-03T10:00:00.000Z', [
						{ id: memberB, amountCents: 900 },
					]),
				],
				members,
				[],
				memberB,
				memberA,
			);
			const reviewed = {
				netCents: 1200,
				settleableCents: 1200,
				splits: [
					{ id: 'expense-old-split-2222', amountCents: 700 },
					{ id: 'expense-new-split-2222', amountCents: 500 },
				],
			};

			expect(settlementScopeMatches(reviewed, actual)).toBe(true);
			expect(settlementScopeMatches({ ...reviewed, netCents: 1100 }, actual)).toBe(false);
			expect(
				settlementScopeMatches(
					{
						...reviewed,
						splits: [
							{ id: 'different-split', amountCents: 700 },
							{ id: 'expense-new-split-2222', amountCents: 500 },
						],
					},
					actual,
				),
			).toBe(false);
			expect(
				settlementScopeMatches(
					{
						...reviewed,
						splits: [
							{ id: 'expense-old-split-2222', amountCents: 600 },
							{ id: 'expense-new-split-2222', amountCents: 600 },
						],
					},
					actual,
				),
			).toBe(false);
		});

		test('rejects a retry using the review from before its splits were settled', () => {
			const reviewedExpenses = [
				expense('expense-first', memberA, '2026-09-01T10:00:00.000Z', [
					{ id: memberB, amountCents: 500 },
				]),
				expense('expense-second', memberA, '2026-09-02T10:00:00.000Z', [
					{ id: memberB, amountCents: 500 },
				]),
			];
			const preview = selectSettlementScope(reviewedExpenses, members, [], memberB, memberA);
			const expected = {
				currency: preview.currency,
				netCents: preview.netCents,
				settleableCents: preview.settleableCents,
				splits: preview.splits.map(({ id, amountCents }) => ({ id, amountCents })),
			};
			const afterFirstCommit = reviewedExpenses.map((current) => ({
				...current,
				splits: current.splits.map((split) => ({
					...split,
					settledAt: new Date('2026-09-03T10:00:00.000Z'),
				})),
			}));
			const retry = selectSettlementScope(afterFirstCommit, members, [], memberB, memberA);

			expect(preview.splits).toHaveLength(2);
			expect(retry.splits).toEqual([]);
			expect(settlementScopeMatches(expected, retry)).toBe(false);
		});

		test('requires a complete strict review and rejects duplicate or invalid records', () => {
			const validReview = {
				fromMemberId: memberB,
				toMemberId: memberA,
				currency: 'EUR',
				expected: {
					currency: 'EUR',
					netCents: 1000,
					settleableCents: 1000,
					splits: [{ id: '44444444-4444-4444-8444-444444444444', amountCents: 1000 }],
				},
			};
			expect(parseSettlementConfirmation(validReview)).toEqual({ ok: true, value: validReview });

			expect(parseSettlementConfirmation({ fromMemberId: memberB, toMemberId: memberA })).toEqual({
				ok: false,
				reason: 'required',
			});

			expect(
				parseSettlementConfirmation({
					fromMemberId: memberB,
					toMemberId: memberA,
					expected: {
						netCents: 1000,
						settleableCents: 1000,
						splits: [
							{ id: '44444444-4444-4444-8444-444444444444', amountCents: 500 },
							{ id: '44444444-4444-4444-8444-444444444444', amountCents: 500 },
						],
					},
				}),
			).toEqual({ ok: false, reason: 'invalid' });

			expect(
				parseSettlementConfirmation({
					fromMemberId: memberB,
					toMemberId: memberA,
					expected: {
						netCents: 1000,
						settleableCents: 500,
						splits: [{ id: '44444444-4444-4444-8444-444444444444', amountCents: -1 }],
					},
				}),
			).toEqual({ ok: false, reason: 'invalid' });

			expect(
				parseSettlementConfirmation({
					fromMemberId: memberB,
					toMemberId: memberA,
					expected: {
						netCents: 1000,
						settleableCents: 1000,
						splits: [],
					},
					extra: 'not-supported',
				}),
			).toEqual({ ok: false, reason: 'invalid' });
		});
	});

	test.describe('Settlement HTTP cache policy', () => {
		test.skip(
			process.env.BASE_URL === noHttpBaseUrl,
			'HTTP checks are intentionally skipped for the no-network pure-test run',
		);

		test('sets no-store on an invalid share-code preamble response', async ({ request }) => {
			const response = await request.get(
				`/api/wg/not-a-code/expenses/settle-batch?fromMemberId=${memberA}&toMemberId=${memberB}`,
			);

			expect(response.status()).toBe(400);
			expect(response.headers()['cache-control']).toBe('private, no-store');
			await expect(response.json()).resolves.toMatchObject({ error: 'invalid_share_code' });
		});

		test('sets no-store on a withWgRoute authentication rejection', async ({ request }) => {
			test.skip(
				process.env.CI !== 'true' || process.env.NEXT_PUBLIC_DB_DOWN !== 'true',
				'the fixture authentication case requires the local DB-down fixture server',
			);

			const response = await request.get(
				`/api/wg/MTE8PZAT/expenses/settle-batch?fromMemberId=${memberA}&toMemberId=${memberB}`,
				{ headers: { 'x-manawg-expected-member-id': fixtureMemberId } },
			);

			expect(response.status()).toBe(401);
			expect(response.headers()['cache-control']).toBe('private, no-store');
			await expect(response.json()).resolves.toMatchObject({ error: 'auth_required' });
		});
	});
});

test.describe('currency-scoped accounting', () => {
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
			const payments = [
				{ fromMemberId: ben, toMemberId: alice, amountCents: 1000, currency: 'EUR' },
			];

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
			expect(
				formatNotificationMessage('expense.debt_settled', {
					actorName: 'Ben',
					amountCents: 2000,
					currency: 'CHF',
					direction: 'paid',
				}),
			).toMatchObject({ body: expect.stringContaining('CHF'), urlPath: '/ausgaben' });

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
				now: new Date('2026-01-15T12:00:00.000Z').getTime(),
			});
			expect(today[0]?.detail).toContain('CHF');
		});
	});
});
