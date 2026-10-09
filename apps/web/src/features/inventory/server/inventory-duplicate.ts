import 'server-only';
import { wgInventoryItems } from '@/core/db';
import type { DbTransaction } from '@/core/db/transaction';
import { normalizeForMatch } from '@/features/inventory/inventory';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Whether another inventory item of the WG already has this name (case and surrounding
 * whitespace ignored, like the shopping list). Not atomic: two simultaneous creates can
 * still both pass. An item that keeps its own name is never flagged, so old duplicates stay editable.
 */
export async function isInventoryNameTaken(
	tx: DbTransaction,
	wgId: string,
	name: string,
	ownId?: string,
): Promise<boolean> {
	const key = normalizeForMatch(name);
	if (ownId) {
		const [own] = await tx
			.select({ name: wgInventoryItems.name })
			.from(wgInventoryItems)
			.where(and(eq(wgInventoryItems.id, ownId), eq(wgInventoryItems.wgId, wgId)))
			.limit(1);
		if (own && normalizeForMatch(own.name) === key) return false;
	}
	const rows = await tx
		.select({ id: wgInventoryItems.id })
		.from(wgInventoryItems)
		.where(
			and(eq(wgInventoryItems.wgId, wgId), sql`lower(btrim(${wgInventoryItems.name})) = ${key}`),
		)
		.limit(1);
	return rows.length > 0;
}
