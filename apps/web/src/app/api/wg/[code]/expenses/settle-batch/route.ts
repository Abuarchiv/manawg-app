import { recordAuditEvent } from '@/core/audit';
import { db } from '@/core/db';
import { withIdempotentWrite } from '@/core/db/idempotent-write';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import {
	badRequest,
	conflict,
	forbidden,
	rateLimitResponse,
	unauthorized,
	unreadableJsonBody,
} from '@/core/http/api-errors';
import { readJsonLimited } from '@/core/http/read-json';
import { readIdempotencyKey } from '@/core/idempotency-store';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { withExpensePaymentLock } from '@/features/expenses/server/expense-payments';
import {
	SettlementChangedError,
	loadSettlementSnapshot,
	pairIsInWg,
	settleDebtPair,
	settlementCodec,
} from '@/features/expenses/server/settle-debt';
import { notifySettlement } from '@/features/expenses/server/settle-notify';
import {
	type SettlementConfirmation,
	parseSettlementConfirmation,
	selectSettlementScope,
} from '@/features/expenses/settlement-scope';
import { NextResponse } from 'next/server';

function noStore<T extends NextResponse>(response: T): T {
	response.headers.set('Cache-Control', 'no-store');
	return response;
}

function noStoreJson<T>(body: T, status = 200): NextResponse<T> {
	return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
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

function isParty(authMemberId: string, fromMemberId: string, toMemberId: string): boolean {
	return authMemberId === fromMemberId || authMemberId === toMemberId;
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
		raw = await readJsonLimited(req);
	} catch (err) {
		return unreadableJsonBody(err);
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
	if (!isParty(auth.member.memberId, confirmation.fromMemberId, confirmation.toMemberId)) {
		return forbidden('not_party_to_debt', 'not_party_to_debt');
	}

	let result: Awaited<ReturnType<typeof settleOnce>>;
	try {
		result = await settleOnce(req, auth, confirmation);
	} catch (error) {
		if (error instanceof SettlementChangedError) return conflict('settlement_changed');
		throw error;
	}
	if (result.kind === 'stopped') return result.response;
	if (result.kind === 'replayed') return noStoreJson(result.body, result.status);
	const outcome = result.context;
	if (!outcome || outcome.kind === 'member_deactivated') {
		return unauthorized('member_deactivated', 'member_deactivated');
	}
	if (outcome.kind === 'member_not_in_wg') return badRequest('member_not_in_wg');
	if (outcome.kind === 'blocked') return conflict('paypal_payment_pending');
	if (outcome.kind === 'changed') return conflict('settlement_changed');

	// The claim makes a keyed settlement run once, and a keyless one can only settle splits that
	// were still open, so the audit event is recorded exactly once per settled split.
	if (outcome.settledIds.length > 0) {
		await recordAuditEvent({
			wgId: auth.wg.id,
			memberId: auth.member.memberId,
			eventType: 'expense.debt.settled',
			entityType: 'expense_debt',
			entityId: `${confirmation.fromMemberId}:${confirmation.toMemberId}`,
			summary: `${auth.member.name} hat ${outcome.settledIds.length} offene Anteil${outcome.settledIds.length === 1 ? '' : 'e'} beglichen.`,
			metadata: {
				fromMemberId: confirmation.fromMemberId,
				toMemberId: confirmation.toMemberId,
				splitIds: outcome.settledIds,
			},
		});
		await notifySettlement({
			wg: auth.wg,
			actor: auth.member,
			otherMemberId:
				auth.member.memberId === confirmation.fromMemberId
					? confirmation.toMemberId
					: confirmation.fromMemberId,
			amountCents: outcome.settledCents,
			currency: confirmation.currency,
			direction: auth.member.memberId === confirmation.fromMemberId ? 'paid' : 'received',
		});
	}
	return noStoreJson(result.body, result.status);
});

/**
 * Settle the confirmed splits once per key under the WG's payment lock. A stored response
 * replays before the rate limit, so a retried settlement never counts against it.
 */
function settleOnce(
	req: Request,
	auth: { wg: { id: string }; member: { memberId: string } },
	confirmation: SettlementConfirmation,
) {
	return withIdempotentWrite(
		{
			scope: `settle-batch:${auth.wg.id}:${auth.member.memberId}`,
			key: readIdempotencyKey(req),
			codec: settlementCodec,
			inTransaction: (work) => withExpensePaymentLock(auth.wg.id, work),
			prepare: async () => {
				const limited = rateLimitResponse(
					await checkRateLimit(
						wgWriteLimiter,
						`settle-batch:${auth.wg.id}:${auth.member.memberId}`,
					),
				);
				return limited ? { stop: limited } : { input: undefined };
			},
		},
		(tx) => settleDebtPair(tx, auth.wg.id, auth.member.memberId, confirmation),
	);
}
