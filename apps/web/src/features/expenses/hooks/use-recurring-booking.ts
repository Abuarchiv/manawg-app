'use client';

import { apiFetch } from '@/core/infra/api-client';
import { notificationWarningMessage } from '@/core/notifications/notification-warning';
import { enqueueOfflineAction, readOfflineQueue } from '@/core/offline/offline-client';
import { createOfflineIdempotencyKey, createQueuedExpense } from '@/core/offline/offline-queue';
import type { RecurringExpense } from '@/features/expenses/components/ausgaben/expense-types';
import {
	expenseSaveErrorMessage,
	isPermanentClientError,
} from '@/features/expenses/expense-errors';
import { buildOptimisticExpense } from '@/features/expenses/optimistic-expense';
import { withQueuedOccurredAt } from '@/features/expenses/queued-occurred-at';
import { isRecurringBookingQueued } from '@/features/expenses/recurring-template-plan';
import { useRef, useState } from 'react';
import type { ExpensePageContext } from './expense-page-context';
import type { ExpenseCreateResponse } from './use-expense-submit';

const OFFLINE_RECURRING_EXPENSE_MESSAGE =
	'Fixkosten-Ausgabe offline vorgemerkt. Die Vorlage bleibt bis zur Synchronisierung unverändert.';

/**
 * Booking a due fixed cost: create the expense from the template; the server advances the
 * template's due date with it. Offline, the expense is queued with the due date it books, so it
 * is booked once.
 */
export function useRecurringBooking(ctx: ExpensePageContext) {
	const { wg, identity, toast, notify, pending, updateExpenses, reload, refreshQueuedCount } = ctx;
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const [creatingRecurringId, setCreatingRecurringId] = useState<string | null>(null);
	const creatingRecurringRef = useRef(false);
	const expenseRequestsRef = useRef(
		new Map<string, { fingerprint: string; key: string; expectedRecurringNextDueAt: string }>(),
	);

	async function createFromRecurringTemplate(template: RecurringExpense): Promise<void> {
		if (creatingRecurringRef.current) return;
		const alreadyQueued = isRecurringBookingQueued(
			readOfflineQueue(),
			{ wgId: wg.id, shareCode: wg.shareCode, memberId: identity.memberId },
			template,
		);
		if (alreadyQueued) {
			notify.error(null);
			notify.warning(OFFLINE_RECURRING_EXPENSE_MESSAGE);
			return;
		}
		creatingRecurringRef.current = true;
		const finishCreating = () => {
			creatingRecurringRef.current = false;
			setCreatingRecurringId(null);
		};
		setCreatingRecurringId(template.id);
		notify.error(null);
		const requestBody = {
			description: template.description,
			amountCents: template.amountCents,
			paidByMemberId: template.paidByMemberId,
			splits: template.splits,
		};
		const fingerprint = JSON.stringify({ recurringExpenseId: template.id, ...requestBody });
		const pendingRequest = expenseRequestsRef.current.get(template.id);
		const reusePendingRequest = pendingRequest?.fingerprint === fingerprint;
		const expectedRecurringNextDueAt =
			reusePendingRequest && pendingRequest
				? pendingRequest.expectedRecurringNextDueAt
				: template.nextDueAt;
		const idempotencyKey =
			reusePendingRequest && pendingRequest ? pendingRequest.key : createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			notify.error('Fixkosten-Ausgabe konnte nicht sicher gesendet werden. Versuche es erneut.');
			finishCreating();
			return;
		}
		expenseRequestsRef.current.set(template.id, {
			fingerprint,
			key: idempotencyKey,
			expectedRecurringNextDueAt,
		});
		const optimisticId = `pending:${idempotencyKey}`;
		const rollbackOptimisticExpense = () =>
			updateExpenses((current) => current.filter((expense) => expense.id !== optimisticId));
		const optimisticExpense = buildOptimisticExpense({
			id: optimisticId,
			description: template.description,
			amountCents: template.amountCents,
			paidByMemberId: template.paidByMemberId,
			imageUrl: null,
			splits: template.splits,
		});
		pending.start(optimisticId);
		updateExpenses((current) => [optimisticExpense, ...current]);
		const createRes = await apiFetch<ExpenseCreateResponse>(
			`/api/wg/${encodedShareCode}/expenses`,
			{
				method: 'POST',
				memberId: identity.memberId,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({
					...requestBody,
					recurringExpenseId: template.id,
					expectedRecurringNextDueAt,
				}),
			},
		);
		if (!createRes.ok) {
			if (isPermanentClientError(createRes.status)) expenseRequestsRef.current.delete(template.id);
			if (createRes.status === 0) {
				const queuedCount = await enqueueOfflineAction(
					withQueuedOccurredAt(
						createQueuedExpense({
							wgId: wg.id,
							shareCode: wg.shareCode,
							memberId: identity.memberId,
							idempotencyKey,
							description: template.description,
							amountCents: template.amountCents,
							paidByMemberId: template.paidByMemberId,
							splits: template.splits,
							recurringExpenseId: template.id,
							expectedRecurringNextDueAt,
						}),
						new Date().toISOString(),
					),
				);
				if (queuedCount === 0) {
					rollbackOptimisticExpense();
					pending.end(optimisticId);
					notify.error(
						'Offline-Speicher ist blockiert. Die Fixkosten-Ausgabe konnte nicht vorgemerkt werden.',
					);
					toast.error('Die Fixkosten-Ausgabe wurde zurückgesetzt.');
					finishCreating();
					return;
				}
				expenseRequestsRef.current.delete(template.id);
				refreshQueuedCount();
				notify.warning(OFFLINE_RECURRING_EXPENSE_MESSAGE);
				pending.end(optimisticId);
				finishCreating();
				return;
			}
			rollbackOptimisticExpense();
			pending.end(optimisticId);
			const message = expenseSaveErrorMessage(createRes.error);
			notify.error(message);
			toast.error(message);
			finishCreating();
			// The template changed under us (already booked, paused or deleted): show its current state.
			if (isPermanentClientError(createRes.status)) void reload();
			return;
		}
		updateExpenses((current) => {
			const withoutOptimistic = current.filter((expense) => expense.id !== optimisticId);
			return withoutOptimistic.some((expense) => expense.id === createRes.data.expense.id)
				? withoutOptimistic
				: [createRes.data.expense, ...withoutOptimistic];
		});
		pending.end(optimisticId);
		// The server moved the template on in the same transaction as the booking.
		expenseRequestsRef.current.delete(template.id);
		const pushWarning = notificationWarningMessage(createRes.data.warning);
		if (pushWarning) notify.warning(pushWarning);
		else notify.success('Fixkosten-Ausgabe wurde erstellt.');
		finishCreating();
		void reload();
	}

	return { createFromRecurringTemplate, creatingRecurringId };
}
