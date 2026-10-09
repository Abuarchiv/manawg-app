'use client';

import { apiFetch } from '@/core/infra/api-client';
import type { RecurringExpense } from '@/features/expenses/components/ausgaben/expense-types';
import { recurringTemplateDeleteErrorMessage } from '@/features/expenses/expense-errors';
import type { ExpenseFormState, ExpensePageContext } from './expense-page-context';
import type { ExpenseFormSupport } from './use-expense-form-support';
import { useRecurringBooking } from './use-recurring-booking';
import { useRecurringTemplateSave } from './use-recurring-template-save';

/**
 * Fixed-cost templates ("Fixkosten-Vorlagen"): save/edit a template, book an expense from one,
 * delete one, and advance a template's due date after it was booked.
 */
export function useRecurringExpenseActions(
	ctx: ExpensePageContext,
	form: ExpenseFormState,
	support: ExpenseFormSupport,
) {
	const { identity, toast, notify, pending, recurringExpenses, updateRecurringExpenses, reload } =
		ctx;
	const recurringApiUrl = `/api/wg/${encodeURIComponent(ctx.wg.shareCode)}/recurring-expenses`;
	const templateSave = useRecurringTemplateSave(ctx, form, support);
	const booking = useRecurringBooking(ctx);

	async function deleteRecurringTemplate(template: RecurringExpense): Promise<void> {
		if (pending.isPending(template.id)) return;
		pending.start(template.id);
		notify.error(null);
		const previousTemplateIndex = recurringExpenses.findIndex((item) => item.id === template.id);
		updateRecurringExpenses((current) => current.filter((item) => item.id !== template.id));

		const res = await apiFetch<unknown>(recurringApiUrl, {
			method: 'DELETE',
			memberId: identity.memberId,
			body: JSON.stringify({ id: template.id }),
		});

		const alreadyGone =
			!res.ok && res.status === 404 && res.error === 'recurring_expense_not_found';
		if (!res.ok && !alreadyGone) {
			updateRecurringExpenses((current) => {
				if (current.some((item) => item.id === template.id)) return current;
				const restored = [...current];
				restored.splice(Math.min(previousTemplateIndex, restored.length), 0, template);
				return restored;
			});
			const message = recurringTemplateDeleteErrorMessage(res.error);
			notify.error(message);
			toast.error(message);
			pending.end(template.id);
			return;
		}

		if (form.editingRecurringExpense?.id === template.id) {
			form.resetForm();
			form.setShowForm(false);
		}
		if (alreadyGone) {
			notify.error('Diese Fixkosten-Vorlage existiert nicht mehr und wurde entfernt.');
		} else {
			notify.success('Fixkosten-Vorlage gelöscht.');
		}
		pending.end(template.id);
		void reload();
	}

	return {
		saveRecurringTemplate: templateSave.saveRecurringTemplate,
		createFromRecurringTemplate: booking.createFromRecurringTemplate,
		deleteRecurringTemplate,
		savingRecurringTemplate: templateSave.savingRecurringTemplate,
		creatingRecurringId: booking.creatingRecurringId,
		forgetPendingRequest: templateSave.forgetPendingRequest,
	};
}
