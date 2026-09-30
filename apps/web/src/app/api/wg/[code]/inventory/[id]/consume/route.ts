import { recordAuditEvent } from '@/core/audit';
import { withTransaction } from '@/core/db/transaction';
import { badRequest, conflict, notFound, tooMany } from '@/core/errors';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import {
	ReplayCache,
	type ReplayReservation,
	claimReplaySlotWithRetry,
	replayKey,
} from '@/core/guards/idempotency';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { getCachedResponse, readIdempotencyKey, releaseResponseSlot } from '@/core/idempotency';
import { logApiError } from '@/core/infra/observability';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { consumeInventoryMutation } from '@/features/inventory/consume-mutation';
import { INVENTORY_LIMITS } from '@/features/inventory/inventory';
import {
	completeInventoryReplay,
	persistInventoryReplayWarning,
} from '@/features/inventory/inventory-mutations';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const consumeSchema = z.object({
	delta: z
		.number()
		.int()
		.min(INVENTORY_LIMITS.CONSUME_DELTA_MIN)
		.max(INVENTORY_LIMITS.CONSUME_DELTA_MAX),
});

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
type ConsumeWarning = null | 'notification_delivery_failed' | 'notification_delivery_unknown';

type ConsumeResponseBody = {
	item: unknown;
	clamped: boolean;
	autoPushedShoppingItemId: string | null;
	warning: ConsumeWarning;
};
const consumeReplay = new ReplayCache<ConsumeResponseBody>(IDEMPOTENCY_TTL_MS);

export const POST = withWgRoute<{ id: string }>('inventory consume', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');

	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}

	const parsed = consumeSchema.safeParse(raw);
	if (!parsed.success) {
		return badRequest('delta_invalid');
	}
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;
	const idemKey = readIdempotencyKey(req);
	const idemScope = idemKey ? `inventory-consume:${wg.id}:${auth.member.memberId}:${id}` : null;
	const idemReplayKey = idemScope && idemKey ? replayKey(idemScope, idemKey) : null;
	if (idemScope && idemKey && idemReplayKey) {
		const localReplay = consumeReplay.get(idemReplayKey);
		if (localReplay) return NextResponse.json(await localReplay);
		const cached = await getCachedResponse<ConsumeResponseBody>(idemScope, idemKey);
		if (cached) {
			return NextResponse.json(cached);
		}
	}

	const limited = await checkRateLimit(
		wgWriteLimiter,
		`inventory-consume:${wg.id}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();
	let replayReservation: Extract<ReplayReservation<ConsumeResponseBody>, { owned: true }> | null =
		null;
	if (idemReplayKey) {
		const localReservation = consumeReplay.reserve(idemReplayKey);
		if (localReservation.owned === false) return NextResponse.json(await localReservation.promise);
		replayReservation = localReservation;
	}

	try {
		if (idemScope && idemKey) {
			const slot = await claimReplaySlotWithRetry<ConsumeResponseBody>(idemScope, idemKey);
			if (!slot.won) {
				replayReservation?.resolve(slot.cached);
				return NextResponse.json(slot.cached);
			}
		}

		const transactionResult = await withTransaction(async (tx) => {
			const mutation = await consumeInventoryMutation(tx, {
				itemId: id,
				wgId: wg.id,
				memberId: auth.member.memberId,
				delta: parsed.data.delta,
			});
			if (mutation.kind === 'ok' && idemScope && idemKey) {
				await completeInventoryReplay(tx, idemScope, idemKey, {
					item: mutation.updated,
					clamped: mutation.clamped,
					autoPushedShoppingItemId: mutation.autoPushedShoppingItemId,
					warning: null,
				});
			}
			return mutation;
		});

		if (transactionResult.kind === 'not_found') {
			if (idemScope && idemKey) await releaseResponseSlot(idemScope, idemKey);
			const err = new Error('item_not_found');
			replayReservation?.reject(err);
			return notFound('item_not_found');
		}
		if (transactionResult.kind === 'conflict') {
			if (idemScope && idemKey) await releaseResponseSlot(idemScope, idemKey);
			const err = new Error('version_conflict');
			replayReservation?.reject(err);
			return conflict('version_conflict');
		}
		const { updated, appliedDelta, clamped, justCrossedThreshold, autoPushedShoppingItemId } =
			transactionResult;

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

		let warning: ConsumeWarning = null;
		if (justCrossedThreshold || autoPushedShoppingItemId !== null) {
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
		if (idemScope && idemKey && warning !== null) {
			try {
				const persisted = await persistInventoryReplayWarning(
					idemScope,
					idemKey,
					updated.id,
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
		if (idemScope && idemKey && replayReservation?.owned) {
			replayReservation.resolve(responseBody);
		}
		return NextResponse.json(responseBody);
	} catch (err) {
		replayReservation?.reject(err);
		throw err;
	}
});
