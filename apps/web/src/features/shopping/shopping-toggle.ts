import { OFFLINE_NO_CONNECTION_TITLE } from '@/core/offline/offline-failure-copy';
import type { OfflineAction } from '@/core/offline/offline-queue';
import type { ShoppingItem } from '@/features/shopping/components/shopping-types';
import { keepItems } from '@/features/shopping/shopping-view';

/** A PATCH that checks the item off (or reopens it) only if nobody changed it meanwhile. */
export interface ShoppingPatchRequest {
	expectedUpdatedAt: string;
	expectedBoughtAt: string | null;
	fingerprint: string;
	idempotencyKey: string;
}

export type ShoppingPatchPlan =
	| { ok: true; request: ShoppingPatchRequest }
	| { ok: false; reason: 'version_missing' | 'key_unavailable' };

/**
 * Builds the toggle request for a server item. A retry of the same toggle on the same version
 * reuses the earlier idempotency key, so an ambiguous first attempt is not applied twice.
 */
export function planShoppingPatch(
	item: ShoppingItem,
	bought: boolean,
	previous: { fingerprint: string; key: string } | undefined,
	createKey: () => string | null,
): ShoppingPatchPlan {
	if (!item.updatedAt) return { ok: false, reason: 'version_missing' };
	const fingerprint = JSON.stringify({
		expectedUpdatedAt: item.updatedAt,
		expectedBoughtAt: item.boughtAt,
		bought,
	});
	const idempotencyKey = previous?.fingerprint === fingerprint ? previous.key : createKey();
	if (!idempotencyKey) return { ok: false, reason: 'key_unavailable' };
	return {
		ok: true,
		request: {
			expectedUpdatedAt: item.updatedAt,
			expectedBoughtAt: item.boughtAt,
			fingerprint,
			idempotencyKey,
		},
	};
}

/** The row as it looks right after the tap, before the server confirms it. */
export function toggledShoppingItem(
	item: ShoppingItem,
	bought: boolean,
	memberId: string,
	now: Date,
): ShoppingItem {
	return {
		...item,
		boughtAt: bought ? now.toISOString() : null,
		boughtByMemberId: bought ? memberId : null,
	};
}

interface QueuedCreateTarget {
	itemId: string;
	shareCode: string;
	memberId: string;
}

function isQueuedCreate(action: OfflineAction, target: QueuedCreateTarget): boolean {
	return (
		action.id === target.itemId &&
		action.shareCode === target.shareCode &&
		action.memberId === target.memberId &&
		action.type === 'shopping.create'
	);
}

/**
 * Marks a not-yet-synced create as bought (or open) inside the queue, so it reaches the server in
 * its final state. Returns null when the create is not queued (anymore).
 */
export function withQueuedCreateBought(
	actions: OfflineAction[],
	target: QueuedCreateTarget,
	bought: boolean,
): OfflineAction[] | null {
	if (!actions.some((action) => isQueuedCreate(action, target))) return null;
	return actions.map((action) =>
		isQueuedCreate(action, target) ? { ...action, payload: { ...action.payload, bought } } : action,
	);
}

/** `items` with one row replaced, keeping the array identity when nothing changed. */
export function replaceShoppingItem(
	items: ShoppingItem[],
	id: string,
	replacement: ShoppingItem,
): ShoppingItem[] {
	return keepItems(
		items,
		items.map((item) => (item.id === id ? replacement : item)),
	);
}

/** `items` without the rows `drop` matches, keeping the array identity when nothing changed. */
export function dropShoppingItems(
	items: ShoppingItem[],
	drop: (item: ShoppingItem) => boolean,
): ShoppingItem[] {
	return keepItems(
		items,
		items.filter((item) => !drop(item)),
	);
}

const openNameKey = (name: string): string => name.trim().toLowerCase();

/**
 * The server list with this member's not-yet-synced offline actions laid back over it: queued
 * creates reappear as rows, queued check-offs keep their state. Without it, any fetch that lands
 * before the replay hides what the queue counter still says is waiting.
 */
export function overlayQueuedShopping(
	incoming: ShoppingItem[],
	queue: readonly OfflineAction[],
	target: { shareCode: string; memberId: string },
): ShoppingItem[] {
	const mine = queue.filter(
		(action) => action.shareCode === target.shareCode && action.memberId === target.memberId,
	);
	const updates = new Map<string, OfflineAction>();
	for (const action of mine) {
		// A rejected update (e.g. changed meanwhile) will never apply, so the list must not show it.
		const rejected = action.lastError && !action.lastError.startsWith(OFFLINE_NO_CONNECTION_TITLE);
		if (action.type === 'shopping.update' && !rejected) {
			updates.set(String(action.payload.itemId), action);
		}
	}
	const result = incoming.map((row) => {
		const action = updates.get(row.id);
		const bought = action?.payload.bought === true;
		return action && (row.boughtAt !== null) !== bought
			? toggledShoppingItem(row, bought, target.memberId, new Date(action.createdAt))
			: row;
	});
	const openNames = new Set(
		incoming.filter((row) => row.boughtAt === null).map((row) => openNameKey(row.name)),
	);
	const created: ShoppingItem[] = [];
	for (const action of mine) {
		if (action.type !== 'shopping.create' || result.some((row) => row.id === action.id)) continue;
		const bought = action.payload.bought === true;
		const name = String(action.payload.name ?? '');
		// The replay answers a same-named open item with a duplicate, i.e. it adds nothing.
		if (!bought && openNames.has(openNameKey(name))) continue;
		created.push({
			id: action.id,
			addedByMemberId: action.memberId,
			name,
			quantity: typeof action.payload.quantity === 'string' ? action.payload.quantity : null,
			boughtAt: bought ? action.createdAt : null,
			boughtByMemberId: bought ? action.memberId : null,
			createdAt: action.createdAt,
		});
	}
	return created.length === 0 ? result : [...created, ...result];
}

/** The queue without follow-up actions of this WG that target the (server) item `itemId`. */
export function withoutQueuedFollowUps(
	actions: readonly OfflineAction[],
	shareCode: string,
	itemId: string,
): OfflineAction[] | null {
	const next = actions.filter(
		(action) => !(action.shareCode === shareCode && action.payload.itemId === itemId),
	);
	return next.length === actions.length ? null : next;
}
