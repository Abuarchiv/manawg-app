import assert from 'node:assert/strict';
import test from 'node:test';

const { filterExpenses } = await import('./expense-filter');

const expense = (id: string, description: string, paidBy: string, debtors: string[]) => ({
	id,
	description,
	paidByMemberId: paidBy,
	amountCents: 1000,
	currency: 'EUR',
	imageUrl: null,
	occurredAt: '2026-01-01T12:00:00.000Z',
	createdAt: '2026-01-01T12:00:00.000Z',
	updatedAt: '2026-01-01T12:00:00.000Z',
	splits: debtors.map((debtorMemberId) => ({
		id: `${id}-${debtorMemberId}`,
		debtorMemberId,
		amountCents: 500,
		settledAt: null,
	})),
});
const list = [
	expense('1', 'Wocheneinkauf REWE', 'me', ['me', 'tim']),
	expense('2', 'Strom', 'tim', ['tim', 'me']),
	expense('3', 'Pizza', 'tim', ['tim', 'ann']),
];
const names: Record<string, string> = { me: 'Mia', tim: 'Tim', ann: 'Ann' };
const name = (id: string) => names[id] ?? '?';
const ids = (items: ReadonlyArray<{ id: string }>) => items.map((item) => item.id);

test('the history filter matches description and payer name case-insensitively', () => {
	assert.deepEqual(ids(filterExpenses(list, { query: ' rewe ', scope: 'all' }, 'me', name)), ['1']);
	assert.deepEqual(ids(filterExpenses(list, { query: 'TIM', scope: 'all' }, 'me', name)), [
		'2',
		'3',
	]);
	assert.deepEqual(ids(filterExpenses(list, { query: '', scope: 'all' }, 'me', name)), [
		'1',
		'2',
		'3',
	]);
});

test('the history filter narrows by the member role', () => {
	assert.deepEqual(ids(filterExpenses(list, { query: '', scope: 'paid' }, 'me', name)), ['1']);
	assert.deepEqual(ids(filterExpenses(list, { query: '', scope: 'involved' }, 'me', name)), [
		'1',
		'2',
	]);
	assert.deepEqual(ids(filterExpenses(list, { query: 'strom', scope: 'involved' }, 'me', name)), [
		'2',
	]);
});
