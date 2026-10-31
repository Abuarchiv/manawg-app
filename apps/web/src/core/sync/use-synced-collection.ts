'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CachedFetchError, CachedFetchResult } from '@/core/hooks/cached-fetch-store';
import { useCachedFetch } from '@/core/hooks/use-cached-fetch';
import { captureException } from '@/core/infra/capture-client';
import { syncOfflineActions } from '@/core/offline/offline-client';
import { useOfflineQueueSync } from '@/core/offline/use-offline-queue-sync';
import {
	LIST_REFRESH_INTERVAL_MS,
	useVisibilityPausedInterval,
} from '@/core/utils/use-visibility-paused-interval';
import { applyPendingOverlay, type HideLoadError, loadErrorMessage } from './collection-overlay';

const DEFAULT_POLL_INTERVAL_MS = LIST_REFRESH_INTERVAL_MS;

/** Why the hook asks the feature to reload: first mount, a visible-tab poll, or a queue flush. */
export type SyncedReloadReason = 'mount' | 'poll' | 'synced';

export interface SyncedLoadOptions {
	/** Background refresh: never shows the initial skeleton. */
	silent?: boolean;
	/** Fetch again even if a GET is running, because a mutation just settled. */
	afterMutation?: boolean;
}

export interface SyncedCollectionConfig<TData, TItem> {
	/** Collection endpoint; the response is cached per member and URL. */
	url: string;
	memberId: string;
	/** The list inside a response. */
	select: (data: TData) => TItem[];
	/** The response to cache for a changed list; `current` is the cached response, if any. */
	assemble: (items: TItem[], current: TData | undefined) => TData;
	getId: (item: TItem) => string;
	/**
	 * Combines the rows on screen with a fresh cache state. The default shows the cache state
	 * as is; a feature that must not reorder rows under the reader merges here.
	 */
	reconcile?: (shown: TItem[], incoming: TItem[]) => TItem[];
	/** Banner text for a failed read. */
	describeError: (error: CachedFetchError) => string;
	/** Keeps the shown data without a banner for some failures; default shows every failure. */
	hideError?: HideLoadError;
	/** Visible-tab refresh interval; `null` disables polling. */
	pollIntervalMs?: number | null;
	/**
	 * How the feature reloads for each reason. The default is `load()` on mount and a silent
	 * `load()` otherwise; features with extra work per load (merging, side reads) pass their own.
	 */
	reload?: (reason: SyncedReloadReason) => void;
	/** Offline replay for this WG; without it the hook never touches the offline queue. */
	offline?: {
		shareCode: string;
		/** Tags sync failures in observability. */
		page: string;
		/** Runs before the reload when one of this hook's loads flushed queued actions. */
		onReplayed?: () => void;
	};
}

export interface PendingOverlay<TItem> {
	set: (item: TItem) => void;
	delete: (id: string) => void;
	has: (id: string) => boolean;
}

/**
 * A server collection kept in sync on the client. Owns the cached fetch, the optimistic overlay
 * of unconfirmed rows, offline replay after a successful load, polling paused while the tab is
 * hidden, the refresh on reconnect, and the single place where server responses and local
 * changes are reconciled into the rows on screen.
 *
 * Feature hooks describe the resource (URL, id, merge rules) and keep only their domain actions;
 * they write through `commit` and enqueue offline actions themselves, then call `refreshCount`.
 */
export function useSyncedCollection<TData, TItem>(config: SyncedCollectionConfig<TData, TItem>) {
	const configRef = useRef(config);
	configRef.current = config;
	const { url, memberId, offline } = config;
	const {
		data,
		serverData,
		serverRevision,
		error: readError,
		refresh,
		setData,
	} = useCachedFetch<TData>(url, { memberId });

	const pendingRef = useRef(new Map<string, TItem>());
	const toShown = useCallback((incoming: TItem[], shown: TItem[]): TItem[] => {
		const { reconcile, getId } = configRef.current;
		const merged = reconcile ? reconcile(shown, incoming) : incoming;
		return applyPendingOverlay(merged, pendingRef.current, getId);
	}, []);

	const [items, setItems] = useState<TItem[]>(() =>
		data === undefined ? [] : toShown(config.select(data), []),
	);
	const itemsRef = useRef(items);
	const [initialLoading, setInitialLoading] = useState(data === undefined);
	const [refreshing, setRefreshing] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const hasDataRef = useRef(data !== undefined);
	const mountedRef = useRef(false);
	const loadRequestIdRef = useRef(0);

	const showItems = useCallback((next: TItem[]) => {
		itemsRef.current = next;
		setItems(next);
	}, []);

	const reloadRef = useRef<(reason: SyncedReloadReason) => void>(() => undefined);

	const { queuedCount, refreshCount } = useOfflineQueueSync({
		shareCode: offline?.shareCode ?? null,
		memberId,
		page: offline?.page ?? '',
		// The queue was flushed from elsewhere (online event, "Jetzt senden"): the pages' "saved
		// offline" notices are obsolete now, not just after this hook's own replay.
		onSynced: () => {
			configRef.current.offline?.onReplayed?.();
			reloadRef.current('synced');
		},
	});

	const load = useCallback(
		async ({
			silent = false,
			afterMutation = false,
		}: SyncedLoadOptions = {}): Promise<CachedFetchResult<TData> | null> => {
			const requestId = loadRequestIdRef.current + 1;
			loadRequestIdRef.current = requestId;
			if (!silent && !hasDataRef.current) setInitialLoading(true);
			else setRefreshing(true);
			const result = await refresh({ afterMutation });
			// A newer load owns the loading flags and the banner.
			if (requestId !== loadRequestIdRef.current) return null;
			const current = configRef.current;
			if (result.ok) {
				setLoadError(null);
				const replay = current.offline;
				if (replay) {
					syncOfflineActions(replay.shareCode, { memberId: current.memberId })
						.then(() => {
							if (!mountedRef.current || requestId !== loadRequestIdRef.current) return;
							// `onSynced` of useOfflineQueueSync already reloads when actions were replayed.
							refreshCount();
						})
						.catch((err) =>
							captureException(err, { action: 'syncOfflineActions', page: replay.page }),
						);
				}
			} else {
				const message = loadErrorMessage(
					result,
					{ silent, hasData: hasDataRef.current },
					current.describeError,
					current.hideError,
				);
				if (message !== null) setLoadError(message);
			}
			setInitialLoading(false);
			setRefreshing(false);
			return result;
		},
		[refresh, refreshCount],
	);

	reloadRef.current = (reason) => {
		const custom = configRef.current.reload;
		if (custom) custom(reason);
		else void load(reason === 'mount' ? {} : { silent: true });
	};

	// Every cache change (own fetch, another hook's fetch, a local commit) reaches the screen here.
	useEffect(() => {
		if (data === undefined) return;
		hasDataRef.current = true;
		showItems(toShown(configRef.current.select(data), itemsRef.current));
	}, [data, showItems, toShown]);

	useEffect(() => {
		if (readError) {
			const { describeError, hideError } = configRef.current;
			const message = loadErrorMessage(
				readError,
				{ silent: true, hasData: data !== undefined },
				describeError,
				hideError,
			);
			if (message !== null) setLoadError(message);
			else setLoadError(null);
			setInitialLoading(false);
		} else if (data !== undefined) {
			setLoadError(null);
			setInitialLoading(false);
		}
	}, [data, readError]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const mountLoadStartedRef = useRef(false);
	useEffect(() => {
		if (mountLoadStartedRef.current) return;
		mountLoadStartedRef.current = true;
		reloadRef.current('mount');
	}, []);

	useVisibilityPausedInterval(
		() => reloadRef.current('poll'),
		config.pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : config.pollIntervalMs,
	);

	/**
	 * Applies a local change to the rows on screen and to the cached response, so the next render
	 * from cache (or a page revisit) shows it too. `update` must be pure: it runs on both lists.
	 */
	const commit = useCallback(
		(update: (current: TItem[]) => TItem[]) => {
			const shownBefore = itemsRef.current;
			showItems(update(shownBefore));
			setData((current) => {
				const { select, assemble } = configRef.current;
				const previous = current === undefined ? shownBefore : select(current);
				const next = update(previous);
				if (current === undefined && next === previous) return current;
				return assemble(next, current);
			});
		},
		[setData, showItems],
	);

	const pending = useMemo<PendingOverlay<TItem>>(
		() => ({
			set: (item) => {
				pendingRef.current.set(configRef.current.getId(item), item);
			},
			delete: (id) => {
				pendingRef.current.delete(id);
			},
			has: (id) => pendingRef.current.has(id),
		}),
		[],
	);

	const hasData = useCallback(() => hasDataRef.current, []);

	return {
		items,
		itemsRef,
		data,
		serverData,
		serverRevision,
		initialLoading,
		refreshing,
		loadError,
		hasData,
		load,
		commit,
		pending,
		queuedCount,
		refreshCount,
	};
}
