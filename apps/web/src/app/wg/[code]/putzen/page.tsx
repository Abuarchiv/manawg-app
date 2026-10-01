'use client';
import { useToast } from '@/components/ui/Toast';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { ItemGroup } from '@/components/ui/item';
import { ActionNoticeBanner } from '@/components/wg/ActionNoticeBanner';
import { LoadErrorBanner } from '@/components/wg/LoadErrorBanner';
import { OfflineQueueNotice } from '@/components/wg/OfflineQueueNotice';
import { SubNav } from '@/components/wg/SubNav';
import { useWg } from '@/components/wg/WgContextProvider';
import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { usePendingSet } from '@/core/hooks/usePendingSet';
import { apiFetch } from '@/core/infra/api-client';
import { captureException } from '@/core/infra/observability';
import {
	buildDraftKey,
	isEmptyModuleDraft,
	readDraft,
	removeDraft,
	writeDraft,
} from '@/core/offline/drafts';
import {
	enqueueOfflineAction,
	readOfflineQueue,
	syncOfflineActions,
	writeOfflineQueue,
} from '@/core/offline/offline-client';
import {
	DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE,
	OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE,
} from '@/core/offline/offline-copy';
import {
	type OfflineActionType,
	createOfflineIdempotencyKey,
	createQueuedAbsence,
	createQueuedChore,
	createQueuedChoreCompletion,
} from '@/core/offline/offline-queue';
import { useOfflineQueueSync } from '@/core/offline/useOfflineQueueSync';
import { endOfBerlinDay, instantAtBerlinWallTime } from '@/core/utils/berlin-day';
import { formatShortDate, parseTimestamp } from '@/core/utils/time';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import { getAbsentMemberIds } from '@/features/chores/absence';
import type { AbsenceInput } from '@/features/chores/absence';
import { absenceSaveErrorMessage, choreCreateErrorMessage } from '@/features/chores/chore-errors';
import { buildChoreFairness, chooseNextAvailableMember } from '@/features/chores/chore-fairness';
import {
	CHORE_GROUPS,
	getChoreGroup,
	getChorePlanHealth,
	getChoreRepairHint,
	getChoreStatus,
} from '@/features/chores/chore-status';
import { AbsencePanel } from '@/features/chores/components/AbsencePanel';
import { ChoreForm } from '@/features/chores/components/ChoreForm';
import { ChoreRow } from '@/features/chores/components/ChoreRow';
import { FairnessPanel } from '@/features/chores/components/FairnessPanel';
import { ListSkeleton } from '@/features/chores/components/ListSkeleton';
import { PutzenHeader } from '@/features/chores/components/PutzenHeader';
import type {
	AbsenceListResponse,
	Chore,
	ChoreListResponse,
	MemberInfo,
	RecurrenceType,
} from '@/features/chores/components/chore-types';
import { QUICK_CHORE_TEMPLATES, TITLE_MAX } from '@/features/chores/components/constants';
import { Sparkles } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
type ChoreSuggestion = { title: string; intervalDays: number; recurrenceType: RecurrenceType };
type ChoreCreateWarning = null | 'notification_delivery_failed' | 'notification_delivery_unknown';
type ChoreCreateResponse = { chore: unknown; warning: ChoreCreateWarning };
const ConfirmDialog = dynamic(() =>
	import('@/components/ui/ConfirmDialog').then((module) => module.ConfirmDialog),
);

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function PutzenPage() {
	const { wg, members, identity, isAdmin } = useWg();
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const {
		data: cachedChores,
		error: choresReadError,
		refresh: refreshChores,
		setData: setCachedChores,
	} = useCachedFetch<ChoreListResponse>(`/api/wg/${encodedShareCode}/chores`, {
		memberId: identity.memberId,
	});
	const {
		data: cachedAbsences,
		error: absencesReadError,
		refresh: refreshAbsences,
		setData: setCachedAbsences,
	} = useCachedFetch<AbsenceListResponse>(`/api/wg/${encodedShareCode}/absences`, {
		memberId: identity.memberId,
	});
	const wgBaseHref = `/wg/${encodedShareCode}`;
	const searchParams = useSearchParams();
	const highlightedId = searchParams.get('highlight');
	const prefillTitle = searchParams.get('title');
	const overdueFilterActive = searchParams.get('filter') === 'overdue';
	const absencesPanelActive = searchParams.get('panel') === 'absences';
	const absenceId = searchParams.get('absence');
	const [items, setItems] = useState<Chore[]>(() => cachedChores?.chores ?? []);
	const [monthCompletions, setMonthCompletions] = useState<Record<string, number>>(
		() => cachedChores?.monthCompletions ?? {},
	);
	const absences = cachedAbsences?.absences ?? [];
	const [initialLoading, setInitialLoading] = useState(!cachedChores && !cachedAbsences);
	const [refreshing, setRefreshing] = useState(false);
	const [showForm, setShowForm] = useState(false);
	const [pendingSuggestion, setPendingSuggestion] = useState<ChoreSuggestion | null>(null);
	const [confirmSuggestion, setConfirmSuggestion] = useState(false);
	const [newTitle, setNewTitle] = useState('');
	const [newInterval, setNewInterval] = useState(7);
	const [newRecurrenceType, setNewRecurrenceType] = useState<RecurrenceType>('days');
	const [newAssigned, setNewAssigned] = useState<string>('');
	const [absenceMemberId, setAbsenceMemberId] = useState(identity.memberId);
	const [absenceStart, setAbsenceStart] = useState('');
	const [absenceEnd, setAbsenceEnd] = useState('');
	const [absenceReason, setAbsenceReason] = useState('');
	const [actionError, setActionError] = useState<string | null>(null);
	const [actionNotice, setActionNotice] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [queueEditId, setQueueEditId] = useState<string | null>(null);
	const [draftHydrated, setDraftHydrated] = useState(false);
	const draftKey = buildDraftKey(wg.shareCode, identity.memberId, 'chore');
	const appliedPrefillRef = useRef<string | null>(null);
	const initialLoadStartedRef = useRef(false);
	const hasPageCacheRef = useRef(Boolean(cachedChores || cachedAbsences));
	const mountedRef = useRef(false);
	const loadRequestIdRef = useRef(0);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const assigneeTouchedRef = useRef(false);
	const choreCreateRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const absenceCreateRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const completionRequestKeysRef = useRef(new Map<string, string>());

	const { isPending, start: startPending, end: endPending } = usePendingSet();
	const [completeConfirmId, setCompleteConfirmId] = useState<string | null>(null);

	const load = useCallback(
		async (initial: boolean): Promise<void> => {
			const requestId = loadRequestIdRef.current + 1;
			loadRequestIdRef.current = requestId;
			if (initial && !hasPageCacheRef.current) {
				setInitialLoading(true);
			} else {
				setRefreshing(true);
			}
			const [result, absenceResult] = await Promise.all([refreshChores(), refreshAbsences()]);
			if (requestId !== loadRequestIdRef.current) {
				return;
			}
			let nextLoadError: string | null = null;
			if (result.ok) {
				setItems(result.data.chores);
				setMonthCompletions(result.data.monthCompletions ?? {});
				syncOfflineActions(wg.shareCode, { memberId: identity.memberId })
					.then((synced) => {
						if (!mountedRef.current) return;
						if (requestId !== loadRequestIdRef.current) return;
						refreshCount();
						if (synced > 0) void load(false);
					})
					.catch((err) => captureException(err, { action: 'syncOfflineActions', page: 'putzen' }));
			} else {
				nextLoadError = getWgLoadErrorMessage('Putzplan', result.status, result.error);
			}
			if (!absenceResult.ok && !nextLoadError) {
				nextLoadError = getWgLoadErrorMessage(
					'Abwesenheiten',
					absenceResult.status,
					absenceResult.error,
					{ verb: 'konnten' },
				);
			}
			setLoadError(nextLoadError);
			if (requestId === loadRequestIdRef.current) {
				setInitialLoading(false);
				setRefreshing(false);
			}
		},
		[identity.memberId, refreshAbsences, refreshChores, wg.shareCode],
	);
	useEffect(() => {
		if (cachedChores) {
			hasPageCacheRef.current = true;
			setItems(cachedChores.chores);
			setMonthCompletions(cachedChores.monthCompletions ?? {});
		}
	}, [cachedChores]);
	useEffect(() => {
		if (cachedChores || cachedAbsences) {
			hasPageCacheRef.current = true;
			setInitialLoading(false);
			setLoadError(null);
		}
		if (choresReadError) {
			setLoadError(
				getWgLoadErrorMessage('Putzplan', choresReadError.status, choresReadError.error),
			);
		} else if (absencesReadError) {
			setLoadError(
				getWgLoadErrorMessage('Abwesenheiten', absencesReadError.status, absencesReadError.error, {
					verb: 'konnten',
				}),
			);
		}
	}, [absencesReadError, cachedAbsences, cachedChores, choresReadError]);
	const itemCount = items.length;

	function updateAbsences(update: (current: AbsenceInput[]) => AbsenceInput[]): void {
		setCachedAbsences((current) => ({
			...(current ?? { absences: [] }),
			absences: update(current?.absences ?? []),
		}));
	}

	function updateChores(update: (current: Chore[]) => Chore[]): void {
		setItems(update);
		setCachedChores((current) => {
			const previous = current?.chores ?? items;
			const next = update(previous);
			if (!current && next === previous) return current;
			return { ...(current ?? { chores: previous }), chores: next };
		});
	}

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
	// Auto-Refresh wie auf dem Dashboard — ersetzt den manuellen Reload-Button.
	useVisibilityPausedInterval(() => void load(false), 30_000);

	useEffect(() => {
		const draft = readDraft<{
			title?: string;
			intervalDays?: number;
			recurrenceType?: RecurrenceType;
			assignedMemberId?: string;
			absenceMemberId?: string;
			absenceStartDate?: string;
			absenceEndDate?: string;
			absenceReason?: string;
			openAbsencesPanel?: boolean;
			queueEditId?: string;
		}>(draftKey);
		if (!draft) {
			setDraftHydrated(true);
			return;
		}
		if (!isEmptyModuleDraft('chore', draft, identity.memberId)) {
			assigneeTouchedRef.current = true;
			setShowForm(true);
		}
		if (draft.title) {
			setNewTitle(draft.title);
		}
		if (draft.intervalDays) setNewInterval(draft.intervalDays);
		if (draft.recurrenceType === 'months' || draft.recurrenceType === 'days')
			setNewRecurrenceType(draft.recurrenceType);
		if (typeof draft.assignedMemberId === 'string') setNewAssigned(draft.assignedMemberId);
		if (draft.absenceMemberId) setAbsenceMemberId(draft.absenceMemberId);
		if (draft.absenceStartDate) setAbsenceStart(draft.absenceStartDate.slice(0, 10));
		if (draft.absenceEndDate) setAbsenceEnd(draft.absenceEndDate.slice(0, 10));
		if (draft.absenceReason !== undefined) setAbsenceReason(draft.absenceReason);
		if (draft.queueEditId) setQueueEditId(draft.queueEditId);
		setDraftHydrated(true);
	}, [draftKey, identity.memberId]);

	const applyChoreSuggestion = useCallback(
		(suggestion: ChoreSuggestion): void => {
			assigneeTouchedRef.current = false;
			writeDraft(draftKey, {
				title: suggestion.title,
				intervalDays: suggestion.intervalDays,
				recurrenceType: suggestion.recurrenceType,
				assignedMemberId: '',
			});
			setNewTitle(suggestion.title);
			setNewInterval(suggestion.intervalDays);
			setNewRecurrenceType(suggestion.recurrenceType);
			setNewAssigned('');
			setQueueEditId(null);
			setPendingSuggestion(null);
			setShowForm(true);
		},
		[draftKey],
	);

	const suggestChore = useCallback(
		(suggestion: ChoreSuggestion): void => {
			const draft = readDraft<Record<string, unknown>>(draftKey);
			if (draft && !isEmptyModuleDraft('chore', draft, identity.memberId)) {
				assigneeTouchedRef.current = true;
				setPendingSuggestion(suggestion);
				setShowForm(true);
			} else {
				applyChoreSuggestion(suggestion);
			}
		},
		[applyChoreSuggestion, draftKey, identity.memberId],
	);

	useEffect(() => {
		if (!prefillTitle || appliedPrefillRef.current === prefillTitle) return;
		appliedPrefillRef.current = prefillTitle;
		suggestChore({
			title: prefillTitle.slice(0, TITLE_MAX),
			intervalDays: 7,
			recurrenceType: 'days',
		});
	}, [prefillTitle, suggestChore]);

	useEffect(() => {
		if (!draftHydrated) return;
		writeDraft(draftKey, {
			...readDraft<Record<string, unknown>>(draftKey),
			title: newTitle,
			recurrenceType: newRecurrenceType,
			intervalDays: newInterval,
			assignedMemberId: newAssigned,
			absenceMemberId,
			absenceStartDate: absenceStart,
			absenceEndDate: absenceEnd,
			absenceReason,
			queueEditId,
		});
	}, [
		absenceEnd,
		absenceMemberId,
		absenceReason,
		absenceStart,
		draftHydrated,
		draftKey,
		newAssigned,
		newInterval,
		newRecurrenceType,
		newTitle,
		queueEditId,
	]);

	const { queuedCount, refreshCount } = useOfflineQueueSync({
		shareCode: wg.shareCode,
		memberId: identity.memberId,
		page: 'putzen',
		onSynced: () => void load(false),
	});

	useEffect(() => {
		if (!highlightedId || itemCount === 0) return;
		window.setTimeout(() => {
			document.getElementById(`chore-${highlightedId}`)?.scrollIntoView({
				block: 'center',
				behavior: 'smooth',
			});
		}, 80);
	}, [highlightedId, itemCount]);

	useEffect(() => {
		if (!overdueFilterActive) return;
		window.setTimeout(() => {
			document.getElementById('chore-list')?.scrollIntoView({
				block: 'start',
				behavior: 'smooth',
			});
		}, 80);
	}, [overdueFilterActive]);

	useEffect(() => {
		if (!absencesPanelActive && !absenceId) return;
		window.setTimeout(() => {
			document.getElementById('absences-panel')?.scrollIntoView({
				block: 'start',
				behavior: 'smooth',
			});
		}, 80);
	}, [absenceId, absencesPanelActive]);

	function clearEditedQueueItem(expectedTypes?: OfflineActionType[]): boolean {
		if (!queueEditId) return true;
		if (expectedTypes) {
			const queued = readOfflineQueue().find((item) => item.id === queueEditId);
			if (!queued || !expectedTypes.includes(queued.type)) return true;
		}
		const saved = writeOfflineQueue(readOfflineQueue().filter((item) => item.id !== queueEditId));
		if (!saved) return false;
		setQueueEditId(null);
		return true;
	}

	async function add(): Promise<void> {
		const title = newTitle.trim();
		if (title.length === 0) return;
		const pendingKey = 'chore:add';
		if (isPending(pendingKey)) return;
		startPending(pendingKey);
		setActionError(null);
		setActionNotice(null);
		const fingerprint = JSON.stringify({
			title,
			intervalDays: newInterval,
			recurrenceType: newRecurrenceType,
			assignedMemberId: newAssigned || null,
		});
		const pendingRequest = choreCreateRequestRef.current;
		const idempotencyKey =
			pendingRequest?.fingerprint === fingerprint
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setActionError('Aufgabe konnte nicht sicher gespeichert werden. Versuche es erneut.');
			endPending(pendingKey);
			return;
		}
		choreCreateRequestRef.current = { fingerprint, key: idempotencyKey };

		try {
			const result = await apiFetch<ChoreCreateResponse>(`/api/wg/${encodedShareCode}/chores`, {
				method: 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({
					title,
					intervalDays: newInterval,
					recurrenceType: newRecurrenceType,
					assignedMemberId: newAssigned || null,
				}),
			});

			if (!result.ok) {
				if (result.status > 0 && result.status < 500 && result.status !== 429)
					choreCreateRequestRef.current = null;
				if (result.status === 0) {
					const queued = createQueuedChore({
						wgId: wg.id,
						shareCode: wg.shareCode,
						memberId: identity.memberId,
						idempotencyKey,
						title,
						intervalDays: newInterval,
						recurrenceType: newRecurrenceType,
						assignedMemberId: newAssigned || null,
					});
					if (enqueueOfflineAction(queued) === 0) {
						setActionError(OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE);
						return;
					}
					refreshCount();
					setItems((current) => [
						{
							id: queued.id,
							title,
							intervalDays: newInterval,
							recurrenceType: newRecurrenceType,
							assignedMemberId: newAssigned || null,
							nextDueAt: new Date().toISOString(),
							lastCompletedAt: null,
							lastCompletedByName: null,
							openGapCountForAssignee: 0,
						},
						...current,
					]);
					setNewTitle('');
					setNewInterval(7);
					setNewRecurrenceType('days');
					setNewAssigned('');
					if (!clearEditedQueueItem(['chore.create'])) {
						setActionError(OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE);
						return;
					}
					assigneeTouchedRef.current = false;
					setShowForm(false);
					removeDraft(draftKey);
					setActionNotice(
						'Offline gespeichert. Wird synchronisiert, sobald ihr wieder online seid.',
					);
					return;
				}
				setActionError(choreCreateErrorMessage(result.error));
				return;
			}

			choreCreateRequestRef.current = null;
			setNewTitle('');
			setNewInterval(7);
			setNewRecurrenceType('days');
			setNewAssigned('');
			if (!clearEditedQueueItem(['chore.create'])) {
				setActionError(DRAFT_CLEANUP_FAILED_MESSAGE);
				return;
			}
			assigneeTouchedRef.current = false;
			setShowForm(false);
			removeDraft(draftKey);
			void load(false);
			if (result.data.warning === 'notification_delivery_failed') {
				setActionNotice(
					'Gespeichert. Nicht alle Push-Benachrichtigungen konnten versendet werden.',
				);
			} else if (result.data.warning === 'notification_delivery_unknown') {
				setActionNotice('Gespeichert. Push-Versand konnte nicht bestätigt werden.');
			}
		} finally {
			endPending(pendingKey);
		}
	}

	async function addAbsence(): Promise<void> {
		if (!absenceStart || !absenceEnd) return;
		const startDay = /^\d{4}-\d{2}-\d{2}$/.test(absenceStart)
			? instantAtBerlinWallTime(absenceStart, 0)
			: null;
		const endDay = /^\d{4}-\d{2}-\d{2}$/.test(absenceEnd)
			? instantAtBerlinWallTime(absenceEnd, 0)
			: null;
		if (!startDay || !endDay || startDay > endDay) {
			setActionError('Bitte wähle einen gültigen Zeitraum für die Abwesenheit.');
			return;
		}
		const pendingKey = 'absence:add';
		if (isPending(pendingKey)) return;
		startPending(pendingKey);
		setActionError(null);
		setActionNotice(null);
		const startDate = startDay.toISOString();
		const endDate = endOfBerlinDay(endDay).toISOString();
		const fingerprint = JSON.stringify({
			memberId: absenceMemberId,
			startDate,
			endDate,
			reason: absenceReason.trim() || null,
		});
		const pendingRequest = absenceCreateRequestRef.current;
		const idempotencyKey =
			pendingRequest?.fingerprint === fingerprint
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setActionError('Abwesenheit konnte nicht sicher gespeichert werden. Versuche es erneut.');
			endPending(pendingKey);
			return;
		}
		absenceCreateRequestRef.current = { fingerprint, key: idempotencyKey };
		try {
			const result = await apiFetch<{ absence: AbsenceInput | null }>(
				`/api/wg/${encodedShareCode}/absences`,
				{
					method: 'POST',
					memberId: identity.memberId,
					memberToken: identity.memberToken,
					headers: { 'Idempotency-Key': idempotencyKey },
					body: JSON.stringify({
						memberId: absenceMemberId,
						startDate,
						endDate,
						reason: absenceReason.trim() || null,
					}),
				},
			);
			if (!result.ok) {
				if (result.status > 0 && result.status < 500 && result.status !== 429)
					absenceCreateRequestRef.current = null;
				if (result.status === 0) {
					const queued = createQueuedAbsence({
						wgId: wg.id,
						shareCode: wg.shareCode,
						memberId: identity.memberId,
						idempotencyKey,
						absenceMemberId,
						startDate,
						endDate,
						reason: absenceReason.trim() || null,
					});
					if (enqueueOfflineAction(queued) === 0) {
						setActionError(OFFLINE_QUEUE_BLOCKED_DRAFT_MESSAGE);
						return;
					}
					if (!clearEditedQueueItem(['absence.create'])) {
						setActionError(OFFLINE_DRAFT_CLEANUP_FAILED_MESSAGE);
						return;
					}
					refreshCount();
					updateAbsences((current) => [
						{
							id: queued.id,
							memberId: absenceMemberId,
							memberName: members.find((member) => member.id === absenceMemberId)?.name ?? '?',
							startDate,
							endDate,
							reason: absenceReason.trim() || null,
						},
						...current,
					]);
					setAbsenceStart('');
					setAbsenceEnd('');
					setAbsenceReason('');
					setQueueEditId(null);
					setActionNotice(
						'Offline gespeichert. Die Rotation nutzt diese Abwesenheit sofort lokal.',
					);
					return;
				}
				setActionError(absenceSaveErrorMessage(result.error));
				return;
			}
			absenceCreateRequestRef.current = null;
			setAbsenceStart('');
			setAbsenceEnd('');
			setAbsenceReason('');
			if (!clearEditedQueueItem(['absence.create'])) {
				setActionError(DRAFT_CLEANUP_FAILED_MESSAGE);
				return;
			}
			setQueueEditId(null);
			setActionNotice('Abwesenheit gespeichert. Die Rotation überspringt diese Person.');
			void load(false);
		} finally {
			endPending(pendingKey);
		}
	}

	async function removeAbsence(id: string): Promise<void> {
		const pendingKey = `absence:${id}:remove`;
		if (isPending(pendingKey)) return;
		startPending(pendingKey);
		try {
			const result = await apiFetch<Record<string, never>>(
				`/api/wg/${encodedShareCode}/absences/${encodeURIComponent(id)}`,
				{
					method: 'DELETE',
					memberId: identity.memberId,
					memberToken: identity.memberToken,
				},
			);
			if (!result.ok) {
				if (result.status === 404 && result.error === 'absence_not_found') {
					updateAbsences((current) => current.filter((absence) => absence.id !== id));
					setActionError('Diese Abwesenheit existiert nicht mehr und wurde aus dem Plan entfernt.');
					void load(false);
					return;
				}
				setActionError(
					result.status === 0 ||
						result.error === 'Netzwerkfehler' ||
						result.error === 'Failed to fetch'
						? 'Abwesenheit konnte nicht entfernt werden: Prüfe deine Verbindung und versuche es erneut.'
						: 'Abwesenheit konnte nicht entfernt werden.',
				);
				return;
			}
			updateAbsences((current) => current.filter((absence) => absence.id !== id));
		} finally {
			endPending(pendingKey);
		}
	}

	async function handleComplete(chore: Chore): Promise<void> {
		if (isPending(chore.id)) return;

		// First tap → arm; second tap → commit
		if (completeConfirmId !== chore.id) {
			setActionError(null);
			setCompleteConfirmId(chore.id);
			return;
		}

		startPending(chore.id);
		setActionError(null);
		setActionNotice(null);
		const idempotencyKey =
			completionRequestKeysRef.current.get(chore.id) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setActionError('Erledigt-Aktion konnte nicht sicher gespeichert werden. Versuche es erneut.');
			endPending(chore.id);
			return;
		}
		completionRequestKeysRef.current.set(chore.id, idempotencyKey);
		const previousChore = items.find((item) => item.id === chore.id) ?? chore;
		updateChores((current) => current.filter((item) => item.id !== chore.id));

		const result = await apiFetch<{ chore?: Pick<Chore, 'id' | 'nextDueAt' | 'assignedMemberId'> }>(
			`/api/wg/${encodedShareCode}/chores/${encodeURIComponent(chore.id)}/complete`,
			{
				method: 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify({ completedByMemberId: identity.memberId }),
			},
		);

		if (!result.ok) {
			if (result.status > 0 && result.status < 500 && result.status !== 429)
				completionRequestKeysRef.current.delete(chore.id);
			if (result.status === 0) {
				const queuedCount = enqueueOfflineAction(
					createQueuedChoreCompletion({
						wgId: wg.id,
						shareCode: wg.shareCode,
						memberId: identity.memberId,
						idempotencyKey,
						choreId: chore.id,
					}),
				);
				if (queuedCount === 0) {
					updateChores((current) =>
						current.some((item) => item.id === chore.id)
							? current.map((item) => (item.id === chore.id ? previousChore : item))
							: [...current, previousChore],
					);
					setActionError(
						'Offline-Speicher ist blockiert. Versuche es später erneut, sobald dein Browser wieder speichern kann.',
					);
					toast.error('Die Erledigung konnte nicht offline vorgemerkt werden.');
					endPending(chore.id);
					return;
				}
				refreshCount();
				setActionNotice(
					'Erledigung offline vorgemerkt. Nächster Termin und Zuständigkeit werden nach der Synchronisierung bestätigt.',
				);
				setCompleteConfirmId(null);
				endPending(chore.id);
				return;
			}
			if (result.status === 404 && result.error === 'chore_not_found') {
				setItems((current) => current.filter((item) => item.id !== chore.id));
				setCompleteConfirmId(null);
				const message = 'Diese Putzaufgabe existiert nicht mehr und wurde aus dem Plan entfernt.';
				setActionError(message);
				toast.error(message);
				void load(false);
				endPending(chore.id);
				return;
			}
			if (
				(result.status === 404 || result.status === 409) &&
				result.error === 'chore_already_completed'
			) {
				setCompleteConfirmId(null);
				setActionNotice('Diese Putzaufgabe wurde bereits erledigt. Der Plan wird aktualisiert.');
				void load(false);
				endPending(chore.id);
				return;
			}
			if (result.error === 'completion_insert_failed') {
				updateChores((current) =>
					current.some((item) => item.id === chore.id)
						? current.map((item) => (item.id === chore.id ? previousChore : item))
						: [...current, previousChore],
				);
				const message =
					'Erledigt-Aktion konnte nicht vollständig gespeichert werden: Lade den Plan neu und prüfe den Verlauf.';
				setActionError(message);
				toast.error(message);
				void load(false);
				endPending(chore.id);
				return;
			}
			updateChores((current) =>
				current.some((item) => item.id === chore.id)
					? current.map((item) => (item.id === chore.id ? previousChore : item))
					: [...current, previousChore],
			);
			const message = 'Erledigt-Aktion konnte nicht gespeichert werden: Versuche es gleich erneut.';
			setActionError(message);
			toast.error(message);
		} else {
			completionRequestKeysRef.current.delete(chore.id);
			const updated = result.data.chore;
			const confirmed = updated?.id === chore.id && parseTimestamp(updated.nextDueAt) !== null;
			if (confirmed) {
				updateChores((current) => {
					const completed: Chore = {
						...chore,
						nextDueAt: updated.nextDueAt,
						assignedMemberId: updated.assignedMemberId,
						lastCompletedAt: new Date().toISOString(),
						lastCompletedByName: identity.name,
					};
					return current.some((item) => item.id === chore.id)
						? current.map((item) => (item.id === chore.id ? completed : item))
						: [...current, completed];
				});
				const nextName = members.find((member) => member.id === updated.assignedMemberId)?.name;
				setActionNotice(
					`Erledigt. Nächster Termin: ${formatShortDate(updated.nextDueAt)}; ${nextName ? `${nextName} ist dran (Rotation).` : 'noch niemand zugewiesen.'}`,
				);
			} else {
				setActionNotice(
					'Erledigt. Der bestätigte nächste Termin und die Zuständigkeit werden geladen.',
				);
			}

			setCompleteConfirmId(null);
			toast.success('Aufgabe erledigt ✓');
			void load(false);
		}

		endPending(chore.id);
	}

	async function handleSwapRequest(chore: Chore): Promise<void> {
		const pendingKey = `${chore.id}:swap`;
		if (isPending(pendingKey)) return;

		startPending(pendingKey);
		setActionError(null);
		setActionNotice(null);

		const status = getChoreStatus(chore.nextDueAt);
		const result = await apiFetch<Record<string, never>>(
			`/api/wg/${encodedShareCode}/announcements`,
			{
				method: 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				body: JSON.stringify({
					kind: 'request',
					source: 'chore_swap',
					sourcePath: `/putzen?highlight=${encodeURIComponent(chore.id)}`,
					content: `${identity.name} bittet um Tausch: "${chore.title}" ist ${status.label}. Nachholen, übernehmen oder kurz absprechen.`,
				}),
			},
		);

		if (!result.ok) {
			setActionError(
				result.error === 'unexpected_error' || result.error === 'server_error'
					? 'Tauschanfrage konnte nicht gepostet werden: Versuche es gleich erneut.'
					: result.status === 0 ||
							result.error === 'Netzwerkfehler' ||
							result.error === 'Failed to fetch'
						? 'Tauschanfrage konnte nicht gepostet werden: Prüfe deine Verbindung und versuche es erneut.'
						: 'Tauschanfrage konnte nicht gepostet werden.',
			);
		} else {
			setActionNotice('Tauschanfrage wurde auf der Pinnwand gepostet.');
		}

		endPending(pendingKey);
	}

	async function handleTakeOver(chore: Chore): Promise<void> {
		await handleAssignTo(chore, identity.memberId, 'Du bist jetzt für die Aufgabe eingetragen.');
	}

	async function handleAssignTo(chore: Chore, memberId: string, notice: string): Promise<void> {
		const pendingKey = `${chore.id}:take`;
		if (isPending(pendingKey)) return;
		startPending(pendingKey);
		setActionError(null);
		setActionNotice(null);

		const result = await apiFetch<{ chore: Chore }>(
			`/api/wg/${encodedShareCode}/chores/${encodeURIComponent(chore.id)}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				body: JSON.stringify({ assignedMemberId: memberId }),
			},
		);

		if (!result.ok) {
			if (result.status === 404 && result.error === 'chore_not_found') {
				setItems((current) => current.filter((item) => item.id !== chore.id));
				setActionError('Diese Putzaufgabe existiert nicht mehr und wurde aus dem Plan entfernt.');
				void load(false);
				endPending(pendingKey);
				return;
			}
			setActionError(
				result.error === 'unexpected_error' || result.error === 'server_error'
					? 'Aufgabe konnte nicht übernommen werden: Versuche es gleich erneut.'
					: result.status === 0 ||
							result.error === 'Netzwerkfehler' ||
							result.error === 'Failed to fetch'
						? 'Aufgabe konnte nicht übernommen werden: Prüfe deine Verbindung und versuche es erneut.'
						: 'Aufgabe konnte nicht übernommen werden.',
			);
		} else {
			setItems((current) =>
				current.map((item) =>
					item.id === chore.id ? { ...item, assignedMemberId: memberId } : item,
				),
			);
			setActionNotice(notice);
			void load(false);
		}

		endPending(pendingKey);
	}

	async function handleRemove(id: string): Promise<void> {
		if (isPending(id)) return;
		startPending(id);
		setActionError(null);
		setActionNotice(null);

		const result = await apiFetch<Record<string, never>>(
			`/api/wg/${encodedShareCode}/chores/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
			},
		);

		if (!result.ok) {
			const msg =
				result.status === 403
					? 'Nur WG-Admins können diese Aufgabe endgültig entfernen.'
					: result.status === 404 && result.error === 'chore_not_found'
						? 'Diese Putzaufgabe existiert nicht mehr und wurde aus dem Plan entfernt.'
						: result.status === 0 ||
								result.error === 'Netzwerkfehler' ||
								result.error === 'Failed to fetch'
							? 'Entfernen fehlgeschlagen: Prüfe deine Verbindung und versuche es erneut.'
							: 'Entfernen fehlgeschlagen.';
			setActionError(msg);
			if (result.status === 404 && result.error === 'chore_not_found') {
				setItems((current) => current.filter((item) => item.id !== id));
				void load(false);
			}
		} else {
			setItems((current) => current.filter((item) => item.id !== id));
			void load(false);
		}

		endPending(id);
	}

	function memberLookup(id: string | null): MemberInfo {
		if (!id) return { name: 'Niemand', color: null };
		const m = members.find((x) => x.id === id);
		return { name: m?.name ?? '?', color: m?.color ?? null };
	}

	// A member who moved out ("Auszug") leaves the rotation and every picker.
	// `memberLookup` above still resolves their name from the full roster so the
	// history and past assignments keep displaying correctly.
	const activeMembers = members.filter((m) => m.active);

	const showSkeleton = initialLoading && items.length === 0;
	const ownDueCount =
		!initialLoading && !loadError
			? items.filter(
					(chore) =>
						chore.assignedMemberId === identity.memberId &&
						['due', 'overdue'].includes(getChoreStatus(chore.nextDueAt).state),
				).length
			: undefined;
	const health = getChorePlanHealth(items);
	// Der Block "Lücken reparieren" zeigte genau diese Aufgaben als zweite
	// Kartenreihe, 200px über der Liste, in der sie ohnehin stehen. Statt sie zu
	// verdoppeln stehen die reparaturbedürftigen jetzt einfach oben.
	const sortedItems = useMemo(() => {
		const needsRepair = (item: Chore) => (getChoreRepairHint(item) !== null ? 0 : 1);
		return [...items].sort((a, b) => needsRepair(a) - needsRepair(b));
	}, [items]);
	const choreGroups = useMemo(
		() =>
			CHORE_GROUPS.map((group) => ({
				...group,
				chores: sortedItems.filter(
					(chore) => getChoreGroup(chore, identity.memberId) === group.key,
				),
			})).filter((group) => group.chores.length > 0),
		[identity.memberId, sortedItems],
	);
	const absentMemberIds = getAbsentMemberIds(absences);
	const selectedAbsence = useMemo(
		() => absences.find((absence) => absence.id === absenceId) ?? null,
		[absenceId, absences],
	);
	const visibleAbsences = useMemo(() => {
		if (absencesPanelActive) return absences;
		const firstItems = absences.slice(0, 4);
		if (!selectedAbsence || firstItems.some((absence) => absence.id === selectedAbsence.id)) {
			return firstItems;
		}
		return [selectedAbsence, ...firstItems].slice(0, 4);
	}, [absences, absencesPanelActive, selectedAbsence]);
	const hiddenAbsenceCount = absences.length - visibleAbsences.length;
	const fairness = buildChoreFairness({
		members: activeMembers.map((member) => ({ id: member.id, name: member.name })),
		chores: items,
		absentMemberIds,
	});
	const nextAssigneeNameByChoreId = new Map<string, string | null>(
		items.map((chore): [string, string | null] => {
			const nextAssigneeId = chooseNextAvailableMember({
				members: activeMembers,
				currentMemberId: chore.assignedMemberId,
				absentMemberIds,
				chores: items,
			});
			if (!nextAssigneeId) return [chore.id, null];
			return [
				chore.id,
				nextAssigneeId === identity.memberId ? 'du' : memberLookup(nextAssigneeId).name,
			];
		}),
	);
	const choreAddPending = isPending('chore:add');
	const absenceAddPending = isPending('absence:add');

	// A restored choice (including nobody) survives close/keep. Only a fresh
	// form after saving, or an explicitly accepted suggestion, gets a default.
	useEffect(() => {
		if (!showForm || !draftHydrated || pendingSuggestion) return;
		if (assigneeTouchedRef.current || !fairness.suggestedAssignee || newAssigned) return;
		setNewAssigned(fairness.suggestedAssignee.id);
	}, [draftHydrated, fairness.suggestedAssignee, newAssigned, pendingSuggestion, showForm]);
	const handleAssignedMemberIdChange = (value: string): void => {
		assigneeTouchedRef.current = true;
		setNewAssigned(value);
	};

	function applyQuickChore(template: (typeof QUICK_CHORE_TEMPLATES)[number]): void {
		suggestChore(template);
		window.setTimeout(() => titleInputRef.current?.focus(), 0);
	}

	function handleRecurrenceUnitToggle(unit: RecurrenceType): void {
		setNewRecurrenceType(unit);
		// Snap to a sensible default for the new unit so the number doesn't
		// become semantically meaningless (e.g. "30 Monate" after switching
		// from "30 Tage").
		if (unit === 'months') setNewInterval(1);
		else setNewInterval(7);
	}

	function handleIntervalPresetSelect(interval: number, unit: RecurrenceType): void {
		setNewInterval(interval);
		setNewRecurrenceType(unit);
	}

	return (
		<div data-household-content className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
			<SubNav liveCount={ownDueCount} />
			<PutzenHeader
				itemCount={items.length}
				loading={showSkeleton}
				health={!showSkeleton && items.length > 0 ? health : null}
				refreshing={refreshing}
				showForm={showForm}
				onToggleForm={() => setShowForm((open) => !open)}
			/>
			<ChoreForm
				open={showForm}
				onClose={() => setShowForm(false)}
				error={actionError}
				title={newTitle}
				onTitleChange={setNewTitle}
				titleInputRef={titleInputRef}
				interval={newInterval}
				recurrenceType={newRecurrenceType}
				onRecurrenceUnitToggle={handleRecurrenceUnitToggle}
				onIntervalPresetSelect={handleIntervalPresetSelect}
				assignedMemberId={newAssigned}
				onAssignedMemberIdChange={handleAssignedMemberIdChange}
				members={activeMembers}
				pending={choreAddPending}
				onSubmit={() => void add()}
			>
				{pendingSuggestion && (
					<Alert>
						<AlertDescription>
							<p>Dein vorhandener Entwurf bleibt erhalten.</p>
							<Button
								type="button"
								variant="outline"
								onClick={() => setConfirmSuggestion(true)}
								disabled={choreAddPending}
								className="h-auto whitespace-normal"
							>
								Entwurf verwerfen und „{pendingSuggestion.title}“ übernehmen
							</Button>
						</AlertDescription>
					</Alert>
				)}
				{confirmSuggestion && (
					<ConfirmDialog
						open
						onClose={() => setConfirmSuggestion(false)}
						onConfirm={() => {
							if (pendingSuggestion) applyChoreSuggestion(pendingSuggestion);
						}}
						title="Entwurf verwerfen?"
						description="Der bisherige Aufgabenentwurf wird durch den Vorschlag ersetzt. Bereits gespeicherte Aufgaben bleiben erhalten."
						confirmLabel="Entwurf verwerfen"
						cancelLabel="Entwurf behalten"
					/>
				)}
			</ChoreForm>
			{actionError && !showForm && !completeConfirmId && (
				<Alert variant="destructive">
					<AlertDescription>{actionError}</AlertDescription>
				</Alert>
			)}
			{actionNotice && <ActionNoticeBanner notice={{ tone: 'success', message: actionNotice }} />}
			{queuedCount > 0 && (
				<output aria-live="polite">
					<OfflineQueueNotice queuedCount={queuedCount} />
				</output>
			)}
			{loadError && (
				<LoadErrorBanner
					message={loadError}
					onRetry={() => void load(true)}
					busy={initialLoading || refreshing}
					retryLabel="Putzplan erneut laden"
				/>
			)}

			{showSkeleton ? (
				<ListSkeleton />
			) : loadError && items.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Noch keine Aufgaben geladen</EmptyTitle>
						<EmptyDescription>Versuche es erneut.</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : items.length === 0 && !initialLoading ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Sparkles aria-hidden />
						</EmptyMedia>
						<EmptyTitle>Noch keine Aufgaben</EmptyTitle>
						<EmptyDescription>Starte mit einer typischen WG-Aufgabe:</EmptyDescription>
					</EmptyHeader>
					<EmptyContent className="flex-row flex-wrap justify-center">
						{QUICK_CHORE_TEMPLATES.map((template) => (
							<Button
								key={template.title}
								variant="outline"
								onClick={() => applyQuickChore(template)}
							>
								{template.title}
							</Button>
						))}
					</EmptyContent>
				</Empty>
			) : (
				<div id="chore-list" className="flex flex-col gap-5">
					{choreGroups.map((group) => (
						<section
							key={group.key}
							aria-labelledby={`chore-group-${group.key}`}
							className="flex flex-col gap-2"
						>
							<h2
								id={`chore-group-${group.key}`}
								className="text-sm font-medium text-muted-foreground"
							>
								{group.label} ({group.chores.length})
							</h2>
							<ItemGroup aria-label={group.label}>
								{group.chores.map((chore) => (
									<ChoreRow
										key={chore.id}
										chore={chore}
										isAdmin={isAdmin}
										assignee={memberLookup(chore.assignedMemberId)}
										isPending={isPending(chore.id)}
										isSwapPending={isPending(`${chore.id}:swap`)}
										isTakePending={isPending(`${chore.id}:take`)}
										isCompleteArmed={completeConfirmId === chore.id}
										completeError={actionError}
										nextAssigneeName={nextAssigneeNameByChoreId.get(chore.id) ?? null}
										onCancelComplete={() => setCompleteConfirmId(null)}
										onComplete={handleComplete}
										onSwapRequest={handleSwapRequest}
										onTakeOver={handleTakeOver}
										onRemove={handleRemove}
										highlighted={highlightedId === chore.id}
									/>
								))}
							</ItemGroup>
						</section>
					))}
				</div>
			)}
			{!showSkeleton && (items.length > 0 || absences.length > 0 || absencesPanelActive) && (
				<AbsencePanel
					active={absencesPanelActive}
					absentCount={absentMemberIds.length}
					members={activeMembers}
					memberId={absenceMemberId}
					onMemberIdChange={setAbsenceMemberId}
					start={absenceStart}
					onStartChange={setAbsenceStart}
					end={absenceEnd}
					onEndChange={setAbsenceEnd}
					reason={absenceReason}
					onReasonChange={setAbsenceReason}
					pending={absenceAddPending}
					onAdd={() => void addAbsence()}
					hiddenCount={hiddenAbsenceCount}
					totalCount={absences.length}
					allAbsencesHref={`${wgBaseHref}/putzen?panel=absences`}
					visibleAbsences={visibleAbsences}
					highlightedAbsenceId={absenceId}
					onRemove={(id) => void removeAbsence(id)}
					isPending={isPending}
				/>
			)}
			{!showSkeleton && items.length > 0 && (
				<FairnessPanel
					fairness={fairness}
					monthCompletions={monthCompletions}
					members={members.map((member) => ({ id: member.id, name: member.name }))}
				/>
			)}
		</div>
	);
}
