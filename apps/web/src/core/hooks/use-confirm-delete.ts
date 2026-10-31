'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

interface ConfirmDelete {
	confirmId: string | null;
	request: (id: string) => boolean;
	cancel: () => void;
}

/** After this long an armed remove button falls back, so it never lingers in the list. */
const ARMED_TIMEOUT_MS = 4000;

// One armed row per page: arming a second row disarms the first, so two red
// confirm buttons never stand side by side. Every hook instance reads this store.
let armed: { id: string; owner: object } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function setArmed(next: typeof armed): void {
	armed = next;
	clearTimeout(timer);
	if (next) timer = setTimeout(() => setArmed(null), ARMED_TIMEOUT_MS);
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useConfirmDelete(): ConfirmDelete {
	const owner = useRef({}).current;
	const current = useSyncExternalStore(
		subscribe,
		() => armed,
		() => null,
	);

	const request = useCallback(
		(id: string): boolean => {
			if (armed?.id === id) {
				setArmed(null);
				return true;
			}
			setArmed({ id, owner });
			return false;
		},
		[owner],
	);

	// Only the hook that armed a row may disarm it; another row's cancel must not.
	const cancel = useCallback((): void => {
		if (armed?.owner === owner) setArmed(null);
	}, [owner]);

	useEffect(() => cancel, [cancel]);

	return { confirmId: current?.id ?? null, request, cancel };
}
