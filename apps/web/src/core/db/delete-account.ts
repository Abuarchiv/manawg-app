import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { hasCapturingMemberPayment, lockAccount } from './account-deletion';
import { deleteWgCascade } from './delete-wg';
import {
	accountDeletions,
	calendarSubscriptions,
	pushSubscriptions,
	wgMembers,
	wgs,
} from './schema';
import { type DbTransaction, TransactionAbort, lockExpensePayments } from './transaction';

export type LeftWg = { wgId: string; memberId: string; name: string; newAdminId: string | null };

/**
 * Detaches an auth user from every WG before the account is deleted. The
 * member moves out like an "Auszug": history and balances stay with the WG,
 * the login link, push subscriptions and PayPal id are removed, and an admin
 * hands the role to the longest-standing active flatmate (preferring one who
 * can sign in). A WG with no other active member is deleted entirely.
 */
export async function removeAccountFromWgs(
	tx: DbTransaction,
	authUserId: string,
): Promise<{ left: LeftWg[]; deletedWgIds: string[] }> {
	await lockAccount(tx, authUserId);
	const [existingDeletion] = await tx
		.select({ authUserId: accountDeletions.authUserId })
		.from(accountDeletions)
		.where(eq(accountDeletions.authUserId, authUserId))
		.limit(1);
	if (existingDeletion) return { left: [], deletedWgIds: [] };
	await tx.insert(accountDeletions).values({ authUserId });

	const membershipWgs = await tx
		.select({ wgId: wgMembers.wgId })
		.from(wgMembers)
		.where(eq(wgMembers.authUserId, authUserId))
		.orderBy(asc(wgMembers.wgId));
	const wgIds = [...new Set(membershipWgs.map(({ wgId }) => wgId))];
	for (const wgId of wgIds) await lockExpensePayments(tx, wgId);
	if (wgIds.length > 0) {
		await tx
			.select({ id: wgs.id })
			.from(wgs)
			.where(inArray(wgs.id, wgIds))
			.orderBy(asc(wgs.id))
			.for('update');
	}

	const memberships = await tx
		.select({ id: wgMembers.id, wgId: wgMembers.wgId, name: wgMembers.name, role: wgMembers.role })
		.from(wgMembers)
		.where(eq(wgMembers.authUserId, authUserId))
		.orderBy(asc(wgMembers.wgId), asc(wgMembers.id))
		.for('update');
	const left: LeftWg[] = [];
	const deletedWgIds: string[] = [];
	for (const membership of memberships) {
		if (await hasCapturingMemberPayment(tx, membership.wgId, membership.id)) {
			throw new TransactionAbort('paypal_payment_pending');
		}
		const [successor] = await tx
			.select({ id: wgMembers.id })
			.from(wgMembers)
			.where(
				and(
					eq(wgMembers.wgId, membership.wgId),
					ne(wgMembers.id, membership.id),
					isNull(wgMembers.deactivatedAt),
				),
			)
			.orderBy(sql`${wgMembers.authUserId} is null`, asc(wgMembers.createdAt), asc(wgMembers.id))
			.limit(1);
		if (!successor) {
			await deleteWgCascade(tx, membership.wgId);
			deletedWgIds.push(membership.wgId);
			continue;
		}
		await tx.delete(calendarSubscriptions).where(eq(calendarSubscriptions.memberId, membership.id));
		await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.memberId, membership.id));
		await tx
			.update(wgMembers)
			.set({
				authUserId: null,
				role: 'member',
				deactivatedAt: sql`coalesce(${wgMembers.deactivatedAt}, now())`,
				paypalMerchantId: null,
				pushOptIn: false,
			})
			.where(eq(wgMembers.id, membership.id));
		const newAdminId = membership.role === 'admin' ? successor.id : null;
		if (newAdminId) {
			await tx.update(wgMembers).set({ role: 'admin' }).where(eq(wgMembers.id, newAdminId));
		}
		left.push({
			wgId: membership.wgId,
			memberId: membership.id,
			name: membership.name,
			newAdminId,
		});
	}
	return { left, deletedWgIds };
}
