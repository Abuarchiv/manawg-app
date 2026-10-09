import 'server-only';
import { db, wgInventoryLog } from '@/core/db';
import { MS_PER_DAY } from '@/core/utils/time';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';

const DEFAULT_DECREMENT_WINDOW_DAYS = 30;
export async function getRecentDecrementCounts(
	itemIds: readonly string[],
	days: number = DEFAULT_DECREMENT_WINDOW_DAYS,
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (const id of itemIds) counts.set(id, 0);
	if (itemIds.length === 0) return counts;
	const since = new Date(Date.now() - days * MS_PER_DAY);
	const rows = await db
		.select({ itemId: wgInventoryLog.itemId, count: sql<number>`count(*)::int` })
		.from(wgInventoryLog)
		.where(
			and(
				inArray(wgInventoryLog.itemId, [...itemIds]),
				eq(wgInventoryLog.kind, 'consume'),
				gte(wgInventoryLog.createdAt, since),
				lt(wgInventoryLog.delta, 0),
			),
		)
		.groupBy(wgInventoryLog.itemId);
	for (const row of rows) counts.set(row.itemId, row.count);
	return counts;
}
