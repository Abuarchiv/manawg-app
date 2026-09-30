import { getAuthenticatedUser } from '@/core/auth/server';
import { db, wgMembers } from '@/core/db';
import { assertAccountCanAcquireMembership } from '@/core/db/account-deletion';
import { TransactionAbort, withTransaction } from '@/core/db/transaction';
import { apiError, badRequest, conflict, forbidden, notFound } from '@/core/errors';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { verifyMemberToken } from '@/core/guards/member-token';
import { shareCodeMissResponse } from '@/core/guards/share-code-miss';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { logApiError } from '@/core/infra/observability';
import { MEMBER_ID_HEADER, MEMBER_TOKEN_HEADER } from '@/shared/lib/member-header';
import { and, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

type ClaimResult =
	| { ok: true; member: { id: string; name: string } }
	| {
			ok: false;
			reason: 'account_already_linked' | 'member_already_linked' | 'member_deactivated';
	  };

export const POST = withWgRoute<{ id: string }>('members claim POST', async (req, { code, id }) => {
	if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
	let authUser: Awaited<ReturnType<typeof getAuthenticatedUser>>;
	try {
		authUser = await getAuthenticatedUser(req);
	} catch (err) {
		// A transient Auth outage is retryable, not an unauthenticated caller.
		logApiError('[members claim POST] auth error', err);
		return apiError('db_error', 503);
	}
	if (!authUser) return apiError('auth_required', 401, 'auth_required');
	const user = authUser;

	const wg = await db.query.wgs.findFirst({
		where: (w, { eq }) => eq(w.shareCode, code),
		columns: { id: true },
	});
	if (!wg) return shareCodeMissResponse(user.id, notFound('wg_not_found'));

	const legacyMemberId = req.headers.get(MEMBER_ID_HEADER)?.trim();
	const legacyToken = req.headers.get(MEMBER_TOKEN_HEADER);
	if (legacyMemberId !== id || !verifyMemberToken(wg.id, id, legacyToken)) {
		return forbidden('legacy_proof_required', 'legacy_proof_required');
	}

	let claimed: ClaimResult;
	try {
		claimed = await withTransaction(async (tx): Promise<ClaimResult> => {
			await assertAccountCanAcquireMembership(tx, user.id);
			await tx.execute(sql`select id from wgs where id = ${wg.id} for update`);
			const [member] = await tx
				.select({
					id: wgMembers.id,
					name: wgMembers.name,
					authUserId: wgMembers.authUserId,
					deactivatedAt: wgMembers.deactivatedAt,
				})
				.from(wgMembers)
				.where(and(eq(wgMembers.id, id), eq(wgMembers.wgId, wg.id)))
				.limit(1);
			if (!member) throw new Error('member_not_found');
			if (member.deactivatedAt) return { ok: false, reason: 'member_deactivated' };
			if (member.authUserId === user.id)
				return { ok: true, member: { id: member.id, name: member.name } };
			if (member.authUserId) return { ok: false, reason: 'member_already_linked' };

			const [existingForUser] = await tx
				.select({ id: wgMembers.id })
				.from(wgMembers)
				.where(and(eq(wgMembers.wgId, wg.id), eq(wgMembers.authUserId, user.id)))
				.limit(1);
			if (existingForUser) return { ok: false, reason: 'account_already_linked' };

			const [updated] = await tx
				.update(wgMembers)
				.set({ authUserId: user.id })
				.where(and(eq(wgMembers.id, id), eq(wgMembers.wgId, wg.id)))
				.returning({ id: wgMembers.id, name: wgMembers.name });
			if (!updated) throw new Error('member_claim_failed');
			return { ok: true, member: updated };
		});
	} catch (err) {
		if (err instanceof TransactionAbort && err.code === 'account_deletion_pending') {
			return conflict('account_deletion_pending', 'account_deletion_pending');
		}
		throw err;
	}

	if (claimed.ok) return NextResponse.json({ member: claimed.member });
	if (claimed.reason === 'member_deactivated')
		return conflict('member_deactivated', 'member_deactivated');
	return conflict(claimed.reason, claimed.reason);
});
