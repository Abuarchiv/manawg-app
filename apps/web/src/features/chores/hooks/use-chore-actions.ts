import { apiFetch } from '@/core/infra/api-client';
import { discardQueuedEntry } from '@/core/offline/offline-client';
import { isQueuedCreateId } from '@/core/offline/offline-queue';
import { parseValidDate } from '@/core/utils/time';
import { getAbsentMemberIds } from '@/features/chores/absence';
import { choreCompletionFeedback } from '@/features/chores/chore-completion';
import type { ChoreEditChanges } from '@/features/chores/chore-edit';
import { choreEditErrorMessage } from '@/features/chores/chore-errors';
import { choreActionErrorMessage } from '@/features/chores/chore-errors';
import { chooseNextAvailableMember } from '@/features/chores/chore-fairness';
import { computeNextDueAt } from '@/features/chores/chore-recurrence';
import { getChoreStatus } from '@/features/chores/chore-status';
import type { Chore } from '@/features/chores/components/chore-types';
import { useState } from 'react';
import type { ChorePageContext } from './chore-page-context';
import { useChoreCompletion } from './use-chore-completion';

/** Completing (with a confirm tap), swap request, taking over and removing a chore. */
export function useChoreActions(ctx: ChorePageContext) {
	const {
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
		updateChores,
		load,
		refreshCount,
	} = ctx;
	const completeChore = useChoreCompletion(wg, identity);
	const [completeConfirmId, setCompleteConfirmId] = useState<string | null>(null);
	// Chores whose swap request is already on the Pinnwand; a second tap would post a duplicate.
	const [swapRequestedIds, setSwapRequestedIds] = useState<ReadonlySet<string>>(new Set());

	/**
	 * A chore created offline only has a local pseudo id, which the server routes reject with
	 * `id_invalid`. A clear notice replaces the misleading error.
	 */
	function isStillQueued(chore: Chore): boolean {
		if (!isQueuedCreateId(chore.id)) return false;
		setActionError(null);
		setActionNotice(
			'Diese Aufgabe ist noch offline vorgemerkt und lässt sich erst nach der Synchronisierung bearbeiten.',
		);
		return true;
	}

	function restore(previousChore: Chore): void {
		updateChores((current) =>
			current.some((item) => item.id === previousChore.id)
				? current.map((item) => (item.id === previousChore.id ? previousChore : item))
				: [...current, previousChore],
		);
	}

	/** The chore stays in the plan offline: move it to its next date and assignee locally. */
	function advanceLocally(previousChore: Chore): void {
		const dueAt = parseValidDate(previousChore.nextDueAt);
		if (!dueAt) {
			// Without a valid date there is nothing to move; the row stays as it was.
			restore(previousChore);
			return;
		}
		const localNextDueAt = computeNextDueAt(
			dueAt,
			previousChore.intervalDays,
			new Date(),
			previousChore.recurrenceType,
		);
		const localNextAssignee = chooseNextAvailableMember({
			members: activeMembers,
			currentMemberId: previousChore.assignedMemberId,
			absentMemberIds: getAbsentMemberIds(absences, localNextDueAt.getTime()),
			chores: items,
		});
		updateChores((current) => [
			...current.filter((item) => item.id !== previousChore.id),
			{
				...previousChore,
				nextDueAt: localNextDueAt.toISOString(),
				assignedMemberId: localNextAssignee ?? previousChore.assignedMemberId,
			},
		]);
	}

	async function handleComplete(chore: Chore): Promise<void> {
		if (isPending(chore.id) || isStillQueued(chore)) return;

		// First tap → arm; second tap → commit
		if (completeConfirmId !== chore.id) {
			setActionError(null);
			setCompleteConfirmId(chore.id);
			return;
		}

		startPending(chore.id);
		setActionError(null);
		setActionNotice(null);
		const previousChore = items.find((item) => item.id === chore.id) ?? chore;
		updateChores((current) => current.filter((item) => item.id !== chore.id));

		const outcome = await completeChore(chore);
		switch (outcome.kind) {
			case 'completed':
				// Completing a chore closes the swap request; a new one is possible for the next occurrence.
				setSwapRequestedIds((current) => {
					if (!current.has(chore.id)) return current;
					const rest = new Set(current);
					rest.delete(chore.id);
					return rest;
				});
				if (outcome.next) {
					const next = outcome.next;
					const completed: Chore = {
						...chore,
						nextDueAt: next.nextDueAt,
						assignedMemberId: next.assignedMemberId,
						lastCompletedAt: new Date().toISOString(),
						lastCompletedByName: identity.name,
					};
					updateChores((current) =>
						current.some((item) => item.id === chore.id)
							? current.map((item) => (item.id === chore.id ? completed : item))
							: [...current, completed],
					);
				}
				break;
			case 'queued':
				advanceLocally(previousChore);
				refreshCount();
				break;
			case 'not_found':
				updateChores((current) => current.filter((item) => item.id !== chore.id));
				break;
			case 'already_completed':
			case 'occurrence_changed':
				break;
			default:
				restore(previousChore);
		}

		const feedback = choreCompletionFeedback(outcome, chore, (id) =>
			id === identity.memberId ? 'du' : members.find((member) => member.id === id)?.name,
		);
		if (feedback.tone === 'success') toast.success(feedback.message);
		else if (feedback.tone === 'notice') setActionNotice(feedback.message);
		else setActionError(feedback.message);
		// While the dialog stays open its alert already shows the error; a toast would duplicate it.
		if (feedback.done && feedback.toast && feedback.toast !== feedback.message) {
			toast.error(feedback.toast);
		}
		if (feedback.done) setCompleteConfirmId(null);
		if (feedback.reload) void load(false);
		endPending(chore.id);
	}

	/** Cancel also clears the error, which would otherwise linger as a page banner after the dialog closes. */
	function cancelComplete(): void {
		setActionError(null);
		setCompleteConfirmId(null);
	}

	async function handleSwapRequest(chore: Chore): Promise<void> {
		const pendingKey = `${chore.id}:swap`;
		if (isPending(pendingKey) || swapRequestedIds.has(chore.id) || isStillQueued(chore)) return;

		startPending(pendingKey);
		setActionError(null);
		setActionNotice(null);

		const status = getChoreStatus(chore.nextDueAt);
		const result = await apiFetch<Record<string, never>>(
			`/api/wg/${encodedShareCode}/announcements`,
			{
				method: 'POST',
				memberId: identity.memberId,
				body: JSON.stringify({
					kind: 'request',
					source: 'chore_swap',
					choreId: chore.id,
					// Parentheses instead of „ist …“: labels like „in 7 T.“ or „Datum prüfen“ read wrong inside the sentence.
					content: `${identity.name} bittet um Tausch: „${chore.title}“ (${status.label}). Übernehmen oder kurz absprechen?`,
				}),
			},
		);

		if (!result.ok) {
			setActionError(choreActionErrorMessage('Tauschanfrage konnte nicht gepostet werden', result));
		} else {
			setSwapRequestedIds((current) => new Set(current).add(chore.id));
			toast.success('Tauschanfrage wurde auf der Pinnwand gepostet.');
		}

		endPending(pendingKey);
	}

	async function handleTakeOver(chore: Chore): Promise<void> {
		await patchChore(
			chore,
			{ assignedMemberId: identity.memberId },
			`${chore.id}:take`,
			(result) => choreActionErrorMessage('Aufgabe konnte nicht übernommen werden', result),
			'Du bist jetzt für die Aufgabe eingetragen.',
		);
	}

	/** Saves the edit form; resolves to whether it went through, so the drawer can close. */
	async function handleEdit(chore: Chore, changes: ChoreEditChanges): Promise<boolean> {
		const assigneeName =
			changes.assignedMemberId === undefined
				? null
				: changes.assignedMemberId === null
					? 'Niemand'
					: changes.assignedMemberId === identity.memberId
						? 'du'
						: (members.find((member) => member.id === changes.assignedMemberId)?.name ?? null);
		return patchChore(
			chore,
			changes,
			`${chore.id}:edit`,
			(result) => choreEditErrorMessage(result.error),
			assigneeName && Object.keys(changes).length === 1
				? `Zuständig: ${assigneeName}.`
				: 'Änderungen gespeichert.',
		);
	}

	async function patchChore(
		chore: Chore,
		changes: ChoreEditChanges,
		pendingKey: string,
		errorMessage: (result: { error: string; status: number }) => string,
		notice: string,
	): Promise<boolean> {
		if (isPending(pendingKey) || isStillQueued(chore)) return false;
		startPending(pendingKey);
		setActionError(null);
		setActionNotice(null);

		const result = await apiFetch<{ chore: Chore }>(
			`/api/wg/${encodedShareCode}/chores/${encodeURIComponent(chore.id)}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				body: JSON.stringify(changes),
			},
		);

		try {
			if (!result.ok) {
				if (result.status === 404 && result.error === 'chore_not_found') {
					updateChores((current) => current.filter((item) => item.id !== chore.id));
					setActionError('Diese Putzaufgabe existiert nicht mehr und wurde aus dem Plan entfernt.');
					void load(false);
					return true;
				}
				setActionError(errorMessage(result));
				if (result.status === 409 && result.error === 'chore_changed') void load(false);
				return false;
			}
			updateChores((current) =>
				current.map((item) => (item.id === chore.id ? { ...item, ...changes } : item)),
			);
			// A new assignee settles the open swap request, so the chore can ask again later.
			if (changes.assignedMemberId !== undefined) {
				setSwapRequestedIds((current) => {
					if (!current.has(chore.id)) return current;
					const rest = new Set(current);
					rest.delete(chore.id);
					return rest;
				});
			}
			toast.success(notice);
			void load(false);
			return true;
		} finally {
			endPending(pendingKey);
		}
	}

	async function handleRemove(id: string): Promise<void> {
		if (isPending(id)) return;
		startPending(id);
		try {
			setActionError(null);
			setActionNotice(null);
			const queued = await discardQueuedEntry(wg.shareCode, id);
			if (queued === 'storage_blocked') {
				setActionError(
					'Offline-Speicher ist blockiert. Die vorgemerkte Aufgabe konnte nicht entfernt werden.',
				);
				return;
			}
			if (queued === 'removed' || isQueuedCreateId(id)) {
				updateChores((current) => current.filter((item) => item.id !== id));
				refreshCount();
				setActionNotice('Offline vorgemerkte Aufgabe wurde entfernt.');
				return;
			}

			const result = await apiFetch<Record<string, never>>(
				`/api/wg/${encodedShareCode}/chores/${encodeURIComponent(id)}`,
				{
					method: 'DELETE',
					memberId: identity.memberId,
				},
			);

			if (!result.ok) {
				const msg =
					result.status === 403 && result.error === 'admin_required'
						? 'Nur WG-Admins können diese Aufgabe endgültig entfernen.'
						: result.status === 404 && result.error === 'chore_not_found'
							? 'Diese Putzaufgabe existiert nicht mehr und wurde aus dem Plan entfernt.'
							: choreActionErrorMessage('Entfernen fehlgeschlagen', result);
				setActionError(msg);
				if (result.status === 404 && result.error === 'chore_not_found') {
					updateChores((current) => current.filter((item) => item.id !== id));
					void load(false);
				}
			} else {
				const removedTitle = items.find((item) => item.id === id)?.title;
				updateChores((current) => current.filter((item) => item.id !== id));
				toast.success(removedTitle ? `„${removedTitle}“ entfernt.` : 'Aufgabe entfernt.');
				void load(false);
			}
		} finally {
			endPending(id);
		}
	}

	return {
		completeConfirmId,
		cancelComplete,
		handleComplete,
		handleSwapRequest,
		swapRequestedIds,
		handleTakeOver,
		handleEdit,
		handleRemove,
	};
}
