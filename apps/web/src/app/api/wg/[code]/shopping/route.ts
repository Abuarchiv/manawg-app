import { postSystemNotice } from '@/core/activity-feed';
import { recordAuditEvent } from '@/core/audit';
import { db, shoppingItems } from '@/core/db';
import { withTransaction } from '@/core/db/transaction';
import { badRequest, conflict, forbidden, serverError, tooMany } from '@/core/errors';
import { isWgAdmin } from '@/core/guards/admin';
import {
	ReplayCache,
	type ReplayReservation,
	claimReplaySlotWithRetry,
	replayKey,
} from '@/core/guards/idempotency';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { getCachedResponse, readIdempotencyKey, setCachedResponse } from '@/core/idempotency';
import { readListLimit } from '@/core/infra/env';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { isOpenShoppingItemDuplicate } from '@/features/shopping/shopping-duplicate';
import {
	SHOPPING_CREATE_DUPLICATE_RESPONSE,
	type ShoppingCreateReplayResponse,
	ShoppingCreateTransactionRollback,
	finalizeShoppingCreateDuplicateReplay,
	handleShoppingCreateTransactionFailure,
	insertShoppingItemWithReplay,
	normalizeShoppingCreateReplayOrReject,
	normalizeShoppingCreateReplayResponse,
	persistShoppingCreateReplayResponse,
	releaseShoppingCreateClaim,
	resolveShoppingCreateReplay,
	shoppingCreateHttpResponse,
	withShoppingCreatePostCommitFallback,
} from '@/features/shopping/shopping-mutation';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const NAME_MIN = 1;
const NAME_MAX = 120;
const QUANTITY_MAX = 40;
const SHOPPING_ITEMS_LIST_LIMIT = 1000;
/** Hard ceiling for `SHOPPING_ITEMS_LIST_LIMIT` — env can lower or raise, never unbound. */
const SHOPPING_ITEMS_LIST_LIMIT_MAX = 5000;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

const shoppingCreateReplay = new ReplayCache<ShoppingCreateReplayResponse>(IDEMPOTENCY_TTL_MS);

function shoppingCreateIdempotencyScope(wgId: string, memberId: string): string {
	return `shopping-create:${wgId}:${memberId}`;
}

const createShoppingItemSchema = z.object({
	name: z.string().trim().min(NAME_MIN).max(NAME_MAX),
	quantity: z.string().trim().max(QUANTITY_MAX).optional().nullable(),
	bought: z.boolean().optional(),
});

export const GET = withWgRoute(
	'shopping GET',
	async (req, { code }) => {
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
	},
	{ fixture: () => NextResponse.json({ items: [] }) },
);

export const POST = withWgRoute('shopping POST', async (req, { code }) => {
	let replayReservation: Extract<
		ReplayReservation<ShoppingCreateReplayResponse>,
		{ owned: true }
	> | null = null;
	let mutationCommitted = false;
	let provisionalResponse: ShoppingCreateReplayResponse | null = null;
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}

	const parsed = createShoppingItemSchema.safeParse(raw);
	if (!parsed.success) {
		const { fieldErrors } = parsed.error.flatten();
		if (fieldErrors.quantity) return badRequest('quantity_invalid');
		if (fieldErrors.bought) return badRequest('bought_invalid');
		return badRequest('name_invalid');
	}

	const { name, quantity = null, bought = false } = parsed.data;
	const safeQuantity = typeof quantity === 'string' && quantity.length > 0 ? quantity : null;
	const idemKey = readIdempotencyKey(req);

	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;
	const idemScope = idemKey ? shoppingCreateIdempotencyScope(wg.id, auth.member.memberId) : null;
	const idemReplayKey = idemScope && idemKey ? replayKey(idemScope, idemKey) : null;
	if (idemScope && idemKey && idemReplayKey) {
		const localReplay = shoppingCreateReplay.get(idemReplayKey);
		if (localReplay) {
			try {
				return shoppingCreateHttpResponse(await localReplay);
			} catch {
				return serverError('idempotency_response_pending');
			}
		}

		const cachedPayload = await getCachedResponse<unknown>(idemScope, idemKey);
		if (cachedPayload) {
			const cached = normalizeShoppingCreateReplayResponse(cachedPayload);
			if (!cached) return serverError('idempotency_response_pending');
			shoppingCreateReplay.remember(idemReplayKey, cached);
			return shoppingCreateHttpResponse(cached);
		}
	}

	// Per-member write cap on top of the middleware's per-IP limit. Creating an
	// item fans out to a system announcement and a push to every other member,
	// so without a member-scoped bucket a single member could rotate IPs to spam
	// the whole WG. Same 30/min ceiling as the middleware, so it can only reject
	// a request a normal single-IP user could already not make.
	const limited = await checkRateLimit(
		wgWriteLimiter,
		`shopping:create:${wg.id}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();

	// SECURITY: addedBy is always the authenticated caller. Any body-supplied
	// member id is ignored to prevent attribution spoofing.
	const addedBy = auth.member.memberId;
	const replaySlot = idemReplayKey === null ? null : shoppingCreateReplay.reserve(idemReplayKey);
	if (replaySlot?.owned === false) {
		try {
			return shoppingCreateHttpResponse(await replaySlot.promise);
		} catch {
			return serverError('idempotency_response_pending');
		}
	}
	replayReservation = replaySlot;

	try {
		if (idemScope && idemKey) {
			const slot = await claimReplaySlotWithRetry<ShoppingCreateReplayResponse>(idemScope, idemKey);
			if (!slot.won) {
				const cached = normalizeShoppingCreateReplayOrReject(slot.cached, replayReservation);
				if (!cached) return serverError('idempotency_response_pending');
				resolveShoppingCreateReplay(replayReservation, cached);
				return shoppingCreateHttpResponse(cached);
			}
		}

		let item: typeof shoppingItems.$inferSelect | undefined;
		if (idemScope && idemKey) {
			let transactionBodyStarted = false;
			try {
				item = await withTransaction(async (tx) => {
					transactionBodyStarted = true;
					try {
						return await insertShoppingItemWithReplay(tx, {
							wgId: wg.id,
							addedByMemberId: addedBy,
							name,
							quantity: safeQuantity,
							bought,
							replay: { scope: idemScope, key: idemKey },
						});
					} catch (err) {
						throw new ShoppingCreateTransactionRollback(err);
					}
				});
			} catch (insertErr) {
				if (isOpenShoppingItemDuplicate(insertErr)) {
					const duplicateResponse = await finalizeShoppingCreateDuplicateReplay(replayReservation, {
						persist: () =>
							withTransaction((tx) =>
								persistShoppingCreateReplayResponse(
									tx,
									idemScope,
									idemKey,
									SHOPPING_CREATE_DUPLICATE_RESPONSE,
								),
							),
						read: async () =>
							normalizeShoppingCreateReplayResponse(
								await getCachedResponse<unknown>(idemScope, idemKey),
							),
						release: () => releaseShoppingCreateClaim(idemScope, idemKey),
					});
					if (!duplicateResponse) return serverError('idempotency_response_pending');
					return shoppingCreateHttpResponse(duplicateResponse);
				}

				try {
					const failure = transactionBodyStarted
						? insertErr
						: new ShoppingCreateTransactionRollback(insertErr);
					await handleShoppingCreateTransactionFailure(replayReservation, failure, () =>
						releaseShoppingCreateClaim(idemScope, idemKey),
					);
				} catch {
					return serverError('idempotency_response_pending');
				}
				return serverError('idempotency_response_pending');
			}
		} else {
			try {
				[item] = await db
					.insert(shoppingItems)
					.values({
						wgId: wg.id,
						addedByMemberId: addedBy,
						name,
						quantity: safeQuantity,
						boughtAt: bought ? new Date() : null,
						boughtByMemberId: bought ? addedBy : null,
					})
					.returning();
			} catch (insertErr) {
				if (isOpenShoppingItemDuplicate(insertErr)) {
					return conflict('shopping_item_duplicate');
				}
				throw insertErr;
			}
		}
		if (!item) {
			const err = new Error('insert_failed');
			replayReservation?.reject(err);
			if (idemScope && idemKey) {
				try {
					if (!(await releaseShoppingCreateClaim(idemScope, idemKey))) {
						return serverError('idempotency_response_pending');
					}
				} catch {
					return serverError('idempotency_response_pending');
				}
			}
			return serverError('insert_failed');
		}
		mutationCommitted = true;
		const provisionalReplayResponse: ShoppingCreateReplayResponse = {
			status: 200,
			body: { item, warning: 'notification_delivery_unknown' },
		};
		provisionalResponse = provisionalReplayResponse;
		resolveShoppingCreateReplay(replayReservation, provisionalReplayResponse);
		const responseBody = await withShoppingCreatePostCommitFallback(
			provisionalReplayResponse,
			async () => {
				await recordAuditEvent({
					wgId: wg.id,
					memberId: auth.member.memberId,
					eventType: 'shopping.created',
					entityType: 'shopping_item',
					entityId: item.id,
					summary: `${auth.member.name} hat ${name} auf die Einkaufsliste gesetzt.`,
					metadata: {
						title: name,
						quantity: safeQuantity,
					},
				});
				await postSystemNotice({
					wgId: wg.id,
					authorMemberId: addedBy,
					kind: 'request',
					source: 'shopping',
					sourcePath: `/einkauf?highlight=${encodeURIComponent(item.id)}`,
					content: `${auth.member.name} hat ${safeQuantity ? `${name} (${safeQuantity})` : name} auf die Einkaufsliste gesetzt.`,
				});
				const { warning } = await dispatchNotificationSafely({
					wg,
					event: 'shopping.added',
					payload: { title: name, actorName: auth.member.name, shoppingItemId: item.id },
					excludeMemberId: auth.member.memberId,
				});
				const finalResponse: ShoppingCreateReplayResponse = {
					status: 200,
					body: { item, warning },
				};
				if (idemScope && idemKey && idemReplayKey && replayReservation?.owned) {
					await setCachedResponse(idemScope, idemKey, finalResponse);
					shoppingCreateReplay.remember(idemReplayKey, finalResponse);
				}
				return finalResponse;
			},
			() => console.error('[shopping POST] post-commit side effect failed'),
		);
		return shoppingCreateHttpResponse(responseBody);
	} catch (err) {
		if (mutationCommitted && provisionalResponse) {
			console.error('[shopping POST] post-commit failure; returning provisional response');
			return shoppingCreateHttpResponse(provisionalResponse);
		}
		replayReservation?.reject(err);
		throw err;
	}
});

export const DELETE = withWgRoute('shopping DELETE', async (req, { code }) => {
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wgId = auth.wg.id;
	// SECURITY: this clears every bought row of the whole WG (unlike the
	// item-level DELETE, which is limited to the item's own adder), so it is
	// admin-only like the other bulk/override mutations (chores DELETE,
	// announcement override). The caller's identity is resolved from the
	// Supabase session by requireWgMember, so the explicit DB role check
	// (`isWgAdmin`) is the sound proof here — `isVerifiedWgAdmin` would also
	// demand the legacy HMAC token, which no flow issues since the Supabase
	// migration and would lock every admin out of this action.
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
