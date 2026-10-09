import { useToast } from '@/components/ui/Toast';
import type { ActionNotice, ActionNoticeTone } from '@/components/wg/ActionNoticeBanner';
import { useWg } from '@/components/wg/WgContextProvider';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import {
	aboActionErrorMessage,
	aboDeleteErrorMessage,
	aboSaveErrorMessage,
} from '@/features/expenses/abo-errors';
import type { AboFormValues } from '@/features/expenses/components/abos/AboForm';
import type { Abo, AboFilter } from '@/features/expenses/components/abos/abos-types';
import { getDueRecurringExpenses } from '@/features/expenses/recurring-expenses';
import { haptic } from '@/shared/lib/haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface RecurringExpensesResponse {
	recurringExpenses: Abo[];
}

interface RecurringExpenseResponse {
	recurringExpense: Abo;
}

function sortByNextDue(abos: Abo[]): Abo[] {
	return [...abos].sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt));
}

function upsertAbo(current: Abo[], next: Abo): Abo[] {
	const existing = current.some((abo) => abo.id === next.id);
	return sortByNextDue(
		existing ? current.map((abo) => (abo.id === next.id ? next : abo)) : [...current, next],
	);
}

/** Fixkosten page: cached list, 30 s refresh, create/edit/pause/delete with optimistic updates. */
export function useAbosPage() {
	const { wg, members, identity } = useWg();
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const {
		data: cachedAbos,
		error: abosReadError,
		isLoading: abosReadLoading,
		refresh: refreshAbos,
		setData: setCachedAbos,
	} = useCachedFetch<RecurringExpensesResponse>(`/api/wg/${encodedShareCode}/recurring-expenses`, {
		memberId: identity.memberId,
	});
	const memberOptions = useMemo(
		() => members.map((member) => ({ ...member, color: member.color ?? null })),
		[members],
	);

	const [abos, setAbos] = useState<Abo[]>(() =>
		cachedAbos ? sortByNextDue(cachedAbos.recurringExpenses) : [],
	);
	const [filter, setFilter] = useState<AboFilter>('active');
	const [loading, setLoading] = useState(abosReadLoading);
	const [refreshing, setRefreshing] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [notice, setNotice] = useState<ActionNotice | null>(null);
	const [showCreate, setShowCreate] = useState(false);
	const [editing, setEditing] = useState<Abo | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [deleteCandidate, setDeleteCandidate] = useState<Abo | null>(null);
	const createRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const hasAbosDataRef = useRef(cachedAbos !== undefined);

	function updateAbos(update: (current: Abo[]) => Abo[]): void {
		setAbos(update);
		setCachedAbos((current) => {
			const previous = current?.recurringExpenses ?? abos;
			const next = update(previous);
			if (!current && next === previous) return current;
			return { ...(current ?? { recurringExpenses: previous }), recurringExpenses: next };
		});
	}

	const load = useCallback(
		async (initial: boolean): Promise<void> => {
			if (initial && !hasAbosDataRef.current) setLoading(true);
			else setRefreshing(true);
			const res = await refreshAbos();
			if (res.ok) {
				setAbos(sortByNextDue(res.data.recurringExpenses));
				setLoadError(null);
			} else {
				setLoadError(
					getWgLoadErrorMessage('Fixkosten', res.status, res.error, { verb: 'konnten' }),
				);
			}
			setLoading(false);
			setRefreshing(false);
		},
		[refreshAbos],
	);

	useEffect(() => {
		if (cachedAbos) {
			hasAbosDataRef.current = true;
			setAbos(sortByNextDue(cachedAbos.recurringExpenses));
			setLoadError(null);
		} else if (abosReadError) {
			setLoadError(
				getWgLoadErrorMessage('Fixkosten', abosReadError.status, abosReadError.error, {
					verb: 'konnten',
				}),
			);
			setLoading(false);
		}
	}, [abosReadError, cachedAbos]);

	useEffect(() => {
		void load(true);
	}, [load]);
	// Auto refresh like the dashboard instead of a manual reload button.
	useVisibilityPausedInterval(() => void load(false), 30_000);

	function setNoticeMessage(tone: ActionNoticeTone, message: string): void {
		// Success as a toast: it dismisses itself, shifts nothing and is visible even far down the list.
		if (tone === 'success') {
			setNotice(null);
			toast.success(message);
			return;
		}
		setNotice({ tone, message });
	}

	async function handleCreate(values: AboFormValues): Promise<void> {
		setSubmitting(true);
		const fingerprint = JSON.stringify(values);
		const pendingRequest = createRequestRef.current;
		const idempotencyKey =
			pendingRequest?.fingerprint === fingerprint
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setNoticeMessage(
				'error',
				'Fixkosten konnten nicht sicher gespeichert werden. Versuche es erneut.',
			);
			setSubmitting(false);
			return;
		}
		createRequestRef.current = { fingerprint, key: idempotencyKey };
		const optimisticId = `pending:${idempotencyKey}`;
		const optimisticAbo: Abo = {
			id: optimisticId,
			description: values.description,
			amountCents: values.amountCents,
			currency: 'EUR',
			paidByMemberId: values.paidByMemberId,
			intervalMonths: values.intervalMonths,
			nextDueAt: values.nextDueAt,
			lastCreatedAt: null,
			pausedAt: null,
			splits: values.splits,
		};
		updateAbos((current) => upsertAbo(current, optimisticAbo));
		const res = await apiFetch<RecurringExpenseResponse>(
			`/api/wg/${encodedShareCode}/recurring-expenses`,
			{
				method: 'POST',
				memberId: identity.memberId,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify(values),
			},
		);
		if (res.ok) {
			createRequestRef.current = null;
			haptic('medium');
			updateAbos((current) =>
				upsertAbo(
					current.filter((abo) => abo.id !== optimisticId),
					res.data.recurringExpense,
				),
			);
			setShowCreate(false);
			setNoticeMessage('success', 'Fixkosten angelegt.');
		} else {
			updateAbos((current) => current.filter((abo) => abo.id !== optimisticId));
			if (res.status > 0 && res.status < 500 && res.status !== 429) createRequestRef.current = null;
			const message = aboSaveErrorMessage(res.error, 'angelegt');
			setNoticeMessage('error', message);
		}
		setSubmitting(false);
	}

	async function handleEdit(values: AboFormValues): Promise<void> {
		if (!editing) return;
		setSubmitting(true);
		const previousAbo = editing;
		updateAbos((current) =>
			upsertAbo(current, {
				...previousAbo,
				...values,
			}),
		);
		const res = await apiFetch<RecurringExpenseResponse>(
			`/api/wg/${encodedShareCode}/recurring-expenses/${encodeURIComponent(editing.id)}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				body: JSON.stringify({ ...values, expectedNextDueAt: previousAbo.nextDueAt }),
			},
		);
		if (res.ok) {
			haptic('medium');
			updateAbos((current) => upsertAbo(current, res.data.recurringExpense));
			setEditing(null);
			setNoticeMessage('success', 'Fixkosten aktualisiert.');
		} else {
			updateAbos((current) => upsertAbo(current, previousAbo));
			const message = aboSaveErrorMessage(res.error, 'aktualisiert');
			setNoticeMessage('error', message);
			if (res.status === 409 && res.error === 'recurring_expense_changed') {
				// The form holds the old due date; close it so the next edit starts from fresh data.
				setEditing(null);
				void load(false);
			}
		}
		setSubmitting(false);
	}

	async function handleTogglePause(abo: Abo): Promise<void> {
		setPendingId(abo.id);
		const isPaused = abo.pausedAt !== null;
		updateAbos((current) =>
			upsertAbo(current, { ...abo, pausedAt: isPaused ? null : new Date().toISOString() }),
		);
		const res = await apiFetch<RecurringExpenseResponse>(
			`/api/wg/${encodedShareCode}/recurring-expenses/${encodeURIComponent(abo.id)}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				body: JSON.stringify({ paused: !isPaused }),
			},
		);
		if (res.ok) {
			updateAbos((current) => upsertAbo(current, res.data.recurringExpense));
			setNoticeMessage('success', isPaused ? 'Fixkosten fortgesetzt.' : 'Fixkosten pausiert.');
		} else {
			updateAbos((current) => upsertAbo(current, abo));
			const message = aboActionErrorMessage(res.error);
			setNoticeMessage('error', message);
			toast.error(message);
		}
		setPendingId(null);
	}

	async function handleDelete(abo: Abo): Promise<void> {
		setPendingId(abo.id);
		const previousAbo = abos.find((item) => item.id === abo.id) ?? abo;
		updateAbos((current) => current.filter((item) => item.id !== abo.id));
		const res = await apiFetch<{ deleted: true }>(
			`/api/wg/${encodedShareCode}/recurring-expenses/${encodeURIComponent(abo.id)}`,
			{ method: 'DELETE', memberId: identity.memberId },
		);
		if (res.ok) {
			setNoticeMessage('success', 'Fixkosten gelöscht.');
		} else {
			// Already deleted elsewhere: keep the row gone and show what the server has.
			const alreadyGone = res.status === 404 && res.error === 'recurring_expense_not_found';
			if (alreadyGone) void load(false);
			else updateAbos((current) => upsertAbo(current, previousAbo));
			const message = aboDeleteErrorMessage(res.error);
			setNoticeMessage('error', message);
			toast.error(message);
		}
		setPendingId(null);
	}

	const activeCount = abos.filter((abo) => abo.pausedAt === null).length;
	const dueCount = getDueRecurringExpenses(abos.filter((abo) => abo.pausedAt === null)).length;
	// Monthly load of active fixed costs: yearly ones count with 1/12.
	const monthly = new Map<string, { totalCents: number; mineCents: number }>();
	for (const abo of abos) {
		if (abo.pausedAt !== null) continue;
		const months = Math.max(1, abo.intervalMonths);
		const entry = monthly.get(abo.currency) ?? { totalCents: 0, mineCents: 0 };
		entry.totalCents += abo.amountCents / months;
		entry.mineCents +=
			(abo.splits.find((split) => split.debtorMemberId === identity.memberId)?.amountCents ?? 0) /
			months;
		monthly.set(abo.currency, entry);
	}

	return {
		identity,
		memberOptions,
		abos,
		filter,
		setFilter,
		loading,
		refreshing,
		loadError,
		load,
		notice,
		setNotice,
		showCreate,
		setShowCreate,
		editing,
		setEditing,
		submitting,
		pendingId,
		deleteCandidate,
		setDeleteCandidate,
		handleCreate,
		handleEdit,
		handleTogglePause,
		handleDelete,
		activeCount,
		dueCount,
		monthly,
	};
}
