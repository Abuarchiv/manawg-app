import {
	db,
	idempotencyResponses,
	shoppingItems,
	wgInventoryItems,
	wgInventoryLog,
} from '@/core/db';
import type { WgInventoryItem } from '@/core/db/schema';
import type { DbTransaction } from '@/core/db/transaction';
import {
	buildShoppingPushPayload,
	clampQuantity,
	isBelowThreshold,
} from '@/features/inventory/inventory';
import { and, eq, gt, sql } from 'drizzle-orm';

const INVENTORY_REPLAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function completeInventoryReplay(
	tx: DbTransaction,
	scope: string,
	key: string,
	payload: object,
): Promise<void> {
	const [completed] = await tx
		.update(idempotencyResponses)
		.set({
			responseBody: payload,
			expiresAt: new Date(Date.now() + INVENTORY_REPLAY_TTL_MS),
		})
		.where(
			and(
				eq(idempotencyResponses.scope, scope),
				eq(idempotencyResponses.key, key),
				sql`${idempotencyResponses.responseBody} @> '{"_claimed": true}'::jsonb`,
			),
		)
		.returning({ scope: idempotencyResponses.scope });
	if (!completed) throw new Error('inventory_replay_completion_failed');
}

export async function persistInventoryReplayWarning(
	scope: string,
	key: string,
	itemId: string,
	warning: 'notification_delivery_failed' | 'notification_delivery_unknown',
): Promise<boolean> {
	const rows = await db
		.update(idempotencyResponses)
		.set({
			responseBody: sql`jsonb_set(${idempotencyResponses.responseBody}, '{warning}', to_jsonb(${warning}::text))`,
		})
		.where(
			and(
				eq(idempotencyResponses.scope, scope),
				eq(idempotencyResponses.key, key),
				gt(idempotencyResponses.expiresAt, new Date()),
				sql`${idempotencyResponses.responseBody}->'item'->>'id' = ${itemId}`,
				sql`${idempotencyResponses.responseBody}->'warning' = 'null'::jsonb`,
			),
		)
		.returning({ scope: idempotencyResponses.scope });
	return rows.length === 1;
}

type InventoryItemInput = Pick<
	WgInventoryItem,
	'wgId' | 'name' | 'quantity' | 'unit' | 'threshold' | 'category'
>;

async function pushBelowThresholdItemToShopping(
	tx: DbTransaction,
	item: Pick<WgInventoryItem, 'name' | 'quantity' | 'threshold' | 'unit'>,
	wgId: string,
	memberId: string,
): Promise<string | null> {
	if (!isBelowThreshold(item)) return null;
	const payload = buildShoppingPushPayload(item);
	const [created] = await tx
		.insert(shoppingItems)
		.values({
			wgId,
			addedByMemberId: memberId,
			name: payload.name,
			quantity: payload.quantity,
		})
		.onConflictDoNothing({
			target: [shoppingItems.wgId, shoppingItems.normalizedName],
			where: sql`${shoppingItems.boughtAt} IS NULL`,
		})
		.returning({ id: shoppingItems.id });
	return created?.id ?? null;
}

export async function createInventoryItemMutation(
	tx: DbTransaction,
	input: InventoryItemInput & { memberId: string },
) {
	const [item] = await tx
		.insert(wgInventoryItems)
		.values({
			wgId: input.wgId,
			name: input.name,
			quantity: input.quantity,
			unit: input.unit,
			threshold: input.threshold,
			category: input.category,
		})
		.returning();
	if (!item) return { kind: 'insert_failed' as const };

	const autoPushedShoppingItemId = await pushBelowThresholdItemToShopping(
		tx,
		item,
		input.wgId,
		input.memberId,
	);
	return { kind: 'ok' as const, item, autoPushedShoppingItemId };
}

export type UpdateInventoryItemMutationInput = {
	itemId: string;
	wgId: string;
	memberId: string;
	name?: string | undefined;
	quantityDelta?: number | undefined;
	quantity?: number | undefined;
	expectedQuantity?: number | undefined;
	threshold?: number | undefined;
	unit?: string | undefined;
	category?: string | undefined;
	expectedUpdatedAt?: string | undefined;
};

export async function updateInventoryItemMutation(
	tx: DbTransaction,
	input: UpdateInventoryItemMutationInput,
) {
	const existingQuery = tx
		.select()
		.from(wgInventoryItems)
		.where(and(eq(wgInventoryItems.id, input.itemId), eq(wgInventoryItems.wgId, input.wgId)))
		.limit(1);
	// A relative +/- tap has no stale state to conflict on: lock the row so
	// concurrent taps apply one after another (and log their exact delta)
	// instead of failing the optimistic quantity check below with a 409.
	const isDeltaOnly = input.quantity === undefined && input.quantityDelta !== undefined;
	const existingRows = await (isDeltaOnly ? existingQuery.for('update') : existingQuery);
	const existing = existingRows[0];
	if (!existing) return { kind: 'not_found' as const };

	if (input.quantity !== undefined) {
		if (!input.expectedUpdatedAt || input.expectedQuantity === undefined) {
			return { kind: 'conflict' as const };
		}
		if (
			existing.quantity !== input.expectedQuantity ||
			existing.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()
		) {
			return { kind: 'conflict' as const };
		}
	}

	const updates: Partial<typeof wgInventoryItems.$inferInsert> = { updatedAt: new Date() };
	let nextQuantity = existing.quantity;
	if (input.quantity !== undefined) {
		nextQuantity = clampQuantity(input.quantity);
	} else if (input.quantityDelta !== undefined) {
		nextQuantity = clampQuantity(existing.quantity + input.quantityDelta);
	}

	if (nextQuantity !== existing.quantity) updates.quantity = nextQuantity;
	if (input.name !== undefined) updates.name = input.name;
	if (input.threshold !== undefined) updates.threshold = input.threshold;
	if (input.unit !== undefined) updates.unit = input.unit;
	if (input.category !== undefined) updates.category = input.category;

	const updateConditions = [
		eq(wgInventoryItems.id, input.itemId),
		eq(wgInventoryItems.wgId, input.wgId),
		eq(wgInventoryItems.quantity, existing.quantity),
	];
	if (input.expectedUpdatedAt) {
		updateConditions.push(
			sql`date_trunc('milliseconds', ${wgInventoryItems.updatedAt}) = ${new Date(input.expectedUpdatedAt)}`,
		);
	}
	const [updated] = await tx
		.update(wgInventoryItems)
		.set(updates)
		.where(and(...updateConditions))
		.returning();
	if (!updated) {
		const stillExistsRows = await tx
			.select()
			.from(wgInventoryItems)
			.where(and(eq(wgInventoryItems.id, input.itemId), eq(wgInventoryItems.wgId, input.wgId)))
			.limit(1);
		return stillExistsRows[0] ? { kind: 'conflict' as const } : { kind: 'not_found' as const };
	}

	const delta = nextQuantity - existing.quantity;
	if (delta !== 0) {
		await tx.insert(wgInventoryLog).values({
			itemId: updated.id,
			memberId: input.memberId,
			delta,
			kind: delta < 0 ? 'consume' : 'restock',
		});
	}

	const autoPushedShoppingItemId = await pushBelowThresholdItemToShopping(
		tx,
		updated,
		input.wgId,
		input.memberId,
	);
	return { kind: 'ok' as const, updated, delta, autoPushedShoppingItemId };
}
