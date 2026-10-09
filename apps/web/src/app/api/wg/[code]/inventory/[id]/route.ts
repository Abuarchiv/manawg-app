import { recordAuditEvent } from '@/core/audit';
import { db, wgInventoryItems } from '@/core/db';
import { bodyCodec, rejectWrite, withIdempotentWrite } from '@/core/db/idempotent-write';
import type { WgInventoryItem } from '@/core/db/schema';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { badRequest, conflict, notFound, tooMany } from '@/core/http/api-errors';
import { parseBody } from '@/core/http/parse-body';
import { readIdempotencyKey } from '@/core/idempotency-store';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import {
	INVENTORY_CATEGORIES,
	INVENTORY_LIMITS,
	INVENTORY_UNITS,
} from '@/features/inventory/inventory';
import { isInventoryNameTaken } from '@/features/inventory/server/inventory-duplicate';
import { updateInventoryItemMutation } from '@/features/inventory/server/inventory-mutations';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const patchInventorySchema = z
	.object({
		name: z
			.string()
			.trim()
			.min(INVENTORY_LIMITS.NAME_MIN)
			.max(INVENTORY_LIMITS.NAME_MAX)
			.optional(),
		quantityDelta: z
			.number()
			.int()
			.min(-INVENTORY_LIMITS.QUANTITY_MAX)
			.max(INVENTORY_LIMITS.QUANTITY_MAX)
			.optional(),
		quantity: z
			.number()
			.int()
			.min(INVENTORY_LIMITS.QUANTITY_MIN)
			.max(INVENTORY_LIMITS.QUANTITY_MAX)
			.optional(),
		expectedQuantity: z
			.number()
			.int()
			.min(INVENTORY_LIMITS.QUANTITY_MIN)
			.max(INVENTORY_LIMITS.QUANTITY_MAX)
			.optional(),
		threshold: z
			.number()
			.int()
			.min(INVENTORY_LIMITS.THRESHOLD_MIN)
			.max(INVENTORY_LIMITS.THRESHOLD_MAX)
			.optional(),
		unit: z.enum(INVENTORY_UNITS).optional(),
		category: z.enum(INVENTORY_CATEGORIES).optional(),
		expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
	})
	.refine(
		(value) =>
			value.name !== undefined ||
			value.quantityDelta !== undefined ||
			value.quantity !== undefined ||
			value.threshold !== undefined ||
			value.unit !== undefined ||
			value.category !== undefined,
		{ message: 'empty_update' },
	)
	.refine((value) => value.quantity === undefined || value.expectedUpdatedAt !== undefined, {
		message: 'expected_updated_at_required',
	})
	.refine((value) => value.quantity === undefined || value.expectedQuantity !== undefined, {
		message: 'expected_quantity_required',
	});

const inventoryPatchCodec = bodyCodec(
	(stored): stored is { item: WgInventoryItem } =>
		stored !== null && typeof stored === 'object' && 'item' in stored,
);

export const PATCH = withWgRoute<{ id: string }>('inventory PATCH', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');

	const parsed = await parseBody(req, patchInventorySchema, {
		fieldErrors: {
			name: 'name_invalid',
			quantity: 'quantity_invalid',
			quantityDelta: 'quantity_invalid',
			expectedQuantity: 'expected_quantity_invalid',
			threshold: 'threshold_invalid',
			unit: 'unit_invalid',
			category: 'category_invalid',
			expectedUpdatedAt: 'expected_updated_at_invalid',
		},
		formErrors: {
			empty_update: 'empty_update',
			expected_updated_at_required: 'expected_updated_at_required',
			expected_quantity_required: 'expected_quantity_required',
		},
	});
	if (!parsed.ok) return parsed.response;
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;

	const result = await withIdempotentWrite(
		{
			scope: `inventory-patch:${wgId}:${auth.member.memberId}:${id}`,
			key: readIdempotencyKey(req),
			codec: inventoryPatchCodec,
			prepare: async () => {
				const limited = await checkRateLimit(
					wgWriteLimiter,
					`inventory-patch:${wgId}:${auth.member.memberId}`,
				);
				return limited.success ? { input: undefined } : { stop: tooMany() };
			},
		},
		async (tx) => {
			if (
				parsed.data.name !== undefined &&
				(await isInventoryNameTaken(tx, wgId, parsed.data.name, id))
			) {
				return rejectWrite(conflict('inventory_item_duplicate'));
			}
			const mutation = await updateInventoryItemMutation(tx, {
				...parsed.data,
				itemId: id,
				wgId,
				memberId: auth.member.memberId,
			});
			if (mutation.kind === 'not_found') return rejectWrite(notFound('item_not_found'));
			if (mutation.kind === 'conflict') return rejectWrite(conflict('version_conflict'));
			return { status: 200, body: { item: mutation.updated }, context: mutation };
		},
	);
	if (result.kind === 'stopped') return result.response;
	if (result.kind === 'written' && result.context) {
		if ('rejected' in result.context) return result.context.rejected;
		const { updated, delta, autoPushedShoppingItemId } = result.context;
		await recordAuditEvent({
			wgId,
			memberId: auth.member.memberId,
			eventType: 'inventory.updated',
			entityType: 'inventory_item',
			entityId: updated.id,
			summary: `${auth.member.name} hat ${updated.name} in den Vorräten aktualisiert.`,
			metadata: {
				name: updated.name,
				delta,
				quantity: updated.quantity,
				threshold: updated.threshold,
				unit: updated.unit,
				category: updated.category,
				autoPushedShoppingItemId,
			},
		});
	}
	return NextResponse.json(result.body, { status: result.status });
});

export const DELETE = withWgRoute<{ id: string }>('inventory DELETE', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;

	const limitedDelete = await checkRateLimit(
		wgWriteLimiter,
		`inventory-delete:${wgId}:${auth.member.memberId}`,
	);
	if (!limitedDelete.success) return tooMany();

	const deleted = await db
		.delete(wgInventoryItems)
		.where(and(eq(wgInventoryItems.id, id), eq(wgInventoryItems.wgId, wgId)))
		.returning({ id: wgInventoryItems.id, name: wgInventoryItems.name });
	if (deleted.length === 0) return notFound('item_not_found');

	await recordAuditEvent({
		wgId,
		memberId: auth.member.memberId,
		eventType: 'inventory.deleted',
		entityType: 'inventory_item',
		entityId: id,
		summary: `${auth.member.name} hat ${deleted[0]?.name ?? 'einen Vorrat'} aus den Vorräten entfernt.`,
		metadata: { name: deleted[0]?.name ?? null },
	});

	return NextResponse.json({ deleted: true });
});
