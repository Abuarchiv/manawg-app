import { postSystemNotice } from '@/core/activity-feed';
import { recordAuditEvent } from '@/core/audit';
import { db, shoppingItems } from '@/core/db';
import { badRequest, forbidden, notFound, tooMany } from '@/core/errors';
import { isWgAdmin } from '@/core/guards/admin';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const patchShoppingItemSchema = z.object({
	bought: z.boolean(),
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

	const limited = await checkRateLimit(
		wgWriteLimiter,
		`shopping:item:${wgId}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();

	// SECURITY: bought-by is always the authenticated caller. Body-supplied
	// ids are ignored to prevent attribution spoofing.
	const boughtBy = isBought ? auth.member.memberId : null;

	const [updated] = await db
		.update(shoppingItems)
		.set({
			boughtAt: isBought ? new Date() : null,
			boughtByMemberId: boughtBy,
			updatedAt: new Date(),
		})
		.where(and(eq(shoppingItems.id, id), eq(shoppingItems.wgId, wgId)))
		.returning();
	if (!updated) return notFound('item_not_found');
	await recordAuditEvent({
		wgId,
		memberId: auth.member.memberId,
		eventType: isBought ? 'shopping.bought' : 'shopping.reopened',
		entityType: 'shopping_item',
		entityId: updated.id,
		summary: isBought
			? `${auth.member.name} hat ${updated.name} gekauft.`
			: `${auth.member.name} hat ${updated.name} wieder geöffnet.`,
		metadata: { name: updated.name },
	});
	if (isBought) {
		await postSystemNotice({
			wgId,
			authorMemberId: auth.member.memberId,
			kind: 'info',
			source: 'shopping',
			sourcePath: `/einkauf?highlight=${encodeURIComponent(updated.id)}`,
			content: `${auth.member.name} hat ${updated.name} gekauft.`,
		});
	}
	return NextResponse.json({ item: updated });
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

	// The member who added the item may delete it; the WG admin gets the same
	// override every sibling route has (chores, announcements, events,
	// absences, recurring-expenses), so an item added by a member who has
	// since moved out can still be moderated away. `isWgAdmin` — like the bulk
	// clear in shopping/route.ts — is the admin proof here.
	// Self-ownership and the override both still require a verified HMAC
	// token: the bare member-id header is spoofable.
	const existing = await db
		.select({ addedByMemberId: shoppingItems.addedByMemberId, name: shoppingItems.name })
		.from(shoppingItems)
		.where(and(eq(shoppingItems.id, id), eq(shoppingItems.wgId, wgId)))
		.limit(1);
	const row = existing[0];
	if (!row) return notFound('item_not_found');
	const isOwner = row.addedByMemberId === auth.member.memberId;
	if (!auth.member.verified || (!isOwner && !(await isWgAdmin(wgId, auth.member.memberId)))) {
		return forbidden('not_owner', 'not_owner');
	}

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
