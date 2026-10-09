import { getIdentity } from '@/core/auth/identity';
import { apiFetch } from '@/core/infra/api-client';
import { isPendingImageToken, removePendingImage, uploadPendingImageToken } from './offline-images';
import {
	type OfflineAction,
	explainOfflineActionFailure,
	getOfflineActionRequest,
	isOfflineIdempotencyKey,
	shouldRetryOfflineAction,
} from './offline-queue';
import {
	IDEMPOTENCY_KEY_ERROR,
	MISSING_PENDING_IMAGE_ERROR,
	REAUTH_REQUIRED_ERROR,
	backfillIdempotencyKey,
	explainPendingImageUploadError,
	isChoreAlreadyCompleted,
	isRecurringAlreadyAdvanced,
	isShoppingAlreadyOnList,
	mergeSyncOutcomes,
	needsManualOfflineResolution,
	needsReviewAfterRequest,
	sameOfflineAction,
} from './offline-replay-rules';
import {
	REVIEW_REQUIRED_ERROR,
	persistOfflineQueue,
	persistOfflineReviewIds,
	persistSyncedIds,
	readOfflineQueue,
	readOfflineQueueFromStorage,
	reviewAfterFailedQueueSave,
	syncedAfterFailedQueueSave,
	updateOfflineQueue,
	withOfflineQueueLock,
} from './offline-store';

/**
 * Replays queued actions under their idempotency keys, one sync at a time per tab, and merges the
 * outcomes back into whatever the queue holds by then (edits and removals from other tabs win).
 */

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

async function replaceQueuedSnapshot(
	snapshot: OfflineAction,
	replacement: OfflineAction,
): Promise<boolean> {
	let replaced = false;
	const saved = await updateOfflineQueue((current) => {
		const index = current.findIndex(
			(action) => action.id === snapshot.id && sameOfflineAction(action, snapshot),
		);
		if (index < 0) return null;
		current[index] = replacement;
		replaced = true;
		return current;
	});
	return saved && replaced;
}

function failedAttemptFields(
	action: OfflineAction,
	now: number,
): Pick<OfflineAction, 'attempts' | 'lastAttemptAt'> {
	return { attempts: (action.attempts ?? 0) + 1, lastAttemptAt: new Date(now).toISOString() };
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
	const preflight = await withOfflineQueueLock((storage) => {
		const storedQueue = readOfflineQueueFromStorage(storage);
		if (!storedQueue) return null;
		if (storedQueue.length === 0) return [];
		const queue = storedQueue.map((action) =>
			needsManualOfflineResolution(action) ? action : backfillIdempotencyKey(action),
		);
		return persistOfflineQueue(queue, storage) ? queue : null;
	});
	if (!preflight.acquired || preflight.value === null) return 0;
	const queue = preflight.value;
	if (queue.length === 0) return 0;
	const outcomes = new Map<
		string,
		{ snapshot: OfflineAction; retry?: OfflineAction; reviewOnEdit?: boolean }
	>();
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
				if (!(await replaceQueuedSnapshot(action, readyAction))) continue;
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
			} else if (
				(readyAction.type === 'recurring.advance' && isRecurringAlreadyAdvanced(res)) ||
				isChoreAlreadyCompleted(readyAction, res) ||
				isShoppingAlreadyOnList(readyAction, res)
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
						// A plain connection failure (status 0) is not a server rejection: it must not
						// grow the backoff, or the first sync after reconnecting would be skipped.
						...(res.status === 0 ? {} : failedAttemptFields(readyAction, now)),
						lastError:
							res.error === 'member_context_changed'
								? REAUTH_REQUIRED_ERROR
								: res.error === 'image_removed'
									? 'Bild wurde entfernt: Entferne den Anhang in der Offline-Warteschlange oder wähle das Bild erneut aus.'
									: `${failure.title}: ${failure.detail}`,
					},
				});
				// The rate limit applies to the whole session: the remaining actions would
				// also get 429 and only push out their own retry delay. The next sync sends them.
				if (res.status === 429) break;
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
					// Network errors and timeouts (no upload/sign error code) skip the backoff.
					...(pendingImageUploadError || missingPendingImage
						? failedAttemptFields(requestSnapshot, now)
						: {}),
					lastError,
				},
			});
		}
	}

	// Apply results to exact snapshots still present; preserve concurrent edits,
	// removals, and enqueues from every same-origin tab.
	const finalSave = await withOfflineQueueLock((storage) => {
		const current = readOfflineQueueFromStorage(storage);
		if (!current) {
			const uncertainIds = [...new Set([...syncedActionIds, ...reviewIds])];
			for (const actionId of uncertainIds) reviewAfterFailedQueueSave.add(actionId);
			persistOfflineReviewIds(storage, uncertainIds);
			window.dispatchEvent(new CustomEvent('manawg:offline-queue'));
			return false;
		}
		const merged = mergeSyncOutcomes(current, outcomes, reviewIds);
		if (reviewIds.size > 0) persistOfflineReviewIds(storage, [...reviewIds]);
		const queueToWrite = merged.map((action) =>
			reviewIds.has(action.id) ? { ...action, lastError: REVIEW_REQUIRED_ERROR } : action,
		);
		const flushedActionIds = syncedActionIds.filter(
			(actionId) => !queueToWrite.some((action) => action.id === actionId),
		);
		const queueSaved =
			outcomes.size === 0 && reviewIds.size === 0
				? true
				: persistOfflineQueue(queueToWrite, storage);
		if (!queueSaved) {
			for (const actionId of flushedActionIds) {
				syncedAfterFailedQueueSave.add(actionId);
			}
			persistSyncedIds(storage, flushedActionIds);
			if (reviewIds.size > 0) {
				window.dispatchEvent(new CustomEvent('manawg:offline-queue'));
			}
		}
		return queueSaved;
	});
	if (!finalSave.acquired) {
		for (const actionId of [...new Set([...syncedActionIds, ...reviewIds])]) {
			reviewAfterFailedQueueSave.add(actionId);
		}
		window.dispatchEvent(new CustomEvent('manawg:offline-queue'));
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
