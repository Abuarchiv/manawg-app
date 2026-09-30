import { expect, test } from '@playwright/test';
import * as offlineClient from '../src/core/offline/offline-client';
import { type ActivityItem, filterActivityByScope } from '../src/core/reads/activity';
import { buildChoreFairness } from '../src/features/chores/chore-fairness';

const NOW = Date.parse('2026-09-19T12:00:00.000Z');

function activity(id: string, text: string, completed: boolean): ActivityItem {
	return {
		id,
		kind: 'chore',
		timestamp: new Date(NOW).toISOString(),
		memberId: 'member-1',
		memberName: 'Abu',
		text,
		completed,
	} as ActivityItem;
}

test('retries a recurring advance carried by an expense action', () => {
	const createRetry = Reflect.get(offlineClient, 'createRecurringAdvanceRetry') as
		| ((action: Record<string, unknown>, now: number) => unknown)
		| undefined;

	expect(createRetry).toBeDefined();
	const retry = createRetry?.(
		{
			id: 'queued-recurring',
			type: 'expense.create',
			shareCode: 'WGCODE',
			memberId: 'member-1',
			createdAt: new Date(NOW).toISOString(),
			payload: {
				recurringExpenseId: 'recurring-1',
				expectedRecurringNextDueAt: '2026-10-01T00:00:00.000Z',
			},
		},
		NOW,
	);

	expect(retry).toMatchObject({
		type: 'recurring.advance',
		payload: {
			recurringExpenseId: 'recurring-1',
			expectedRecurringNextDueAt: '2026-10-01T00:00:00.000Z',
		},
	});
});

test('activity done and changes scopes respect chore completion state', () => {
	const items = [activity('open', 'Flur geplant', false), activity('done', 'Bad erledigt', true)];

	expect(filterActivityByScope(items, 'done', 'Abu', 'member-1').map((item) => item.id)).toEqual([
		'done',
	]);
	expect(filterActivityByScope(items, 'changes', 'Abu', 'member-1').map((item) => item.id)).toEqual(
		['open'],
	);
});

test('uses the API-repeated open-gap total once for an assignee', () => {
	const fairness = buildChoreFairness({
		members: [{ id: 'member-1', name: 'Abu' }],
		chores: [
			{
				assignedMemberId: 'member-1',
				openGapCountForAssignee: 2,
				nextDueAt: '2026-09-20T12:00:00.000Z',
			},
			{
				assignedMemberId: 'member-1',
				openGapCountForAssignee: 2,
				nextDueAt: '2026-09-20T12:00:00.000Z',
			},
		],
		now: NOW,
	});

	expect(fairness.rows[0]).toMatchObject({ openGapCount: 2, score: 10 });
});
