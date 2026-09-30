import { deleteAuthUser } from '@/core/auth/delete-user';
import { getSupabaseEnv, hasSupabaseEnv } from '@/core/auth/env';
import { retryPendingAccountDeletions } from '@/core/db/account-deletion';
import {
	claimPrivateImageCleanupBatch,
	countPendingPrivateImageDeletions,
	findLivePrivateImageReferenceKeys,
	markPrivateImageStorageDeleted,
} from '@/core/db/private-image-deletions';
import { purgeExpiredIdempotencyResponses } from '@/core/idempotency';
import { verifyCronSecret } from '@/core/infra/cron-auth';
import { logApiError, withCronLogging } from '@/core/infra/observability';
import { removeSupabaseImages } from '@/core/infra/supabase-storage';
import { type NextRequest, NextResponse } from 'next/server';

async function cleanupPrivateImages(): Promise<{
	attempted: number;
	completed: number;
	failed: number;
	skippedReferenced: number;
	pending: number;
	error: string | null;
}> {
	const keys = await claimPrivateImageCleanupBatch();
	const referenced = await findLivePrivateImageReferenceKeys(keys);
	const removable = keys.filter((key) => !referenced.has(key));
	let completed = 0;
	let failed = 0;
	let errorCode: string | null = null;

	if (referenced.size > 0) {
		logApiError(
			'[maintenance] private image deletion found a live reference',
			new Error('private_image_cleanup_live_reference_invariant'),
		);
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
		pending: await countPendingPrivateImageDeletions(),
		error: errorCode ?? (referenced.size > 0 ? 'live_reference_invariant' : null),
	};
}

/** Purges expired replay rows and runs bounded account/image deletion recovery. */
export const GET = withCronLogging(
	'maintenance',
	async (req: NextRequest): Promise<NextResponse> => {
		const secret = process.env.CRON_SECRET;
		if (!secret) {
			return new NextResponse('cron_secret_missing', { status: 503 });
		}
		if (!verifyCronSecret(req.headers.get('authorization'), secret)) {
			return new NextResponse('unauthorized', { status: 401 });
		}

		const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
		const auth = hasSupabaseEnv() && serviceRoleKey ? getSupabaseEnv() : null;
		const deleteAuth =
			auth && serviceRoleKey
				? (authUserId: string) => deleteAuthUser(auth.url, serviceRoleKey, authUserId)
				: null;
		const [purge, deletions, privateImages] = await Promise.allSettled([
			purgeExpiredIdempotencyResponses(),
			retryPendingAccountDeletions(deleteAuth),
			cleanupPrivateImages(),
		]);
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
				(privateImages.value.failed > 0 || privateImages.value.skippedReferenced > 0));
		const ok =
			purge.status === 'fulfilled' &&
			deletions.status === 'fulfilled' &&
			!recoveryPending &&
			!imageCleanupProblem;
		return NextResponse.json(
			{
				ok,
				purgedIdempotencyRows: purge.status === 'fulfilled' ? purge.value : null,
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
