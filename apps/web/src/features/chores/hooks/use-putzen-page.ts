import { useToast } from '@/components/ui/Toast';
import { useWg } from '@/components/wg/WgContextProvider';
import { usePendingSet } from '@/core/hooks/usePendingSet';
import {
	getAbsentAssigneeChoreIds,
	getAbsentMemberIds,
	pickVisibleAbsences,
} from '@/features/chores/absence';
import { buildChoreFairness, predictNextAssigneeId } from '@/features/chores/chore-fairness';
import {
	filterOverdueGroups,
	getChorePlanHealth,
	getChoreStatus,
	groupChoresForPlan,
} from '@/features/chores/chore-status';
import type { MemberInfo } from '@/shared/lib/member-types';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { ChorePageContext } from './chore-page-context';
import { useAbsenceFormState, useAbsences } from './use-absences';
import { useChoreActions } from './use-chore-actions';
import { useChoreCreate } from './use-chore-create';
import { useChoresData } from './use-chores-data';

/** The chore plan page: ties loading, creating, actions and absences together and derives the view. */
export function usePutzenPage() {
	const { wg, members, identity } = useWg();
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const searchParams = useSearchParams();
	const highlightedId = searchParams.get('highlight');
	const prefillTitle = searchParams.get('title');
	const overdueFilterActive = searchParams.get('filter') === 'overdue';
	const absencesPanelActive = searchParams.get('panel') === 'absences';
	const absenceId = searchParams.get('absence');
	const [actionError, setActionError] = useState<string | null>(null);
	const [actionNotice, setActionNotice] = useState<string | null>(null);
	const { isPending, start: startPending, end: endPending } = usePendingSet();

	const data = useChoresData({ wg, identity, encodedShareCode, setActionNotice });
	const { items, absences, initialLoading, loadError } = data;

	// A member who moved out ("Auszug") leaves the rotation and every picker.
	// `memberLookup` below still resolves their name from the full roster so the
	// history and past assignments keep displaying correctly.
	const activeMembers = members.filter((m) => m.active);

	const ctx: ChorePageContext = {
		wg,
		identity,
		members,
		activeMembers,
		encodedShareCode,
		toast,
		isPending,
		startPending,
		endPending,
		setActionError,
		setActionNotice,
		items,
		absences,
		updateChores: data.updateChores,
		updateAbsences: data.updateAbsences,
		load: data.load,
		refreshCount: data.refreshCount,
	};

	const absentMemberIds = getAbsentMemberIds(absences);
	const fairness = buildChoreFairness({
		members: activeMembers.map((member) => ({ id: member.id, name: member.name })),
		chores: items,
		absentMemberIds,
	});
	const absenceForm = useAbsenceFormState(identity.memberId);
	const create = useChoreCreate(ctx, absenceForm, prefillTitle, fairness.suggestedAssignee);
	const absenceActions = useAbsences(ctx, absenceForm, create.queueEdit);
	const choreActions = useChoreActions(ctx);

	// The highlight is a brief hint, not a selection state: it fades after 2.5 s.
	const [flashId, setFlashId] = useState<string | null>(null);
	const hasItems = items.length > 0;
	useEffect(() => {
		if (!highlightedId || !hasItems) return;
		setFlashId(highlightedId);
		const scrollTimer = window.setTimeout(() => {
			document.getElementById(`chore-${highlightedId}`)?.scrollIntoView({
				block: 'center',
			});
		}, 80);
		const clearTimer = window.setTimeout(() => setFlashId(null), 2500);
		return () => {
			window.clearTimeout(scrollTimer);
			window.clearTimeout(clearTimer);
		};
	}, [highlightedId, hasItems]);

	// `?filter=overdue` shows only overdue chores until "Alle anzeigen" is tapped.
	const [showAllChores, setShowAllChores] = useState(false);

	// The row exists only after loading; without it in the dependencies the scroll would target nothing.
	const absenceRowExists = absenceId ? absences.some((absence) => absence.id === absenceId) : false;
	const [flashAbsenceId, setFlashAbsenceId] = useState<string | null>(null);
	useEffect(() => {
		if ((!absencesPanelActive && !absenceId) || initialLoading) return;
		if (absenceRowExists) setFlashAbsenceId(absenceId);
		const scrollTimer = window.setTimeout(() => {
			if (absenceRowExists) {
				document.getElementById(`absence-${absenceId}`)?.scrollIntoView({ block: 'center' });
				return;
			}
			document.getElementById('absences-panel')?.scrollIntoView({
				block: 'start',
			});
		}, 80);
		const clearTimer = window.setTimeout(() => setFlashAbsenceId(null), 2500);
		return () => {
			window.clearTimeout(scrollTimer);
			window.clearTimeout(clearTimer);
		};
	}, [absenceId, absenceRowExists, absencesPanelActive, initialLoading]);

	function memberLookup(id: string | null): MemberInfo {
		if (!id) return { name: 'Niemand', color: null };
		const m = members.find((x) => x.id === id);
		return { name: m?.name ?? '?', color: m?.color ?? null };
	}

	const showSkeleton = initialLoading && items.length === 0;
	const ownDueCount =
		!initialLoading && !loadError
			? items.filter(
					(chore) =>
						chore.assignedMemberId === identity.memberId &&
						['due', 'overdue'].includes(getChoreStatus(chore.nextDueAt).state),
				).length
			: undefined;
	const allChoreGroups = useMemo(() => {
		const absentAssigneeChoreIds = getAbsentAssigneeChoreIds(items, absences);
		return groupChoresForPlan(
			items.map((chore) => ({ ...chore, assigneeAbsent: absentAssigneeChoreIds.has(chore.id) })),
			identity.memberId,
		);
	}, [absences, identity.memberId, items]);
	const overdueGroups = useMemo(() => filterOverdueGroups(allChoreGroups), [allChoreGroups]);
	// Once nothing is overdue anymore (e.g. after completing the last one) the full list returns.
	const overdueFilter = {
		active: overdueFilterActive && !showAllChores && overdueGroups.length > 0,
		showAll: () => setShowAllChores(true),
	};
	const choreGroups = overdueFilter.active ? overdueGroups : allChoreGroups;
	const visibleAbsences = useMemo(
		() => pickVisibleAbsences(absences, absencesPanelActive, absenceId),
		[absenceId, absences, absencesPanelActive],
	);
	const nextAssigneeNameByChoreId = new Map<string, string | null>(
		items.map((chore): [string, string | null] => {
			const nextAssigneeId = predictNextAssigneeId(chore, items, activeMembers, absences);
			if (!nextAssigneeId) return [chore.id, null];
			return [
				chore.id,
				nextAssigneeId === identity.memberId ? 'du' : memberLookup(nextAssigneeId).name,
			];
		}),
	);

	return {
		activeMembers,
		absenceAddPending: isPending('absence:add'),
		absenceEnd: absenceForm.absenceEnd,
		absenceError: absenceActions.absenceError,
		absenceListError: absenceActions.absenceListError,
		absenceId,
		absenceMemberId: absenceForm.absenceMemberId,
		absenceReason: absenceForm.absenceReason,
		absenceStart: absenceForm.absenceStart,
		absences,
		absencesPanelActive,
		absentMemberIds,
		actionError,
		actionNotice,
		applyChoreSuggestion: create.applyChoreSuggestion,
		applyQuickChore: create.applyQuickChore,
		choreAddPending: isPending('chore:add'),
		choreGroups,
		overdueFilter,
		completeConfirmId: choreActions.completeConfirmId,
		confirmSuggestion: create.confirmSuggestion,
		fairness,
		flashAbsenceId,
		handleAssignedMemberIdChange: create.handleAssignedMemberIdChange,
		handleComplete: choreActions.handleComplete,
		handleEdit: choreActions.handleEdit,
		handleIntervalPresetSelect: create.handleIntervalPresetSelect,
		handleRecurrenceUnitToggle: create.handleRecurrenceUnitToggle,
		handleRemove: choreActions.handleRemove,
		handleSwapRequest: choreActions.handleSwapRequest,
		swapRequestedIds: choreActions.swapRequestedIds,
		handleTakeOver: choreActions.handleTakeOver,
		hiddenAbsenceCount: absences.length - visibleAbsences.length,
		highlightedId: flashId,
		initialLoading,
		isPending,
		items,
		load: data.load,
		loadError,
		memberLookup,
		monthCompletions: data.monthCompletions,
		newAssigned: create.newAssigned,
		newFirstDue: create.newFirstDue,
		newInterval: create.newInterval,
		newRecurrenceType: create.newRecurrenceType,
		newTitle: create.newTitle,
		nextAssigneeNameByChoreId,
		ownDueCount,
		pendingSuggestion: create.pendingSuggestion,
		queuedCount: data.queuedCount,
		refreshing: data.refreshing,
		removeAbsence: absenceActions.removeAbsence,
		addAbsence: absenceActions.addAbsence,
		add: create.add,
		setAbsenceEnd: (value: string) => {
			absenceActions.clearAbsenceError();
			absenceForm.setAbsenceEnd(value);
		},
		setAbsenceMemberId: (value: string) => {
			absenceActions.clearAbsenceError();
			absenceForm.setAbsenceMemberId(value);
		},
		setAbsenceReason: (value: string) => {
			absenceActions.clearAbsenceError();
			absenceForm.setAbsenceReason(value);
		},
		setAbsenceStart: (value: string) => {
			absenceActions.clearAbsenceError();
			absenceForm.setAbsenceStart(value);
		},
		cancelComplete: choreActions.cancelComplete,
		setConfirmSuggestion: create.setConfirmSuggestion,
		setNewFirstDue: create.setNewFirstDue,
		setNewTitle: create.setNewTitle,
		setShowForm: create.setShowForm,
		health: getChorePlanHealth(items),
		showForm: create.showForm,
		showSkeleton,
		titleInputRef: create.titleInputRef,
		visibleAbsences,
	};
}
