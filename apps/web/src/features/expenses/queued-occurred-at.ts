import type { OfflineAction } from '@/core/offline/offline-queue';

/**
 * Stamps a queued expense with the day it happened. The queue replays hours or days later, and
 * the server falls back to the replay time when the request carries no `occurredAt`. A null
 * date leaves the action untouched (an edit that keeps the original day).
 */
export function withQueuedOccurredAt(
	action: OfflineAction,
	occurredAt: string | null,
): OfflineAction {
	return occurredAt === null ? action : { ...action, payload: { ...action.payload, occurredAt } };
}
