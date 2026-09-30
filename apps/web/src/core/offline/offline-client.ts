'use client';

import { apiFetch } from '@/core/infra/api-client';
import { getIdentity } from '@/shared/lib/identity';
import { isPendingImageToken, removePendingImage, uploadPendingImageToken } from './offline-images';
import {
	type OfflineAction,
	type OfflineActionType,
	createOfflineIdempotencyKey,
	explainOfflineActionFailure,
	getOfflineActionRequest,
	isOfflineIdempotencyKey,
	serializeOfflineAction,
	shouldRetryOfflineAction,
	withoutQueuedEntry,
} from './offline-queue';
import {
	OFFLINE_REPLAY_CLOCK_SKEW_MS,
	OFFLINE_REPLAY_MAX_AGE_MS,
	RESPONSE_REPLAY_TTL_SECONDS,
} from './replay-retention';

export const OFFLINE_QUEUE_KEY = 'manawg:offline-actions';
export const SYNCED_IDS_KEY = 'manawg:offline-synced-ids';
/** No expiry: replaying an edited action under its original key can drop the edit. */
const OFFLINE_REVIEW_IDS_KEY = 'manawg:offline-review-ids';
/** How long a "synced but queue-write failed" marker survives reloads. */
const SYNCED_IDS_TTL_MS = RESPONSE_REPLAY_TTL_SECONDS * 1000;
const syncedAfterFailedQueueSave = new Set<string>();
const reviewAfterFailedQueueSave = new Set<string>();
// ponytail: this fallback lasts for the current page only; use IndexedDB if reload-time recovery is required.
let cachedOfflineQueue: OfflineAction[] | null = null;
const OFFLINE_ACTION_TYPES: ReadonlySet<OfflineActionType> = new Set([
	'shopping.create',
	'shopping.update',
	'announcement.create',
	'absence.create',
	'chore.create',
	'chore.complete',
	'expense.create',
	'expense.update',
	'recurring.create',
	'recurring.advance',
]);
const MISSING_PENDING_IMAGE_ERROR =
	'Bild fehlt: Der lokale Anhang ist nicht mehr verfügbar. Entferne den Anhang in der Offline-Warteschlange oder wähle das Bild erneut aus.';
const RECURRING_ADVANCE_ERROR =
	'Fixkosten-Vorlage nicht weitergeschoben: Die Ausgabe wurde erstellt. Die Vorlage bleibt zur Nachholung in der Warteschlange.';
const REAUTH_REQUIRED_ERROR =
	'Erneute Anmeldung erforderlich: Öffne die WG erneut oder tritt mit einem aktuellen Einladungslink bei.';
const REVIEW_REQUIRED_ERROR =
	'Server prüfen: Die erste Version kann bereits gespeichert sein. Die Bearbeitung wurde nicht gesendet. Vergleiche den WG-Eintrag und verwirf diese Aktion erst danach; lege benötigte Änderungen neu an.';
const REPLAY_EXPIRED_ERROR =
	'Server prüfen: Die sichere Wiederholungsfrist ist abgelaufen. Diese Aktion kann bereits gespeichert sein und wird nicht erneut gesendet. Vergleiche den WG-Eintrag und verwirf diese Aktion erst danach; lege nur fehlende Änderungen neu an.';
const INVALID_ACTION_TIME_ERROR =
	'Server prüfen: Der Zeitpunkt dieser Aktion ist unklar. Sie kann bereits gespeichert sein und wird nicht erneut gesendet. Vergleiche den WG-Eintrag und verwirf diese Aktion erst danach; lege nur fehlende Änderungen neu an.';
const IDEMPOTENCY_KEY_ERROR =
	'Idempotenz-Schlüssel konnte nicht erzeugt werden. Die Aktion bleibt gespeichert und wird nicht gesendet.';
const syncInFlight = new Map<string, Promise<number>>();
let syncTail: Promise<unknown> = Promise.resolve();

interface OfflineSyncOptions {
	force?: boolean;
	memberId?: string;
	signal?: AbortSignal;
}

function getSyncScopeKey(shareCode?: string, options?: OfflineSyncOptions): string {
	return `${shareCode ?? '*'}:${options?.memberId ?? '*'}:${options?.force ? 'force' : 'auto'}`;
}

function getOfflineStorage(): Storage | null {
	if (typeof window === 'undefined') return null;
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
	return typeof value === 'string' || value === null;
}

function isOptionalStringOrNull(value: unknown): value is string | null | undefined {
	return value === undefined || isStringOrNull(value);
}

function isSplitArray(
	value: unknown,
): value is Array<{ debtorMemberId: string; amountCents: number }> {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(split) =>
				isRecord(split) &&
				typeof split.debtorMemberId === 'string' &&
				typeof split.amountCents === 'number',
		)
	);
}

function hasValidPayload(type: OfflineActionType, payload: Record<string, unknown>): boolean {
	switch (type) {
		case 'shopping.create':
			return (
				typeof payload.name === 'string' &&
				isOptionalStringOrNull(payload.quantity) &&
				(payload.bought === undefined || typeof payload.bought === 'boolean')
			);
		case 'shopping.update':
			return (
				typeof payload.itemId === 'string' &&
				typeof payload.name === 'string' &&
				typeof payload.bought === 'boolean'
			);
		case 'announcement.create':
			return (
				typeof payload.content === 'string' &&
				typeof payload.kind === 'string' &&
				isOptionalStringOrNull(payload.imageUrl)
			);
		case 'absence.create':
			return (
				typeof payload.memberId === 'string' &&
				typeof payload.startDate === 'string' &&
				typeof payload.endDate === 'string' &&
				isOptionalStringOrNull(payload.reason)
			);
		case 'chore.create':
			return (
				typeof payload.title === 'string' &&
				typeof payload.intervalDays === 'number' &&
				isOptionalStringOrNull(payload.assignedMemberId)
			);
		case 'chore.complete':
			return typeof payload.choreId === 'string';
		case 'expense.create':
			return (
				typeof payload.description === 'string' &&
				typeof payload.amountCents === 'number' &&
				typeof payload.paidByMemberId === 'string' &&
				isSplitArray(payload.splits) &&
				isOptionalStringOrNull(payload.imageUrl)
			);
		case 'expense.update':
			return (
				typeof payload.expenseId === 'string' &&
				typeof payload.expectedUpdatedAt === 'string' &&
				typeof payload.description === 'string' &&
				typeof payload.amountCents === 'number' &&
				typeof payload.paidByMemberId === 'string' &&
				isSplitArray(payload.splits) &&
				isOptionalStringOrNull(payload.imageUrl)
			);
		case 'recurring.create':
			return (
				typeof payload.description === 'string' &&
				typeof payload.amountCents === 'number' &&
				typeof payload.paidByMemberId === 'string' &&
				typeof payload.intervalMonths === 'number' &&
				typeof payload.nextDueAt === 'string' &&
				isSplitArray(payload.splits)
			);
		case 'recurring.advance':
			return (
				typeof payload.recurringExpenseId === 'string' &&
				typeof payload.expectedRecurringNextDueAt === 'string'
			);
	}
}

function isOfflineAction(value: unknown): value is OfflineAction {
	if (!isRecord(value)) return false;
	if (
		typeof value.id !== 'string' ||
		typeof value.type !== 'string' ||
		typeof value.shareCode !== 'string' ||
		typeof value.memberId !== 'string' ||
		typeof value.createdAt !== 'string' ||
		!isRecord(value.payload)
	) {
		return false;
	}
	if (value.wgId !== undefined && typeof value.wgId !== 'string') return false;
	const type = value.type as OfflineActionType;
	return OFFLINE_ACTION_TYPES.has(type) && hasValidPayload(type, value.payload);
}

function readPersistedSyncedIds(): string[] {
	const storage = getOfflineStorage();
	if (!storage) return [];
	try {
		const raw = storage.getItem(SYNCED_IDS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) return [];
		const now = Date.now();
		return Object.entries(parsed)
			.filter(
				([id, ts]) =>
					typeof id === 'string' && typeof ts === 'number' && now - ts < SYNCED_IDS_TTL_MS,
			)
			.map(([id]) => id);
	} catch {
		return [];
	}
}

function persistSyncedIds(ids: string[]): void {
	const storage = getOfflineStorage();
	if (!storage) return;
	try {
		const raw = storage.getItem(SYNCED_IDS_KEY);
		const parsed = isRecord(raw ? (JSON.parse(raw) as unknown) : null) ? raw : null;
		const map: Record<string, number> = parsed
			? (JSON.parse(parsed) as Record<string, number>)
			: {};
		const now = Date.now();
		for (const [id, ts] of Object.entries(map)) {
			if (typeof ts !== 'number' || now - ts >= SYNCED_IDS_TTL_MS) delete map[id];
		}
		for (const id of ids) map[id] = now;
		storage.setItem(SYNCED_IDS_KEY, JSON.stringify(map));
	} catch {
		// Best-effort marker; the in-memory set still covers this session.
	}
}

function readPersistedReviewIds(): string[] {
	const storage = getOfflineStorage();
	if (!storage) return [];
	try {
		const raw = storage.getItem(OFFLINE_REVIEW_IDS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) return [];
		return Object.entries(parsed)
			.filter(([id, ts]) => typeof id === 'string' && typeof ts === 'number')
			.map(([id]) => id);
	} catch {
		return [];
	}
}

function persistOfflineReviewIds(ids: string[]): void {
	const storage = getOfflineStorage();
	if (!storage) return;
	try {
		const raw = storage.getItem(OFFLINE_REVIEW_IDS_KEY);
		const parsed = isRecord(raw ? (JSON.parse(raw) as unknown) : null) ? raw : null;
		const map: Record<string, number> = parsed
			? (JSON.parse(parsed) as Record<string, number>)
			: {};
		const now = Date.now();
		for (const [id, ts] of Object.entries(map)) {
			if (typeof ts !== 'number') delete map[id];
		}
		for (const id of ids) map[id] = now;
		storage.setItem(OFFLINE_REVIEW_IDS_KEY, JSON.stringify(map));
	} catch {
		for (const id of ids) reviewAfterFailedQueueSave.add(id);
	}
}

function clearReviewIdsForMissingActions(actions: OfflineAction[]): void {
	const currentIds = new Set(actions.map((action) => action.id));
	for (const id of reviewAfterFailedQueueSave) {
		if (!currentIds.has(id)) reviewAfterFailedQueueSave.delete(id);
	}
	const storage = getOfflineStorage();
	if (!storage) return;
	try {
		const raw = storage.getItem(OFFLINE_REVIEW_IDS_KEY);
		const parsed = isRecord(raw ? (JSON.parse(raw) as unknown) : null) ? raw : null;
		const map: Record<string, number> = parsed
			? (JSON.parse(parsed) as Record<string, number>)
			: {};
		let changed = false;
		for (const [id, ts] of Object.entries(map)) {
			if (typeof ts !== 'number' || !currentIds.has(id)) {
				delete map[id];
				changed = true;
			}
		}
		if (changed) storage.setItem(OFFLINE_REVIEW_IDS_KEY, JSON.stringify(map));
	} catch {
		// Keep the marker if clearing it cannot be persisted.
	}
}

function replayWindowReviewError(action: OfflineAction): string | null {
	const createdAt = Date.parse(action.createdAt);
	const now = Date.now();
	if (!Number.isFinite(createdAt) || createdAt > now + OFFLINE_REPLAY_CLOCK_SKEW_MS) {
		return INVALID_ACTION_TIME_ERROR;
	}
	// Creation is conservative: a crashed first attempt may never have saved attempt metadata.
	return now - createdAt >= OFFLINE_REPLAY_MAX_AGE_MS ? REPLAY_EXPIRED_ERROR : null;
}

function filterOfflineQueue(actions: OfflineAction[]): OfflineAction[] {
	const persistedSynced = new Set(readPersistedSyncedIds());
	const reviewIds = new Set([...reviewAfterFailedQueueSave, ...readPersistedReviewIds()]);
	return actions
		.filter((action) => !syncedAfterFailedQueueSave.has(action.id))
		.filter((action) => !persistedSynced.has(action.id))
		.map((action) => {
			const lastError =
				replayWindowReviewError(action) ??
				(reviewIds.has(action.id) ? REVIEW_REQUIRED_ERROR : null);
			return lastError ? { ...action, lastError } : action;
		});
}

function readCachedOfflineQueue(): OfflineAction[] {
	return filterOfflineQueue(cachedOfflineQueue ?? []);
}

export function readOfflineQueue(): OfflineAction[] {
	const storage = getOfflineStorage();
	if (!storage) return readCachedOfflineQueue();
	try {
		const raw = storage.getItem(OFFLINE_QUEUE_KEY);
		if (!raw) {
			cachedOfflineQueue = [];
			return [];
		}
		const parsed = JSON.parse(raw) as unknown;
		const queue = Array.isArray(parsed) ? filterOfflineQueue(parsed.filter(isOfflineAction)) : [];
		cachedOfflineQueue = queue;
		return queue;
	} catch {
		return readCachedOfflineQueue();
	}
}

/** False once the action left the queue, e.g. because a background sync already sent it. */
export function isOfflineActionQueued(id: string): boolean {
	return readOfflineQueue().some((item) => item.id === id);
}

export function countOfflineActions(shareCode?: string, options?: { memberId?: string }): number {
	const queue = readOfflineQueue();
	return queue.filter(
		(item) =>
			(!shareCode || item.shareCode === shareCode) &&
			(!options?.memberId || item.memberId === options.memberId),
	).length;
}

export function filterOfflineActionsForAuthUser(
	actions: OfflineAction[],
	authUserId: string | null | undefined,
): OfflineAction[] {
	if (!authUserId) return [];
	return actions.filter((action) => {
		if (!action.wgId) return false;
		const identity = getIdentity(action.wgId);
		return identity?.authUserId === authUserId && identity.memberId === action.memberId;
	});
}

export function writeOfflineQueue(actions: OfflineAction[]): boolean {
	const storage = getOfflineStorage();
	if (!storage) return false;
	try {
		storage.setItem(OFFLINE_QUEUE_KEY, `[${actions.map(serializeOfflineAction).join(',')}]`);
		for (const action of actions) {
			syncedAfterFailedQueueSave.delete(action.id);
		}
		clearReviewIdsForMissingActions(actions);
		cachedOfflineQueue = filterOfflineQueue(actions);
		window.dispatchEvent(new CustomEvent('manawg:offline-queue'));
		return true;
	} catch {
		// Offline queue persistence is best-effort when browser storage is blocked.
		return false;
	}
}

/**
 * Deletes a not-yet-synced create (and follow-ups that target it) locally.
 * Item routes reject the synthetic queue id, so a list delete must not call them.
 */
export function discardQueuedEntry(
	shareCode: string,
	id: string,
): 'removed' | 'not_queued' | 'storage_blocked' {
	const next = withoutQueuedEntry(readOfflineQueue(), shareCode, id);
	if (!next) return 'not_queued';
	return writeOfflineQueue(next) ? 'removed' : 'storage_blocked';
}

export function enqueueOfflineAction(action: OfflineAction): number {
	const next = [...readOfflineQueue(), action];
	return writeOfflineQueue(next) ? next.length : 0;
}

async function resolvePendingImages(
	action: OfflineAction,
	signal?: AbortSignal,
): Promise<{ action: OfflineAction; tokens: string[] }> {
	const imageUrl = action.payload.imageUrl;
	if (typeof imageUrl !== 'string' || !isPendingImageToken(imageUrl)) {
		return { action, tokens: [] };
	}
	const publicUrl = await uploadPendingImageToken(imageUrl, action.memberId, signal);
	return {
		action: {
			...action,
			payload: {
				...action.payload,
				imageUrl: publicUrl,
			},
		},
		tokens: [imageUrl],
	};
}

function sameOfflineAction(left: OfflineAction, right: OfflineAction): boolean {
	return serializeOfflineAction(left) === serializeOfflineAction(right);
}

function needsReviewAfterRequest(current: OfflineAction, snapshot: OfflineAction): boolean {
	return (
		JSON.stringify(current.payload) !== JSON.stringify(snapshot.payload) ||
		current.idempotencyKey !== snapshot.idempotencyKey
	);
}

function replaceQueuedSnapshot(snapshot: OfflineAction, replacement: OfflineAction): boolean {
	const current = readOfflineQueue();
	const index = current.findIndex(
		(action) => action.id === snapshot.id && sameOfflineAction(action, snapshot),
	);
	if (index < 0) return false;
	current[index] = replacement;
	return writeOfflineQueue(current);
}

function mergeSyncOutcomes(
	current: OfflineAction[],
	outcomes: Map<string, { snapshot: OfflineAction; retry?: OfflineAction; reviewOnEdit?: boolean }>,
	reviewIds: Set<string>,
): OfflineAction[] {
	return current.flatMap((action) => {
		const outcome = outcomes.get(action.id);
		if (!outcome || !sameOfflineAction(action, outcome.snapshot)) {
			if (outcome?.reviewOnEdit && needsReviewAfterRequest(action, outcome.snapshot)) {
				reviewIds.add(action.id);
			}
			return [action];
		}
		return outcome.retry ? [outcome.retry] : [];
	});
}

function getRecurringAdvancePayload(
	action: OfflineAction,
): { id: string; expectedNextDueAt?: string } | null {
	if (action.type !== 'expense.create') return null;
	const recurringExpenseId = action.payload.recurringExpenseId;
	if (typeof recurringExpenseId !== 'string') return null;
	const expectedNextDueAt = action.payload.expectedRecurringNextDueAt;
	if (typeof expectedNextDueAt !== 'string') return null;
	return {
		id: recurringExpenseId,
		expectedNextDueAt,
	};
}

export function createRecurringAdvanceRetry(
	action: OfflineAction,
	now: number,
): OfflineAction | null {
	const payload = getRecurringAdvancePayload(action);
	if (!payload) return null;
	const idempotencyKey = createOfflineIdempotencyKey();
	return {
		id: `recurring-advance:${action.shareCode}:${payload.id}`,
		...(idempotencyKey ? { idempotencyKey } : {}),
		type: 'recurring.advance',
		shareCode: action.shareCode,
		...(action.wgId ? { wgId: action.wgId } : {}),
		memberId: action.memberId,
		createdAt: new Date(now).toISOString(),
		payload: {
			recurringExpenseId: payload.id,
			...(payload.expectedNextDueAt
				? { expectedRecurringNextDueAt: payload.expectedNextDueAt }
				: {}),
		},
		attempts: 1,
		lastAttemptAt: new Date(now).toISOString(),
		lastError: RECURRING_ADVANCE_ERROR,
	};
}

function backfillIdempotencyKey(action: OfflineAction): OfflineAction {
	if (isOfflineIdempotencyKey(action.idempotencyKey)) return action;
	const idempotencyKey = createOfflineIdempotencyKey();
	return idempotencyKey ? { ...action, idempotencyKey } : action;
}

function isRecurringAlreadyAdvanced(res: { status: number; error: string }): boolean {
	return res.status === 409 && res.error === 'recurring_expense_already_advanced';
}

function isChoreAlreadyCompleted(
	action: OfflineAction,
	res: { status: number; error: string },
): boolean {
	return (
		action.type === 'chore.complete' &&
		res.status === 409 &&
		res.error === 'chore_already_completed'
	);
}

export function needsManualOfflineResolution(action: OfflineAction): boolean {
	if (replayWindowReviewError(action)) return true;
	if (action.lastError?.startsWith('Server prüfen:')) return true;
	return (
		typeof action.payload.imageUrl === 'string' &&
		Boolean(
			action.lastError?.startsWith('Bild fehlt:') ||
				action.lastError?.startsWith('Bild wurde entfernt:'),
		)
	);
}

function explainPendingImageUploadError(err: unknown): string | null {
	if (!(err instanceof Error)) return null;
	const match = /^(?:sign|upload)-failed:(\d+)(?::(.+))?$/.exec(err.message);
	if (!match) return null;
	if (match[2] === 'image_removed') {
		return 'Bild wurde entfernt: Entferne den Anhang in der Offline-Warteschlange oder wähle das Bild erneut aus.';
	}
	const status = Number(match[1]);
	const failure = explainOfflineActionFailure(status, match[2]);
	return `${failure.title}: ${failure.detail}`;
}

export async function syncOfflineActions(
	shareCode?: string,
	options?: OfflineSyncOptions,
): Promise<number> {
	const scopeKey = getSyncScopeKey(shareCode, options);
	const running = syncInFlight.get(scopeKey);
	if (running) return running;
	const next = syncTail.then(() => runOfflineSync(shareCode, options));
	syncTail = next.catch(() => undefined);
	syncInFlight.set(scopeKey, next);
	try {
		return await next;
	} finally {
		syncInFlight.delete(scopeKey);
	}
}

async function runOfflineSync(shareCode?: string, options?: OfflineSyncOptions): Promise<number> {
	if (options?.signal?.aborted) return 0;
	const storedQueue = readOfflineQueue();
	if (storedQueue.length === 0) return 0;
	const queue = storedQueue.map((action) =>
		needsManualOfflineResolution(action) ? action : backfillIdempotencyKey(action),
	);
	// Probe storage writability BEFORE spending network calls — if we cannot
	// persist removals, replaying would duplicate mutations. This rewrite of
	// the just-read snapshot races with concurrent enqueues only for the few
	// microseconds until the next line; the final write-back below re-reads
	// and merges, which is what actually protects longer-running syncs.
	if (!writeOfflineQueue(queue)) return 0;
	const outcomes = new Map<
		string,
		{ snapshot: OfflineAction; retry?: OfflineAction; reviewOnEdit?: boolean }
	>();
	const additions: OfflineAction[] = [];
	const recurringRetrySourceIds = new Set<string>();
	const reviewIds = new Set<string>();
	let synced = 0;
	const syncedActionIds: string[] = [];
	const syncedByShareCode: Record<string, number> = {};
	const now = Date.now();
	const recordSynced = (action: OfflineAction) => {
		synced += 1;
		syncedActionIds.push(action.id);
		syncedByShareCode[action.shareCode] = (syncedByShareCode[action.shareCode] ?? 0) + 1;
	};
	const queueRecurringRetry = (action: OfflineAction) => {
		const retry = createRecurringAdvanceRetry(action, now);
		if (!retry) return;
		additions.push(retry);
		recurringRetrySourceIds.add(action.id);
	};
	const reviewEditedSnapshot = (snapshot: OfflineAction) => {
		const current = readOfflineQueue().find((action) => action.id === snapshot.id);
		if (current && needsReviewAfterRequest(current, snapshot)) reviewIds.add(current.id);
	};

	for (const action of queue) {
		if (options?.signal?.aborted) break;
		if (shareCode && action.shareCode !== shareCode) {
			continue;
		}
		if (options?.memberId && action.memberId !== options.memberId) {
			continue;
		}
		if (needsManualOfflineResolution(action)) continue;
		if (!options?.force && !shouldRetryOfflineAction(action, now)) {
			continue;
		}
		const idempotencyKey = action.idempotencyKey;
		if (!isOfflineIdempotencyKey(idempotencyKey)) {
			outcomes.set(action.id, {
				snapshot: action,
				retry: {
					...action,
					attempts: (action.attempts ?? 0) + 1,
					lastAttemptAt: new Date(now).toISOString(),
					lastError: IDEMPOTENCY_KEY_ERROR,
				},
			});
			continue;
		}
		const identity = action.wgId ? getIdentity(action.wgId) : null;
		const activeMemberId = options?.memberId ?? identity?.memberId;
		if (!activeMemberId || activeMemberId !== action.memberId) {
			outcomes.set(action.id, {
				snapshot: action,
				retry: {
					...action,
					attempts: (action.attempts ?? 0) + 1,
					lastAttemptAt: new Date(now).toISOString(),
					lastError: REAUTH_REQUIRED_ERROR,
				},
			});
			continue;
		}
		let requestSnapshot = action;
		try {
			const { action: readyAction, tokens } = await resolvePendingImages(action, options?.signal);
			if (options?.signal?.aborted) break;
			if (!sameOfflineAction(action, readyAction)) {
				if (!replaceQueuedSnapshot(action, readyAction)) continue;
				requestSnapshot = readyAction;
				await Promise.all(
					tokens.map((token) =>
						removePendingImage(token, readyAction.memberId).catch(() => undefined),
					),
				);
			}
			if (options?.signal?.aborted) break;
			if (needsManualOfflineResolution(readyAction)) continue;
			if (
				!readOfflineQueue().some(
					(current) =>
						current.id === requestSnapshot.id && sameOfflineAction(current, requestSnapshot),
				)
			) {
				continue;
			}
			const request = getOfflineActionRequest(readyAction);
			const res = await apiFetch<unknown>(request.path, {
				method: request.method,
				memberId: readyAction.memberId,
				...(identity?.memberToken ? { memberToken: identity.memberToken } : {}),
				body: JSON.stringify(request.body),
				...(options?.signal ? { signal: options.signal } : {}),
				headers: { 'Idempotency-Key': idempotencyKey },
			});
			if (options?.signal?.aborted) {
				reviewEditedSnapshot(requestSnapshot);
				break;
			}
			if (res.ok) {
				recordSynced(readyAction);
				outcomes.set(action.id, { snapshot: requestSnapshot, reviewOnEdit: true });
				const recurringAdvance = getRecurringAdvancePayload(readyAction);
				if (recurringAdvance) {
					if (options?.signal?.aborted) {
						queueRecurringRetry(readyAction);
						break;
					}
					try {
						const advanceRes = await apiFetch<unknown>(
							`/api/wg/${encodeURIComponent(readyAction.shareCode)}/recurring-expenses`,
							{
								method: 'PATCH',
								memberId: readyAction.memberId,
								...(identity?.memberToken ? { memberToken: identity.memberToken } : {}),
								body: JSON.stringify(recurringAdvance),
								...(options?.signal ? { signal: options.signal } : {}),
							},
						);
						if (!advanceRes.ok && !isRecurringAlreadyAdvanced(advanceRes)) {
							queueRecurringRetry(readyAction);
						}
					} catch {
						queueRecurringRetry(readyAction);
					}
				}
			} else if (
				(readyAction.type === 'recurring.advance' && isRecurringAlreadyAdvanced(res)) ||
				isChoreAlreadyCompleted(readyAction, res)
			) {
				recordSynced(readyAction);
				outcomes.set(action.id, { snapshot: requestSnapshot, reviewOnEdit: true });
			} else {
				const failure = explainOfflineActionFailure(res.status, res.error);
				outcomes.set(action.id, {
					snapshot: requestSnapshot,
					reviewOnEdit: res.status === 0 || res.status >= 500,
					retry: {
						...readyAction,
						attempts: (readyAction.attempts ?? 0) + 1,
						lastAttemptAt: new Date(now).toISOString(),
						lastError:
							res.error === 'member_context_changed'
								? REAUTH_REQUIRED_ERROR
								: res.error === 'image_removed'
									? 'Bild wurde entfernt: Entferne den Anhang in der Offline-Warteschlange oder wähle das Bild erneut aus.'
									: `${failure.title}: ${failure.detail}`,
					},
				});
			}
		} catch (err) {
			if (options?.signal?.aborted) break;
			const missingPendingImage = err instanceof Error && err.message === 'pending-image-missing';
			const pendingImageUploadError = explainPendingImageUploadError(err);
			const lastError = missingPendingImage
				? MISSING_PENDING_IMAGE_ERROR
				: (pendingImageUploadError ??
					(() => {
						const failure = explainOfflineActionFailure(0);
						return `${failure.title}: ${failure.detail}`;
					})());
			outcomes.set(action.id, {
				snapshot: requestSnapshot,
				retry: {
					...requestSnapshot,
					attempts: (requestSnapshot.attempts ?? 0) + 1,
					lastAttemptAt: new Date(now).toISOString(),
					lastError,
				},
			});
		}
	}

	// Apply results only to exact snapshots still present in the queue. A
	// deletion or edit made while a request waited wins over this stale result.
	const merged = mergeSyncOutcomes(readOfflineQueue(), outcomes, reviewIds);
	const mergedIds = new Set(merged.map((action) => action.id));
	for (const action of additions) {
		if (!mergedIds.has(action.id)) {
			merged.push(action);
			mergedIds.add(action.id);
		}
	}
	if (reviewIds.size > 0) persistOfflineReviewIds([...reviewIds]);
	const queueToWrite = merged.map((action) =>
		reviewIds.has(action.id) ? { ...action, lastError: REVIEW_REQUIRED_ERROR } : action,
	);
	const flushedActionIds = syncedActionIds.filter(
		(actionId) => !queueToWrite.some((action) => action.id === actionId),
	);
	const queueSaved =
		outcomes.size === 0 && additions.length === 0 && reviewIds.size === 0
			? true
			: writeOfflineQueue(queueToWrite);
	if (!queueSaved) {
		const markerIds = flushedActionIds.filter((actionId) => !recurringRetrySourceIds.has(actionId));
		for (const actionId of markerIds) {
			syncedAfterFailedQueueSave.add(actionId);
		}
		persistSyncedIds(markerIds);
		if (reviewIds.size > 0) {
			window.dispatchEvent(new CustomEvent('manawg:offline-queue'));
		}
	}
	if (synced > 0) {
		window.dispatchEvent(
			new CustomEvent('manawg:offline-synced', { detail: { synced, syncedByShareCode } }),
		);
	}
	return synced;
}

/**
 * How many of a `manawg:offline-synced` event's flushed actions belonged to
 * this WG. Shared by every listener that needs to react per-WG (e.g. refresh
 * this page's data, or show a per-WG toast) instead of on any sync anywhere.
 */
export function getSyncedCountForWg(event: Event, shareCode: string): number {
	if (!(event instanceof CustomEvent)) return 0;
	const syncedByShareCode = event.detail?.syncedByShareCode;
	if (syncedByShareCode && typeof syncedByShareCode === 'object') {
		const scoped = syncedByShareCode[shareCode];
		return typeof scoped === 'number' ? scoped : 0;
	}
	return typeof event.detail?.synced === 'number' ? event.detail.synced : 0;
}
