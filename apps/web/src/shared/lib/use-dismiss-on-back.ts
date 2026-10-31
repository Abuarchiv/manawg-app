'use client';

import { type RefObject, useEffect } from 'react';

interface OverlayCloseActions {
	close: () => void;
}

interface CloseWatcherLike {
	onclose: (() => void) | null;
	destroy: () => void;
}

interface OverlayEntry {
	id: number;
	close: () => void;
}

// Open overlays, innermost last. Each owns one history entry, so a back press
// pops exactly the topmost one (nested sheets stack).
const stack: OverlayEntry[] = [];
let nextId = 0;
// Number of popstates caused by our own history.back() that must be ignored.
let ownPops = 0;
let listening = false;
// When an overlay action starts a navigation, the router replaces the marker
// entry itself once the new route has loaded. That can take longer than any
// fixed delay on a slow device, so the cleanup must not pop the entry in the
// meantime: a back() during the pending navigation cancels it.
let navigationStartedAt = 0;
const NAVIGATION_GRACE_MS = 5000;

/** Call right before `router.push`/`router.replace` from inside an overlay action. */
export function markOverlayNavigation(): void {
	navigationStartedAt = Date.now();
}

export function overlayNavigationPending(): boolean {
	return Date.now() - navigationStartedAt < NAVIGATION_GRACE_MS;
}

function onPopState() {
	if (ownPops > 0) {
		ownPops--;
		return;
	}
	// The browser already left the entry; the overlay only has to close.
	stack.pop()?.close();
}

/**
 * Back button / iOS edge swipe / Android back closes the topmost open overlay
 * (dialog, alert dialog, drawer) instead of leaving the page, so a typed draft
 * survives. Each overlay pushes one marker history entry while open (state is
 * copied so Next's router keeps recognising it) and removes it again when it is
 * closed through the UI. CloseWatcher (Android Chromium) additionally routes
 * the system gesture to the overlay without history traversal; the cleanup then
 * drops the marker entry. Touch-only for CloseWatcher: with a keyboard, Base UI
 * already owns Escape.
 *
 * A navigation started while the overlay closes (e.g. "Discard" → router.replace)
 * replaces the marker entry once it commits; the caller announces it through
 * `markOverlayNavigation` so no back() is issued while it is pending.
 *
 * Known limit: closing an outer overlay before an inner one leaves a stale entry.
 */
export function useDismissOnBack(
	open: boolean,
	actionsRef: RefObject<OverlayCloseActions | null>,
): void {
	// actionsRef is a stable ref object; only `open` should retrigger this.
	// biome-ignore lint/correctness/useExhaustiveDependencies: actionsRef is stable
	useEffect(() => {
		if (!open) return;
		const entry: OverlayEntry = { id: ++nextId, close: () => actionsRef.current?.close() };
		stack.push(entry);
		window.history.pushState({ ...window.history.state, overlayId: entry.id }, '');
		if (!listening) {
			listening = true;
			window.addEventListener('popstate', onPopState);
		}

		const Watcher = (window as Window & { CloseWatcher?: new () => CloseWatcherLike }).CloseWatcher;
		let watcher: CloseWatcherLike | undefined;
		if (Watcher && window.matchMedia('(pointer: coarse)').matches) {
			watcher = new Watcher();
			watcher.onclose = () => entry.close();
		}

		return () => {
			watcher?.destroy();
			const i = stack.indexOf(entry);
			if (i < 0) return; // popped by the browser already
			stack.splice(i, 1);
			// Defer so a navigation started by the same click can replace the state first.
			setTimeout(() => {
				if (overlayNavigationPending()) return;
				if (window.history.state?.overlayId !== entry.id) return;
				ownPops++;
				window.history.back();
			}, 50);
		};
	}, [open]);
}
