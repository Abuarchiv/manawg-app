'use client';

import type { StoredIdentity } from '@/core/auth/identity';
import { subscribeOnline } from '@/core/hooks/use-online-status';
import { countOfflineActions, syncOfflineActions } from '@/core/offline/offline-client';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import { type RefObject, useCallback, useEffect, useRef } from 'react';

/**
 * Replays this member's queued offline actions every 60 s while visible. The
 * shared syncAbortRef lets an auth change cancel a running replay.
 */
export function useOfflineAutoSync({
	shareCode,
	identity,
	accountReady,
	syncAbortRef,
}: {
	shareCode: string;
	identity: StoredIdentity | null;
	accountReady: boolean;
	syncAbortRef: RefObject<AbortController | null>;
}): () => Promise<void> {
	const syncingRef = useRef(false);

	const sync = useCallback(async () => {
		if (
			!accountReady ||
			!identity ||
			syncingRef.current ||
			// Offline attempts would only fail (and start image uploads); the online event syncs.
			(typeof navigator !== 'undefined' && navigator.onLine === false) ||
			countOfflineActions(shareCode, { memberId: identity.memberId }) === 0
		) {
			return;
		}
		const controller = syncAbortRef.current ?? new AbortController();
		syncAbortRef.current = controller;
		syncingRef.current = true;
		try {
			await syncOfflineActions(shareCode, {
				memberId: identity.memberId,
				signal: controller.signal,
			});
		} catch {
			// Automatic sync retries on the next app event or interval.
		} finally {
			syncingRef.current = false;
		}
	}, [accountReady, identity, shareCode, syncAbortRef]);

	useVisibilityPausedInterval(() => void sync(), identity && accountReady ? 60_000 : null);

	return sync;
}

/**
 * Sync on online/focus events in addition to the paused interval. These
 * listeners are re-registered when `sync` changes (which happens when identity
 * or the share code change), so the cleanup always removes the listeners
 * bound to the current closure.
 */
export function useSyncOnFocusAndOnline(
	sync: () => Promise<void>,
	identity: StoredIdentity | null,
	accountReady: boolean,
): void {
	useEffect(() => {
		if (!identity || !accountReady) return;
		void sync();
		const unsubscribeOnline = subscribeOnline(() => void sync());
		window.addEventListener('focus', sync);
		return () => {
			unsubscribeOnline();
			window.removeEventListener('focus', sync);
		};
	}, [accountReady, identity, sync]);
}
