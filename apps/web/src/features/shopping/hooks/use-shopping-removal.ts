import { useToast } from '@/components/ui/Toast';
import type { usePendingSet } from '@/core/hooks/usePendingSet';
import { apiFetch } from '@/core/infra/api-client';
import { discardQueuedEntry, updateOfflineQueue } from '@/core/offline/offline-client';
import { isQueuedCreateId } from '@/core/offline/offline-queue';
import {
	clearBoughtErrorMessage,
	shoppingActionErrorMessage,
} from '@/features/shopping/shopping-errors';
import { dropShoppingItems, withoutQueuedFollowUps } from '@/features/shopping/shopping-toggle';
import { isTempItemId } from '@/features/shopping/shopping-view';
import { useCallback, useRef, useState } from 'react';
import type { ShoppingActionContext } from './shopping-action-context';

type RemovalContext = Omit<ShoppingActionContext, 'pending' | 'isPending'> &
	Pick<ReturnType<typeof usePendingSet>, 'isPending' | 'start' | 'end'>;

/** Removing one item (queued or saved) and clearing all bought items. */
export function useShoppingRemoval(ctx: RemovalContext) {
	const {
		wg,
		memberId,
		encodedShareCode,
		commit,
		load,
		refreshCount,
		isPending,
		start,
		end,
		togglingRef,
		setToggleError,
		setToggleNotice,
	} = ctx;
	const toast = useToast();
	const [removeError, setRemoveError] = useState<string | null>(null);
	const [removeErrorId, setRemoveErrorId] = useState<string | null>(null);
	const [clearingBought, setClearingBought] = useState(false);
	const clearingBoughtRef = useRef(false);

	const failRemove = useCallback((id: string | null, message: string) => {
		setRemoveErrorId(id);
		setRemoveError(message);
	}, []);

	/** The item is gone on the server, so a queued check-off for it could only fail on replay. */
	const dropQueuedFollowUps = useCallback(
		async (id: string): Promise<void> => {
			if (
				await updateOfflineQueue((actions) => withoutQueuedFollowUps(actions, wg.shareCode, id))
			) {
				refreshCount();
			}
		},
		[refreshCount, wg.shareCode],
	);

	const remove = useCallback(
		async (id: string, itemName: string): Promise<boolean> => {
			if (isPending(id) || togglingRef.current.has(id) || isTempItemId(id)) return false;
			start(id);
			try {
				setToggleError(null);
				setRemoveError(null);
				setRemoveErrorId(null);
				const queued = await discardQueuedEntry(wg.shareCode, id);
				if (queued === 'storage_blocked') {
					failRemove(
						id,
						'Offline-Speicher ist blockiert. Der vorgemerkte Artikel konnte nicht entfernt werden.',
					);
					return false;
				}
				if (queued === 'removed' || isQueuedCreateId(id)) {
					commit((prev) => dropShoppingItems(prev, (item) => item.id === id));
					refreshCount();
					setToggleNotice('Offline vorgemerkter Artikel wurde entfernt.');
					return true;
				}
				const res = await apiFetch<unknown>(
					`/api/wg/${encodedShareCode}/shopping/${encodeURIComponent(id)}`,
					{ method: 'DELETE', memberId },
				);
				if (!res.ok) {
					if (res.status === 404 && res.error === 'item_not_found') {
						await dropQueuedFollowUps(id);
						commit((prev) => dropShoppingItems(prev, (item) => item.id === id));
						setRemoveError(
							'Dieser Einkaufsartikel existiert nicht mehr und wurde aus deiner Liste entfernt.',
						);
						return true;
					}
					failRemove(
						id,
						res.status === 403
							? 'Nur wer den Artikel hinzugefügt hat oder ein WG-Admin kann ihn entfernen.'
							: shoppingActionErrorMessage(res.error, itemName, 'entfernt'),
					);
					return false;
				}
				await dropQueuedFollowUps(id);
				commit((prev) => dropShoppingItems(prev, (item) => item.id === id));
				void load(true);
				return true;
			} finally {
				end(id);
			}
		},
		[
			commit,
			dropQueuedFollowUps,
			encodedShareCode,
			end,
			failRemove,
			isPending,
			load,
			memberId,
			refreshCount,
			setToggleError,
			setToggleNotice,
			start,
			togglingRef,
			wg.shareCode,
		],
	);

	async function clearBought(): Promise<boolean> {
		if (clearingBoughtRef.current) return false;
		clearingBoughtRef.current = true;
		setClearingBought(true);
		setToggleError(null);
		setRemoveError(null);
		setRemoveErrorId(null);
		try {
			const res = await apiFetch<{ deleted: number }>(`/api/wg/${encodedShareCode}/shopping`, {
				method: 'DELETE',
				memberId,
			});
			if (res.ok) {
				commit((prev) => dropShoppingItems(prev, (item) => item.boughtAt !== null));
				void load(true);
				toast.success('Erledigte Artikel entfernt.');
				return true;
			}
			setRemoveError(clearBoughtErrorMessage(res.status, res.error));
			return false;
		} finally {
			clearingBoughtRef.current = false;
			setClearingBought(false);
		}
	}

	return { remove, clearBought, removeError, removeErrorId, clearingBought };
}
