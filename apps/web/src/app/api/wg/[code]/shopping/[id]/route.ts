import { postSystemNotice } from '@/core/activity-feed';
import { recordAuditEvent } from '@/core/audit';
import { db, shoppingItems } from '@/core/db';
import { badRequest, conflict, notFound, tooMany } from '@/core/errors';
import { requireOwnerOrAdmin } from '@/core/guards/admin';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { readIdempotencyKey } from '@/core/idempotency';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { withAnnouncementReplay } from '@/features/pinnwand/announcement-replay';
import { isOpenShoppingItemDuplicate } from '@/features/shopping/shopping-duplicate';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const patchShoppingItemSchema = z.object({
	bought: z.boolean(),
	expectedUpdatedAt: z.string().optional(),
	expectedBoughtAt: z.string().nullable().optional(),
});

export const PATCH = withWgRoute<{ id: string }>('shopping PATCH', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');

	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}

	const parsed = patchShoppingItemSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.flatten();
		if (issues.fieldErrors.bought) return badRequest('bought_invalid');
		return badRequest('invalid_body');
	}

	const isBought = parsed.data.bought;
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;
	const idemKey = readIdempotencyKey(req);
	if (!idemKey) return badRequest('idempotency_key_required');
	if (!parsed.data.expectedUpdatedAt || !Object.hasOwn(parsed.data, 'expectedBoughtAt')) {
		return conflict('shopping_item_changed');
	}
	const expectedUpdatedAt = new Date(parsed.data.expectedUpdatedAt);
	const expectedBoughtAt = parsed.data.expectedBoughtAt;
	if (
		!Number.isFinite(expectedUpdatedAt.getTime()) ||
		(expectedBoughtAt !== null &&
			(expectedBoughtAt === undefined || !Number.isFinite(Date.parse(expectedBoughtAt))))
	) {
		return badRequest('expected_state_invalid');
	}

	const limited = await checkRateLimit(
		wgWriteLimiter,
		`shopping:item:${wgId}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();

	// SECURITY: bought-by is always the authenticated caller. Body-supplied
	// ids are ignored to prevent attribution spoofing.
	const boughtBy = isBought ? auth.member.memberId : null;
	const replay = await withAnnouncementReplay(
		req,
		`shopping-item:${wgId}:${auth.member.memberId}:${id}`,
		async (tx) => {
			const [updated] = await tx
				.update(shoppingItems)
				.set({
					boughtAt: isBought ? new Date() : null,
					boughtByMemberId: boughtBy,
					updatedAt: sql`greatest(clock_timestamp(), ${shoppingItems.updatedAt} + interval '1 millisecond')`,
				})
				.where(
					and(
						eq(shoppingItems.id, id),
						eq(shoppingItems.wgId, wgId),
						sql`date_trunc('milliseconds', ${shoppingItems.updatedAt}) = ${expectedUpdatedAt}`,
						expectedBoughtAt === null
							? isNull(shoppingItems.boughtAt)
							: sql`date_trunc('milliseconds', ${shoppingItems.boughtAt}) = ${new Date(expectedBoughtAt)}`,
					),
				)
				.returning();
			if (!updated) {
				const [existing] = await tx
					.select({ id: shoppingItems.id })
					.from(shoppingItems)
					.where(and(eq(shoppingItems.id, id), eq(shoppingItems.wgId, wgId)))
					.limit(1);
				return {
					response: existing
						? { status: 409, body: { error: 'shopping_item_changed' } }
						: { status: 404, body: { error: 'item_not_found' } },
					effect: null,
				};
			}
			return {
				response: { status: 200, body: { item: updated } },
				effect: { item: updated },
			};
		},
	).catch((err) => {
		// Return this conflict only after the helper has rolled back the aborted
		// Postgres transaction and released its claim.
		if (isOpenShoppingItemDuplicate(err)) {
			return {
				response: { status: 409, body: { error: 'shopping_item_duplicate' } },
				effect: null,
				key: idemKey,
			};
		}
		throw err;
	});
	if (replay.effect) {
		const { item } = replay.effect;
		await recordAuditEvent({
			wgId,
			memberId: auth.member.memberId,
			eventType: isBought ? 'shopping.bought' : 'shopping.reopened',
			entityType: 'shopping_item',
			entityId: item.id,
			summary: isBought
				? `${auth.member.name} hat ${item.name} gekauft.`
				: `${auth.member.name} hat ${item.name} wieder geöffnet.`,
			metadata: { name: item.name },
		});
		if (isBought) {
			await postSystemNotice({
				wgId,
				authorMemberId: auth.member.memberId,
				kind: 'info',
				source: 'shopping',
				sourcePath: `/einkauf?highlight=${encodeURIComponent(item.id)}`,
				content: `${auth.member.name} hat ${item.name} gekauft.`,
			});
		}
	}
	return NextResponse.json(replay.response.body, { status: replay.response.status });
});

export const DELETE = withWgRoute<{ id: string }>('shopping DELETE', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;

	const limited = await checkRateLimit(
		wgWriteLimiter,
		`shopping:item:${wgId}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();

	// The member who added the item, or the WG admin, may delete it.
	const existing = await db
		.select({ addedByMemberId: shoppingItems.addedByMemberId, name: shoppingItems.name })
		.from(shoppingItems)
		.where(and(eq(shoppingItems.id, id), eq(shoppingItems.wgId, wgId)))
		.limit(1);
	const row = existing[0];
	if (!row) return notFound('item_not_found');
	// Ownership and the admin override both require a verified caller — the
	// bare member-id header is spoofable.
	const denied = await requireOwnerOrAdmin(wgId, auth.member, row.addedByMemberId);
	if (denied) return denied;

	const deleted = await db
		.delete(shoppingItems)
		.where(and(eq(shoppingItems.id, id), eq(shoppingItems.wgId, wgId)))
		.returning({ id: shoppingItems.id });
	if (deleted.length === 0) return notFound('item_not_found');
	await recordAuditEvent({
		wgId,
		memberId: auth.member.memberId,
		eventType: 'shopping.deleted',
		entityType: 'shopping_item',
		entityId: id,
		summary: `${auth.member.name} hat ${row.name} aus der Einkaufsliste entfernt.`,
		metadata: { name: row.name },
	});
	return NextResponse.json({ deleted: true });
});
