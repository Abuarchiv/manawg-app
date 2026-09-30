import { recordAuditEvent } from '@/core/audit';
import { db, expensePayments, expenseSplits, expenses, wgMembers } from '@/core/db';
import type { DbTransaction } from '@/core/db/transaction';
import {
	apiError,
	badRequest,
	conflict,
	forbidden,
	requireVerifiedMember,
	tooMany,
} from '@/core/errors';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { withIdempotentJsonResponse } from '@/core/guards/idempotency';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { claimIdempotencySlot, readIdempotencyKey } from '@/core/idempotency';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import {
	type ExpensePaymentInput,
	hasActiveExpensePayment,
	withExpensePaymentLock,
} from '@/features/expenses/expense-payments';
import {
	type SettlementConfirmation,
	type SettlementExpenseInput,
	type SettlementMemberInput,
	type SettlementPreview,
	type SettlementSplitInput,
	parseSettlementConfirmation,
	selectSettlementScope,
	settlementScopeMatches,
} from '@/features/expenses/settlement-scope';
import { and, eq, isNull, or } from 'drizzle-orm';
import { NextResponse } from 'next/server';

type SettlementQueryClient = typeof db | DbTransaction;

interface SettlementSnapshot {
	members: SettlementMemberInput[];
	expenses: SettlementExpenseInput[];
	payments: ExpensePaymentInput[];
}

class SettlementChangedError extends Error {
	constructor() {
		super('settlement_changed');
		this.name = 'SettlementChangedError';
	}
}

function noStore<T extends NextResponse>(response: T): T {
	response.headers.set('Cache-Control', 'no-store');
	return response;
}

function noStoreJson<T>(body: T): NextResponse<T> {
	return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

async function loadSettlementSnapshot(
	client: SettlementQueryClient,
	wgId: string,
): Promise<SettlementSnapshot> {
	const [members, expenseRows] = await Promise.all([
		client
			.select({ id: wgMembers.id, name: wgMembers.name, color: wgMembers.color })
			.from(wgMembers)
			.where(eq(wgMembers.wgId, wgId)),
		client
			.select({
				id: expenses.id,
				paidByMemberId: expenses.paidByMemberId,
				currency: expenses.currency,
				occurredAt: expenses.occurredAt,
			})
			.from(expenses)
			.where(eq(expenses.wgId, wgId)),
	]);

	// Splits are joined by WG instead of `inArray(expenseIds)`: one bind
	// parameter per expense would exceed PostgreSQL's 65,535-parameter limit.
	const [splitRows, paymentRows] = await Promise.all([
		expenseRows.length === 0
			? Promise.resolve([] as SettlementSplitInput[])
			: client
					.select({
						id: expenseSplits.id,
						expenseId: expenseSplits.expenseId,
						debtorMemberId: expenseSplits.debtorMemberId,
						amountCents: expenseSplits.amountCents,
						settledAt: expenseSplits.settledAt,
					})
					.from(expenseSplits)
					.innerJoin(expenses, eq(expenseSplits.expenseId, expenses.id))
					.where(eq(expenses.wgId, wgId)),
		client
			.select({
				fromMemberId: expensePayments.fromMemberId,
				toMemberId: expensePayments.toMemberId,
				amountCents: expensePayments.amountCents,
				currency: expensePayments.currency,
			})
			.from(expensePayments)
			.where(and(eq(expensePayments.wgId, wgId), eq(expensePayments.status, 'completed'))),
	]);

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

function validateCurrency(currency: string | null | undefined): string | NextResponse {
	const normalized = currency?.trim().toUpperCase() || 'EUR';
	return /^[A-Z]{3}$/.test(normalized) ? normalized : badRequest('currency_invalid');
}

function validatePair(fromMemberId: string, toMemberId: string): NextResponse | null {
	if (!UUID_PATTERN.test(fromMemberId) || !UUID_PATTERN.test(toMemberId)) {
		return badRequest('member_ids_invalid');
	}
	if (fromMemberId === toMemberId) return badRequest('same_member');
	return null;
}

function pairIsInWg(
	snapshot: SettlementSnapshot,
	fromMemberId: string,
	toMemberId: string,
): boolean {
	const memberIds = new Set(snapshot.members.map((member) => member.id));
	return memberIds.has(fromMemberId) && memberIds.has(toMemberId);
}

function isParty(authMemberId: string, fromMemberId: string, toMemberId: string): boolean {
	return authMemberId === fromMemberId || authMemberId === toMemberId;
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

const getSettlement = withWgRoute('settle-batch GET', async (req, { code }) => {
	const fromMemberId = req.nextUrl.searchParams.get('fromMemberId');
	const toMemberId = req.nextUrl.searchParams.get('toMemberId');
	const currency = validateCurrency(req.nextUrl.searchParams.get('currency'));
	if (!fromMemberId || !toMemberId) return noStore(badRequest('member_ids_invalid'));
	if (currency instanceof NextResponse) return noStore(currency);
	const invalidPair = validatePair(fromMemberId, toMemberId);
	if (invalidPair) return noStore(invalidPair);

	const auth = await requireWgMember(req, code);
	if (!auth.ok) return noStore(auth.response);
	const unverified = requireVerifiedMember(auth.member);
	if (unverified) return noStore(unverified);
	if (!isParty(auth.member.memberId, fromMemberId, toMemberId)) {
		return noStore(forbidden('not_party_to_debt', 'not_party_to_debt'));
	}

	const snapshot = await loadSettlementSnapshot(db, auth.wg.id);
	if (!pairIsInWg(snapshot, fromMemberId, toMemberId)) {
		return noStore(badRequest('member_not_in_wg'));
	}

	return noStoreJson(
		selectSettlementScope(
			snapshot.expenses,
			snapshot.members,
			snapshot.payments,
			fromMemberId,
			toMemberId,
			currency,
		),
	);
});

// Keep the cache policy outside the route ceremony so preamble and caught-error
// responses receive the same no-store header as normal handler responses.
export const GET = async (
	req: Parameters<typeof getSettlement>[0],
	ctx: Parameters<typeof getSettlement>[1],
) => noStore(await getSettlement(req, ctx));

export const POST = withWgRoute('settle-batch POST', async (req, { code }) => {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}

	const parsed = parseSettlementConfirmation(raw);
	if (!parsed.ok) {
		return badRequest(
			parsed.reason === 'required' ? 'settlement_review_required' : 'settlement_review_invalid',
		);
	}
	const confirmation: SettlementConfirmation = parsed.value;
	const invalidPair = validatePair(confirmation.fromMemberId, confirmation.toMemberId);
	if (invalidPair) return invalidPair;

	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const unverified = requireVerifiedMember(auth.member);
	if (unverified) return unverified;
	if (!isParty(auth.member.memberId, confirmation.fromMemberId, confirmation.toMemberId)) {
		return forbidden('not_party_to_debt', 'not_party_to_debt');
	}

	const limited = await checkRateLimit(
		wgWriteLimiter,
		`settle-batch:${auth.wg.id}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();

	return withIdempotentJsonResponse(
		req,
		`settle-batch:${auth.wg.id}:${auth.member.memberId}`,
		async () => {
			let mutation:
				| { kind: 'member_deactivated' }
				| { kind: 'member_not_in_wg' }
				| { kind: 'blocked' }
				| { kind: 'changed' }
				| {
						kind: 'settled';
						preview: SettlementPreview;
						settledIds: string[];
						settledCents: number;
				  } = { kind: 'member_not_in_wg' };
			try {
				mutation = await withExpensePaymentLock(auth.wg.id, async (tx) => {
					const [activeCaller] = await tx
						.select({ id: wgMembers.id })
						.from(wgMembers)
						.where(
							and(
								eq(wgMembers.id, auth.member.memberId),
								eq(wgMembers.wgId, auth.wg.id),
								isNull(wgMembers.deactivatedAt),
							),
						)
						.limit(1)
						.for('update');
					// The row lock is held through the accounting write: a concurrent
					// deactivation either wins before this check or waits until settlement commits.
					if (!activeCaller) return { kind: 'member_deactivated' as const };

					const snapshot = await loadSettlementSnapshot(tx, auth.wg.id);
					if (!pairIsInWg(snapshot, confirmation.fromMemberId, confirmation.toMemberId)) {
						return { kind: 'member_not_in_wg' as const };
					}

					const preview = selectSettlementScope(
						snapshot.expenses,
						snapshot.members,
						snapshot.payments,
						confirmation.fromMemberId,
						confirmation.toMemberId,
						confirmation.currency,
					);
					if (await hasActiveExpensePayment(tx, auth.wg.id)) return { kind: 'blocked' as const };
					if (!settlementScopeMatches(confirmation.expected, preview)) {
						return { kind: 'changed' as const };
					}
					if (preview.splits.length === 0) {
						return { kind: 'settled' as const, preview, settledIds: [], settledCents: 0 };
					}

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
					const settledIds = preview.splits
						.map((split) => split.id)
						.filter((id) => returnedIds.has(id));
					return {
						kind: 'settled' as const,
						preview,
						settledIds,
						settledCents: preview.settleableCents,
					};
				});
			} catch (error) {
				if (error instanceof SettlementChangedError) return conflict('settlement_changed');
				throw error;
			}

			if (mutation.kind === 'member_deactivated') {
				return apiError('member_deactivated', 401, 'member_deactivated');
			}
			if (mutation.kind === 'member_not_in_wg') return badRequest('member_not_in_wg');
			if (mutation.kind === 'blocked') return conflict('paypal_payment_pending');
			if (mutation.kind === 'changed') return conflict('settlement_changed');

			if (mutation.settledIds.length > 0) {
				const idemKey =
					readIdempotencyKey(req) ??
					`derived:settle:${confirmation.fromMemberId}:${confirmation.toMemberId}:${[...mutation.settledIds].sort().join(',')}`;
				const shouldAudit = await claimIdempotencySlot(
					`settle-batch:${auth.wg.id}:${auth.member.memberId}`,
					idemKey,
				);
				if (shouldAudit) {
					await recordAuditEvent({
						wgId: auth.wg.id,
						memberId: auth.member.memberId,
						eventType: 'expense.debt.settled',
						entityType: 'expense_debt',
						entityId: `${confirmation.fromMemberId}:${confirmation.toMemberId}`,
						summary: `${auth.member.name} hat ${mutation.settledIds.length} offene Anteil${mutation.settledIds.length === 1 ? '' : 'e'} beglichen.`,
						metadata: {
							fromMemberId: confirmation.fromMemberId,
							toMemberId: confirmation.toMemberId,
							splitIds: mutation.settledIds,
						},
					});
				}
			}

			return noStoreJson(
				buildSettlementResponse(
					mutation.preview,
					mutation.settledIds,
					mutation.settledCents,
					confirmation.currency,
					confirmation.fromMemberId,
					confirmation.toMemberId,
				),
			);
		},
	);
});
