import { recordAuditEvent } from '@/core/audit';
import { db, shoppingItems } from '@/core/db';
import {
	type Rejected,
	type WriteOutcome,
	rejectWrite,
	withIdempotentWrite,
} from '@/core/db/idempotent-write';
import type { ShoppingItem } from '@/core/db/schema';
import { isWgAdmin } from '@/core/guards/admin';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { conflict, forbidden, serverError, tooMany } from '@/core/http/api-errors';
import { parseBody } from '@/core/http/parse-body';
import { readIdempotencyKey, setReplayWarning } from '@/core/idempotency-store';
import { readListLimit } from '@/core/infra/env';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import {
	SHOPPING_CREATE_DUPLICATE_RESPONSE,
	type ShoppingCreateReplayResponse,
	insertShoppingItem,
	shoppingCreateCodec,
	shoppingCreateHttpResponse,
	withShoppingCreatePostCommitFallback,
} from '@/features/shopping/server/shopping-mutation';
import { isOpenShoppingItemDuplicate } from '@/features/shopping/shopping-duplicate';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const NAME_MIN = 1;
const NAME_MAX = 120;
const QUANTITY_MAX = 40;
const SHOPPING_ITEMS_LIST_LIMIT = 1000;
/** Hard ceiling for `SHOPPING_ITEMS_LIST_LIMIT` — env can lower or raise, never unbound. */
const SHOPPING_ITEMS_LIST_LIMIT_MAX = 5000;

type ShoppingCreateOutcome = WriteOutcome<unknown, Rejected<NextResponse> | { item: ShoppingItem }>;

const createShoppingItemSchema = z.object({
	name: z.string().trim().min(NAME_MIN).max(NAME_MAX),
	quantity: z.string().trim().max(QUANTITY_MAX).optional().nullable(),
	bought: z.boolean().optional(),
});

export const GET = withWgRoute('shopping GET', async (req, { code }) => {
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;
	const listLimit = readListLimit(
		process.env,
		'SHOPPING_ITEMS_LIST_LIMIT',
		SHOPPING_ITEMS_LIST_LIMIT,
		SHOPPING_ITEMS_LIST_LIMIT_MAX,
	);
	// Open items always ship in full (bounded only by the hard ceiling); the
	// list limit caps the bought history, newest first, so a long purchase
	// history can never push open items out of the response.
	const [openItems, boughtItems] = await Promise.all([
		db
			.select()
			.from(shoppingItems)
			.where(and(eq(shoppingItems.wgId, wgId), isNull(shoppingItems.boughtAt)))
			.orderBy(asc(shoppingItems.createdAt))
			.limit(SHOPPING_ITEMS_LIST_LIMIT_MAX),
		db
			.select()
			.from(shoppingItems)
			.where(and(eq(shoppingItems.wgId, wgId), isNotNull(shoppingItems.boughtAt)))
			.orderBy(desc(shoppingItems.boughtAt), asc(shoppingItems.createdAt))
			.limit(listLimit),
	]);
	return NextResponse.json({ items: [...openItems, ...boughtItems] });
});

export const POST = withWgRoute('shopping POST', async (req, { code }) => {
	const parsed = await parseBody(req, createShoppingItemSchema, {
		fieldErrors: { quantity: 'quantity_invalid', bought: 'bought_invalid' },
		invalid: 'name_invalid',
	});
	if (!parsed.ok) return parsed.response;

	const { name, quantity = null, bought = false } = parsed.data;
	const safeQuantity = typeof quantity === 'string' && quantity.length > 0 ? quantity : null;
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const { wg, member } = auth;
	const key = readIdempotencyKey(req);
	const scope = `shopping-create:${wg.id}:${member.memberId}`;
	// SECURITY: addedBy is always the authenticated caller. Any body-supplied member id is
	// ignored to prevent attribution spoofing.
	const input = {
		wgId: wg.id,
		addedByMemberId: member.memberId,
		name,
		quantity: safeQuantity,
		bought,
	};

	const create = () =>
		withIdempotentWrite(
			{
				scope,
				key,
				codec: shoppingCreateCodec,
				// A same-key duplicate replays as 409 like the original request answered.
				storeStatus: (status) => status === 200 || status === 409,
				// Per-member write cap on top of the middleware's per-IP limit: an item fans out to
				// a system notice and a push to every other member, so one member must not rotate
				// IPs to spam the WG. Same 30/min ceiling as the middleware.
				prepare: async () => {
					const limited = await checkRateLimit(
						wgWriteLimiter,
						`shopping:create:${wg.id}:${member.memberId}`,
					);
					return limited.success ? { input: undefined } : { stop: tooMany() };
				},
				retryAfterRollback: (error, attempt) =>
					attempt === 1 && isOpenShoppingItemDuplicate(error)
						? async (): Promise<ShoppingCreateOutcome> => SHOPPING_CREATE_DUPLICATE_RESPONSE
						: null,
			},
			async (tx): Promise<ShoppingCreateOutcome> => {
				const item = await insertShoppingItem(tx, input);
				if (!item) return rejectWrite(serverError('insert_failed'));
				// The stored response is safe before any side effect: a retry stays replayable
				// when notification delivery or the later warning update fails.
				const provisional: ShoppingCreateReplayResponse = {
					status: 200,
					body: { item, warning: 'notification_delivery_unknown' },
				};
				return { ...provisional, context: { item } };
			},
		);
	let result: Awaited<ReturnType<typeof create>>;
	try {
		result = await create();
	} catch (err) {
		if (key) return serverError('idempotency_response_pending');
		if (isOpenShoppingItemDuplicate(err)) return conflict('shopping_item_duplicate');
		throw err;
	}
	if (result.kind === 'stopped') return result.response;
	if (result.kind === 'replayed' || !result.context) {
		return NextResponse.json(result.body, { status: result.status });
	}
	if ('rejected' in result.context) return result.context.rejected;

	const { item } = result.context;
	const provisional: ShoppingCreateReplayResponse = {
		status: 200,
		body: { item, warning: 'notification_delivery_unknown' },
	};
	const response = await withShoppingCreatePostCommitFallback(
		provisional,
		async () => {
			await recordAuditEvent({
				wgId: wg.id,
				memberId: member.memberId,
				eventType: 'shopping.created',
				entityType: 'shopping_item',
				entityId: item.id,
				summary: `${member.name} hat ${name} auf die Einkaufsliste gesetzt.`,
				metadata: { title: name, quantity: safeQuantity },
			});
			const { warning } = await dispatchNotificationSafely({
				wg,
				event: 'shopping.added',
				payload: { title: name, actorName: member.name, shoppingItemId: item.id },
				excludeMemberId: member.memberId,
			});
			if (key) {
				await setReplayWarning(
					scope,
					key,
					{
						match: [{ path: ['body', 'item', 'id'], equals: item.id }],
						warningPath: ['body', 'warning'],
						replaces: ['notification_delivery_unknown'],
					},
					warning,
				);
			}
			return { status: 200, body: { item, warning } };
		},
		() => console.error('[shopping POST] post-commit side effect failed'),
	);
	return shoppingCreateHttpResponse(response);
});

export const DELETE = withWgRoute('shopping DELETE', async (req, { code }) => {
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;
	// SECURITY: this clears every bought row of the whole WG (unlike the
	// item-level DELETE, which is limited to the item's own adder), so it is
	// admin-only like the other bulk/override mutations (chores DELETE,
	// announcement override). The caller's identity is resolved from the
	// Supabase session by requireWgMember, so the DB role check is the proof.
	if (!(await isWgAdmin(wgId, auth.member.memberId))) {
		return forbidden('not_admin', 'not_admin');
	}

	const limited = await checkRateLimit(
		wgWriteLimiter,
		`shopping:clear-bought:${wgId}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();

	const deleted = await db
		.delete(shoppingItems)
		.where(and(eq(shoppingItems.wgId, wgId), isNotNull(shoppingItems.boughtAt)))
		.returning({ id: shoppingItems.id, name: shoppingItems.name });
	if (deleted.length > 0) {
		await recordAuditEvent({
			wgId,
			memberId: auth.member.memberId,
			eventType: 'shopping.cleared_bought',
			entityType: 'shopping_item',
			entityId: null,
			summary: `${auth.member.name} hat ${deleted.length} erledigte Einkaufseinträge entfernt.`,
			metadata: {
				count: deleted.length,
				items: deleted.slice(0, 20).map((item) => item.name),
			},
		});
	}

	return NextResponse.json({ deleted: deleted.length });
});
