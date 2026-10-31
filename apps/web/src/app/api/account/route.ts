import { eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { auditValues } from '@/core/audit-values';
import { SESSION_HINT_COOKIE } from '@/core/auth/cookie-options';
import { deleteAuthUser } from '@/core/auth/delete-user';
import { getSupabaseEnv, hasSupabaseEnv } from '@/core/auth/supabase-env';
import { accountDeletions, auditEvents } from '@/core/db';
import {
	readAccountDeletionStatusWithFreshConnection,
	tryCompleteAccountDeletion,
} from '@/core/db/account-deletion';
import { removeAccountFromWgs } from '@/core/db/delete-account';
import { withTransaction } from '@/core/db/transaction';
import { requireAccount } from '@/core/guards/require-account';
import { serverError, serviceUnavailable } from '@/core/http/api-errors';
import { requestLocale } from '@/core/i18n/request-locale';
import { afterResponse } from '@/core/infra/after-response';
import { logApiError } from '@/core/infra/observability';
import { confirmedRecipientOf, sendAccountDeletedMail } from '@/core/mail/account-deleted';

export { PATCH } from './locale-patch';

const SUPABASE_AUTH_COOKIE = /^sb-[A-Za-z0-9-]+-auth-token(?:\.\d+)?$/;

function acceptedDeletionResponse(
	req: NextRequest,
	completed: boolean,
	deletedWgs?: number,
): NextResponse {
	const response = NextResponse.json(
		{
			status: completed ? 'completed' : 'pending',
			...(deletedWgs === undefined ? {} : { deletedWgs }),
		},
		{ status: completed ? 200 : 202 },
	);
	for (const { name } of req.cookies.getAll()) {
		if (SUPABASE_AUTH_COOKIE.test(name)) {
			response.cookies.set({ name, value: '', maxAge: 0, path: '/' });
			response.cookies.set({ name: SESSION_HINT_COOKIE, value: '', maxAge: 0, path: '/' });
		}
	}
	return response;
}

/** Deletes local access first, then completes the Auth request or leaves it retryable. */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
	const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
	if (!hasSupabaseEnv() || !serviceRoleKey) {
		return serviceUnavailable('account_deletion_unavailable', 'account_deletion_unavailable');
	}
	const account = await requireAccount(req, 'api/account DELETE');
	if (!account.ok) return account.response;
	const user = account.user;

	try {
		const { url } = getSupabaseEnv();
		const local = await withTransaction(async (tx) => {
			const removed = await removeAccountFromWgs(tx, user.id);
			const [deletion] = await tx
				.select({ completedAt: accountDeletions.completedAt })
				.from(accountDeletions)
				.where(eq(accountDeletions.authUserId, user.id))
				.limit(1);
			if (!deletion) throw new Error('account_deletion_fence_missing');

			for (const { wgId, memberId, name, newAdminId, newAdminName } of removed.left) {
				await tx.insert(auditEvents).values(
					auditValues({
						wgId,
						memberId,
						eventType: 'member.account_deletion_requested',
						entityType: 'member',
						entityId: memberId,
						actorName: name,
						metadata: { name, newAdminId, newAdminName },
					}),
				);
			}
			return { deletedWgs: removed.deletedWgIds.length, completedAt: deletion.completedAt };
		});

		const recipient = local.completedAt ? null : await confirmedRecipientOf(user.id);
		const completed =
			Boolean(local.completedAt) ||
			(await tryCompleteAccountDeletion(user.id, (authUserId) =>
				deleteAuthUser(url, serviceRoleKey, authUserId),
			));
		if (completed && !local.completedAt) {
			// The account's stored language, like every other mail; the device's as fallback.
			const locale = recipient?.locale ?? requestLocale(req);
			afterResponse(() => sendAccountDeletedMail(user.id, recipient?.email ?? null, locale));
		}
		return acceptedDeletionResponse(req, completed, local.deletedWgs);
	} catch (err) {
		logApiError('[api/account DELETE] failed', err);
		try {
			const deletion = await readAccountDeletionStatusWithFreshConnection(user.id);
			if (deletion) {
				return acceptedDeletionResponse(req, Boolean(deletion.completedAt));
			}
			return serverError('account_deletion_failed');
		} catch (statusError) {
			logApiError('[api/account DELETE] outcome could not be confirmed', statusError);
			return NextResponse.json(
				{ status: 'unknown', error: 'account_deletion_outcome_unconfirmed' },
				{ status: 503 },
			);
		}
	}
}
