import { recordAuditEvent } from '@/core/audit';
import { bodyCodec, rejectWrite, withIdempotentWrite } from '@/core/db/idempotent-write';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { badRequest, conflict, notFound, tooMany } from '@/core/http/api-errors';
import { parseBody } from '@/core/http/parse-body';
import { readIdempotencyKey, setReplayWarning } from '@/core/idempotency-store';
import { logApiError } from '@/core/infra/observability';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import type { NotificationWarning } from '@/core/notifications/notification-warning';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { INVENTORY_LIMITS } from '@/features/inventory/inventory';
import { consumeInventoryMutation } from '@/features/inventory/server/consume-mutation';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const consumeSchema = z.object({
	delta: z
		.number()
		.int()
		.min(INVENTORY_LIMITS.CONSUME_DELTA_MIN)
		.max(INVENTORY_LIMITS.CONSUME_DELTA_MAX),
});

type ConsumeResponseBody = {
	item: unknown;
	clamped: boolean;
	autoPushedShoppingItemId: string | null;
	warning: NotificationWarning;
};

const consumeCodec = bodyCodec(
	(stored): stored is ConsumeResponseBody =>
		stored !== null && typeof stored === 'object' && 'item' in stored,
);

export const POST = withWgRoute<{ id: string }>('inventory consume', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');

	const parsed = await parseBody(req, consumeSchema, { invalid: 'delta_invalid' });
	if (!parsed.ok) return parsed.response;
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;
	const key = readIdempotencyKey(req);
	const scope = `inventory-consume:${wg.id}:${auth.member.memberId}:${id}`;

	const result = await withIdempotentWrite(
		{
			scope,
			key,
			codec: consumeCodec,
			prepare: async () => {
				const limited = await checkRateLimit(
					wgWriteLimiter,
					`inventory-consume:${wg.id}:${auth.member.memberId}`,
				);
				return limited.success ? { input: undefined } : { stop: tooMany() };
			},
		},
		async (tx) => {
			const mutation = await consumeInventoryMutation(tx, {
				itemId: id,
				wgId: wg.id,
				memberId: auth.member.memberId,
				delta: parsed.data.delta,
			});
			if (mutation.kind === 'not_found') return rejectWrite(notFound('item_not_found'));
			if (mutation.kind === 'conflict') return rejectWrite(conflict('version_conflict'));
			const body: ConsumeResponseBody = {
				item: mutation.updated,
				clamped: mutation.clamped,
				autoPushedShoppingItemId: mutation.autoPushedShoppingItemId,
				warning: null,
			};
			return { status: 200, body, context: mutation };
		},
	);
	if (result.kind === 'stopped') return result.response;
	if (result.kind === 'replayed' || !result.context) {
		return NextResponse.json(result.body, { status: result.status });
	}
	if ('rejected' in result.context) return result.context.rejected;
	const { updated, appliedDelta, clamped, justCrossedThreshold, autoPushedShoppingItemId } =
		result.context;

	await recordAuditEvent({
		wgId: wg.id,
		memberId: auth.member.memberId,
		eventType: 'inventory.consumed',
		entityType: 'inventory_item',
		entityId: updated.id,
		summary: `${auth.member.name} hat ${Math.abs(appliedDelta)} ${updated.unit} ${updated.name} entnommen.`,
		metadata: {
			name: updated.name,
			appliedDelta,
			requestedDelta: parsed.data.delta,
			quantity: updated.quantity,
			threshold: updated.threshold,
			clamped,
			autoPushedShoppingItemId,
		},
	});

	let warning: NotificationWarning = null;
	if (justCrossedThreshold) {
		({ warning } = await dispatchNotificationSafely({
			wg,
			event: 'inventory.low_stock',
			payload: {
				title: updated.name,
				actorName: auth.member.name,
				quantity: updated.quantity,
				threshold: updated.threshold,
				unit: updated.unit,
				inventoryItemId: updated.id,
				shoppingItemId: autoPushedShoppingItemId,
			},
			excludeMemberId: auth.member.memberId,
		}));
	}
	if (key && warning !== null) {
		try {
			const persisted = await setReplayWarning(
				scope,
				key,
				{
					match: [{ path: ['item', 'id'], equals: updated.id }],
					warningPath: ['warning'],
					replaces: [null],
				},
				warning,
			);
			if (!persisted) throw new Error('replay_row_missing');
		} catch (warningError) {
			logApiError('[inventory/consume] replay warning persistence failed', warningError);
			warning = null;
		}
	}

	const responseBody: ConsumeResponseBody = {
		item: updated,
		clamped,
		autoPushedShoppingItemId,
		warning,
	};
	return NextResponse.json(responseBody);
});
