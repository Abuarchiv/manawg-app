import 'server-only';

import { asc } from 'drizzle-orm';
import { db } from '@/core/db';
import { wgs } from '@/core/db/schema';
import { logApiError } from '@/core/infra/observability';
import type { StoredImageObject } from '@/core/infra/supabase-storage';
import { listSupabaseImageFolders, listSupabaseImageObjects } from '@/core/infra/supabase-storage';
import { MS_PER_DAY } from '@/core/utils/time';
import { selectOrphanKeys } from './orphan-upload-selection';
import {
	dequeueImageDeletions,
	findQueuedImageDeletionKeys,
	findWgReferencedImageKeys,
	queueImageDeletions,
} from './private-image-deletions';

const PURPOSES = ['expense', 'announcement', 'chat'] as const;
const WGS_PER_RUN = 10;

const UUID_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The daily slice of `ids`: a few at a time, stepping through the list so every id is reached. */
function dailyBatch<T>(ids: readonly T[], now: Date): T[] {
	if (ids.length === 0) return [];
	const start = (Math.floor(now.getTime() / MS_PER_DAY) * WGS_PER_RUN) % ids.length;
	return Array.from(
		{ length: Math.min(WGS_PER_RUN, ids.length) },
		(_, index) => ids[(start + index) % ids.length] as T,
	);
}

/** Queues the unreferenced pictures of one WG folder; returns how many stay queued. */
async function sweepWgFolder(wgId: string, now: Date): Promise<number> {
	const objects: StoredImageObject[] = [];
	for (const purpose of PURPOSES) {
		objects.push(...(await listSupabaseImageObjects(`manawg/${wgId}/${purpose}`)));
	}
	if (objects.length === 0) return 0;
	const referenced = await findWgReferencedImageKeys(wgId);
	const alreadyQueued = await findQueuedImageDeletionKeys(objects.map(({ key }) => key));
	const orphans = selectOrphanKeys(objects, referenced, alreadyQueued, now);
	if (orphans.length === 0) return 0;
	await queueImageDeletions(orphans);
	// A picture attached while the sweep was deciding is live now; queued, it would read as
	// removed, so it comes off the queue again.
	// Retried once; if both tries fail, the cleanup cron's own live-reference check dequeues it.
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			const attachedMeanwhile = await findWgReferencedImageKeys(wgId);
			const rescued = orphans.filter((key) => attachedMeanwhile.has(key));
			await dequeueImageDeletions(rescued);
			return orphans.length - rescued.length;
		} catch (err) {
			logApiError(`[orphan-uploads] rescue after queueing failed (attempt ${attempt})`, err);
		}
	}
	return orphans.length;
}

/**
 * Queues uploaded pictures no row points at for deletion: a visitor picked a picture and then
 * dropped the form. Queued keys cannot be attached any more, and the regular cleanup removes them
 * after a final reference check, so a picture attached meanwhile is never lost. A run looks at a
 * few WGs and the next run (the cron runs daily) at the following ones, stepping through the
 * WG list by the batch size so every WG is reached however many there are. Folders of deleted
 * WGs hold only abandoned uploads and are swept the same way.
 */
export async function sweepOrphanUploads(now = new Date()): Promise<{
	wgsChecked: number;
	queued: number;
}> {
	const rows = await db.select({ id: wgs.id }).from(wgs).orderBy(asc(wgs.id));
	const existing = new Set(rows.map((row) => row.id));
	const goneFolders = (await listSupabaseImageFolders('manawg'))
		.filter((name) => UUID_FOLDER.test(name) && !existing.has(name))
		.sort();
	const batch = [
		...dailyBatch(
			rows.map((row) => row.id),
			now,
		),
		...dailyBatch(goneFolders, now),
	];

	let queuedTotal = 0;
	for (const wgId of batch) {
		// One broken folder must not stop the sweep of the others.
		try {
			queuedTotal += await sweepWgFolder(wgId, now);
		} catch (err) {
			logApiError('[orphan-uploads] sweeping a WG folder failed', err);
		}
	}
	return { wgsChecked: batch.length, queued: queuedTotal };
}
