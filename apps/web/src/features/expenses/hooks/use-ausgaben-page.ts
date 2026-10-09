'use client';

import { useToast } from '@/components/ui/Toast';
import type { ActionNotice } from '@/components/wg/ActionNoticeBanner';
import { useWg } from '@/components/wg/WgContextProvider';
import { usePendingSet } from '@/core/hooks/usePendingSet';
import { useStableCallback } from '@/core/hooks/useStableCallback';
import { parseEuroAmount } from '@/core/utils/amount';
import { CENTS_PER_EURO } from '@/core/utils/money';
import { formatWeekLabel, parseValidDate, startOfWeek } from '@/core/utils/time';
import {
	AMOUNT_MAX_EUROS,
	AMOUNT_MIN_EUROS,
} from '@/features/expenses/components/ausgaben/constants';
import { useExpenseForm } from '@/features/expenses/components/ausgaben/useExpenseForm';
import {
	buildSettlementSummary,
	computeDirectDebts,
	computeNetBalances,
} from '@/features/expenses/debt-reduction';
import { type ExpenseScope, filterExpenses } from '@/features/expenses/expense-filter';
import {
	payerOptions,
	settledSharesAffectedByEdit,
	splitCandidates,
} from '@/features/expenses/expense-split-input';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionNotifier, ExpensePageContext } from './expense-page-context';
import { useExpenseFormSupport } from './use-expense-form-support';
import { useExpenseRowActions } from './use-expense-row-actions';
import { useExpenseSubmit } from './use-expense-submit';
import { useExpensesData } from './use-expenses-data';
import { useRecurringExpenseActions } from './use-recurring-expense-actions';

/** Entries per page in the history; balances and export still use all entries. */
const EXPENSE_RENDER_PAGE = 60;
/** The recurring-expense preview shows at most this many templates unless the filter is active. */
const RECURRING_PREVIEW_LIMIT = 4;

/** Expenses page: loads data, keeps form and mutations together and provides the display derivations. */
export function useAusgabenPage() {
	const { wg, members, identity, isAdmin } = useWg();
	const toast = useToast();
	const searchParams = useSearchParams();
	const router = useRouter();
	const pathname = usePathname();
	const highlightedId = searchParams.get('highlight');
	const openNewExpense = searchParams.get('new') === '1';
	const recurringId = searchParams.get('recurring');
	const recurringFilterActive = searchParams.get('filter') === 'recurring';

	const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
	const notify: ActionNotifier = {
		error: (message) => setActionNotice(message ? { message, tone: 'error' } : null),
		warning: (message) => setActionNotice({ message, tone: 'warning' }),
		// Success as a floating toast: an in-flow banner would stay, reappear in the next form and push the page.
		success: (message) => toast.success(message),
	};
	const pending = usePendingSet();

	const data = useExpensesData({
		shareCode: wg.shareCode,
		memberId: identity.memberId,
		setActionNotice,
	});
	const { expenses, recurringExpenses } = data;

	// Everything the form itself edits, plus its localStorage draft.
	const form = useExpenseForm({
		shareCode: wg.shareCode,
		members,
		identityMemberId: identity.memberId,
		prefillDescription: searchParams.get('desc'),
		prefillAmount: searchParams.get('amount'),
		prefillPaidBy: searchParams.get('paidBy'),
		recurringId,
		recurringExpenses,
	});
	const { setShowForm } = form;

	const ctx: ExpensePageContext = {
		wg,
		identity,
		members,
		toast,
		notify,
		pending,
		expenses,
		recurringExpenses,
		updateExpenses: data.updateExpenses,
		updateRecurringExpenses: data.updateRecurringExpenses,
		reload: async () => {
			await data.load(false);
		},
		refreshQueuedCount: data.refreshQueuedCount,
	};
	const support = useExpenseFormSupport(ctx, form);
	const recurring = useRecurringExpenseActions(ctx, form, support);
	const expenseSubmit = useExpenseSubmit(ctx, form, support);
	const rowActions = useExpenseRowActions(ctx);

	useEffect(() => {
		if (openNewExpense) setShowForm(true);
	}, [openNewExpense, setShowForm]);

	// Remove the deep-link parameter only on close (cancel, save): a reload with
	// the form open restores it again, but afterwards it does not reopen unprompted.
	const prevShowFormRef = useRef(form.showForm);
	useEffect(() => {
		const wasOpen = prevShowFormRef.current;
		prevShowFormRef.current = form.showForm;
		if (!wasOpen || form.showForm) return;
		const next = new URLSearchParams(searchParams.toString());
		let changed = false;
		for (const key of ['new', 'desc', 'amount', 'paidBy', 'recurring']) {
			if (next.has(key)) {
				next.delete(key);
				changed = true;
			}
		}
		if (!changed) return;
		const query = next.toString();
		router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
	}, [form.showForm, searchParams, router, pathname]);

	const expenseCount = expenses.length;
	useEffect(() => {
		if (!highlightedId || expenseCount === 0) return;
		const timerId = window.setTimeout(() => {
			document.getElementById(`expense-${highlightedId}`)?.scrollIntoView({
				block: 'center',
			});
		}, 80);
		return () => window.clearTimeout(timerId);
	}, [highlightedId, expenseCount]);

	useEffect(() => {
		if (!recurringFilterActive && !recurringId) return;
		const timerId = window.setTimeout(() => {
			document.getElementById('recurring-expenses')?.scrollIntoView({
				block: 'start',
			});
		}, 80);
		return () => window.clearTimeout(timerId);
	}, [recurringFilterActive, recurringId]);

	function memberName(id: string): string {
		return members.find((m) => m.id === id)?.name ?? '?';
	}

	function memberPayPalMerchantId(id: string): string | null {
		return members.find((m) => m.id === id)?.paypalMerchantId ?? null;
	}

	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	function toggleExpand(id: string): void {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	const stableToggleExpand = useStableCallback(toggleExpand);
	const stableDelete = useStableCallback(rowActions.deleteExpense);
	const stableEdit = useStableCallback(form.startEdit);
	const stableToggleSettle = useStableCallback(rowActions.toggleSettle);
	const stableMemberName = useStableCallback(memberName);

	// History by calendar week; the API returns newest first.
	// Render only the newest entries (balances still use all); "Mehr anzeigen" loads more.
	const [visibleLimit, setVisibleLimit] = useState(EXPENSE_RENDER_PAGE);
	const [searchQuery, setSearchQuery] = useState('');
	const [scope, setScope] = useState<ExpenseScope>('all');
	const shownExpenses = useMemo(
		() =>
			filterExpenses(expenses, { query: searchQuery, scope }, identity.memberId, stableMemberName),
		[expenses, searchQuery, scope, identity.memberId, stableMemberName],
	);
	const highlightIndex = highlightedId
		? shownExpenses.findIndex((e) => e.id === highlightedId)
		: -1;
	const renderLimit = Math.max(visibleLimit, highlightIndex + 1);
	const expenseWeeks = useMemo(() => {
		const weeks: Array<{ label: string; items: typeof expenses }> = [];
		const now = new Date();
		for (const expense of shownExpenses.slice(0, renderLimit)) {
			const date = parseValidDate(expense.occurredAt);
			const label = date ? formatWeekLabel(startOfWeek(date), now) : 'Datum unbekannt';
			const current = weeks.at(-1);
			if (current?.label === label) current.items.push(expense);
			else weeks.push({ label, items: [expense] });
		}
		return weeks;
	}, [shownExpenses, renderLimit]);

	const { payments } = data;
	const balanceMembers = useMemo(
		() =>
			members.map((member) => ({ id: member.id, name: member.name, color: member.color ?? null })),
		[members],
	);
	const directDebts = useMemo(
		() => computeDirectDebts(expenses, balanceMembers, payments),
		[expenses, balanceMembers, payments],
	);
	const memberBalances = useMemo(
		() =>
			computeNetBalances(expenses, balanceMembers, payments).map(({ cents, ...member }) => ({
				...member,
				balanceCents: cents,
				active: members.find((m) => m.id === member.memberId)?.active !== false,
			})),
		[expenses, balanceMembers, payments, members],
	);
	const settlementSummary = useMemo(
		() => buildSettlementSummary(expenses, balanceMembers, payments),
		[expenses, balanceMembers, payments],
	);

	const selectedRecurringExpense = useMemo(
		() => recurringExpenses.find((item) => item.id === recurringId) ?? null,
		[recurringExpenses, recurringId],
	);
	const visibleRecurringExpenses = useMemo(() => {
		if (recurringFilterActive) return recurringExpenses;
		const firstItems = recurringExpenses.slice(0, RECURRING_PREVIEW_LIMIT);
		if (
			!selectedRecurringExpense ||
			firstItems.some((item) => item.id === selectedRecurringExpense.id)
		) {
			return firstItems;
		}
		return [selectedRecurringExpense, ...firstItems].slice(0, RECURRING_PREVIEW_LIMIT);
	}, [recurringExpenses, recurringFilterActive, selectedRecurringExpense]);

	const previewAmount = parseEuroAmount(form.amountStr);
	const splitPreview =
		previewAmount !== null && previewAmount >= AMOUNT_MIN_EUROS && previewAmount <= AMOUNT_MAX_EUROS
			? support.buildSplits(Math.round(previewAmount * CENTS_PER_EURO))
			: null;
	const editedExpense = form.editingExpense
		? expenses.find((expense) => expense.id === form.editingExpense?.id)
		: undefined;
	const reopenedShares =
		editedExpense && splitPreview?.ok
			? settledSharesAffectedByEdit(
					editedExpense.splits,
					splitPreview.splits,
					editedExpense.paidByMemberId,
				)
			: [];
	const formCurrency = form.editingExpense
		? (expenses.find((expense) => expense.id === form.editingExpense?.id)?.currency ??
			form.editingExpense.currency ??
			'EUR')
		: (form.editingRecurringExpense?.currency ?? 'EUR');

	function clearPendingCreateRequests(): void {
		expenseSubmit.forgetPendingRequest();
		recurring.forgetPendingRequest();
	}

	return {
		wg,
		members,
		identity,
		isAdmin,
		wgBaseHref: `/wg/${encodeURIComponent(wg.shareCode)}`,
		highlightedId,
		recurringId,
		recurringFilterActive,
		data,
		form,
		support,
		recurring,
		submit: expenseSubmit,
		actionNotice,
		notify,
		pending,
		showSkeleton: data.initialLoading && expenses.length === 0,
		expanded,
		expenseWeeks,
		hasMoreExpenses: renderLimit < shownExpenses.length,
		hiddenExpenseCount: Math.max(0, shownExpenses.length - renderLimit),
		shownExpenseCount: shownExpenses.length,
		searchQuery,
		setSearchQuery,
		scope,
		setScope,
		showMoreExpenses: () => setVisibleLimit(renderLimit + EXPENSE_RENDER_PAGE),
		directDebts,
		memberBalances,
		settlementSummary,
		visibleRecurringExpenses,
		hiddenRecurringCount: recurringExpenses.length - visibleRecurringExpenses.length,
		selectablePayers: payerOptions(members, form.paidByMemberId),
		// A member who moved out ("Auszug") drops out of every picker, while the
		// full `members` list stays in use for name/colour/balance lookups so the
		// history keeps resolving. See expense-split-input.ts for the cases where a
		// moved-out member has to be offered anyway.
		selectableSplitMembers: splitCandidates(members, form.splitMode, form.manualSplits),
		splitPreview,
		reopenedShares,
		formCurrency,
		clearPendingCreateRequests,
		memberName,
		memberPayPalMerchantId,
		stable: {
			toggleExpand: stableToggleExpand,
			deleteExpense: stableDelete,
			edit: stableEdit,
			toggleSettle: stableToggleSettle,
			memberName: stableMemberName,
		},
	};
}
