import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { accountDeletions, expensePayments, wgMembers, wgs } from './schema';
import { type DbTransaction, withFreshTransaction, withTransaction } from './transaction';
import { TransactionAbort } from './transaction-abort';

export const ACCOUNT_DELETION_RETRY_BATCH_SIZE = 5;

export type AuthDeletionExecutor = (authUserId: string) => Promise<boolean>;

export type ActiveAccountMember = {
	id: string;
	name: string;
	role: string;
	authUserId: string | null;
	deactivatedAt: Date | null;
};

export async function lockAccount(tx: DbTransaction, authUserId: string): Promise<void> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended('manawg:account-membership:v1:' || ${authUserId}, 0))`,
	);
}

/** Call while holding the WG payment lock before removing the payer's retry identity. */
export async function hasCapturingMemberPayment(
	tx: DbTransaction,
	wgId: string,
	memberId: string,
): Promise<boolean> {
	const [payment] = await tx
		.select({ id: expensePayments.id })
		.from(expensePayments)
		.where(
			and(
				eq(expensePayments.wgId, wgId),
				eq(expensePayments.fromMemberId, memberId),
				eq(expensePayments.status, 'capturing'),
			),
		)
		.limit(1);
	return Boolean(payment);
}

export async function readAccountDeletionStatusWithFreshConnection(authUserId: string) {
	return withFreshTransaction(async (tx) => {
		await lockAccount(tx, authUserId);
		const [deletion] = await tx
			.select({ completedAt: accountDeletions.completedAt })
			.from(accountDeletions)
			.where(eq(accountDeletions.authUserId, authUserId))
			.limit(1);
		return deletion ?? null;
	});
}

export async function assertAccountCanAcquireMembership(
	tx: DbTransaction,
	authUserId: string,
): Promise<void> {
	await lockAccount(tx, authUserId);
	const [deletion] = await tx
		.select({ authUserId: accountDeletions.authUserId })
		.from(accountDeletions)
		.where(eq(accountDeletions.authUserId, authUserId))
		.limit(1);
	if (deletion) throw new TransactionAbort('account_deletion_pending');
}

export async function lockActiveAccountMember(
	tx: DbTransaction,
	wgId: string,
	memberId: string,
	authUserId: string,
): Promise<ActiveAccountMember | null> {
	const [wg] = await tx.select({ id: wgs.id }).from(wgs).where(eq(wgs.id, wgId)).for('update');
	if (!wg) return null;
	const [member] = await tx
		.select({
			id: wgMembers.id,
			name: wgMembers.name,
			role: wgMembers.role,
			authUserId: wgMembers.authUserId,
			deactivatedAt: wgMembers.deactivatedAt,
		})
		.from(wgMembers)
		.where(and(eq(wgMembers.id, memberId), eq(wgMembers.wgId, wgId)))
		.for('update');
	if (!member || member.authUserId !== authUserId || member.deactivatedAt) return null;
	return member;
}

export async function tryCompleteAccountDeletion(
	authUserId: string,
	deleteAuthUser: AuthDeletionExecutor,
): Promise<boolean> {
	try {
		const state = await withTransaction(async (tx) => {
			const [attempt] = await tx
				.update(accountDeletions)
				.set({ lastAttemptAt: new Date() })
				.where(
					and(eq(accountDeletions.authUserId, authUserId), isNull(accountDeletions.completedAt)),
				)
				.returning({ authUserId: accountDeletions.authUserId });
			if (attempt) return 'pending' as const;
			const [record] = await tx
				.select({ completedAt: accountDeletions.completedAt })
				.from(accountDeletions)
				.where(eq(accountDeletions.authUserId, authUserId))
				.limit(1);
			return record?.completedAt ? ('completed' as const) : ('missing' as const);
		});
		if (state === 'completed') return true;
		if (state === 'missing') return false;
	} catch {
		return false;
	}

	let confirmed: boolean;
	try {
		confirmed = await deleteAuthUser(authUserId);
	} catch {
		return false;
	}
	if (!confirmed) return false;

	try {
		await withTransaction((tx) =>
			tx
				.update(accountDeletions)
				.set({ completedAt: sql`coalesce(${accountDeletions.completedAt}, now())` })
				.where(eq(accountDeletions.authUserId, authUserId)),
		);
		const [record] = await withTransaction((tx) =>
			tx
				.select({ completedAt: accountDeletions.completedAt })
				.from(accountDeletions)
				.where(eq(accountDeletions.authUserId, authUserId))
				.limit(1),
		);
		return Boolean(record?.completedAt);
	} catch {
		return false;
	}
}

export async function retryPendingAccountDeletions(
	deleteAuthUser: AuthDeletionExecutor | null,
): Promise<{ attempted: number; completed: number; failed: number; pending: number }> {
	const countPending = async () => {
		const [total] = await withTransaction((tx) =>
			tx
				.select({ count: sql<number>`count(*)::int` })
				.from(accountDeletions)
				.where(isNull(accountDeletions.completedAt)),
		);
		return total?.count ?? 0;
	};
	if (!deleteAuthUser) {
		return { attempted: 0, completed: 0, failed: 0, pending: await countPending() };
	}

	const pending = await withTransaction((tx) =>
		tx
			.select({ authUserId: accountDeletions.authUserId })
			.from(accountDeletions)
			.where(isNull(accountDeletions.completedAt))
			.orderBy(
				sql`${accountDeletions.lastAttemptAt} ASC NULLS FIRST`,
				asc(accountDeletions.requestedAt),
				asc(accountDeletions.authUserId),
			)
			.limit(ACCOUNT_DELETION_RETRY_BATCH_SIZE),
	);
	const results = await Promise.all(
		pending.map(({ authUserId }) => tryCompleteAccountDeletion(authUserId, deleteAuthUser)),
	);
	return {
		attempted: pending.length,
		completed: results.filter(Boolean).length,
		failed: results.filter((completed) => !completed).length,
		pending: await countPending(),
	};
}
