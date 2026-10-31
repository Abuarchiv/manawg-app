import { type NextRequest, NextResponse } from 'next/server';
import { deleteAuthUser } from '@/core/auth/delete-user';
import { getSupabaseEnv, hasSupabaseEnv } from '@/core/auth/supabase-env';
import { retryPendingAccountDeletions } from '@/core/db/account-deletion';
import { sweepOrphanUploads } from '@/core/db/orphan-uploads';
import {
	CLEANUP_BATCH_SIZE,
	claimPrivateImageCleanupBatch,
	countPendingPrivateImageDeletions,
	dequeueImageDeletions,
	findLivePrivateImageReferenceKeys,
	markPrivateImageStorageDeleted,
	purgeFinishedPrivateImageDeletions,
} from '@/core/db/private-image-deletions';
import { purgeExpiredIdempotencyResponses } from '@/core/idempotency-store';
import { requireCronSecret } from '@/core/infra/cron-auth';
import { logApiError, withCronLogging } from '@/core/infra/observability';
import { removeSupabaseImages } from '@/core/infra/supabase-storage';
import { confirmedRecipientOf, sendAccountDeletedMail } from '@/core/mail/account-deleted';
import { purgeOldMailLog } from '@/core/mail/mail-retention';
import { DEFAULT_LOCALE } from '@/shared/i18n/locale';

export const maxDuration = 60;

type ImageCleanupPass = {
	attempted: number;
	completed: number;
	failed: number;
	skippedReferenced: number;
	rescued: number;
	error: string | null;
};

/** Processes one claimed batch; a set `error` means the batch did not finish cleanly. */
async function cleanupPrivateImageBatch(keys: string[]): Promise<ImageCleanupPass> {
	const referenced = await findLivePrivateImageReferenceKeys(keys);
	const removable = keys.filter((key) => !referenced.has(key));
	let completed = 0;
	let failed = 0;
	let errorCode: string | null = null;

	let rescued = 0;
	if (referenced.size > 0) {
		// A row points at the picture, so it stays: a draft attached while the orphan sweep
		// queued it comes back off the queue instead of reading as removed.
		logApiError(
			'[maintenance] private image deletion found a live reference',
			new Error('private_image_cleanup_live_reference_rescued'),
		);
		try {
			await dequeueImageDeletions([...referenced]);
			rescued = referenced.size;
		} catch (err) {
			errorCode = 'live_reference_rescue_failed';
			logApiError('[maintenance] rescuing a live private image failed', err);
		}
	}
	if (removable.length > 0) {
		try {
			await removeSupabaseImages(removable);
		} catch (err) {
			failed = removable.length;
			errorCode = 'storage_remove_failed';
			logApiError('[maintenance] private image storage removal failed', err);
		}
		if (errorCode === null) {
			try {
				await markPrivateImageStorageDeleted(removable);
				completed = removable.length;
			} catch (err) {
				failed = removable.length;
				errorCode = 'cleanup_record_update_failed';
				logApiError('[maintenance] private image cleanup record update failed', err);
			}
		}
	}
	return {
		attempted: keys.length,
		completed,
		failed,
		skippedReferenced: referenced.size,
		rescued,
		error: errorCode,
	};
}

const IMAGE_CLEANUP_BUDGET_MS = 40_000;

/**
 * Drains the due deletion queue in batches within a time budget. It stops on a short batch
 * (queue empty) and on the first error, so rows that keep failing are not claimed again.
 */
async function cleanupPrivateImages(): Promise<ImageCleanupPass & { pending: number }> {
	const startedAt = Date.now();
	const total: ImageCleanupPass = {
		attempted: 0,
		completed: 0,
		failed: 0,
		skippedReferenced: 0,
		rescued: 0,
		error: null,
	};
	do {
		const keys = await claimPrivateImageCleanupBatch();
		const pass = await cleanupPrivateImageBatch(keys);
		total.attempted += pass.attempted;
		total.completed += pass.completed;
		total.failed += pass.failed;
		total.skippedReferenced += pass.skippedReferenced;
		total.rescued += pass.rescued;
		total.error = pass.error;
		if (pass.error !== null || keys.length < CLEANUP_BATCH_SIZE) break;
	} while (Date.now() - startedAt < IMAGE_CLEANUP_BUDGET_MS);
	return { ...total, pending: await countPendingPrivateImageDeletions() };
}

/** Without a configured bucket there is nothing to sweep. */
async function sweepOrphans(): Promise<{ wgsChecked: number; queued: number } | null> {
	return process.env.SUPABASE_STORAGE_BUCKET?.trim() ? sweepOrphanUploads() : null;
}

/** Drops old ledger rows (finished image tombstones, mail log); failures only get logged. */
async function purgeRetention(): Promise<void> {
	const results = await Promise.allSettled([
		purgeFinishedPrivateImageDeletions(),
		purgeOldMailLog(),
	]);
	for (const result of results) {
		if (result.status === 'rejected')
			logApiError('[maintenance] retention purge failed', result.reason);
	}
}

/**
 * Purges expired replay rows, runs bounded account/image deletion recovery
 * and hands the admin role to a member with an account in WGs that lack one.
 */
export const GET = withCronLogging(
	'maintenance',
	async (req: NextRequest): Promise<NextResponse> => {
		const denied = requireCronSecret(req);
		if (denied) return denied;

		const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
		const auth = hasSupabaseEnv() && serviceRoleKey ? getSupabaseEnv() : null;
		const deleteAuth =
			auth && serviceRoleKey
				? async (authUserId: string) => {
						// Read the address first; after the Auth delete it is gone. The mail (E10) follows a confirmed delete.
						// The member rows are gone by now, so the account metadata is the only language left.
						const recipient = await confirmedRecipientOf(authUserId);
						const confirmed = await deleteAuthUser(auth.url, serviceRoleKey, authUserId);
						if (confirmed)
							await sendAccountDeletedMail(
								authUserId,
								recipient?.email ?? null,
								recipient?.locale ?? DEFAULT_LOCALE,
							);
						return confirmed;
					}
				: null;
		const [purge, deletions, privateImages, orphans] = await Promise.allSettled([
			purgeExpiredIdempotencyResponses(),

			retryPendingAccountDeletions(deleteAuth),
			cleanupPrivateImages(),
			sweepOrphans(),
		]);
		await purgeRetention();
		if (orphans.status === 'rejected')
			logApiError('[maintenance] orphan upload sweep failed', orphans.reason);
		if (purge.status === 'rejected')
			logApiError('[maintenance] idempotency cleanup failed', purge.reason);
		if (deletions.status === 'rejected') {
			logApiError('[maintenance] account deletion recovery failed', deletions.reason);
		}
		if (privateImages.status === 'rejected') {
			logApiError('[maintenance] private image cleanup failed', privateImages.reason);
		}
		const recoveryPending =
			deletions.status === 'fulfilled' &&
			(!deleteAuth ? deletions.value.pending > 0 : deletions.value.failed > 0);
		const imageCleanupProblem =
			privateImages.status === 'rejected' ||
			(privateImages.status === 'fulfilled' &&
				(privateImages.value.failed > 0 ||
					privateImages.value.skippedReferenced > privateImages.value.rescued));
		const ok =
			purge.status === 'fulfilled' &&
			deletions.status === 'fulfilled' &&
			orphans.status === 'fulfilled' &&
			!recoveryPending &&
			!imageCleanupProblem;
		return NextResponse.json(
			{
				ok,
				purgedIdempotencyRows: purge.status === 'fulfilled' ? purge.value : null,
				orphanUploads: orphans.status === 'fulfilled' ? orphans.value : null,
				accountDeletions:
					deletions.status === 'fulfilled'
						? { ...deletions.value, authAdminAvailable: Boolean(deleteAuth) }
						: {
								attempted: 0,
								completed: 0,
								failed: 0,
								pending: null,
								authAdminAvailable: Boolean(deleteAuth),
							},
				privateImageCleanup:
					privateImages.status === 'fulfilled'
						? privateImages.value
						: {
								attempted: 0,
								completed: 0,
								failed: 0,
								skippedReferenced: 0,
								pending: null,
								error: 'cleanup_unavailable',
							},
			},
			{ status: ok ? 200 : 503 },
		);
	},
);
