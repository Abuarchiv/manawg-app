import { recordAuditEvent } from '@/core/audit';
import { db, expensePayments, wgMembers } from '@/core/db';
import { lockActiveAccountMember } from '@/core/db/account-deletion';
import {
	badRequest,
	conflict,
	forbidden,
	requireVerifiedMember,
	serverError,
	tooMany,
} from '@/core/errors';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { logApiError } from '@/core/infra/observability';
import {
	type PayPalOrderResponse,
	capturePayPalOrder,
	getPayPalOrder,
	isPayPalConfigured,
} from '@/core/infra/paypal';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { computeNetBalances, simplifyDebts } from '@/features/expenses/debt-reduction';
import { computeBalances } from '@/features/expenses/debts';
import {
	hasCapturingExpensePayment,
	loadCompletedExpensePayments,
	withExpensePaymentLock,
} from '@/features/expenses/expense-payments';
import { loadOpenExpenses } from '@/features/expenses/open-expenses';
import {
	isPayPalCaptureDebtChanged,
	parsePayPalAmountCents,
	terminalPayPalCaptureOutcome,
} from '@/features/expenses/paypal-settlement';
import { and, eq, gt } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const captureSchema = z.object({ orderId: z.string().trim().min(1).max(100) });

export const POST = withWgRoute('paypal capture POST', async (req, { code }) => {
	if (!isPayPalConfigured()) return conflict('paypal_not_configured');

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return badRequest('invalid_json');
	}
	const parsed = captureSchema.safeParse(body);
	if (!parsed.success) return badRequest('order_id_invalid');

	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const verified = requireVerifiedMember(auth.member);
	if (verified) return verified;
	const limited = await checkRateLimit(
		wgWriteLimiter,
		`paypal-capture:${auth.wg.id}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();

	try {
		const [payment] = await db
			.select()
			.from(expensePayments)
			.where(
				and(
					eq(expensePayments.wgId, auth.wg.id),
					eq(expensePayments.providerOrderId, parsed.data.orderId),
				),
			)
			.limit(1);
		if (!payment) return conflict('paypal_order_not_found');
		if (payment.fromMemberId !== auth.member.memberId) {
			return forbidden('not_party_to_debt', 'not_party_to_debt');
		}
		if (payment.status === 'completed') {
			return NextResponse.json({
				status: 'COMPLETED',
				amountCents: payment.amountCents,
				currency: payment.currency,
			});
		}

		const captureState = await withExpensePaymentLock(auth.wg.id, async (tx) => {
			const actor = await lockActiveAccountMember(
				tx,
				auth.wg.id,
				auth.member.memberId,
				auth.authUserId,
			);
			if (!actor) return { kind: 'member_inactive' as const };
			const [current] = await tx
				.select()
				.from(expensePayments)
				.where(and(eq(expensePayments.id, payment.id), eq(expensePayments.wgId, auth.wg.id)))
				.limit(1);
			if (!current) return { kind: 'missing' as const };
			if (current.status === 'completed') return { kind: 'completed' as const, payment: current };
			if (current.providerOrderId.startsWith('pending:')) {
				if (current.status === 'capturing') {
					await tx
						.update(expensePayments)
						.set({ status: 'failed' })
						.where(
							and(eq(expensePayments.id, current.id), eq(expensePayments.status, 'capturing')),
						);
				}
				return { kind: 'unavailable' as const };
			}
			if (current.status === 'capturing') {
				return { kind: 'capture' as const, payment: current, reconcileFirst: true };
			}
			if (current.status !== 'created') return { kind: 'unavailable' as const };

			const now = new Date();
			if (current.expiresAt <= now) {
				await tx
					.update(expensePayments)
					.set({ status: 'failed' })
					.where(and(eq(expensePayments.id, current.id), eq(expensePayments.status, 'created')));
				return { kind: 'expired' as const };
			}
			// ponytail: one unresolved PayPal capture per WG; per-account starts if throughput needs it.
			if (await hasCapturingExpensePayment(tx, auth.wg.id)) return { kind: 'busy' as const };
			const [members, expenses, payments] = await Promise.all([
				tx
					.select({ id: wgMembers.id, name: wgMembers.name, color: wgMembers.color })
					.from(wgMembers)
					.where(eq(wgMembers.wgId, auth.wg.id)),
				loadOpenExpenses(auth.wg.id, tx),
				loadCompletedExpensePayments(auth.wg.id, tx),
			]);
			const debt = simplifyDebts(computeNetBalances(expenses, members, payments)).find(
				(item) =>
					item.fromId === current.fromMemberId &&
					item.toId === current.toMemberId &&
					(item.currency ?? 'EUR') === current.currency,
			);
			if (isPayPalCaptureDebtChanged(debt?.cents, current.amountCents)) {
				await tx
					.update(expensePayments)
					.set({ status: 'failed' })
					.where(and(eq(expensePayments.id, current.id), eq(expensePayments.status, 'created')));
				return { kind: 'debt_changed' as const };
			}
			const directDebt = computeBalances(expenses, payments).find(
				(item) =>
					item.debtorId === current.fromMemberId &&
					item.creditorId === current.toMemberId &&
					item.currency === current.currency,
			);
			if (!directDebt || directDebt.amountCents < current.amountCents) {
				await tx
					.update(expensePayments)
					.set({ status: 'failed' })
					.where(and(eq(expensePayments.id, current.id), eq(expensePayments.status, 'created')));
				return { kind: 'debt_changed' as const };
			}

			const [capturing] = await tx
				.update(expensePayments)
				.set({ status: 'capturing' })
				.where(
					and(
						eq(expensePayments.id, current.id),
						eq(expensePayments.status, 'created'),
						gt(expensePayments.expiresAt, now),
					),
				)
				.returning();
			return capturing
				? { kind: 'capture' as const, payment: capturing, reconcileFirst: false }
				: { kind: 'unavailable' as const };
		});
		if (captureState.kind === 'member_inactive') return forbidden('member_deactivated');
		if (captureState.kind === 'busy') {
			return NextResponse.json(
				{ status: 'PENDING', amountCents: payment.amountCents, currency: payment.currency },
				{ status: 202 },
			);
		}
		if (captureState.kind === 'completed') {
			return NextResponse.json({
				status: 'COMPLETED',
				amountCents: captureState.payment.amountCents,
				currency: captureState.payment.currency,
			});
		}
		if (captureState.kind === 'expired') return conflict('paypal_order_expired');
		if (captureState.kind === 'missing') return conflict('paypal_order_not_found');
		if (captureState.kind === 'unavailable') return conflict('paypal_order_unavailable');
		if (captureState.kind === 'debt_changed') return conflict('debt_changed');
		const capturePayment = captureState.payment;

		let order: PayPalOrderResponse = {};
		let orderSource: 'capture' | 'get' = captureState.reconcileFirst ? 'get' : 'capture';
		const pendingResponse = () =>
			NextResponse.json(
				{
					status: 'PENDING',
					amountCents: capturePayment.amountCents,
					currency: capturePayment.currency,
				},
				{ status: 202 },
			);
		const readProviderOrder = async () => {
			order = await getPayPalOrder(capturePayment.providerOrderId, capturePayment.payeeMerchantId);
			orderSource = 'get';
		};
		const captureProviderOrder = async () => {
			order = await capturePayPalOrder(
				capturePayment.providerOrderId,
				capturePayment.payeeMerchantId,
			);
			orderSource = 'capture';
		};

		if (captureState.reconcileFirst) {
			try {
				await readProviderOrder();
			} catch (statusError) {
				logApiError('[paypal capture] status recovery failed', statusError);
				return pendingResponse();
			}
			if (!order.status || !order.purchase_units) return pendingResponse();
			const hasProviderCapture = order.purchase_units.some(
				(unit) => (unit.payments?.captures?.length ?? 0) > 0,
			);
			if (order.status === 'APPROVED' && !hasProviderCapture) {
				try {
					await captureProviderOrder();
				} catch (captureError) {
					try {
						await readProviderOrder();
					} catch (statusError) {
						logApiError('[paypal capture] status recovery failed', captureError, statusError);
						return pendingResponse();
					}
				}
			}
		} else {
			try {
				await captureProviderOrder();
			} catch (captureError) {
				// The capture response is ambiguous; reconcile the same persisted order.
				try {
					await readProviderOrder();
				} catch (statusError) {
					logApiError('[paypal capture] status recovery failed', captureError, statusError);
					return pendingResponse();
				}
			}
		}

		const hasCompleteCaptureDetails = () => {
			const unit = order.purchase_units?.find((item) =>
				item.payments?.captures?.some((capture) => capture.status === 'COMPLETED'),
			);
			const completedCapture = unit?.payments?.captures?.find(
				(capture) => capture.status === 'COMPLETED',
			);
			return Boolean(
				unit?.payee?.merchant_id &&
					completedCapture?.amount?.value &&
					completedCapture.amount.currency_code,
			);
		};
		const hasProviderCapture = order.purchase_units?.some(
			(unit) => (unit.payments?.captures?.length ?? 0) > 0,
		);
		const hasCompletedCapture = order.purchase_units?.some((unit) =>
			unit.payments?.captures?.some((capture) => capture.status === 'COMPLETED'),
		);
		if (
			orderSource === 'capture' &&
			(!order.status ||
				(order.status === 'COMPLETED' &&
					(!order.purchase_units?.length ||
						!hasProviderCapture ||
						(hasCompletedCapture && !hasCompleteCaptureDetails()))))
		) {
			try {
				await readProviderOrder();
			} catch (statusError) {
				logApiError('[paypal capture] status recovery failed', statusError);
				return pendingResponse();
			}
		}
		if (order.id !== capturePayment.providerOrderId) return pendingResponse();
		const purchaseUnits = order.purchase_units ?? [];
		const captures = purchaseUnits.flatMap((unit) => unit.payments?.captures ?? []);
		const captureUnit = purchaseUnits.find((unit) =>
			unit.payments?.captures?.some((item) => item.status === 'COMPLETED'),
		);
		const capture = captureUnit?.payments?.captures?.find((item) => item.status === 'COMPLETED');
		if (order.status !== 'COMPLETED' || !capture) {
			const terminalOutcome = terminalPayPalCaptureOutcome(
				order.status,
				captures.map((item) => item.status),
			);
			if (!terminalOutcome) {
				return NextResponse.json(
					{
						status: 'PENDING',
						amountCents: capturePayment.amountCents,
						currency: capturePayment.currency,
					},
					{ status: 202 },
				);
			}
			await withExpensePaymentLock(auth.wg.id, (tx) =>
				tx
					.update(expensePayments)
					.set({ status: 'failed' })
					.where(
						and(eq(expensePayments.id, capturePayment.id), eq(expensePayments.status, 'capturing')),
					),
			);
			return NextResponse.json({
				status: terminalOutcome,
				amountCents: capturePayment.amountCents,
				currency: capturePayment.currency,
			});
		}
		const capturedCents = parsePayPalAmountCents(capture.amount?.value);
		if (
			purchaseUnits.length !== 1 ||
			captureUnit?.payee?.merchant_id !== capturePayment.payeeMerchantId ||
			capturedCents !== capturePayment.amountCents ||
			capture.amount?.currency_code !== capturePayment.currency
		) {
			return conflict('paypal_payment_not_completed');
		}

		const completion = await withExpensePaymentLock(auth.wg.id, async (tx) => {
			const [completed] = await tx
				.update(expensePayments)
				.set({ status: 'completed', completedAt: new Date() })
				.where(
					and(eq(expensePayments.id, capturePayment.id), eq(expensePayments.status, 'capturing')),
				)
				.returning({ id: expensePayments.id });
			if (completed) return 'completed' as const;
			const [alreadyCompleted] = await tx
				.select({ status: expensePayments.status })
				.from(expensePayments)
				.where(eq(expensePayments.id, capturePayment.id))
				.limit(1);
			return alreadyCompleted?.status === 'completed' ? 'already_completed' : 'failed';
		});
		if (completion === 'failed') return serverError('paypal_settlement_failed');
		if (completion === 'already_completed') {
			return NextResponse.json({
				status: 'COMPLETED',
				amountCents: capturePayment.amountCents,
				currency: capturePayment.currency,
			});
		}
		try {
			await recordAuditEvent({
				wgId: auth.wg.id,
				memberId: auth.member.memberId,
				eventType: 'expense.debt.paid.paypal',
				entityType: 'expense_payment',
				entityId: capturePayment.id,
				summary: `${auth.member.name} hat ${capturePayment.amountCents / 100} ${capturePayment.currency} per PayPal beglichen.`,
				metadata: {
					fromMemberId: capturePayment.fromMemberId,
					toMemberId: capturePayment.toMemberId,
					amountCents: capturePayment.amountCents,
					providerOrderId: capturePayment.providerOrderId,
				},
			});
		} catch (auditError) {
			logApiError('[paypal capture] audit failed', auditError);
		}

		return NextResponse.json({
			status: 'COMPLETED',
			amountCents: capturePayment.amountCents,
			currency: capturePayment.currency,
		});
	} catch (err) {
		logApiError('[paypal capture]', err);
		return serverError('paypal_capture_failed');
	}
});
