import { expect, test } from '@playwright/test';
import { isEmptyModuleDraft } from '../src/core/offline/drafts';

const MEMBER = 'member-1';
const emptyChoreDraft = {
	title: '',
	recurrenceType: 'days',
	intervalDays: 7,
	assignedMemberId: '',
	absenceMemberId: MEMBER,
	absenceStartDate: '',
	absenceEndDate: '',
	absenceReason: '',
	queueEditId: null,
};

test('an untouched Putzplan draft with absence fields counts as empty', () => {
	expect(isEmptyModuleDraft('chore', emptyChoreDraft, MEMBER)).toBe(true);
	expect(isEmptyModuleDraft('chore', { ...emptyChoreDraft, title: 'Bad' }, MEMBER)).toBe(false);
	expect(isEmptyModuleDraft('chore', { ...emptyChoreDraft, absenceReason: 'Urlaub' }, MEMBER)).toBe(
		false,
	);
});

const emptyExpenseDraft = {
	description: '',
	amountStr: '',
	imageUrl: null,
	paidByMemberId: MEMBER,
	splitMode: 'equal',
	manualSplits: {},
	queueEditId: null,
	queueEditType: null,
	recurringIntervalMonths: 1,
	recurringNextDueAt: null,
	recurringSourceId: null,
	editingExpense: null,
	editingRecurringExpenseId: null,
};

test('a blank expense draft with recurring edit metadata remains empty', () => {
	expect(isEmptyModuleDraft('expense', emptyExpenseDraft, MEMBER)).toBe(true);
	const legacyDraft = Object.fromEntries(
		Object.entries(emptyExpenseDraft).filter(([key]) => key !== 'editingRecurringExpenseId'),
	);
	expect(isEmptyModuleDraft('expense', legacyDraft, MEMBER)).toBe(true);
	expect(
		isEmptyModuleDraft(
			'expense',
			{ ...emptyExpenseDraft, editingRecurringExpenseId: 'template-1' },
			MEMBER,
		),
	).toBe(false);
});
