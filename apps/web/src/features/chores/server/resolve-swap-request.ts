import 'server-only';
import { announcements, db } from '@/core/db';
import { logApiError } from '@/core/infra/observability';
import { and, eq } from 'drizzle-orm';

/**
 * Closes the open Pinnwand swap request of a chore once the question is settled
 * (someone took it over or the chore is gone). Best-effort like the shopping
 * counterpart: a failed update must not fail the chore mutation itself.
 */
export async function resolveChoreSwapRequest(
	wgId: string,
	choreId: string,
	resolvedByMemberId: string,
): Promise<void> {
	try {
		const now = new Date();
		await db
			.update(announcements)
			.set({ status: 'resolved', resolvedAt: now, resolvedByMemberId, updatedAt: now })
			.where(
				and(
					eq(announcements.wgId, wgId),
					eq(announcements.status, 'open'),
					eq(announcements.source, 'chore_swap'),
					eq(announcements.sourcePath, `/putzen?highlight=${encodeURIComponent(choreId)}`),
				),
			);
	} catch (err) {
		logApiError('[chores] swap request resolve failed', err);
	}
}
