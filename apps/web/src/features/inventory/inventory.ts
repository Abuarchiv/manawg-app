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
	// A consume takes at least one unit; zero would only re-trigger the
	// low-stock push and shopping entry without anything being used.
	CONSUME_DELTA_MAX: -1,
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

const UNIT_PLURALS: Partial<Record<string, string>> = { Rolle: 'Rollen', Packung: 'Packungen' };

/** "2 Rollen", "1 Rolle": Stück, L and kg stay as they are. */
export function formatQuantity(quantity: number, unit: string): string {
	return `${quantity} ${quantity === 1 ? unit : (UNIT_PLURALS[unit] ?? unit)}`;
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
		quantity: formatQuantity(missing, item.unit),
		note: 'Auto: Vorrat unter Schwelle',
	};
}

/** Units that bring a scarce item back above its threshold (same amount the shopping push asks for). */
export function restockAmount(item: InventoryItemForThresholdCheck): number {
	return isBelowThreshold(item) ? item.threshold - item.quantity + 1 : 1;
}

/** Scarce items whose name matches something just bought: the stock was not raised by the purchase. */
export function boughtRestockMatches<T extends InventoryItemForThresholdCheck & { name: string }>(
	items: T[],
	boughtNames: string[],
): T[] {
	const bought = new Set(boughtNames.map(normalizeForMatch));
	return items.filter((item) => isBelowThreshold(item) && bought.has(normalizeForMatch(item.name)));
}

const QUICK_RESTOCK_MIN_ROWS = 5;
const QUICK_RESTOCK_MAX_LOW = 10;

/** Scarce items first (largest shortfall), then the most consumed of the last 30 days up to a minimum row count. */
export function quickRestockCandidates<
	T extends InventoryItemForThresholdCheck & { name: string; decrementCount30d: number },
>(items: T[]): T[] {
	const low = items
		.filter(isBelowThreshold)
		.sort(
			(a, b) =>
				b.threshold - b.quantity - (a.threshold - a.quantity) || a.name.localeCompare(b.name, 'de'),
		)
		.slice(0, QUICK_RESTOCK_MAX_LOW);
	const frequent = items
		.filter((item) => !isBelowThreshold(item) && item.decrementCount30d > 0)
		.sort((a, b) => b.decrementCount30d - a.decrementCount30d)
		.slice(0, Math.max(0, QUICK_RESTOCK_MIN_ROWS - low.length));
	return [...low, ...frequent];
}

export function clampQuantity(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < INVENTORY_LIMITS.QUANTITY_MIN) return INVENTORY_LIMITS.QUANTITY_MIN;
	if (value > INVENTORY_LIMITS.QUANTITY_MAX) return INVENTORY_LIMITS.QUANTITY_MAX;
	return Math.trunc(value);
}

function isValidCategory(value: string): value is InventoryCategory {
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
