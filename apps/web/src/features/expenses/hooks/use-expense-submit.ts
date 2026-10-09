'use client';

import { apiFetch } from '@/core/infra/api-client';
import type { NotificationWarning } from '@/core/notifications/notification-warning';
import { notificationWarningMessage } from '@/core/notifications/notification-warning';
import { removeDraft } from '@/core/offline/drafts';
import { enqueueOfflineAction } from '@/core/offline/offline-client';
import {
	DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE,
	OFFLINE_SAVED_NOTICE,
} from '@/core/offline/offline-copy';
import {
	createOfflineIdempotencyKey,
	createQueuedExpense,
	createQueuedExpenseUpdate,
} from '@/core/offline/offline-queue';
import { parseEuroAmount } from '@/core/utils/amount';
import { inputDateToIso, todayInputValue } from '@/core/utils/local-date';
import { CENTS_PER_EURO } from '@/core/utils/money';
import type { ExpenseFormFieldErrors } from '@/features/expenses/components/ausgaben/ExpenseFormSection';
import {
	AMOUNT_MAX_EUROS,
	AMOUNT_MIN_EUROS,
	DESCRIPTION_MAX,
	amountErrorMessage,
} from '@/features/expenses/components/ausgaben/constants';
import type { Expense } from '@/features/expenses/components/ausgaben/expense-types';
import { isoToInputDate } from '@/features/expenses/components/ausgaben/use-expense-form-extras';
import {
	expenseSaveErrorMessage,
	isPermanentClientError,
	splitInputErrorMessage,
} from '@/features/expenses/expense-errors';
import { manualSplitsFingerprint } from '@/features/expenses/expense-split-input';
import {
	buildOptimisticExpense,
	sortExpensesNewestFirst,
} from '@/features/expenses/optimistic-expense';
import { withQueuedOccurredAt } from '@/features/expenses/queued-occurred-at';
import type { DebtorShare } from '@/features/expenses/split-math';
import { useRef, useState } from 'react';
import type { ExpenseFormState, ExpensePageContext } from './expense-page-context';
import type { ExpenseFormSupport } from './use-expense-form-support';

export type ExpenseCreateResponse = { expense: Expense; warning: NotificationWarning };
type ExpenseMutationResponse = Expense | ExpenseCreateResponse;

/**
 * Create/edit of a single expense: validation, optimistic list update,
 * request with idempotency key (reused while the same unsent form is
 * retried) and offline queueing. A booked recurring template is advanced by the
 * server in the same transaction as the expense.
 */
export function useExpenseSubmit(
	ctx: ExpensePageContext,
	form: ExpenseFormState,
	support: ExpenseFormSupport,
) {
	const {
		wg,
		identity,
		toast,
		notify,
		pending,
		expenses,
		recurringExpenses,
		updateExpenses,
		reload,
		refreshQueuedCount,
	} = ctx;
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const [submitting, setSubmitting] = useState(false);
	const submittingRef = useRef(false);
	const pendingRequestRef = useRef<{
		fingerprint: string;
		key: string;
		splits: DebtorShare[];
		expectedRecurringNextDueAt?: string;
	} | null>(null);

	async function submit(): Promise<void> {
		const {
			editingExpense,
			recurringSourceId,
			queueEditType,
			splitMode,
			paidByMemberId,
			imageUrl,
		} = form;
		support.setFieldErrors({});
		if (form.invalidEditDraft) {
			form.setFormError(
				'Die Zuordnung dieses Entwurfs ist beschädigt. Öffne die ursprüngliche Ausgabe erneut oder verwirf den Entwurf.',
			);
			return;
		}
		if (!submittingRef.current && support.discardSentQueueEdit('expense.create')) return;
		form.setFormError(null);
		form.setConflictExpenseId(null);
		const desc = form.description.trim();
		const amountEuros = parseEuroAmount(form.amountStr);
		const validationErrors: ExpenseFormFieldErrors = {};
		if (desc.length === 0 || desc.length > DESCRIPTION_MAX) {
			validationErrors.description = 'Gib eine kurze Beschreibung ein.';
		}
		if (amountEuros === null || amountEuros < AMOUNT_MIN_EUROS || amountEuros > AMOUNT_MAX_EUROS) {
			validationErrors.amount = amountErrorMessage(amountEuros, form.amountStr);
		}
		const { occurredOn } = form.extras;
		if (occurredOn.length === 0 || occurredOn > todayInputValue()) {
			validationErrors.date = 'Wähle ein Datum, das nicht in der Zukunft liegt.';
		}
		if (Object.keys(validationErrors).length > 0) {
			support.setValidationErrors(validationErrors);
			return;
		}
		if (amountEuros === null) return;
		const amountCents = Math.round(amountEuros * CENTS_PER_EURO);
		const isEdit = editingExpense !== null;
		const fingerprint = JSON.stringify({
			recurringSourceId,
			description: desc,
			amountCents,
			paidByMemberId,
			imageUrl,
			splitMode,
			manualSplits: manualSplitsFingerprint(splitMode, form.manualSplits),
			participantIds: splitMode === 'equal' ? form.extras.participantIds : null,
			occurredOn,
		});
		const pendingRequest = pendingRequestRef.current;
		const reusePendingRequest = !isEdit && pendingRequest?.fingerprint === fingerprint;
		const recurringTemplateForCreate =
			!isEdit && recurringSourceId
				? recurringExpenses.find((item) => item.id === recurringSourceId)
				: null;
		// An edited queued booking keeps the template due date it was queued against.
		const queuedRecurringNextDueAt =
			!isEdit && recurringSourceId && queueEditType === 'expense.create'
				? form.recurringNextDueAt
				: null;
		const expectedRecurringNextDueAt = recurringSourceId
			? reusePendingRequest && pendingRequest?.expectedRecurringNextDueAt
				? pendingRequest.expectedRecurringNextDueAt
				: (queuedRecurringNextDueAt ?? recurringTemplateForCreate?.nextDueAt)
			: undefined;
		if (!isEdit && recurringSourceId && !expectedRecurringNextDueAt) {
			notify.error(
				'Fixkosten-Vorlage ist nicht verfügbar. Aktualisiere die Seite und versuche es erneut.',
			);
			return;
		}
		let splits: DebtorShare[];
		if (reusePendingRequest && pendingRequest) {
			splits = pendingRequest.splits;
		} else {
			const splitResult = support.buildSplits(amountCents);
			if (!splitResult.ok) {
				support.setValidationErrors({ splits: splitInputErrorMessage(splitResult.reason) });
				return;
			}
			splits = splitResult.splits;
		}

		if (submittingRef.current) return;
		submittingRef.current = true;
		const finishSubmitting = () => {
			submittingRef.current = false;
			setSubmitting(false);
		};
		setSubmitting(true);

		const recurringSource =
			recurringSourceId && expectedRecurringNextDueAt
				? { recurringExpenseId: recurringSourceId, expectedRecurringNextDueAt }
				: {};
		// Only a changed day is sent: an unchanged one keeps the real time of day.
		const editedOccurredAt = isEdit
			? expenses.find((expense) => expense.id === editingExpense.id)?.occurredAt
			: undefined;
		const dateChanged =
			occurredOn !== (editedOccurredAt ? isoToInputDate(editedOccurredAt) : todayInputValue());
		const occurredAt = dateChanged ? inputDateToIso(occurredOn) : null;
		const requestBody = {
			...(occurredAt ? { occurredAt } : {}),
			paidByMemberId,
			amountCents,
			description: desc,
			imageUrl,
			splits,
			expectedUpdatedAt: editingExpense?.updatedAt,
			...recurringSource,
		};
		const idempotencyKey = isEdit
			? null
			: reusePendingRequest && pendingRequest
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!isEdit && !idempotencyKey) {
			notify.error('Ausgabe konnte nicht sicher gesendet werden. Versuche es erneut.');
			finishSubmitting();
			return;
		}
		if (!isEdit && idempotencyKey) {
			pendingRequestRef.current = {
				fingerprint,
				key: idempotencyKey,
				splits,
				...(expectedRecurringNextDueAt ? { expectedRecurringNextDueAt } : {}),
			};
		}
		const url = isEdit
			? `/api/wg/${encodedShareCode}/expenses/${encodeURIComponent(editingExpense.id)}`
			: `/api/wg/${encodedShareCode}/expenses`;
		const optimisticId = isEdit ? editingExpense.id : `pending:${idempotencyKey}`;
		const previousExpense = isEdit
			? (expenses.find((expense) => expense.id === editingExpense.id) ?? null)
			: null;
		const rollbackOptimisticExpense = () =>
			updateExpenses((current) => {
				if (!previousExpense) return current.filter((expense) => expense.id !== optimisticId);
				return current.some((expense) => expense.id === previousExpense.id)
					? current.map((expense) =>
							expense.id === previousExpense.id ? previousExpense : expense,
						)
					: [previousExpense, ...current];
			});
		const optimisticExpense = buildOptimisticExpense({
			id: optimisticId,
			description: desc,
			amountCents,
			paidByMemberId,
			imageUrl,
			splits,
			...(occurredAt ? { occurredAt } : {}),
			...(previousExpense ? { previous: previousExpense } : {}),
		});
		pending.start(optimisticId);
		updateExpenses((current) =>
			sortExpensesNewestFirst(
				isEdit
					? current.map((expense) =>
							expense.id === editingExpense.id ? optimisticExpense : expense,
						)
					: [optimisticExpense, ...current],
			),
		);
		const res = await apiFetch<ExpenseMutationResponse>(url, {
			method: isEdit ? 'PATCH' : 'POST',
			memberId: identity.memberId,
			...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
			body: JSON.stringify(requestBody),
		});

		if (!res.ok) {
			if (res.status === 0) {
				const queuedAction = isEdit
					? withQueuedOccurredAt(
							createQueuedExpenseUpdate({
								expenseId: editingExpense.id,
								expectedUpdatedAt: editingExpense.updatedAt,
								wgId: wg.id,
								shareCode: wg.shareCode,
								memberId: identity.memberId,
								description: desc,
								amountCents,
								paidByMemberId,
								splits,
								imageUrl,
							}),
							occurredAt,
						)
					: withQueuedOccurredAt(
							createQueuedExpense({
								wgId: wg.id,
								shareCode: wg.shareCode,
								memberId: identity.memberId,
								...(idempotencyKey ? { idempotencyKey } : {}),
								description: desc,
								amountCents,
								paidByMemberId,
								splits,
								imageUrl,
								...recurringSource,
							}),
							occurredAt ?? new Date().toISOString(),
						);
				const queuedCount = await enqueueOfflineAction(queuedAction);
				if (queuedCount === 0) {
					rollbackOptimisticExpense();
					pending.end(optimisticId);
					finishSubmitting();
					notify.error(OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE);
					toast.error('Offline-Speicher ist blockiert. Die Ausgabe wurde zurückgesetzt.');
					return;
				}
				if (!isEdit) pendingRequestRef.current = null;
				refreshQueuedCount();
				if (!(await support.clearEditedQueueItem(['expense.create', 'expense.update']))) {
					pending.end(optimisticId);
					finishSubmitting();
					notify.error(OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE);
					toast.error(OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE);
					return;
				}
				form.resetForm();
				form.setShowForm(false);
				finishSubmitting();
				pending.end(optimisticId);
				removeDraft(form.draftKey);
				notify.warning(OFFLINE_SAVED_NOTICE);
				return;
			}
			if (!isEdit && isPermanentClientError(res.status)) {
				pendingRequestRef.current = null;
			}
			if (isEdit && res.status === 404 && res.error === 'expense_not_found') {
				form.setFormError(
					'Die ursprüngliche Ausgabe wurde gelöscht. Deine ungespeicherten Änderungen bleiben im Entwurf; du kannst sie kopieren oder den Entwurf verwerfen.',
				);
				updateExpenses((current) => current.filter((expense) => expense.id !== editingExpense.id));
				pending.end(optimisticId);
				notify.error('Diese Ausgabe existiert nicht mehr und wurde aus der Liste entfernt.');
				toast.error('Diese Ausgabe existiert nicht mehr.');
				void reload();
				finishSubmitting();
				return;
			}
			// Only the version check on edit is an edit conflict; other 409s
			// (e.g. recurring expense already taken over) have their own texts.
			const isConflict = res.status === 409 && res.error === 'expense_changed';
			const msg = isConflict
				? 'Diese Ausgabe wurde inzwischen geändert. Lade die Liste neu und entscheide dann, welche Version stimmt.'
				: expenseSaveErrorMessage(res.error);
			if (isConflict) form.setConflictExpenseId(editingExpense?.id ?? null);
			rollbackOptimisticExpense();
			pending.end(optimisticId);
			form.setFormError(msg);
			toast.error(msg);
			finishSubmitting();
			return;
		}

		if (!isEdit) pendingRequestRef.current = null;
		const savedExpense = 'expense' in res.data ? res.data.expense : res.data;
		const pushWarning = 'expense' in res.data ? notificationWarningMessage(res.data.warning) : null;
		updateExpenses((current) =>
			sortExpensesNewestFirst(
				isEdit
					? current.map((expense) => (expense.id === savedExpense.id ? savedExpense : expense))
					: [
							savedExpense,
							...current.filter(
								(expense) => expense.id !== optimisticId && expense.id !== savedExpense.id,
							),
						],
			),
		);
		pending.end(optimisticId);
		if (!(await support.clearEditedQueueItem(['expense.create', 'expense.update']))) {
			finishSubmitting();
			notify.error(DRAFT_CLEANUP_FAILED_MESSAGE);
			toast.error(DRAFT_CLEANUP_FAILED_MESSAGE);
			return;
		}
		form.resetForm();
		if (pushWarning) {
			notify.warning(pushWarning);
		} else {
			notify.success(
				isEdit
					? 'Ausgabe aktualisiert. Hier wird kein Geld überwiesen.'
					: 'Ausgabe gespeichert. Hier wird kein Geld überwiesen.',
			);
		}
		form.setShowForm(false);
		finishSubmitting();
		removeDraft(form.draftKey);
		void reload();
	}

	return {
		submit,
		submitting,
		forgetPendingRequest: () => {
			pendingRequestRef.current = null;
		},
	};
}
