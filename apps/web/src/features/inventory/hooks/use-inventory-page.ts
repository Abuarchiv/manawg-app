import { getWgLoadErrorMessage } from '@/core/guards/load-errors';
import { refreshCachedFetch } from '@/core/hooks/useCachedFetch';
import { useStableCallback } from '@/core/hooks/useStableCallback';
import { isNetworkError } from '@/core/http/error-codes';
import { useSyncedCollection } from '@/core/sync/use-synced-collection';
import {
	type InventoryCategory,
	type InventoryItemDto,
	type InventoryMutationItemDto,
	groupItemsByCategory,
	isBelowThreshold,
} from '@/features/inventory/inventory';
import { useCallback, useState } from 'react';

interface InventoryResponse {
	items: InventoryItemDto[];
	grouped: Record<InventoryCategory, InventoryItemDto[]>;
}

function applyInventoryMutation(
	items: InventoryItemDto[],
	updated?: InventoryMutationItemDto,
	deletedId?: string,
): InventoryItemDto[] {
	if (deletedId) return items.filter((item) => item.id !== deletedId);
	if (!updated) return items;
	const existing = items.find((item) => item.id === updated.id);
	const merged: InventoryItemDto = {
		...(existing ?? {}),
		...updated,
		decrementCount30d: updated.decrementCount30d ?? existing?.decrementCount30d ?? 0,
	};
	return existing
		? items.map((item) => (item.id === updated.id ? merged : item))
		: [...items, merged];
}

/** The pantry list: synced items and `onChanged`, which applies a mutation to the list at once. */
export function useInventoryPage(shareCode: string, memberId: string) {
	const encodedShareCode = encodeURIComponent(shareCode);
	const [addOpen, setAddOpen] = useState(false);
	const inventory = useSyncedCollection<InventoryResponse, InventoryItemDto>({
		url: `/api/wg/${encodedShareCode}/inventory`,
		memberId,
		select: (data) => data.items,
		assemble: (items) => ({ items, grouped: groupItemsByCategory(items) }),
		getId: (item) => item.id,
		describeError: (error) =>
			getWgLoadErrorMessage('Vorräte', error.status, error.error, { verb: 'konnten' }),
		// A background refresh, or a network failure with a list on screen, adds no banner.
		hideError: (error, { silent, hasData }) =>
			hasData && (silent || isNetworkError(error.error, error.status)),
	});
	const loadInventory = inventory.load;
	const load = useCallback(
		async (silent = false): Promise<void> => {
			await loadInventory({ silent });
		},
		[loadInventory],
	);

	const onChanged = useStableCallback(
		(updated?: InventoryMutationItemDto, deletedId?: string): void => {
			// Only the crossing changes the shopping counter; read before the commit overwrites it.
			const before = updated
				? inventory.itemsRef.current.find((item) => item.id === updated.id)
				: undefined;
			if (updated || deletedId) {
				inventory.commit((current) => applyInventoryMutation(current, updated, deletedId));
			}
			// Below the threshold the server adds a shopping item; the dashboard cache behind the
			// "Einkäufe" counter in the sub navigation would otherwise only learn of it on focus.
			if (updated && isBelowThreshold(updated) && !(before && isBelowThreshold(before))) {
				void refreshCachedFetch(`/api/wg/${encodedShareCode}/dashboard`, {
					memberId,
				});
			}
			void load(true);
		},
	);

	return {
		items: inventory.items,
		initialLoading: inventory.initialLoading,
		loadError: inventory.loadError,
		addOpen,
		setAddOpen,
		load,
		onChanged,
	};
}
