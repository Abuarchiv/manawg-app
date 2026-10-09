import 'server-only';
import { type db, expensePayments, expenseSplits, expenses, wgMembers } from '@/core/db';
import { type WriteOutcome, responseCodec } from '@/core/db/idempotent-write';
import type { DbTransaction } from '@/core/db/transaction';
import { HTTP } from '@/core/http/api-errors';
import type { ExpensePaymentInput } from '@/features/expenses/expense-payment-input';
import { hasCapturingExpensePayment } from '@/features/expenses/server/expense-payments';
import {
	type SettlementConfirmation,
	type SettlementExpenseInput,
	type SettlementMemberInput,
	type SettlementPreview,
	type SettlementSplitInput,
	selectSettlementScope,
	settlementScopeMatches,
} from '@/features/expenses/settlement-scope';
import { and, eq, isNull, or } from 'drizzle-orm';

/** Loading, checking and writing a reviewed debt settlement between two members. */

type SettlementQueryClient = typeof db | DbTransaction;

interface SettlementSnapshot {
	members: SettlementMemberInput[];
	expenses: SettlementExpenseInput[];
	payments: ExpensePaymentInput[];
}

export class SettlementChangedError extends Error {
	constructor() {
		super('settlement_changed');
		this.name = 'SettlementChangedError';
	}
}

export async function loadSettlementSnapshot(
	client: SettlementQueryClient,
	wgId: string,
): Promise<SettlementSnapshot> {
	// Sequential instead of Promise.all: a transaction has a single connection, and pg
	// deprecates parallel queries on it (removed in pg 9).
	const members = await client
		.select({ id: wgMembers.id, name: wgMembers.name, color: wgMembers.color })
		.from(wgMembers)
		.where(eq(wgMembers.wgId, wgId));
	const expenseRows = await client
		.select({
			id: expenses.id,
			paidByMemberId: expenses.paidByMemberId,
			currency: expenses.currency,
			occurredAt: expenses.occurredAt,
		})
		.from(expenses)
		.where(eq(expenses.wgId, wgId));

	// Splits are joined by WG instead of `inArray(expenseIds)`: one bind
	// parameter per expense would exceed PostgreSQL's 65,535-parameter limit.
	const splitRows: SettlementSplitInput[] =
		expenseRows.length === 0
			? []
			: await client
					.select({
						id: expenseSplits.id,
						expenseId: expenseSplits.expenseId,
						debtorMemberId: expenseSplits.debtorMemberId,
						amountCents: expenseSplits.amountCents,
						settledAt: expenseSplits.settledAt,
					})
					.from(expenseSplits)
					.innerJoin(expenses, eq(expenseSplits.expenseId, expenses.id))
					.where(eq(expenses.wgId, wgId));
	const paymentRows = await client
		.select({
			fromMemberId: expensePayments.fromMemberId,
			toMemberId: expensePayments.toMemberId,
			amountCents: expensePayments.amountCents,
			currency: expensePayments.currency,
		})
		.from(expensePayments)
		.where(and(eq(expensePayments.wgId, wgId), eq(expensePayments.status, 'completed')));

	const splitsByExpense = new Map<string, SettlementSplitInput[]>();
	for (const split of splitRows) {
		const list = splitsByExpense.get(split.expenseId) ?? [];
		list.push(split);
		splitsByExpense.set(split.expenseId, list);
	}

	return {
		members,
		payments: paymentRows,
		expenses: expenseRows.map((expense) => ({
			...expense,
			splits: splitsByExpense.get(expense.id) ?? [],
		})),
	};
}

export function pairIsInWg(
	snapshot: SettlementSnapshot,
	fromMemberId: string,
	toMemberId: string,
): boolean {
	const memberIds = new Set(snapshot.members.map((member) => member.id));
	return memberIds.has(fromMemberId) && memberIds.has(toMemberId);
}

interface SettlementResponse {
	currency: string;
	settled: number;
	settledIds: string[];
	settledCents: number;
	remainingCents: number;
	creditor: string;
	debtor: string;
	reason?: 'no_direct_splits';
}

function buildSettlementResponse(
	preview: SettlementPreview,
	settledIds: string[],
	settledCents: number,
	currency: string,
	fromMemberId: string,
	toMemberId: string,
): SettlementResponse {
	return {
		settled: settledIds.length,
		settledIds,
		settledCents,
		currency,
		remainingCents: Math.max(0, preview.netCents - settledCents),
		creditor: toMemberId,
		debtor: fromMemberId,
		...(preview.reason ? { reason: preview.reason } : {}),
	};
}

type SettlementOutcome =
	| { kind: 'member_deactivated' }
	| { kind: 'member_not_in_wg' }
	| { kind: 'blocked' }
	| { kind: 'changed' }
	| { kind: 'settled'; settledIds: string[]; settledCents: number };

export const settlementCodec = responseCodec();

/** Rejections are answered by the route and not stored, so the same key can run again. */
function rejected(
	kind: Exclude<SettlementOutcome['kind'], 'settled'>,
): WriteOutcome<unknown, SettlementOutcome> {
	const status =
		kind === 'member_deactivated'
			? HTTP.UNAUTHORIZED
			: kind === 'member_not_in_wg'
				? HTTP.BAD_REQUEST
				: HTTP.CONFLICT;
	return { status, body: null, context: { kind } };
}

/**
 * Settle the confirmed splits; run it under the WG's payment lock. The caller's member row stays
 * locked through the accounting write: a concurrent deactivation either wins before the check or
 * waits until the settlement commits.
 */
export async function settleDebtPair(
	tx: DbTransaction,
	wgId: string,
	callerId: string,
	confirmation: SettlementConfirmation,
): Promise<WriteOutcome<unknown, SettlementOutcome>> {
	const [activeCaller] = await tx
		.select({ id: wgMembers.id })
		.from(wgMembers)
		.where(
			and(eq(wgMembers.id, callerId), eq(wgMembers.wgId, wgId), isNull(wgMembers.deactivatedAt)),
		)
		.limit(1)
		.for('update');
	if (!activeCaller) return rejected('member_deactivated');

	const snapshot = await loadSettlementSnapshot(tx, wgId);
	if (!pairIsInWg(snapshot, confirmation.fromMemberId, confirmation.toMemberId)) {
		return rejected('member_not_in_wg');
	}

	const preview = selectSettlementScope(
		snapshot.expenses,
		snapshot.members,
		snapshot.payments,
		confirmation.fromMemberId,
		confirmation.toMemberId,
		confirmation.currency,
	);
	if (await hasCapturingExpensePayment(tx, wgId)) return rejected('blocked');
	if (!settlementScopeMatches(confirmation.expected, preview)) return rejected('changed');

	let settledIds: string[] = [];
	let settledCents = 0;
	if (preview.splits.length > 0) {
		const exactRows = preview.splits.map((split) =>
			and(
				eq(expenseSplits.id, split.id),
				eq(expenseSplits.expenseId, split.expenseId),
				eq(expenseSplits.amountCents, split.amountCents),
				isNull(expenseSplits.settledAt),
			),
		);
		const rows = await tx
			.update(expenseSplits)
			.set({ settledAt: new Date() })
			.where(or(...exactRows))
			.returning({ id: expenseSplits.id });
		if (rows.length !== preview.splits.length) throw new SettlementChangedError();

		const returnedIds = new Set(rows.map((row) => row.id));
		settledIds = preview.splits.map((split) => split.id).filter((id) => returnedIds.has(id));
		settledCents = preview.settleableCents;
	}
	return {
		status: 200,
		body: buildSettlementResponse(
			preview,
			settledIds,
			settledCents,
			confirmation.currency,
			confirmation.fromMemberId,
			confirmation.toMemberId,
		),
		context: { kind: 'settled', settledIds, settledCents },
	};
}
