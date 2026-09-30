'use client';
import { useToast } from '@/components/ui/Toast';
import { Button, buttonVariants } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { type ActionNotice, ActionNoticeBanner } from '@/components/wg/ActionNoticeBanner';
import { DebtSummary } from '@/components/wg/DebtSummary';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { OfflineQueueNotice } from '@/components/wg/OfflineQueueNotice';
import { SubNav } from '@/components/wg/SubNav';
import { ThumbAction } from '@/components/wg/ThumbAction';
import { useWg } from '@/components/wg/WgContextProvider';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { usePendingSet } from '@/core/hooks/usePendingSet';
import { apiFetch } from '@/core/infra/api-client';
import { captureException } from '@/core/infra/observability';
import { removeDraft } from '@/core/offline/drafts';
import {
	enqueueOfflineAction,
	isOfflineActionQueued,
	readOfflineQueue,
	syncOfflineActions,
	writeOfflineQueue,
} from '@/core/offline/offline-client';
import {
	DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE,
	QUEUE_EDIT_ALREADY_SENT_MESSAGE,
} from '@/core/offline/offline-copy';
import {
	type OfflineActionType,
	createOfflineIdempotencyKey,
	createQueuedExpense,
	createQueuedExpenseUpdate,
	createQueuedRecurring,
} from '@/core/offline/offline-queue';
import { useOfflineQueueSync } from '@/core/offline/useOfflineQueueSync';
import { parseEuroAmount } from '@/core/utils/amount';
import { CENTS_PER_EURO } from '@/core/utils/money';
import { formatWeekLabel, parseTimestamp, parseValidDate, startOfWeek } from '@/core/utils/time';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import { AusgabenHeader } from '@/features/expenses/components/ausgaben/AusgabenHeader';
import type {
	ExpenseFormField,
	ExpenseFormFieldErrors,
} from '@/features/expenses/components/ausgaben/ExpenseFormSection';
import { ExpenseRow } from '@/features/expenses/components/ausgaben/ExpenseRow';
import { ExpensesSkeleton } from '@/features/expenses/components/ausgaben/ExpensesSkeleton';
import { RecurringExpensesSection } from '@/features/expenses/components/ausgaben/RecurringExpensesSection';
import {
	AMOUNT_MAX_EUROS,
	AMOUNT_MIN_EUROS,
	DESCRIPTION_MAX,
} from '@/features/expenses/components/ausgaben/constants';
import type {
	Expense,
	ExpenseSplit,
	RecurringExpense,
} from '@/features/expenses/components/ausgaben/expense-types';
import { useExpenseForm } from '@/features/expenses/components/ausgaben/useExpenseForm';
import {
	buildSettlementSummary,
	computeDirectDebts,
	computeNetBalances,
} from '@/features/expenses/debt-reduction';
import {
	expenseActionErrorMessage,
	expenseSaveErrorMessage,
	recurringAdvanceWarningMessage,
	recurringTemplateDeleteErrorMessage,
	recurringTemplateSaveErrorMessage,
	splitInputErrorMessage,
} from '@/features/expenses/expense-errors';
import type { ExpensePaymentInput } from '@/features/expenses/expense-payments';
import {
	type SplitInputResult,
	buildSplitsFromForm,
	payerOptions,
	splitCandidates,
} from '@/features/expenses/expense-split-input';
import { addMonths } from '@/features/expenses/recurring-expenses';
import { cn } from '@/shared/lib/cn';
import { haptic } from '@/shared/lib/haptics';
import { FileInput, Plus } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const ExpenseFormSection = dynamic(
	() =>
		import('@/features/expenses/components/ausgaben/ExpenseFormSection').then(
			(module) => module.ExpenseFormSection,
		),
	{
		loading: () => (
			<output className="block text-sm text-[var(--text-2)]">Ausgabenformular wird geladen…</output>
		),
	},
);

type ExpenseCreateWarning = null | 'notification_delivery_failed' | 'notification_delivery_unknown';
type ExpenseCreateResponse = { expense: Expense; warning: ExpenseCreateWarning };
type ExpenseMutationResponse = Expense | ExpenseCreateResponse;

function expensePushWarningMessage(warning: ExpenseCreateWarning): string | null {
	if (warning === 'notification_delivery_failed') {
		return 'Gespeichert. Nicht alle Push-Benachrichtigungen konnten versendet werden.';
	}
	if (warning === 'notification_delivery_unknown') {
		return 'Gespeichert. Push-Versand konnte nicht bestätigt werden.';
	}
	return null;
}

function buildOptimisticExpense({
	id,
	description,
	amountCents,
	paidByMemberId,
	imageUrl,
	splits,
	previous,
}: {
	id: string;
	description: string;
	amountCents: number;
	paidByMemberId: string;
	imageUrl: string | null;
	splits: Array<{ debtorMemberId: string; amountCents: number }>;
	previous?: Expense;
}): Expense {
	const now = new Date().toISOString();
	return {
		id,
		paidByMemberId,
		amountCents,
		currency: previous?.currency ?? 'EUR',
		description,
		imageUrl,
		occurredAt: previous?.occurredAt ?? now,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
		splits: splits.map((split, index) => {
			const existing = previous?.splits.find(
				(current) => current.debtorMemberId === split.debtorMemberId,
			);
			return {
				id: existing?.id ?? `${id}:split:${index}`,
				debtorMemberId: split.debtorMemberId,
				amountCents: split.amountCents,
				settledAt: existing?.amountCents === split.amountCents ? existing.settledAt : null,
			};
		}),
	};
}

// ── Page ───────────────────────────────────────────────────────────────────────

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function AusgabenPage() {
	const { wg, members, identity } = useWg();
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const {
		data: cachedExpenses,
		error: expensesReadError,
		refresh: refreshExpenses,
		setData: setCachedExpenses,
	} = useCachedFetch<{ expenses: Expense[]; payments?: ExpensePaymentInput[] }>(
		`/api/wg/${encodedShareCode}/expenses`,
		{ memberId: identity.memberId },
	);
	const {
		data: cachedRecurringExpenses,
		error: recurringReadError,
		refresh: refreshRecurringExpenses,
		setData: setCachedRecurringExpenses,
	} = useCachedFetch<{ recurringExpenses: RecurringExpense[] }>(
		`/api/wg/${encodedShareCode}/recurring-expenses`,
		{ memberId: identity.memberId },
	);
	const wgBaseHref = `/wg/${encodedShareCode}`;
	const searchParams = useSearchParams();
	const highlightedId = searchParams.get('highlight');
	const openNewExpense = searchParams.get('new') === '1';
	const prefillDescription = searchParams.get('desc');
	const prefillAmount = searchParams.get('amount');
	const prefillPaidBy = searchParams.get('paidBy');
	const recurringId = searchParams.get('recurring');
	const recurringFilterActive = searchParams.get('filter') === 'recurring';

	const [expenses, setExpenses] = useState<Expense[]>(() => cachedExpenses?.expenses ?? []);
	const [payments, setPayments] = useState<ExpensePaymentInput[]>(
		() => cachedExpenses?.payments ?? [],
	);
	const [recurringExpenses, setRecurringExpenses] = useState<RecurringExpense[]>(
		() => cachedRecurringExpenses?.recurringExpenses ?? [],
	);
	const [initialLoading, setInitialLoading] = useState(!cachedExpenses && !cachedRecurringExpenses);
	const [refreshing, setRefreshing] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
	const [fieldErrors, setFieldErrors] = useState<ExpenseFormFieldErrors>({});
	const [validationAttempt, setValidationAttempt] = useState(0);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const { isPending, start: startPending, end: endPending } = usePendingSet();

	// Everything the form itself edits, plus its localStorage draft.
	const {
		showForm,
		setShowForm,
		description,
		setDescription,
		amountStr,
		setAmountStr,
		imageUrl,
		setImageUrl,
		paidByMemberId,
		setPaidByMemberId,
		splitMode,
		setSplitMode,
		manualSplits,
		setManualSplits,
		formError,
		setFormError,
		conflictExpenseId,
		setConflictExpenseId,
		editingExpense,
		invalidEditDraft,
		editingRecurringExpense,
		setEditingRecurringExpense,
		queueEditId,
		setQueueEditId,
		queueEditType,
		setQueueEditType,
		recurringIntervalMonths,
		setRecurringIntervalMonths,
		recurringNextDueAt,
		setRecurringNextDueAt,
		draftKey,
		pendingPrefill,
		recurringSourceId,
		acceptPendingPrefill,
		resetForm,
		startEdit,
		startRecurringEdit,
	} = useExpenseForm({
		shareCode: wg.shareCode,
		members,
		identityMemberId: identity.memberId,
		prefillDescription,
		prefillAmount,
		prefillPaidBy,
		recurringId,
		recurringExpenses,
	});

	const [creatingRecurringId, setCreatingRecurringId] = useState<string | null>(null);
	const [savingRecurringTemplate, setSavingRecurringTemplate] = useState(false);
	const submittingRef = useRef(false);
	const savingRecurringTemplateRef = useRef(false);
	const creatingRecurringRef = useRef(false);
	const expenseCreateRequestRef = useRef<{
		fingerprint: string;
		key: string;
		splits: Array<{ debtorMemberId: string; amountCents: number }>;
		expectedRecurringNextDueAt?: string;
	} | null>(null);
	const recurringExpenseCreateRequestsRef = useRef(
		new Map<string, { fingerprint: string; key: string; expectedRecurringNextDueAt: string }>(),
	);
	const loadRequestIdRef = useRef(0);
	const initialLoadStartedRef = useRef(false);
	const mountedRef = useRef(false);
	const recurringCreateRequestRef = useRef<{
		fingerprint: string;
		key: string;
		nextDueAt: string;
		splits: Array<{ debtorMemberId: string; amountCents: number }>;
		queued?: boolean;
	} | null>(null);

	function clearPendingCreateRequests(): void {
		expenseCreateRequestRef.current = null;
		recurringCreateRequestRef.current = null;
	}

	function updateExpenses(update: (current: Expense[]) => Expense[]): void {
		setExpenses(update);
		setCachedExpenses((current) => {
			const previous = current?.expenses ?? expenses;
			const next = update(previous);
			if (!current && next === previous) return current;
			return { ...(current ?? { expenses: previous }), expenses: next };
		});
	}

	function updateRecurringExpenses(
		update: (current: RecurringExpense[]) => RecurringExpense[],
	): void {
		setRecurringExpenses(update);
		setCachedRecurringExpenses((current) => {
			const previous = current?.recurringExpenses ?? recurringExpenses;
			const next = update(previous);
			if (!current && next === previous) return current;
			return { ...(current ?? { recurringExpenses: previous }), recurringExpenses: next };
		});
	}
	const hasPageCacheRef = useRef(Boolean(cachedExpenses || cachedRecurringExpenses));

	function setActionError(message: string | null): void {
		setActionNotice(message ? { message, tone: 'error' } : null);
	}

	function setActionWarning(message: string): void {
		setActionNotice({ message, tone: 'warning' });
	}

	useEffect(() => {
		if (openNewExpense) setShowForm(true);
	}, [openNewExpense, setShowForm]);

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

	// Always awaited: a fire-and-forget version of this once existed alongside
	// this awaited one and could drop advance failures silently if the tab
	// closed right after submit, while this path always surfaced a warning.
	async function advanceRecurringTemplate(
		templateId: string,
		expectedNextDueAt: string | undefined,
	): Promise<boolean> {
		const advanceRes = await apiFetch<{ recurringExpense: RecurringExpense }>(
			`/api/wg/${encodedShareCode}/recurring-expenses`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				body: JSON.stringify({
					id: templateId,
					...(expectedNextDueAt ? { expectedNextDueAt } : {}),
				}),
			},
		);
		if (advanceRes.ok) {
			updateRecurringExpenses((current) =>
				current.map((item) =>
					item.id === advanceRes.data.recurringExpense.id ? advanceRes.data.recurringExpense : item,
				),
			);
			return true;
		}
		if (advanceRes.status === 409 && advanceRes.error === 'recurring_expense_already_advanced') {
			await load(false);
			return true;
		}
		setActionWarning(recurringAdvanceWarningMessage(advanceRes.status, advanceRes.error));
		return false;
	}

	function setActionSuccess(message: string): void {
		setActionNotice({ message, tone: 'success' });
	}

	function toggleExpand(id: string): void {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	const load = useCallback(
		async (isInitial: boolean): Promise<void> => {
			const requestId = loadRequestIdRef.current + 1;
			loadRequestIdRef.current = requestId;
			if (isInitial && !hasPageCacheRef.current) setInitialLoading(true);
			else setRefreshing(true);

			const [res, recurringRes] = await Promise.all([
				refreshExpenses(),
				refreshRecurringExpenses(),
			]);
			if (requestId !== loadRequestIdRef.current) {
				return;
			}
			if (!mountedRef.current) return;

			let nextLoadError: string | null = null;

			if (res.ok) {
				setExpenses(res.data.expenses);
				setPayments(res.data.payments ?? []);
				syncOfflineActions(wg.shareCode, { memberId: identity.memberId })
					.then((synced) => {
						if (!mountedRef.current) return;
						if (requestId !== loadRequestIdRef.current) return;
						refreshCount();
						if (synced > 0) void load(false);
					})
					.catch((err) =>
						captureException(err, { action: 'syncOfflineActions', page: 'ausgaben' }),
					);
			} else {
				nextLoadError = getWgLoadErrorMessage('Ausgaben', res.status, res.error, {
					verb: 'konnten',
				});
			}
			if (recurringRes.ok) setRecurringExpenses(recurringRes.data.recurringExpenses);
			else if (!nextLoadError) {
				nextLoadError = getWgLoadErrorMessage(
					'Fixkosten',
					recurringRes.status,
					recurringRes.error,
					{
						verb: 'konnten',
					},
				);
			}
			setLoadError(nextLoadError);

			setInitialLoading(false);
			setRefreshing(false);
		},
		[identity.memberId, refreshExpenses, refreshRecurringExpenses, wg.shareCode],
	);
	useEffect(() => {
		if (cachedExpenses) {
			hasPageCacheRef.current = true;
			setExpenses(cachedExpenses.expenses);
			setPayments(cachedExpenses.payments ?? []);
			setLoadError(null);
		}
		if (cachedRecurringExpenses) {
			hasPageCacheRef.current = true;
			setRecurringExpenses(cachedRecurringExpenses.recurringExpenses);
			setLoadError(null);
		}
		if (cachedExpenses || cachedRecurringExpenses) setInitialLoading(false);
		if (expensesReadError) {
			setLoadError(
				getWgLoadErrorMessage('Ausgaben', expensesReadError.status, expensesReadError.error, {
					verb: 'konnten',
				}),
			);
		} else if (recurringReadError) {
			setLoadError(
				getWgLoadErrorMessage('Fixkosten', recurringReadError.status, recurringReadError.error, {
					verb: 'konnten',
				}),
			);
		}
	}, [cachedExpenses, cachedRecurringExpenses, expensesReadError, recurringReadError]);
	const expenseCount = expenses.length;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		if (initialLoadStartedRef.current) return;
		initialLoadStartedRef.current = true;
		void load(true);
	}, [load]);
	useEffect(() => {
		if (!showForm) setFieldErrors({});
	}, [showForm]);
	// Auto-Refresh wie auf dem Dashboard — ersetzt den manuellen Reload-Button.
	useVisibilityPausedInterval(() => void load(false), 30_000);

	function clearEditedQueueItem(expectedTypes?: OfflineActionType[]): boolean {
		if (!queueEditId) return true;
		if (expectedTypes) {
			const queued = readOfflineQueue().find((item) => item.id === queueEditId);
			if (!queued || !expectedTypes.includes(queued.type)) return true;
		}
		const saved = writeOfflineQueue(readOfflineQueue().filter((item) => item.id !== queueEditId));
		if (!saved) return false;
		setQueueEditId(null);
		setQueueEditType(null);
		setRecurringNextDueAt(null);
		return true;
	}

	/** The edited queue entry may have been synced meanwhile; a new create would duplicate it. */
	function discardSentQueueEdit(type: OfflineActionType): boolean {
		if (!queueEditId || queueEditType !== type || isOfflineActionQueued(queueEditId)) return false;
		resetForm();
		setShowForm(false);
		setActionWarning(QUEUE_EDIT_ALREADY_SENT_MESSAGE);
		void load(false);
		return true;
	}

	const { queuedCount, refreshCount } = useOfflineQueueSync({
		shareCode: wg.shareCode,
		memberId: identity.memberId,
		page: 'ausgaben',
		onSynced: () => void load(false),
	});

	useEffect(() => {
		if (!highlightedId || expenseCount === 0) return;
		const timerId = window.setTimeout(() => {
			document.getElementById(`expense-${highlightedId}`)?.scrollIntoView({
				block: 'center',
				behavior: 'smooth',
			});
		}, 80);
		return () => window.clearTimeout(timerId);
	}, [highlightedId, expenseCount]);

	useEffect(() => {
		if (!recurringFilterActive && !recurringId) return;
		const timerId = window.setTimeout(() => {
			document.getElementById('recurring-expenses')?.scrollIntoView({
				block: 'start',
				behavior: 'smooth',
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

	// A member who moved out ("Auszug") drops out of every picker, while the
	// full `members` list stays in use for name/colour/balance lookups so the
	// history keeps resolving. See expense-split-input.ts for the cases where a
	// moved-out member has to be offered anyway.
	const selectablePayers = payerOptions(members, paidByMemberId);
	const selectableSplitMembers = splitCandidates(members, splitMode, manualSplits);

	function buildSplits(amountCents: number): SplitInputResult {
		return buildSplitsFromForm({
			splitMode,
			members,
			manualSplits,
			amountCents,
			// Cycles the "+1 cent" recipient across expenses so the same person
			// doesn't always eat the leftover cent on uneven splits.
			rotationOffset: expenses.length,
			// Editing keeps the saved per-member shares when nothing that
			// affects them changed, so a settled share is not reopened.
			previousSplits: editingExpense
				? expenses.find((expense) => expense.id === editingExpense.id)?.splits
				: undefined,
		});
	}

	async function submit(): Promise<void> {
		setFieldErrors({});
		if (invalidEditDraft) {
			setFormError(
				'Die Zuordnung dieses Entwurfs ist beschädigt. Öffne die ursprüngliche Ausgabe erneut oder verwirf den Entwurf.',
			);
			return;
		}
		if (!submittingRef.current && discardSentQueueEdit('expense.create')) return;
		setFormError(null);
		setConflictExpenseId(null);
		const desc = description.trim();
		const amountEuros = parseEuroAmount(amountStr);
		const validationErrors: ExpenseFormFieldErrors = {};
		if (desc.length === 0 || desc.length > DESCRIPTION_MAX) {
			validationErrors.description = 'Beschreibung fehlt.';
		}
		if (amountEuros === null || amountEuros < AMOUNT_MIN_EUROS || amountEuros > AMOUNT_MAX_EUROS) {
			validationErrors.amount = 'Betrag ungültig.';
		}
		if (Object.keys(validationErrors).length > 0) {
			setValidationErrors(validationErrors);
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
			manualSplits:
				splitMode === 'manual'
					? Object.entries(manualSplits).sort(([left], [right]) => left.localeCompare(right))
					: null,
		});
		const pendingRequest = expenseCreateRequestRef.current;
		const reusePendingRequest = !isEdit && pendingRequest?.fingerprint === fingerprint;
		const recurringTemplateForCreate =
			!isEdit && recurringSourceId
				? recurringExpenses.find((item) => item.id === recurringSourceId)
				: null;
		// An edited queued booking keeps the template due date it was queued against.
		const queuedRecurringNextDueAt =
			!isEdit && recurringSourceId && queueEditType === 'expense.create'
				? recurringNextDueAt
				: null;
		const expectedRecurringNextDueAt = recurringSourceId
			? reusePendingRequest && pendingRequest?.expectedRecurringNextDueAt
				? pendingRequest.expectedRecurringNextDueAt
				: (queuedRecurringNextDueAt ?? recurringTemplateForCreate?.nextDueAt)
			: undefined;
		if (!isEdit && recurringSourceId && !expectedRecurringNextDueAt) {
			setActionError(
				'Fixkosten-Vorlage ist nicht verfügbar. Aktualisiere die Seite und versuche es erneut.',
			);
			return;
		}
		let splits: Array<{ debtorMemberId: string; amountCents: number }>;
		if (reusePendingRequest && pendingRequest) {
			splits = pendingRequest.splits;
		} else {
			const splitResult = buildSplits(amountCents);
			if (!splitResult.ok) {
				setValidationErrors({ splits: splitInputErrorMessage(splitResult.reason) });
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

		const requestBody = {
			paidByMemberId,
			amountCents,
			description: desc,
			imageUrl,
			splits,
			expectedUpdatedAt: editingExpense?.updatedAt,
			...(recurringSourceId && expectedRecurringNextDueAt
				? {
						recurringExpenseId: recurringSourceId,
						expectedRecurringNextDueAt,
					}
				: {}),
		};
		const idempotencyKey = isEdit
			? null
			: reusePendingRequest && pendingRequest
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!isEdit && !idempotencyKey) {
			setActionError('Ausgabe konnte nicht sicher gesendet werden. Versuche es erneut.');
			finishSubmitting();
			return;
		}
		if (!isEdit && idempotencyKey) {
			expenseCreateRequestRef.current = {
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
			...(previousExpense ? { previous: previousExpense } : {}),
		});
		startPending(optimisticId);
		updateExpenses((current) =>
			isEdit
				? current.map((expense) => (expense.id === editingExpense.id ? optimisticExpense : expense))
				: [optimisticExpense, ...current],
		);
		const res = await apiFetch<ExpenseMutationResponse>(url, {
			method: isEdit ? 'PATCH' : 'POST',
			memberId: identity.memberId,
			memberToken: identity.memberToken,
			...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
			body: JSON.stringify(requestBody),
		});

		if (!res.ok) {
			if (res.status === 0) {
				const queuedAction = isEdit
					? createQueuedExpenseUpdate({
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
						})
					: createQueuedExpense({
							wgId: wg.id,
							shareCode: wg.shareCode,
							memberId: identity.memberId,
							...(idempotencyKey ? { idempotencyKey } : {}),
							description: desc,
							amountCents,
							paidByMemberId,
							splits,
							imageUrl,
							...(recurringSourceId && expectedRecurringNextDueAt
								? {
										recurringExpenseId: recurringSourceId,
										expectedRecurringNextDueAt,
									}
								: {}),
						});
				const queuedCount = enqueueOfflineAction(queuedAction);
				if (queuedCount === 0) {
					rollbackOptimisticExpense();
					endPending(optimisticId);
					finishSubmitting();
					setActionError(OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE);
					toast.error('Offline-Speicher ist blockiert. Die Ausgabe wurde zurückgesetzt.');
					return;
				}
				if (!isEdit) expenseCreateRequestRef.current = null;
				refreshCount();
				if (!clearEditedQueueItem(['expense.create', 'expense.update'])) {
					endPending(optimisticId);
					finishSubmitting();
					setActionError(OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE);
					toast.error(OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE);
					return;
				}
				resetForm();
				setShowForm(false);
				finishSubmitting();
				endPending(optimisticId);
				removeDraft(draftKey);
				setActionWarning(
					'Offline gespeichert. Wird synchronisiert, sobald ihr wieder online seid.',
				);
				return;
			}
			if (!isEdit && res.status >= 400 && res.status < 500 && res.status !== 429) {
				expenseCreateRequestRef.current = null;
			}
			if (isEdit && res.status === 404 && res.error === 'expense_not_found') {
				setFormError(
					'Die ursprüngliche Ausgabe wurde gelöscht. Deine ungespeicherten Änderungen bleiben im Entwurf; du kannst sie kopieren oder den Entwurf verwerfen.',
				);
				updateExpenses((current) => current.filter((expense) => expense.id !== editingExpense.id));
				endPending(optimisticId);
				setActionError('Diese Ausgabe existiert nicht mehr und wurde aus der Liste entfernt.');
				toast.error('Diese Ausgabe existiert nicht mehr.');
				void load(false);
				finishSubmitting();
				return;
			}
			const msg =
				res.status === 409 && res.error !== 'image_removed'
					? 'Diese Ausgabe wurde inzwischen geändert. Lade die Liste neu und entscheide dann, welche Version stimmt.'
					: expenseSaveErrorMessage(res.error);
			if (res.status === 409 && res.error !== 'image_removed') {
				setConflictExpenseId(editingExpense?.id ?? null);
			}
			rollbackOptimisticExpense();
			endPending(optimisticId);
			setFormError(msg);
			toast.error(msg);
			finishSubmitting();
			return;
		}

		if (!isEdit) expenseCreateRequestRef.current = null;
		const savedExpense = 'expense' in res.data ? res.data.expense : res.data;
		const pushWarning = 'expense' in res.data ? expensePushWarningMessage(res.data.warning) : null;
		updateExpenses((current) =>
			isEdit
				? current.map((expense) => (expense.id === savedExpense.id ? savedExpense : expense))
				: [
						savedExpense,
						...current.filter(
							(expense) => expense.id !== optimisticId && expense.id !== savedExpense.id,
						),
					],
		);
		endPending(optimisticId);
		if (!clearEditedQueueItem(['expense.create', 'expense.update'])) {
			finishSubmitting();
			setActionError(DRAFT_CLEANUP_FAILED_MESSAGE);
			toast.error(DRAFT_CLEANUP_FAILED_MESSAGE);
			return;
		}
		resetForm();
		if (pushWarning) {
			setActionWarning(pushWarning);
		} else {
			setActionSuccess(
				isEdit
					? 'Ausgabe aktualisiert. Hier wird kein Geld überwiesen.'
					: 'Ausgabe gespeichert. Hier wird kein Geld überwiesen.',
			);
		}
		if (recurringSourceId) {
			const recurringTemplateForAdvance = recurringExpenses.find(
				(item) => item.id === recurringSourceId,
			);
			await advanceRecurringTemplate(
				recurringSourceId,
				expectedRecurringNextDueAt ?? recurringTemplateForAdvance?.nextDueAt,
			);
		}
		setShowForm(false);
		finishSubmitting();
		removeDraft(draftKey);
		void load(false);
	}

	async function saveRecurringTemplate(): Promise<void> {
		if (savingRecurringTemplateRef.current) return;
		setFieldErrors({});
		setFormError(null);
		const wasEditingQueuedRecurring = queueEditType === 'recurring.create';
		if (discardSentQueueEdit('recurring.create')) return;
		const desc = description.trim();
		const amountEuros = parseEuroAmount(amountStr);
		const validationErrors: ExpenseFormFieldErrors = {};
		if (!desc || desc.length > DESCRIPTION_MAX) {
			validationErrors.description = 'Beschreibung fehlt.';
		}
		if (amountEuros === null || amountEuros < AMOUNT_MIN_EUROS || amountEuros > AMOUNT_MAX_EUROS) {
			validationErrors.amount = 'Betrag ungültig.';
		}
		if (Object.keys(validationErrors).length > 0 || amountEuros === null) {
			setValidationErrors(validationErrors);
			return;
		}
		const amountCents = Math.round(amountEuros * CENTS_PER_EURO);
		const queuedNextDueAt =
			wasEditingQueuedRecurring && recurringNextDueAt ? parseTimestamp(recurringNextDueAt) : null;
		const recurringFingerprint = JSON.stringify({
			description: desc,
			amountCents,
			paidByMemberId,
			intervalMonths: recurringIntervalMonths,
			queuedNextDueAt: queuedNextDueAt === null ? null : new Date(queuedNextDueAt).toISOString(),
			splitMode,
			manualSplits:
				splitMode === 'manual'
					? Object.entries(manualSplits).sort(([left], [right]) => left.localeCompare(right))
					: null,
		});
		const pendingRecurringRequest = recurringCreateRequestRef.current;
		const reuseRecurringRequest =
			!editingRecurringExpense &&
			!pendingRecurringRequest?.queued &&
			pendingRecurringRequest?.fingerprint === recurringFingerprint;
		let splits: Array<{ debtorMemberId: string; amountCents: number }>;
		if (reuseRecurringRequest && pendingRecurringRequest) {
			splits = pendingRecurringRequest.splits;
		} else {
			const splitResult = buildSplits(amountCents);
			if (!splitResult.ok) {
				setValidationErrors({ splits: splitInputErrorMessage(splitResult.reason) });
				return;
			}
			splits = splitResult.splits;
		}
		const queuedRecurringTemplate = !editingRecurringExpense
			? readOfflineQueue().find((action) => {
					if (
						action.type !== 'recurring.create' ||
						action.wgId !== wg.id ||
						action.shareCode !== wg.shareCode ||
						action.memberId !== identity.memberId
					) {
						return false;
					}
					const payload = action.payload;
					const rawSplits: unknown = payload.splits;
					const isQueuedSplit = (
						split: unknown,
					): split is { debtorMemberId: string; amountCents: number } =>
						typeof split === 'object' &&
						split !== null &&
						'debtorMemberId' in split &&
						typeof split.debtorMemberId === 'string' &&
						'amountCents' in split &&
						typeof split.amountCents === 'number';
					if (
						typeof payload.description !== 'string' ||
						typeof payload.amountCents !== 'number' ||
						typeof payload.paidByMemberId !== 'string' ||
						typeof payload.intervalMonths !== 'number' ||
						typeof payload.nextDueAt !== 'string' ||
						!Array.isArray(rawSplits) ||
						!rawSplits.every(isQueuedSplit)
					) {
						return false;
					}
					const queuedSplits = [...rawSplits].sort((left, right) =>
						left.debtorMemberId.localeCompare(right.debtorMemberId),
					);
					const currentSplits = [...splits].sort((left, right) =>
						left.debtorMemberId.localeCompare(right.debtorMemberId),
					);
					const sameSplits =
						splitMode === 'manual'
							? JSON.stringify(queuedSplits) === JSON.stringify(currentSplits)
							: JSON.stringify(queuedSplits.map((split) => split.debtorMemberId)) ===
									JSON.stringify(currentSplits.map((split) => split.debtorMemberId)) &&
								queuedSplits.reduce((sum, split) => sum + split.amountCents, 0) === amountCents &&
								(queuedSplits.length < 2 ||
									Math.max(...queuedSplits.map((split) => split.amountCents)) -
										Math.min(...queuedSplits.map((split) => split.amountCents)) <=
										1);
					return (
						payload.description === desc &&
						payload.amountCents === amountCents &&
						payload.paidByMemberId === paidByMemberId &&
						payload.intervalMonths === recurringIntervalMonths &&
						sameSplits &&
						(queuedNextDueAt === null ||
							payload.nextDueAt === new Date(queuedNextDueAt).toISOString())
					);
				})
			: undefined;
		if (queuedRecurringTemplate) {
			if (pendingRecurringRequest?.fingerprint === recurringFingerprint) {
				pendingRecurringRequest.queued = true;
			}
			setActionWarning(
				'Fixkosten-Vorlage ist bereits offline vorgemerkt. Synchronisiere oder löse die bestehende Aktion zuerst.',
			);
			return;
		}
		const nextDueAt = editingRecurringExpense
			? new Date(editingRecurringExpense.nextDueAt)
			: queuedNextDueAt !== null
				? new Date(queuedNextDueAt)
				: reuseRecurringRequest && pendingRecurringRequest
					? new Date(pendingRecurringRequest.nextDueAt)
					: addMonths(new Date(), recurringIntervalMonths);
		const idempotencyKey = editingRecurringExpense
			? null
			: reuseRecurringRequest && pendingRecurringRequest
				? pendingRecurringRequest.key
				: createOfflineIdempotencyKey();
		if (!editingRecurringExpense && !idempotencyKey) {
			setActionError(
				'Fixkosten-Vorlage konnte nicht sicher gespeichert werden. Versuche es erneut.',
			);
			return;
		}
		if (idempotencyKey) {
			recurringCreateRequestRef.current = {
				fingerprint: recurringFingerprint,
				key: idempotencyKey,
				nextDueAt: nextDueAt.toISOString(),
				splits,
			};
		}
		savingRecurringTemplateRef.current = true;
		const finishSavingRecurringTemplate = () => {
			savingRecurringTemplateRef.current = false;
			setSavingRecurringTemplate(false);
		};
		setSavingRecurringTemplate(true);
		const res = await apiFetch<{ recurringExpense: RecurringExpense }>(
			`/api/wg/${encodedShareCode}/recurring-expenses`,
			{
				method: editingRecurringExpense ? 'PATCH' : 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
				body: JSON.stringify({
					id: editingRecurringExpense?.id,
					description: desc,
					amountCents,
					paidByMemberId,
					intervalMonths: recurringIntervalMonths,
					nextDueAt: nextDueAt.toISOString(),
					splits,
				}),
			},
		);
		if (!res.ok) {
			if (!editingRecurringExpense && res.status >= 400 && res.status < 500 && res.status !== 429) {
				recurringCreateRequestRef.current = null;
			}
			if (res.status === 0 && !editingRecurringExpense) {
				const queued = createQueuedRecurring({
					wgId: wg.id,
					shareCode: wg.shareCode,
					memberId: identity.memberId,
					...(idempotencyKey ? { idempotencyKey } : {}),
					description: desc,
					amountCents,
					paidByMemberId,
					intervalMonths: recurringIntervalMonths,
					nextDueAt: nextDueAt.toISOString(),
					splits,
				});
				if (enqueueOfflineAction(queued) === 0) {
					setActionError(OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE);
					finishSavingRecurringTemplate();
					return;
				}
				if (recurringCreateRequestRef.current?.fingerprint === recurringFingerprint) {
					recurringCreateRequestRef.current.queued = true;
				}
				refreshCount();
				updateRecurringExpenses((current) => [
					...current,
					{
						id: queued.id,
						description: desc,
						amountCents,
						currency: 'EUR',
						paidByMemberId,
						intervalMonths: recurringIntervalMonths,
						nextDueAt: nextDueAt.toISOString(),
						lastCreatedAt: null,
						splits,
					},
				]);
				if (!clearEditedQueueItem(['recurring.create'])) {
					setActionError(OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE);
					finishSavingRecurringTemplate();
					return;
				}
				if (wasEditingQueuedRecurring) {
					resetForm();
					setShowForm(false);
					removeDraft(draftKey);
				}
				setActionWarning('Fixkosten-Vorlage offline gespeichert.');
				finishSavingRecurringTemplate();
				return;
			}
			if (
				editingRecurringExpense &&
				res.status === 404 &&
				res.error === 'recurring_expense_not_found'
			) {
				const staleId = editingRecurringExpense.id;
				resetForm();
				setShowForm(false);
				updateRecurringExpenses((current) => current.filter((item) => item.id !== staleId));
				setActionError(
					'Diese Fixkosten-Vorlage existiert nicht mehr und wurde aus der Liste entfernt.',
				);
				void load(false);
				finishSavingRecurringTemplate();
				return;
			}
			setFormError(recurringTemplateSaveErrorMessage(res.error));
			finishSavingRecurringTemplate();
			return;
		}
		recurringCreateRequestRef.current = null;
		updateRecurringExpenses((current) =>
			editingRecurringExpense
				? current.map((item) =>
						item.id === res.data.recurringExpense.id ? res.data.recurringExpense : item,
					)
				: current.some((item) => item.id === res.data.recurringExpense.id)
					? current
					: [...current, res.data.recurringExpense],
		);
		setEditingRecurringExpense(null);
		if (!clearEditedQueueItem(['recurring.create'])) {
			setActionError(DRAFT_CLEANUP_FAILED_MESSAGE);
			finishSavingRecurringTemplate();
			return;
		}
		// A completed template edit must not turn the still-open form into a new expense.
		if (wasEditingQueuedRecurring || editingRecurringExpense) {
			resetForm();
			setShowForm(false);
			removeDraft(draftKey);
		}
		setActionSuccess(
			editingRecurringExpense
				? 'Fixkosten-Vorlage aktualisiert.'
				: 'Als monatliche Vorlage gespeichert.',
		);
		finishSavingRecurringTemplate();
	}

	async function createFromRecurringTemplate(template: RecurringExpense): Promise<void> {
		if (creatingRecurringRef.current) return;
		const alreadyQueued = readOfflineQueue().some(
			(action) =>
				action.shareCode === wg.shareCode &&
				action.memberId === identity.memberId &&
				(action.wgId === undefined || action.wgId === wg.id) &&
				(action.type === 'expense.create' || action.type === 'recurring.advance') &&
				action.payload.recurringExpenseId === template.id &&
				action.payload.expectedRecurringNextDueAt === template.nextDueAt,
		);
		if (alreadyQueued) {
			setActionError(null);
			setActionWarning(
				'Fixkosten-Ausgabe offline vorgemerkt. Die Vorlage bleibt bis zur Synchronisierung unverändert.',
			);
			return;
		}
		creatingRecurringRef.current = true;
		const finishCreatingRecurring = () => {
			creatingRecurringRef.current = false;
			setCreatingRecurringId(null);
		};
		setCreatingRecurringId(template.id);
		setActionError(null);
		const requestBody = {
			description: template.description,
			amountCents: template.amountCents,
			paidByMemberId: template.paidByMemberId,
			splits: template.splits,
		};
		const fingerprint = JSON.stringify({
			recurringExpenseId: template.id,
			...requestBody,
		});
		const pendingRequest = recurringExpenseCreateRequestsRef.current.get(template.id);
		const reusePendingRequest = pendingRequest?.fingerprint === fingerprint;
		const expectedRecurringNextDueAt =
			reusePendingRequest && pendingRequest
				? pendingRequest.expectedRecurringNextDueAt
				: template.nextDueAt;
		const idempotencyKey =
			reusePendingRequest && pendingRequest ? pendingRequest.key : createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setActionError('Fixkosten-Ausgabe konnte nicht sicher gesendet werden. Versuche es erneut.');
			finishCreatingRecurring();
			return;
		}
		recurringExpenseCreateRequestsRef.current.set(template.id, {
			fingerprint,
			key: idempotencyKey,
			expectedRecurringNextDueAt,
		});
		const requestBodyWithRecurringSource = {
			...requestBody,
			recurringExpenseId: template.id,
			expectedRecurringNextDueAt,
		};
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
		startPending(optimisticId);
		updateExpenses((current) => [optimisticExpense, ...current]);
		const createRes = await apiFetch<ExpenseCreateResponse>(
			`/api/wg/${encodedShareCode}/expenses`,
			{
				method: 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify(requestBodyWithRecurringSource),
			},
		);
		if (!createRes.ok) {
			if (createRes.status >= 400 && createRes.status < 500 && createRes.status !== 429) {
				recurringExpenseCreateRequestsRef.current.delete(template.id);
			}
			if (createRes.status === 0) {
				const queuedCount = enqueueOfflineAction(
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
				);
				if (queuedCount === 0) {
					rollbackOptimisticExpense();
					endPending(optimisticId);
					setActionError(
						'Offline-Speicher ist blockiert. Die Fixkosten-Ausgabe konnte nicht vorgemerkt werden.',
					);
					toast.error('Die Fixkosten-Ausgabe wurde zurückgesetzt.');
					finishCreatingRecurring();
					return;
				}
				recurringExpenseCreateRequestsRef.current.delete(template.id);
				refreshCount();
				setActionWarning(
					'Fixkosten-Ausgabe offline vorgemerkt. Die Vorlage bleibt bis zur Synchronisierung unverändert.',
				);
				endPending(optimisticId);
				finishCreatingRecurring();
				return;
			}
			rollbackOptimisticExpense();
			endPending(optimisticId);
			const message = 'Fixkosten-Ausgabe konnte nicht erstellt werden: Versuche es gleich erneut.';
			setActionError(message);
			toast.error(message);
			finishCreatingRecurring();
			return;
		}
		recurringExpenseCreateRequestsRef.current.delete(template.id);
		updateExpenses((current) => {
			const withoutOptimistic = current.filter((expense) => expense.id !== optimisticId);
			return withoutOptimistic.some((expense) => expense.id === createRes.data.expense.id)
				? withoutOptimistic
				: [createRes.data.expense, ...withoutOptimistic];
		});
		endPending(optimisticId);
		const advanced = await advanceRecurringTemplate(template.id, expectedRecurringNextDueAt);
		if (advanced) {
			recurringExpenseCreateRequestsRef.current.delete(template.id);
			const pushWarning = expensePushWarningMessage(createRes.data.warning);
			if (pushWarning) setActionWarning(pushWarning);
			else setActionSuccess('Fixkosten-Ausgabe wurde erstellt.');
		}
		finishCreatingRecurring();
		void load(false);
	}

	async function deleteExpense(id: string): Promise<void> {
		if (isPending(id)) return;
		startPending(id);
		setActionError(null);
		const previousExpenseIndex = expenses.findIndex((expense) => expense.id === id);
		const previousExpense = expenses[previousExpenseIndex];
		updateExpenses((current) => current.filter((expense) => expense.id !== id));

		const res = await apiFetch<unknown>(
			`/api/wg/${encodedShareCode}/expenses/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
			},
		);

		// A 404 means someone else already deleted it, so the row has to go
		// either way — the only difference from success is that we say so.
		const alreadyGone = !res.ok && res.status === 404 && res.error === 'expense_not_found';
		if (!res.ok && !alreadyGone) {
			if (previousExpense) {
				updateExpenses((current) => {
					if (current.some((expense) => expense.id === id)) return current;
					const restored = [...current];
					restored.splice(Math.min(previousExpenseIndex, restored.length), 0, previousExpense);
					return restored;
				});
			}
			const message =
				res.status === 403
					? 'Nur Zahler:in oder beteiligte Person kann diese Ausgabe entfernen.'
					: expenseActionErrorMessage(res.error);
			setActionError(message);
			toast.error(message);
			endPending(id);
			return;
		}

		if (alreadyGone) {
			setActionError('Diese Ausgabe existiert nicht mehr und wurde aus der Liste entfernt.');
		}
		endPending(id);
		void load(false);
	}

	async function deleteRecurringTemplate(template: RecurringExpense): Promise<void> {
		if (isPending(template.id)) return;
		startPending(template.id);
		setActionError(null);
		const previousTemplateIndex = recurringExpenses.findIndex((item) => item.id === template.id);
		updateRecurringExpenses((current) => current.filter((item) => item.id !== template.id));

		const res = await apiFetch<unknown>(`/api/wg/${encodedShareCode}/recurring-expenses`, {
			method: 'DELETE',
			memberId: identity.memberId,
			memberToken: identity.memberToken,
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
			setActionError(message);
			toast.error(message);
			endPending(template.id);
			return;
		}

		if (editingRecurringExpense?.id === template.id) {
			resetForm();
			setShowForm(false);
		}
		if (alreadyGone) {
			setActionError('Diese Fixkosten-Vorlage existiert nicht mehr und wurde entfernt.');
		} else {
			setActionSuccess('Fixkosten-Vorlage gelöscht.');
		}
		endPending(template.id);
		void load(false);
	}

	async function toggleSettle(expenseId: string, split: ExpenseSplit): Promise<void> {
		// Double-click guard: sync check before any async work
		if (isPending(split.id)) return;
		startPending(split.id);
		setActionError(null);
		const settled = split.settledAt === null;
		const previousSettledAt = split.settledAt;
		const settledAt = settled ? new Date().toISOString() : null;
		updateExpenses((current) =>
			current.map((expense) =>
				expense.id === expenseId
					? {
							...expense,
							splits: expense.splits.map((currentSplit) =>
								currentSplit.id === split.id ? { ...currentSplit, settledAt } : currentSplit,
							),
						}
					: expense,
			),
		);

		const res = await apiFetch<unknown>(
			`/api/wg/${encodedShareCode}/expenses/${encodeURIComponent(expenseId)}/splits/${encodeURIComponent(split.id)}/settle`,
			{
				method: 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				body: JSON.stringify({ settled }),
			},
		);

		if (!res.ok) {
			updateExpenses((current) =>
				current.map((expense) =>
					expense.id === expenseId
						? {
								...expense,
								splits: expense.splits.map((currentSplit) =>
									currentSplit.id === split.id
										? { ...currentSplit, settledAt: previousSettledAt }
										: currentSplit,
								),
							}
						: expense,
				),
			);
			if (
				res.status === 404 &&
				(res.error === 'split_not_found' || res.error === 'expense_not_found')
			) {
				setActionError('Diese Zahlung existiert nicht mehr. Die Ausgabenliste wird aktualisiert.');
				toast.error('Diese Zahlung existiert nicht mehr.');
				void load(false);
			} else {
				const message = expenseActionErrorMessage(res.error);
				setActionError(message);
				toast.error(message);
				if (res.error === 'split_already_offset') void load(false);
			}
		} else {
			void load(false);
		}

		endPending(split.id);
	}

	const showSkeleton = initialLoading && expenses.length === 0;
	// Verlauf nach Kalenderwoche; die API liefert neueste zuerst.
	const expenseWeeks = useMemo(() => {
		const weeks: Array<{ label: string; items: typeof expenses }> = [];
		const now = new Date();
		for (const expense of expenses) {
			const date = parseValidDate(expense.occurredAt);
			const label = date ? formatWeekLabel(startOfWeek(date), now) : 'Datum unbekannt';
			const current = weeks.at(-1);
			if (current?.label === label) current.items.push(expense);
			else weeks.push({ label, items: [expense] });
		}
		return weeks;
	}, [expenses]);
	const directDebts = useMemo(
		() =>
			computeDirectDebts(
				expenses,
				members.map((member) => ({
					id: member.id,
					name: member.name,
					color: member.color ?? null,
				})),
				payments,
			),
		[expenses, members, payments],
	);
	const memberBalances = useMemo(
		() =>
			computeNetBalances(
				expenses,
				members.map((member) => ({
					id: member.id,
					name: member.name,
					color: member.color ?? null,
				})),
				payments,
			).map(({ cents, ...member }) => ({ ...member, balanceCents: cents })),
		[expenses, members, payments],
	);
	const settlementSummary = useMemo(
		() =>
			buildSettlementSummary(
				expenses,
				members.map((member) => ({
					id: member.id,
					name: member.name,
					color: member.color ?? null,
				})),
				payments,
			),
		[expenses, members, payments],
	);
	const selectedRecurringExpense = useMemo(
		() => recurringExpenses.find((item) => item.id === recurringId) ?? null,
		[recurringExpenses, recurringId],
	);
	const visibleRecurringExpenses = useMemo(() => {
		if (recurringFilterActive) return recurringExpenses;
		const firstItems = recurringExpenses.slice(0, 4);
		if (
			!selectedRecurringExpense ||
			firstItems.some((item) => item.id === selectedRecurringExpense.id)
		) {
			return firstItems;
		}
		return [selectedRecurringExpense, ...firstItems].slice(0, 4);
	}, [recurringExpenses, recurringFilterActive, selectedRecurringExpense]);
	const hiddenRecurringCount = recurringExpenses.length - visibleRecurringExpenses.length;
	const isEditingQueuedExpense = queueEditType === 'expense.create';
	const isEditingQueuedRecurring = queueEditType === 'recurring.create';
	const formSaving = submitting || savingRecurringTemplate;
	const recurringActionPending = creatingRecurringId !== null || savingRecurringTemplate;
	const previewAmount = parseEuroAmount(amountStr);
	const splitPreview =
		previewAmount !== null && previewAmount >= AMOUNT_MIN_EUROS && previewAmount <= AMOUNT_MAX_EUROS
			? buildSplits(Math.round(previewAmount * CENTS_PER_EURO))
			: null;

	const formCurrency = editingExpense
		? (expenses.find((expense) => expense.id === editingExpense.id)?.currency ??
			editingExpense.currency ??
			'EUR')
		: (editingRecurringExpense?.currency ?? 'EUR');

	return (
		<div data-finance-content className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
			<SubNav />
			<AusgabenHeader expenseCount={expenses.length} initialLoading={initialLoading} />
			{showForm && (
				<ExpenseFormSection
					title={
						editingRecurringExpense
							? 'Fixkosten-Vorlage bearbeiten'
							: editingExpense
								? 'Ausgabe bearbeiten'
								: 'Ausgabe erfassen'
					}
					previewSplits={splitPreview?.ok ? splitPreview.splits : null}
					pendingPrefillDescription={pendingPrefill?.description ?? null}
					onReplacePrefill={() => {
						clearPendingCreateRequests();
						acceptPendingPrefill();
					}}
					isEditingExpense={editingExpense !== null || invalidEditDraft}
					editingExpenseId={editingExpense?.id ?? null}
					currency={formCurrency}
					notice={actionNotice}
					description={description}
					setDescription={setDescription}
					amountStr={amountStr}
					setAmountStr={setAmountStr}
					paidByMemberId={paidByMemberId}
					setPaidByMemberId={setPaidByMemberId}
					members={members}
					payerOptions={selectablePayers}
					splitCandidates={selectableSplitMembers}
					identityMemberId={identity.memberId}
					splitMode={splitMode}
					setSplitMode={setSplitMode}
					recurringIntervalMonths={recurringIntervalMonths}
					setRecurringIntervalMonths={setRecurringIntervalMonths}
					manualSplits={manualSplits}
					setManualSplits={setManualSplits}
					imageUrl={imageUrl}
					setImageUrl={setImageUrl}
					shareCode={wg.shareCode}
					isEditingQueuedExpense={isEditingQueuedExpense}
					isEditingQueuedRecurring={isEditingQueuedRecurring}
					formError={formError}
					fieldErrors={fieldErrors}
					validationAttempt={validationAttempt}
					onClearFieldError={clearFieldError}
					conflictExpenseId={conflictExpenseId}
					onReloadServerVersion={() => {
						setConflictExpenseId(null);
						setFormError(null);
						void load(false);
					}}
					onKeepDraft={() => setConflictExpenseId(null)}
					savingRecurringTemplate={savingRecurringTemplate}
					editingRecurringExpense={editingRecurringExpense}
					formSaving={formSaving}
					onSaveRecurringTemplate={() => void saveRecurringTemplate()}
					onCancel={() => setShowForm(false)}
					onDiscard={() => {
						clearPendingCreateRequests();
						resetForm();
						setShowForm(false);
						removeDraft(draftKey);
					}}
					onSubmit={() => {
						haptic('medium');
						if (isEditingQueuedRecurring) void saveRecurringTemplate();
						else void submit();
					}}
				/>
			)}
			{actionNotice && !showForm && <ActionNoticeBanner notice={actionNotice} />}
			{refreshing && (
				<output
					className="flex items-center gap-2 text-sm text-muted-foreground"
					aria-live="polite"
				>
					<Spinner />
					Wird aktualisiert…
				</output>
			)}
			<OfflineQueueNotice queuedCount={queuedCount} />
			{loadError && (
				<LoadErrorBanner
					message={loadError}
					onRetry={() => void load(true)}
					busy={initialLoading || refreshing}
					retryLabel="Ausgaben erneut laden"
				/>
			)}
			{!showSkeleton &&
				(expenses.length > 0 ||
					directDebts.length > 0 ||
					memberBalances.some((member) => member.balanceCents !== 0)) && (
					<DebtSummary
						debts={directDebts}
						summary={settlementSummary}
						balances={memberBalances}
						expenses={expenses}
						shareCode={wg.shareCode}
						currentMemberId={identity.memberId}
						memberToken={identity.memberToken}
						memberPayPalMerchantId={memberPayPalMerchantId}
						onSettled={(message) => {
							if (message) setActionSuccess(message);
							void load(false);
						}}
					/>
				)}
			{/* Fixkosten leben im eigenen Tab; hier nur, wenn ein Link gezielt eine Vorlage öffnet. */}
			{(recurringFilterActive || (recurringId && recurringExpenses.length > 0)) && (
				<RecurringExpensesSection
					recurringExpenses={recurringExpenses}
					recurringFilterActive={recurringFilterActive}
					wgBaseHref={wgBaseHref}
					shareCode={wg.shareCode}
					hiddenRecurringCount={hiddenRecurringCount}
					visibleRecurringExpenses={visibleRecurringExpenses}
					recurringId={recurringId}
					recurringActionPending={recurringActionPending}
					creatingRecurringId={creatingRecurringId}
					isPending={isPending}
					memberName={memberName}
					onCreateFromTemplate={(item) => void createFromRecurringTemplate(item)}
					onEditTemplate={startRecurringEdit}
					onDeleteTemplate={(item) => void deleteRecurringTemplate(item)}
					onPrepareNewExpense={() => setShowForm(true)}
				/>
			)}
			<section className="flex flex-col gap-3" aria-label="Eingetragene Ausgaben">
				{expenses.length > 0 && <h2 className="sr-only">Verlauf</h2>}
				{showSkeleton ? (
					<ExpensesSkeleton />
				) : loadError && expenses.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyTitle>Noch keine Ausgaben geladen</EmptyTitle>
							<EmptyDescription>Versuche es erneut, um eure Einträge zu sehen.</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : expenses.length === 0 && !initialLoading ? (
					<Empty>
						<EmptyHeader>
							<EmptyTitle>Noch keine Ausgaben</EmptyTitle>
							<EmptyDescription>
								Erfasse eure erste gemeinsame Ausgabe über das Plus unten rechts.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<div className="flex flex-col gap-4">
						{expenseWeeks.map((week) => (
							<section key={week.label} aria-label={week.label} className="flex flex-col gap-1.5">
								<h3 className="px-1 text-[12px] font-medium text-muted-foreground">{week.label}</h3>
								<ul className="divide-y overflow-hidden rounded-xl border">
									{week.items.map((expense) => (
										<ExpenseRow
											key={expense.id}
											expense={expense}
											expanded={expanded.has(expense.id)}
											onToggleExpand={toggleExpand}
											onDelete={deleteExpense}
											onEdit={startEdit}
											onToggleSettle={toggleSettle}
											isPending={isPending}
											memberName={memberName}
											currentMemberId={identity.memberId}
											highlighted={highlightedId === expense.id}
										/>
									))}
								</ul>
							</section>
						))}
					</div>
				)}
				{/* Selten gebraucht: Import am Listenende statt als Icon über dem Saldo. */}
				{!showSkeleton && (
					<Link
						href={`${wgBaseHref}/import`}
						className={cn(
							buttonVariants({ variant: 'ghost', size: 'sm' }),
							'self-center text-muted-foreground',
						)}
					>
						<FileInput data-icon="inline-start" aria-hidden />
						Kontoauszug importieren
					</Link>
				)}
			</section>
			<ThumbAction>
				<Button
					type="button"
					className="min-h-11 w-full"
					onClick={() => {
						haptic('light');
						setShowForm(true);
					}}
				>
					<Plus data-icon="inline-start" aria-hidden />
					Ausgabe erfassen
				</Button>
			</ThumbAction>
		</div>
	);
}
