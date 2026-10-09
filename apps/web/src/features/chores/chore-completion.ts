import {
	READ_ONLY_MESSAGE,
	SESSION_EXPIRED_MESSAGE,
	isReadOnlyMode,
	isSessionExpired,
} from '@/core/http/error-codes';
import { apiFetch } from '@/core/infra/api-client';
import { enqueueOfflineAction } from '@/core/offline/offline-client';
import {
	createOfflineIdempotencyKey,
	createQueuedChoreCompletion,
} from '@/core/offline/offline-queue';
import { formatShortDate, parseTimestamp } from '@/core/utils/time';

/** The occurrence a member confirms as done: the server rejects it once date or assignee moved. */
export interface ChoreOccurrence {
	id: string;
	title: string;
	nextDueAt: string;
	assignedMemberId: string | null;
}

/** Next occurrence as `POST /chores/<id>/complete` confirms it. */
interface ConfirmedChore {
	id: string;
	nextDueAt: string;
	assignedMemberId: string | null;
}

export type ChoreCompletionOutcome =
	| { kind: 'completed'; next: ConfirmedChore | null }
	| { kind: 'queued' }
	| { kind: 'queue_blocked' }
	| { kind: 'key_unavailable' }
	| { kind: 'not_found' }
	| { kind: 'already_completed' }
	| { kind: 'occurrence_changed' }
	| { kind: 'insert_failed' }
	| { kind: 'read_only' }
	| { kind: 'session_expired' }
	| { kind: 'failed' };

export interface ChoreCompletionContext {
	wgId: string;
	shareCode: string;
	memberId: string;
	/**
	 * Idempotency keys by occurrence (see `completionRequestKey`). A retry of the same
	 * occurrence reuses its key; the next occurrence must not replay an earlier completion.
	 */
	keys: Map<string, string>;
}

export function completionRequestKey(chore: Pick<ChoreOccurrence, 'id' | 'nextDueAt'>): string {
	return `${chore.id}:${chore.nextDueAt}`;
}

/**
 * Completes one chore occurrence. Network failures queue the completion offline with the
 * same idempotency key, so the later replay deduplicates against an attempt that did reach
 * the server. The key survives 5xx and 429 answers for the same reason.
 */
export async function submitChoreCompletion(
	ctx: ChoreCompletionContext,
	chore: ChoreOccurrence,
): Promise<ChoreCompletionOutcome> {
	const requestKey = completionRequestKey(chore);
	const idempotencyKey = ctx.keys.get(requestKey) ?? createOfflineIdempotencyKey();
	if (!idempotencyKey) return { kind: 'key_unavailable' };
	ctx.keys.set(requestKey, idempotencyKey);

	const result = await apiFetch<{ chore?: ConfirmedChore }>(
		`/api/wg/${encodeURIComponent(ctx.shareCode)}/chores/${encodeURIComponent(chore.id)}/complete`,
		{
			method: 'POST',
			memberId: ctx.memberId,
			headers: { 'Idempotency-Key': idempotencyKey },
			body: JSON.stringify({
				expectedNextDueAt: chore.nextDueAt,
				expectedAssignedMemberId: chore.assignedMemberId,
			}),
		},
	);

	if (result.ok) {
		ctx.keys.delete(requestKey);
		const next = result.data.chore;
		const confirmed = next?.id === chore.id && parseTimestamp(next.nextDueAt) !== null;
		return { kind: 'completed', next: confirmed && next ? next : null };
	}

	if (result.status === 0) {
		const queuedCount = await enqueueOfflineAction(
			createQueuedChoreCompletion({
				wgId: ctx.wgId,
				shareCode: ctx.shareCode,
				memberId: ctx.memberId,
				idempotencyKey,
				choreId: chore.id,
				expectedNextDueAt: chore.nextDueAt,
				expectedAssignedMemberId: chore.assignedMemberId,
			}),
		);
		if (queuedCount === 0) return { kind: 'queue_blocked' };
		// The queued action carries the key from here on.
		ctx.keys.delete(requestKey);
		return { kind: 'queued' };
	}

	if (result.status < 500 && result.status !== 429) ctx.keys.delete(requestKey);
	if (result.status === 404 && result.error === 'chore_not_found') return { kind: 'not_found' };
	if (
		(result.status === 404 || result.status === 409) &&
		result.error === 'chore_already_completed'
	) {
		return { kind: 'already_completed' };
	}
	if (result.status === 409 && result.error === 'chore_occurrence_changed') {
		return { kind: 'occurrence_changed' };
	}
	if (result.error === 'completion_insert_failed') return { kind: 'insert_failed' };
	if (isReadOnlyMode(result.error)) return { kind: 'read_only' };
	if (isSessionExpired(result.error)) return { kind: 'session_expired' };
	return { kind: 'failed' };
}

export interface ChoreCompletionFeedback {
	/** `success` goes to a toast, `notice` and `error` to the page's message slot. */
	tone: 'success' | 'notice' | 'error';
	message: string;
	/** An additional error toast, for failures that must not go unnoticed. */
	toast: string | null;
	/** The confirm step is over; a failure that keeps it open lets the member retry. */
	done: boolean;
	/** The plan has to be read again to show the server's state. */
	reload: boolean;
}

export const CHORE_COMPLETION_COPY = {
	keyUnavailable: 'Erledigt-Aktion konnte nicht sicher gespeichert werden. Versuche es erneut.',
	queued:
		'Erledigung offline vorgemerkt. Nächster Termin und Zuständigkeit werden nach der Synchronisierung bestätigt.',
	queueBlocked:
		'Offline-Speicher ist blockiert. Versuche es später erneut, sobald dein Browser wieder speichern kann.',
	queueBlockedToast: 'Die Erledigung konnte nicht offline vorgemerkt werden.',
	notFound: 'Diese Putzaufgabe existiert nicht mehr und wurde aus dem Plan entfernt.',
	alreadyCompleted: 'Diese Putzaufgabe wurde bereits erledigt. Der Plan wird aktualisiert.',
	occurrenceChanged: 'Termin oder Zuständigkeit haben sich geändert. Der Plan wird aktualisiert.',
	insertFailed:
		'Erledigt-Aktion konnte nicht vollständig gespeichert werden: Lade den Plan neu und prüfe den Verlauf.',
	readOnly: `Erledigt-Aktion konnte nicht gespeichert werden: ${READ_ONLY_MESSAGE}`,
	sessionExpired: `Erledigt-Aktion konnte nicht gespeichert werden: ${SESSION_EXPIRED_MESSAGE}`,
	failed: 'Erledigt-Aktion konnte nicht gespeichert werden: Versuche es gleich erneut.',
} as const;

function choreCompletedMessage(
	title: string,
	next: ConfirmedChore | null,
	nextAssigneeName: string | undefined,
): string {
	if (!next) {
		return `${title} erledigt. Der bestätigte nächste Termin und die Zuständigkeit werden geladen.`;
	}
	const date = formatShortDate(next.nextDueAt, 'Europe/Berlin');
	if (!nextAssigneeName) {
		return `${title} erledigt. Nächster Termin: ${date}, noch niemand zugewiesen.`;
	}
	// "du" is the own member (callers map it), the dialog before says "Danach bist du dran".
	const verb = nextAssigneeName === 'du' ? 'bist' : 'ist';
	return `${title} erledigt. Als Nächstes ${verb} ${nextAssigneeName} am ${date} dran.`;
}

/** What the member sees for an outcome; the start page and the cleaning plan share it. */
export function choreCompletionFeedback(
	outcome: ChoreCompletionOutcome,
	chore: Pick<ChoreOccurrence, 'title'>,
	memberName: (memberId: string | null) => string | undefined,
): ChoreCompletionFeedback {
	const copy = CHORE_COMPLETION_COPY;
	const error = (message: string, done: boolean, reload: boolean, toast: string | null = null) =>
		({ tone: 'error', message, toast, done, reload }) as const;
	switch (outcome.kind) {
		case 'completed':
			return {
				tone: 'success',
				message: choreCompletedMessage(
					chore.title,
					outcome.next,
					outcome.next ? memberName(outcome.next.assignedMemberId) : undefined,
				),
				toast: null,
				done: true,
				reload: true,
			};
		case 'queued':
			return { tone: 'notice', message: copy.queued, toast: null, done: true, reload: false };
		case 'already_completed':
			return {
				tone: 'notice',
				message: copy.alreadyCompleted,
				toast: null,
				done: true,
				reload: true,
			};
		case 'key_unavailable':
			return error(copy.keyUnavailable, false, false);
		case 'queue_blocked':
			return error(copy.queueBlocked, false, false, copy.queueBlockedToast);
		case 'not_found':
			return error(copy.notFound, true, true, copy.notFound);
		case 'occurrence_changed':
			return error(copy.occurrenceChanged, true, true);
		case 'insert_failed':
			return error(copy.insertFailed, false, true, copy.insertFailed);
		case 'read_only':
			return error(copy.readOnly, false, false, copy.readOnly);
		case 'session_expired':
			return error(copy.sessionExpired, false, false, copy.sessionExpired);
		case 'failed':
			return error(copy.failed, false, false, copy.failed);
	}
}
