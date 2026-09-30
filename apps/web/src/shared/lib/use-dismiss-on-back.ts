'use client';

import { type RefObject, useEffect } from 'react';

interface OverlayCloseActions {
	close: () => void;
}

interface CloseWatcherLike {
	onclose: (() => void) | null;
	destroy: () => void;
}

/**
 * Material 3 / Android: the system back gesture closes an open overlay (dialog,
 * alert dialog, drawer) instead of leaving the page. CloseWatcher routes that
 * gesture to the overlay without touching history, so a navigation started
 * while the overlay closes (e.g. "Verwerfen" → router.push) stays intact.
 * Touch-only: with a keyboard, Base UI already owns Escape, including for
 * popups nested inside the overlay.
 *
 * ponytail: no-op where CloseWatcher is missing (Safari, Firefox).
 */
export function useDismissOnBack(
	open: boolean,
	actionsRef: RefObject<OverlayCloseActions | null>,
): void {
	// actionsRef is a stable ref object; only `open` should retrigger this.
	// biome-ignore lint/correctness/useExhaustiveDependencies: actionsRef is stable
	useEffect(() => {
		const Watcher = (window as Window & { CloseWatcher?: new () => CloseWatcherLike }).CloseWatcher;
		if (!open || !Watcher || !window.matchMedia('(pointer: coarse)').matches) return;
		const watcher = new Watcher();
		watcher.onclose = () => actionsRef.current?.close();
		return () => watcher.destroy();
	}, [open]);
}
