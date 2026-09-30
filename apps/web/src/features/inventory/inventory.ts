export const INVENTORY_LIST_LIMIT = 1000;

export const INVENTORY_CATEGORIES = ['bad', 'kueche', 'putzmittel', 'sonstiges'] as const;
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

export const INVENTORY_UNITS = ['Stück', 'L', 'kg', 'Rolle', 'Packung'] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];

export const INVENTORY_LIMITS = {
	NAME_MIN: 1,
	NAME_MAX: 120,
	QUANTITY_MIN: 0,
	QUANTITY_MAX: 9999,
	THRESHOLD_MIN: 0,
	THRESHOLD_MAX: 9999,
	UNIT_MAX: 40,
	CATEGORY_MAX: 40,
	CONSUME_DELTA_MIN: -100,
	CONSUME_DELTA_MAX: 0,
} as const;

export const INVENTORY_CATEGORY_LABELS: Record<InventoryCategory, string> = {
	bad: 'Bad',
	kueche: 'Küche',
	putzmittel: 'Putzmittel',
	sonstiges: 'Sonstiges',
};

/**
 * An inventory item as the API returns it.
 *
 * Lives here rather than in `vorraete/page.tsx` because three components need
 * it, and importing a type out of a page turned the dependency arrow around:
 * the page imported the components, the components imported the page.
 */
export interface InventoryItemDto {
	id: string;
	wgId: string;
	name: string;
	quantity: number;
	unit: string;
	threshold: number;
	category: string;
	lastDecrementedAt: string | null;
	decrementCount30d: number;
	createdAt: string;
	updatedAt: string;
}

export type InventoryMutationItemDto = Omit<InventoryItemDto, 'decrementCount30d'> & {
	decrementCount30d?: number;
};

interface InventoryItemForThresholdCheck {
	quantity: number;
	threshold: number;
}

export function isBelowThreshold(item: InventoryItemForThresholdCheck): boolean {
	return item.quantity <= item.threshold;
}

export function normalizeForMatch(name: string): string {
	return name.trim().toLowerCase();
}

interface ShoppingPushPayload {
	name: string;
	quantity: string | null;
	note: string;
}

export function buildShoppingPushPayload(
	item: Pick<InventoryItemForThresholdCheck, 'quantity' | 'threshold'> & {
		name: string;
		unit: string;
	},
): ShoppingPushPayload {
	const missing = Math.max(0, item.threshold - item.quantity) + 1;
	return {
		name: item.name,
		quantity: `${missing} ${item.unit}`,
		note: 'Auto: Vorrat unter Schwelle',
	};
}

export function clampQuantity(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < INVENTORY_LIMITS.QUANTITY_MIN) return INVENTORY_LIMITS.QUANTITY_MIN;
	if (value > INVENTORY_LIMITS.QUANTITY_MAX) return INVENTORY_LIMITS.QUANTITY_MAX;
	return Math.trunc(value);
}

export function isValidCategory(value: string): value is InventoryCategory {
	return (INVENTORY_CATEGORIES as readonly string[]).includes(value);
}

export function groupItemsByCategory<T extends { category: string }>(
	items: T[],
): Record<InventoryCategory, T[]> {
	const groups: Record<InventoryCategory, T[]> = {
		bad: [],
		kueche: [],
		putzmittel: [],
		sonstiges: [],
	};
	for (const item of items) {
		const category = isValidCategory(item.category) ? item.category : 'sonstiges';
		groups[category].push(item);
	}
	return groups;
}
