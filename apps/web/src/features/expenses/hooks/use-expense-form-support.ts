'use client';

import { isOfflineActionQueued, updateOfflineQueue } from '@/core/offline/offline-client';
import { QUEUE_EDIT_ALREADY_SENT_MESSAGE } from '@/core/offline/offline-copy';
import type { OfflineActionType } from '@/core/offline/offline-queue';
import type {
	ExpenseFormField,
	ExpenseFormFieldErrors,
} from '@/features/expenses/components/ausgaben/ExpenseFormSection';
import {
	type SplitInputResult,
	buildSplitsFromForm,
} from '@/features/expenses/expense-split-input';
import { useEffect, useState } from 'react';
import type { ExpenseFormState, ExpensePageContext } from './expense-page-context';

/** Field validation state and the queue/split helpers the expense and template save paths share. */
export function useExpenseFormSupport(
	{ members, expenses, notify, reload }: ExpensePageContext,
	form: ExpenseFormState,
) {
	const [fieldErrors, setFieldErrors] = useState<ExpenseFormFieldErrors>({});
	const [validationAttempt, setValidationAttempt] = useState(0);

	useEffect(() => {
		if (!form.showForm) setFieldErrors({});
	}, [form.showForm]);

	function setValidationErrors(errors: ExpenseFormFieldErrors): void {
		setFieldErrors(errors);
		setValidationAttempt((attempt) => attempt + 1);
	}

	function clearFieldError(field: ExpenseFormField): void {
		setFieldErrors((current) => {
			if (!current[field]) return current;
			const next = { ...current };
			delete next[field];
			return next;
		});
	}

	function buildSplits(amountCents: number): SplitInputResult {
		return buildSplitsFromForm({
			splitMode: form.splitMode,
			members,
			manualSplits: form.manualSplits,
			participantIds: form.extras.participantIds,
			amountCents,
			// Cycles the "+1 cent" recipient across expenses so the same person
			// doesn't always eat the leftover cent on uneven splits.
			rotationOffset: expenses.length,
			// Editing keeps the saved per-member shares when nothing that
			// affects them changed, so a settled share is not reopened.
			previousSplits: form.editingExpense
				? expenses.find((expense) => expense.id === form.editingExpense?.id)?.splits
				: undefined,
		});
	}

	async function clearEditedQueueItem(expectedTypes?: OfflineActionType[]): Promise<boolean> {
		const { queueEditId } = form;
		if (!queueEditId) return true;
		const saved = await updateOfflineQueue((actions) => {
			const queued = actions.find((item) => item.id === queueEditId);
			if (!queued || (expectedTypes && !expectedTypes.includes(queued.type))) return null;
			return actions.filter((item) => item.id !== queueEditId);
		});
		if (!saved) return false;
		form.setQueueEditId(null);
		form.setQueueEditType(null);
		form.setRecurringNextDueAt(null);
		return true;
	}

	/** The edited queue entry may have been synced meanwhile; a new create would duplicate it. */
	function discardSentQueueEdit(type: OfflineActionType): boolean {
		const { queueEditId, queueEditType } = form;
		if (!queueEditId || queueEditType !== type || isOfflineActionQueued(queueEditId)) return false;
		form.resetForm();
		form.setShowForm(false);
		notify.warning(QUEUE_EDIT_ALREADY_SENT_MESSAGE);
		void reload();
		return true;
	}

	return {
		fieldErrors,
		validationAttempt,
		setFieldErrors,
		setValidationErrors,
		clearFieldError,
		buildSplits,
		clearEditedQueueItem,
		discardSentQueueEdit,
	};
}

export type ExpenseFormSupport = ReturnType<typeof useExpenseFormSupport>;
