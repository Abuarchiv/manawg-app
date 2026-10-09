import { apiFetch } from '@/core/infra/api-client';
import { readOfflineQueue } from '@/core/offline/offline-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import type { ShoppingItem } from '@/features/shopping/components/shopping-types';
import {
	shoppingActionErrorMessage,
	shoppingDuplicateMessage,
} from '@/features/shopping/shopping-errors';
import { dropShoppingItems, replaceShoppingItem } from '@/features/shopping/shopping-toggle';
import { isTempItemId } from '@/features/shopping/shopping-view';
import { useCallback } from 'react';
import type { ShoppingActionContext } from './shopping-action-context';

/** An error message for the edit form, or null when the change was saved. */
export type ShoppingEditResult = string | null;

export type EditShoppingItem = (
	item: ShoppingItem,
	fields: { name: string; quantity: string | null },
) => Promise<ShoppingEditResult>;

/**
 * Changing an item's name or amount. Needs a connection (the offline queue only knows check-offs);
 * the row shows the new text at once and returns to the server state when the change is refused.
 */
export function useShoppingEdit(ctx: ShoppingActionContext): EditShoppingItem {
	const { memberId, encodedShareCode, commit, pending, load, isPending, togglingRef } = ctx;

	return useCallback(
		async (item, fields) => {
			const name = fields.name.trim();
			const quantity = fields.quantity?.trim() || null;
			if (name.length === 0) return 'Der Name darf nicht leer sein.';
			if (name === item.name && quantity === item.quantity) return null;
			const queue = readOfflineQueue();
			const waitingForSync =
				isTempItemId(item.id) ||
				queue.some(
					(action) =>
						action.id === item.id ||
						(action.type === 'shopping.update' && action.payload.itemId === item.id),
				);
			if (waitingForSync || isPending(item.id) || togglingRef.current.has(item.id)) {
				return 'Dieser Artikel wartet noch auf Synchronisierung. Bearbeiten geht danach.';
			}
			const idempotencyKey = createOfflineIdempotencyKey();
			if (!item.updatedAt || !idempotencyKey) {
				void load(true);
				return 'Der Artikelstand wird aktualisiert. Versuche es gleich erneut.';
			}

			togglingRef.current.add(item.id);
			const optimistic = { ...item, name, quantity };
			pending.set(optimistic);
			commit((prev) => replaceShoppingItem(prev, item.id, optimistic));
			const rollback = () => {
				pending.delete(item.id);
				commit((prev) => replaceShoppingItem(prev, item.id, item));
			};
			try {
				const res = await apiFetch<{ item: ShoppingItem }>(
					`/api/wg/${encodedShareCode}/shopping/${encodeURIComponent(item.id)}`,
					{
						method: 'PATCH',
						memberId,
						headers: { 'Idempotency-Key': idempotencyKey },
						body: JSON.stringify({
							name,
							quantity,
							expectedUpdatedAt: item.updatedAt,
							expectedBoughtAt: item.boughtAt,
						}),
					},
				);
				if (res.ok) {
					pending.delete(item.id);
					commit((prev) => replaceShoppingItem(prev, item.id, res.data.item));
					void load(true);
					return null;
				}
				if (res.status === 404 && res.error === 'item_not_found') {
					pending.delete(item.id);
					commit((prev) => dropShoppingItems(prev, (current) => current.id === item.id));
					return 'Dieser Einkaufsartikel existiert nicht mehr und wurde aus deiner Liste entfernt.';
				}
				rollback();
				if (res.status === 409 && res.error === 'shopping_item_duplicate') {
					return shoppingDuplicateMessage(name);
				}
				if (res.status === 409 && res.error === 'shopping_item_changed') {
					await load(true);
					return 'Der Artikel hat sich geändert. Prüfe den aktualisierten Stand und versuche es erneut.';
				}
				if (res.status === 0) return 'Bearbeiten braucht eine Verbindung.';
				return shoppingActionErrorMessage(res.error, item.name, 'geändert');
			} finally {
				pending.delete(item.id);
				togglingRef.current.delete(item.id);
			}
		},
		[commit, encodedShareCode, isPending, load, memberId, pending, togglingRef],
	);
}
