'use client';

import { useToast } from '@/components/ui/Toast';
import { apiFetch } from '@/core/infra/api-client';
import {
	type NotificationWarning,
	notificationWarningMessage,
} from '@/core/notifications/notification-warning';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import type { InventoryItemDto, InventoryMutationItemDto } from '@/features/inventory/inventory';
import { useRef, useState } from 'react';

type QuantityAction = 'decrement' | 'increment';
type ConsumeResponse = {
	item: InventoryMutationItemDto;
	clamped: boolean;
	warning: NotificationWarning;
};

// Server limits per request (consume: -1..-100, PATCH quantityDelta: +-9999).
const MAX_CONSUME = 100;
const MAX_RESTOCK = 9999;

interface UseInventoryQuantityOptions {
	item: InventoryItemDto;
	shareCode: string;
	memberId: string;
	onChanged: (item: InventoryMutationItemDto) => void;
	/** The item was deleted by someone else (404 item_not_found). */
	onGone: () => void;
}

/**
 * +/- taps update the shown quantity immediately. Taps made while a request
 * runs are summed up and sent as one relative delta afterwards, so none is
 * lost. Any error drops the queue and falls back to the server state.
 */
export function useInventoryQuantity(options: UseInventoryQuantityOptions) {
	const toast = useToast();
	const latest = useRef(options);
	latest.current = options;
	// null = show the server value.
	const [shown, setShown] = useState<number | null>(null);
	const shownRef = useRef<number | null>(null);
	const [action, setAction] = useState<QuantityAction | null>(null);
	const queuedRef = useRef(0);
	const runningRef = useRef(false);
	// `${path}:${delta}` -> key. A key is reused only for the identical request after an unclear
	// failure; a different delta under an old key would replay a stale cached response.
	const keysRef = useRef(new Map<string, string>());

	/** Sends one relative delta; returns false when the queue must be dropped. */
	async function send(delta: number): Promise<boolean> {
		const { item, shareCode, memberId, onChanged, onGone } = latest.current;
		const consume = delta < 0;
		const mapKey = `${consume ? 'consume' : 'restock'}:${delta}`;
		const key = keysRef.current.get(mapKey) ?? createOfflineIdempotencyKey();
		if (!key) {
			toast.error('Aktualisierung konnte nicht sicher gesendet werden. Versuche es erneut.');
			return false;
		}
		keysRef.current.set(mapKey, key);
		const url = `/api/wg/${encodeURIComponent(shareCode)}/inventory/${encodeURIComponent(item.id)}`;
		const res = await apiFetch<ConsumeResponse>(consume ? `${url}/consume` : url, {
			method: consume ? 'POST' : 'PATCH',
			memberId,
			headers: { 'Idempotency-Key': key },
			body: JSON.stringify(consume ? { delta } : { quantityDelta: delta }),
		});
		if (res.ok) {
			keysRef.current.delete(mapKey);
			if (consume) {
				const warningMessage = notificationWarningMessage(res.data.warning, 'Bestand aktualisiert');
				if (res.data.clamped && warningMessage) {
					toast.info(`Bestand kann nicht unter 0 fallen. ${warningMessage}`);
				} else if (res.data.clamped) {
					toast.info('Bestand kann nicht unter 0 fallen.');
				} else if (warningMessage) {
					toast.info(warningMessage);
				}
			}
			onChanged(res.data.item);
			return true;
		}
		if (res.status === 404 && res.error === 'item_not_found') {
			onGone();
		} else if (res.status === 429) {
			toast.error('Zu viele Änderungen in kurzer Zeit. Bitte versuche es später erneut.');
		} else {
			if (res.status > 0 && res.status < 500) keysRef.current.delete(mapKey);
			toast.error(
				`Aktualisierung fehlgeschlagen. „${item.name}“ ließ sich nicht ${consume ? 'verringern' : 'erhöhen'}.`,
			);
		}
		return false;
	}

	async function flush(): Promise<void> {
		if (runningRef.current) return;
		runningRef.current = true;
		try {
			while (queuedRef.current !== 0) {
				const net = queuedRef.current;
				const delta = net < 0 ? Math.max(net, -MAX_CONSUME) : Math.min(net, MAX_RESTOCK);
				queuedRef.current -= delta;
				setAction(delta < 0 ? 'decrement' : 'increment');
				if (!(await send(delta))) queuedRef.current = 0;
			}
		} finally {
			runningRef.current = false;
			shownRef.current = null;
			setShown(null);
			setAction(null);
		}
	}

	function tap(delta: number): void {
		const current = shownRef.current ?? latest.current.item.quantity;
		const next = Math.max(0, current + delta);
		if (next === current) return;
		shownRef.current = next;
		setShown(next);
		queuedRef.current += next - current;
		void flush();
	}

	return { quantity: shown ?? options.item.quantity, action, tap };
}
