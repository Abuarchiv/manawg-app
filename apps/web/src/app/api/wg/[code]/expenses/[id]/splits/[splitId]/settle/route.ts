import { recordAuditEvent } from '@/core/audit';
import { db, expenseSplits, expenses, wgMembers } from '@/core/db';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import {
	badRequest,
	conflict,
	forbidden,
	notFound,
	tooMany,
	unreadableJsonBody,
} from '@/core/http/api-errors';
import { readJsonLimited } from '@/core/http/read-json';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { computeNetBalances } from '@/features/expenses/debt-reduction';
import {
	hasCapturingExpensePayment,
	loadCompletedExpensePayments,
	withExpensePaymentLock,
} from '@/features/expenses/server/expense-payments';
import { notifySettlement } from '@/features/expenses/server/settle-notify';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export const POST = withWgRoute<{ id: string; splitId: string }>(
	'split settle POST',
	async (req, { code, id, splitId }) => {
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
		if (!UUID_PATTERN.test(splitId)) return badRequest('id_invalid');

		let body: { settled?: unknown };
		try {
			body = (await readJsonLimited(req)) as { settled?: unknown };
		} catch (err) {
			return unreadableJsonBody(err);
		}
		// `null`, arrays and scalars are valid JSON but not a body; without this a
		// literal `null` dereferences below and surfaces as a 500.
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			return badRequest('invalid_body');
		}
		if (body.settled !== undefined && typeof body.settled !== 'boolean') {
			return badRequest('settled_invalid');
		}
		const settled = body.settled ?? true;
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wgId = auth.wg.id;
		const expenseRow = await db
			.select({
				id: expenses.id,
				wgId: expenses.wgId,
				description: expenses.description,
				paidByMemberId: expenses.paidByMemberId,
				currency: expenses.currency,
			})
			.from(expenses)
			.where(and(eq(expenses.id, id), eq(expenses.wgId, wgId)))
			.limit(1);
		const expense = expenseRow[0];
		if (!expense) return notFound('expense_not_found');

		const splitRow = await db
			.select({
				id: expenseSplits.id,
				debtorMemberId: expenseSplits.debtorMemberId,
				expenseId: expenseSplits.expenseId,
				settledAt: expenseSplits.settledAt,
			})
			.from(expenseSplits)
			.where(and(eq(expenseSplits.id, splitId), eq(expenseSplits.expenseId, id)))
			.limit(1);
		const split = splitRow[0];
		if (!split) return notFound('split_not_found');

		// Only the debtor (paying off their share) or the payer (marking that
		// they received the money) may settle. Other WG members cannot flip
		// someone else's debt state.
		const isDebtor = split.debtorMemberId === auth.member.memberId;
		const isPayer = expense.paidByMemberId === auth.member.memberId;
		if (!isDebtor && !isPayer) return forbidden('not_split_party', 'not_split_party');
		const limited = await checkRateLimit(
			wgWriteLimiter,
			`split-settle:${expense.wgId}:${auth.member.memberId}`,
		);
		if (!limited.success) return tooMany();

		// Keep this state predicate in the write as a final stale-toggle guard.
		const change = await withExpensePaymentLock(expense.wgId, async (tx) => {
			const [current] = await tx
				.select({
					splitId: expenseSplits.id,
					debtorMemberId: expenseSplits.debtorMemberId,
					expenseId: expenseSplits.expenseId,
					amountCents: expenseSplits.amountCents,
					settledAt: expenseSplits.settledAt,
					description: expenses.description,
					paidByMemberId: expenses.paidByMemberId,
					currency: expenses.currency,
				})
				.from(expenses)
				.innerJoin(expenseSplits, eq(expenseSplits.expenseId, expenses.id))
				.where(and(eq(expenses.id, id), eq(expenses.wgId, wgId), eq(expenseSplits.id, splitId)))
				.limit(1);
			if (!current) return { kind: 'missing' as const };

			const currentSplit = {
				id: current.splitId,
				debtorMemberId: current.debtorMemberId,
				expenseId: current.expenseId,
				settledAt: current.settledAt,
			};
			const currentIsDebtor = current.debtorMemberId === auth.member.memberId;
			const currentIsPayer = current.paidByMemberId === auth.member.memberId;
			if (!currentIsDebtor && !currentIsPayer) return { kind: 'not_party' as const };
			if ((settled && current.settledAt !== null) || (!settled && current.settledAt === null)) {
				return { kind: 'unchanged' as const, split: currentSplit };
			}
			// Only money in flight blocks; an unpaid 'created' PayPal order must not freeze the whole
			// group for its 3 h TTL (capture re-validates the debt itself).
			if (await hasCapturingExpensePayment(tx, expense.wgId)) return { kind: 'blocked' as const };

			if (settled) {
				// Scans all WG splits under the lock; indexed stored balances would help if this becomes slow.
				// Sequential instead of Promise.all: a transaction has a single connection, and pg
				// deprecates parallel queries on it (removed in pg 9).
				const members = await tx
					.select({ id: wgMembers.id, name: wgMembers.name, color: wgMembers.color })
					.from(wgMembers)
					.where(eq(wgMembers.wgId, expense.wgId));
				const splitRows = await tx
					.select({
						expenseId: expenses.id,
						paidByMemberId: expenses.paidByMemberId,
						currency: expenses.currency,
						splitId: expenseSplits.id,
						debtorMemberId: expenseSplits.debtorMemberId,
						amountCents: expenseSplits.amountCents,
						settledAt: expenseSplits.settledAt,
					})
					.from(expenses)
					.innerJoin(expenseSplits, eq(expenseSplits.expenseId, expenses.id))
					.where(eq(expenses.wgId, expense.wgId));
				const payments = await loadCompletedExpensePayments(expense.wgId, tx);
				const balanceExpenses = splitRows.map((row) => ({
					paidByMemberId: row.paidByMemberId,
					currency: row.currency,
					splits: [
						{
							debtorMemberId: row.debtorMemberId,
							amountCents: row.amountCents,
							settledAt:
								row.settledAt instanceof Date ? row.settledAt.toISOString() : row.settledAt,
						},
					],
				}));
				const currency = current.currency.trim().toUpperCase() || 'EUR';
				const balances = computeNetBalances(balanceExpenses, members, payments);
				const debtorCents =
					balances.find(
						(balance) =>
							balance.memberId === current.debtorMemberId && balance.currency === currency,
					)?.cents ?? 0;
				const payerCents =
					balances.find(
						(balance) =>
							balance.memberId === current.paidByMemberId && balance.currency === currency,
					)?.cents ?? 0;
				if (
					current.amountCents > Math.max(0, -debtorCents) ||
					current.amountCents > Math.max(0, payerCents)
				) {
					return { kind: 'offset' as const };
				}
			}

			const [updated] = await tx
				.update(expenseSplits)
				.set({ settledAt: settled ? new Date() : null })
				.where(
					and(
						eq(expenseSplits.id, splitId),
						eq(expenseSplits.expenseId, id),
						settled ? isNull(expenseSplits.settledAt) : isNotNull(expenseSplits.settledAt),
					),
				)
				.returning();
			if (!updated) return { kind: 'unchanged' as const, split: currentSplit };
			return { kind: 'updated' as const, updated, current };
		});
		if (change.kind === 'blocked') return conflict('paypal_payment_pending');
		if (change.kind === 'offset') return conflict('split_already_offset');
		if (change.kind === 'missing') return notFound('split_not_found');
		if (change.kind === 'not_party') return forbidden('not_split_party', 'not_split_party');
		if (change.kind === 'unchanged') return NextResponse.json({ split: change.split });
		const { updated, current } = change;
		await recordAuditEvent({
			wgId: expense.wgId,
			memberId: auth.member.memberId,
			eventType: settled ? 'expense.split.settled' : 'expense.split.reopened',
			entityType: 'expense_split',
			entityId: splitId,
			summary: settled
				? `${auth.member.name} hat einen Anteil für ${current.description} beglichen.`
				: `${auth.member.name} hat einen Anteil für ${current.description} wieder geöffnet.`,
			metadata: {
				expenseId: current.expenseId,
				description: current.description,
				debtorMemberId: current.debtorMemberId,
				paidByMemberId: current.paidByMemberId,
			},
		});
		if (settled) {
			await notifySettlement({
				wg: auth.wg,
				actor: auth.member,
				otherMemberId: isDebtor ? current.paidByMemberId : current.debtorMemberId,
				amountCents: current.amountCents,
				currency: current.currency,
				direction: isDebtor ? 'paid' : 'received',
			});
		}

		return NextResponse.json({ split: updated });
	},
);
