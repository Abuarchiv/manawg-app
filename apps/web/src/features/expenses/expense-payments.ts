import { db, expensePayments } from '@/core/db';
import { type DbTransaction, lockExpensePayments, withTransaction } from '@/core/db/transaction';
import { and, eq, gt, or } from 'drizzle-orm';

export const PAYPAL_ORDER_TTL_MS = 3 * 60 * 60 * 1000;

export interface ExpensePaymentInput {
	fromMemberId: string;
	toMemberId: string;
	amountCents: number;
	currency: string;
}

export async function loadCompletedExpensePayments(
	wgId: string,
	client: typeof db | DbTransaction = db,
): Promise<ExpensePaymentInput[]> {
	return client
		.select({
			fromMemberId: expensePayments.fromMemberId,
			toMemberId: expensePayments.toMemberId,
			amountCents: expensePayments.amountCents,
			currency: expensePayments.currency,
		})
		.from(expensePayments)
		.where(and(eq(expensePayments.wgId, wgId), eq(expensePayments.status, 'completed')));
}

export function activeExpensePaymentCondition(wgId: string, now = new Date()) {
	return and(
		eq(expensePayments.wgId, wgId),
		or(
			eq(expensePayments.status, 'capturing'),
			and(eq(expensePayments.status, 'created'), gt(expensePayments.expiresAt, now)),
		),
	);
}

export async function hasActiveExpensePayment(
	tx: DbTransaction,
	wgId: string,
	now = new Date(),
): Promise<boolean> {
	const rows = await tx
		.select({ id: expensePayments.id })
		.from(expensePayments)
		.where(activeExpensePaymentCondition(wgId, now))
		.limit(1);
	return rows.length > 0;
}

export async function hasCapturingExpensePayment(
	tx: DbTransaction,
	wgId: string,
): Promise<boolean> {
	const rows = await tx
		.select({ id: expensePayments.id })
		.from(expensePayments)
		.where(and(eq(expensePayments.wgId, wgId), eq(expensePayments.status, 'capturing')))
		.limit(1);
	return rows.length > 0;
}

export async function withExpensePaymentLock<T>(
	wgId: string,
	fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
	return withTransaction(async (tx) => {
		// All expense, split, and payment writers use this lock before their
		// accounting transaction.
		//
		// wgId is always a DB UUID here — every caller resolves it from a WG
		// row selected by share code (see app/api/wg/[code]/*/route.ts) or
		// from a `wgs.id` column. It is never a raw URL parameter, so the
		// advisory lock key is safe from injection and collisions.
		await lockExpensePayments(tx, wgId);
		return fn(tx);
	});
}
