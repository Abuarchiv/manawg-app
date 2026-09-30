import 'server-only';

import { db } from '@/core/db';
import { announcements, expenses, privateImageDeletions, wgChatMessages } from '@/core/db/schema';
import { type DbTransaction, TransactionAbort, withTransaction } from '@/core/db/transaction';
import { getPrivateImageKeyFromStoredUrl, parsePrivateImageKey } from '@/core/validators/image-url';
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

const CLEANUP_DELAY_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000;
const CLEANUP_RECHECK_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 50;

// ponytail: full per-WG image-history scan; normalize reference keys if measured delete latency warrants it.
async function getWgPrivateImageKeys(
	tx: DbTransaction,
	wgId: string,
	includeDeletedChat = false,
): Promise<Set<string>> {
	const expenseRows = await tx
		.select({ imageUrl: expenses.imageUrl })
		.from(expenses)
		.where(and(eq(expenses.wgId, wgId), isNotNull(expenses.imageUrl)));
	const announcementRows = await tx
		.select({ imageUrl: announcements.imageUrl })
		.from(announcements)
		.where(and(eq(announcements.wgId, wgId), isNotNull(announcements.imageUrl)));
	const chatRows = await tx
		.select({ imageUrl: wgChatMessages.imageUrl })
		.from(wgChatMessages)
		.where(
			and(
				eq(wgChatMessages.wgId, wgId),
				isNotNull(wgChatMessages.imageUrl),
				...(includeDeletedChat ? [] : [isNull(wgChatMessages.deletedAt)]),
			),
		);

	const keys = new Set<string>();
	for (const { imageUrl } of [...expenseRows, ...announcementRows, ...chatRows]) {
		const image = getPrivateImageKeyFromStoredUrl(imageUrl, wgId);
		if (image) keys.add(image.key);
	}
	return keys;
}

export async function assertPrivateImageCanBeAttached(
	tx: DbTransaction,
	wgId: string,
	imageUrl: string | null | undefined,
	previousImageUrl?: string | null,
): Promise<void> {
	const image = getPrivateImageKeyFromStoredUrl(imageUrl, wgId);
	const previous = getPrivateImageKeyFromStoredUrl(previousImageUrl, wgId);
	if (!image || image.key === previous?.key) return;
	const [revocation] = await tx
		.select({ objectKey: privateImageDeletions.objectKey })
		.from(privateImageDeletions)
		.where(eq(privateImageDeletions.objectKey, image.key))
		.limit(1);
	if (revocation) throw new TransactionAbort('image_removed');
}

export async function revokePrivateImageIfUnreferenced(
	tx: DbTransaction,
	wgId: string,
	previousImageUrl: string | null | undefined,
	nextImageUrl: string | null | undefined = null,
): Promise<void> {
	const previous = getPrivateImageKeyFromStoredUrl(previousImageUrl, wgId);
	if (!previous) return;
	const next = getPrivateImageKeyFromStoredUrl(nextImageUrl, wgId);
	if (next?.key === previous.key) return;

	const liveKeys = await getWgPrivateImageKeys(tx, wgId);
	if (liveKeys.has(previous.key)) return;
	await tx.insert(privateImageDeletions).values({ objectKey: previous.key }).onConflictDoNothing();
}

export async function recordWgImageDeletions(tx: DbTransaction, wgId: string): Promise<number> {
	const keys = [...(await getWgPrivateImageKeys(tx, wgId, true))];
	for (let offset = 0; offset < keys.length; offset += 250) {
		const batch = keys.slice(offset, offset + 250);
		await tx
			.insert(privateImageDeletions)
			.values(batch.map((objectKey) => ({ objectKey })))
			.onConflictDoNothing();
	}
	return keys.length;
}

export async function isPrivateImageKeyRevoked(objectKey: string): Promise<boolean> {
	if (!parsePrivateImageKey(objectKey)) return false;
	const [revocation] = await db
		.select({ objectKey: privateImageDeletions.objectKey })
		.from(privateImageDeletions)
		.where(eq(privateImageDeletions.objectKey, objectKey))
		.limit(1);
	return Boolean(revocation);
}

export async function claimPrivateImageCleanupBatch(now = new Date()): Promise<string[]> {
	const eligibleBefore = new Date(now.getTime() - CLEANUP_DELAY_MS);
	const recheckBefore = new Date(now.getTime() - CLEANUP_RECHECK_MS);
	return withTransaction(async (tx) => {
		const rows = await tx
			.select({ objectKey: privateImageDeletions.objectKey })
			.from(privateImageDeletions)
			.where(
				and(
					lte(privateImageDeletions.requestedAt, eligibleBefore),
					or(
						isNull(privateImageDeletions.storageDeletedAt),
						lte(privateImageDeletions.storageDeletedAt, recheckBefore),
					),
				),
			)
			.orderBy(
				asc(sql`${privateImageDeletions.lastAttemptAt} IS NOT NULL`),
				asc(privateImageDeletions.lastAttemptAt),
				asc(privateImageDeletions.requestedAt),
				asc(privateImageDeletions.objectKey),
			)
			.limit(CLEANUP_BATCH_SIZE)
			.for('update', { skipLocked: true });
		const keys = rows.map(({ objectKey }) => objectKey);
		if (keys.length > 0) {
			await tx
				.update(privateImageDeletions)
				.set({ lastAttemptAt: now })
				.where(inArray(privateImageDeletions.objectKey, keys));
		}
		return keys;
	});
}

export async function findLivePrivateImageReferenceKeys(
	objectKeys: readonly string[],
): Promise<Set<string>> {
	const wantedByWg = new Map<string, Set<string>>();
	const referenced = new Set<string>();
	for (const objectKey of objectKeys) {
		const image = parsePrivateImageKey(objectKey);
		if (!image) {
			referenced.add(objectKey);
			continue;
		}
		const wgId = image.wgId.toLowerCase();
		const keys = wantedByWg.get(wgId) ?? new Set<string>();
		keys.add(objectKey);
		wantedByWg.set(wgId, keys);
	}

	await withTransaction(async (tx) => {
		for (const [wgId, wanted] of wantedByWg) {
			const liveKeys = await getWgPrivateImageKeys(tx, wgId);
			for (const key of wanted) {
				if (liveKeys.has(key)) referenced.add(key);
			}
		}
	});
	return referenced;
}

export async function markPrivateImageStorageDeleted(
	objectKeys: readonly string[],
	now = new Date(),
): Promise<void> {
	if (objectKeys.length === 0) return;
	await withTransaction((tx) =>
		tx
			.update(privateImageDeletions)
			.set({ storageDeletedAt: now })
			.where(inArray(privateImageDeletions.objectKey, [...objectKeys])),
	);
}

export async function countPendingPrivateImageDeletions(): Promise<number> {
	return withTransaction(async (tx) => {
		const [row] = await tx
			.select({ count: sql<number>`count(*)::int` })
			.from(privateImageDeletions)
			.where(isNull(privateImageDeletions.storageDeletedAt));
		return row?.count ?? 0;
	});
}
