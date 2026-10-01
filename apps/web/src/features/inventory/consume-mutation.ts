import { shoppingItems, wgInventoryItems, wgInventoryLog } from '@/core/db';
import type { WgInventoryItem, WgMember } from '@/core/db/schema';
import {
	buildShoppingPushPayload,
	clampQuantity,
	isBelowThreshold,
	normalizeForMatch,
} from '@/features/inventory/inventory';
import { and, eq, isNull, sql } from 'drizzle-orm';

export type ConsumeInventoryMutationInput = {
	itemId: WgInventoryItem['id'];
	wgId: WgInventoryItem['wgId'];
	memberId: WgMember['id'];
	delta: number;
};

export interface ConsumeInventoryTransaction {
	select(): {
		from(table: typeof wgInventoryItems): {
			where(condition: unknown): {
				limit(count: number): {
					for(strength: 'update'): PromiseLike<WgInventoryItem[]>;
				};
			};
		};
	};
	select(fields: {
		id: typeof shoppingItems.id;
		name: typeof shoppingItems.name;
	}): {
		from(table: typeof shoppingItems): {
			where(condition: unknown): PromiseLike<Array<{ id: string; name: string }>>;
		};
	};
	update(table: typeof wgInventoryItems): {
		set(values: Partial<WgInventoryItem>): {
			where(condition: unknown): {
				returning(): PromiseLike<WgInventoryItem[]>;
			};
		};
	};
	insert(table: typeof shoppingItems | typeof wgInventoryLog): {
		values(
			values: typeof shoppingItems.$inferInsert | typeof wgInventoryLog.$inferInsert,
		): PromiseLike<unknown> & {
			onConflictDoNothing(config?: { target?: unknown; where?: unknown }): {
				returning(fields: {
					id: typeof shoppingItems.id;
				}): PromiseLike<Array<{ id: string }>>;
			};
		};
	};
}

export async function consumeInventoryMutation(
	tx: ConsumeInventoryTransaction,
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

	let autoPushedShoppingItemId: string | null = null;
	if (isBelowThreshold(updated)) {
		const normalizedName = normalizeForMatch(updated.name);
		const openShoppingRows = await tx
			.select({ id: shoppingItems.id, name: shoppingItems.name })
			.from(shoppingItems)
			.where(and(eq(shoppingItems.wgId, input.wgId), isNull(shoppingItems.boughtAt)));
		const alreadyOpen = openShoppingRows.some(
			(row) => normalizeForMatch(row.name) === normalizedName,
		);
		if (!alreadyOpen) {
			const payload = buildShoppingPushPayload({
				name: updated.name,
				quantity: updated.quantity,
				threshold: updated.threshold,
				unit: updated.unit,
			});
			const created = await tx
				.insert(shoppingItems)
				.values({
					wgId: input.wgId,
					addedByMemberId: input.memberId,
					name: payload.name,
					quantity: payload.quantity,
				})
				.onConflictDoNothing({
					target: [shoppingItems.wgId, shoppingItems.normalizedName],
					where: sql`${shoppingItems.boughtAt} IS NULL`,
				})
				.returning({ id: shoppingItems.id });
			autoPushedShoppingItemId = created[0]?.id ?? null;
		}
	}

	return {
		kind: 'ok' as const,
		updated,
		appliedDelta,
		clamped: requestedQuantity !== nextQuantity,
		justCrossedThreshold: !wasAlreadyBelowThreshold && isBelowThreshold(updated),
		autoPushedShoppingItemId,
	};
}
