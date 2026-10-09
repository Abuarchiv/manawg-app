import 'server-only';
import { wgInventoryItems, wgInventoryLog } from '@/core/db';
import type { WgInventoryItem, WgMember } from '@/core/db/schema';
import type { DbTransaction } from '@/core/db/transaction';
import { clampQuantity, isBelowThreshold } from '@/features/inventory/inventory';
import { pushBelowThresholdItemToShopping } from '@/features/inventory/server/inventory-mutations';
import { and, eq } from 'drizzle-orm';

export type ConsumeInventoryMutationInput = {
	itemId: WgInventoryItem['id'];
	wgId: WgInventoryItem['wgId'];
	memberId: WgMember['id'];
	delta: number;
};

export async function consumeInventoryMutation(
	tx: DbTransaction,
	input: ConsumeInventoryMutationInput,
) {
	// Lock the row: a relative -N has no stale state to conflict on, so
	// concurrent taps must apply one after another instead of failing the
	// quantity check below with a spurious 409 (same as the PATCH delta path).
	const existingRows = await tx
		.select()
		.from(wgInventoryItems)
		.where(and(eq(wgInventoryItems.id, input.itemId), eq(wgInventoryItems.wgId, input.wgId)))
		.limit(1)
		.for('update');
	const existing = existingRows[0];
	if (!existing) return { kind: 'not_found' as const };

	const requestedQuantity = existing.quantity + input.delta;
	const nextQuantity = clampQuantity(requestedQuantity);
	const appliedDelta = nextQuantity - existing.quantity;
	const wasAlreadyBelowThreshold = isBelowThreshold(existing);
	const now = new Date();
	const [updated] = await tx
		.update(wgInventoryItems)
		.set({
			quantity: nextQuantity,
			lastDecrementedAt: appliedDelta < 0 ? now : existing.lastDecrementedAt,
			updatedAt: now,
		})
		.where(
			and(
				eq(wgInventoryItems.id, input.itemId),
				eq(wgInventoryItems.wgId, input.wgId),
				eq(wgInventoryItems.quantity, existing.quantity),
			),
		)
		.returning();
	if (!updated) return { kind: 'conflict' as const };

	if (appliedDelta !== 0) {
		await tx.insert(wgInventoryLog).values({
			itemId: updated.id,
			memberId: input.memberId,
			delta: appliedDelta,
			kind: 'consume',
		});
	}

	// Push only on the crossing itself: a bought or deleted entry must not come
	// back on every further tap (same rule as the PATCH path).
	const justCrossedThreshold = !wasAlreadyBelowThreshold && isBelowThreshold(updated);
	const autoPushedShoppingItemId = justCrossedThreshold
		? await pushBelowThresholdItemToShopping(tx, updated, input.wgId, input.memberId)
		: null;

	return {
		kind: 'ok' as const,
		updated,
		appliedDelta,
		clamped: requestedQuantity !== nextQuantity,
		justCrossedThreshold,
		autoPushedShoppingItemId,
	};
}
