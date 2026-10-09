import 'server-only';
import { recordAuditEvent } from '@/core/audit';
import { db, expensePayments, wgMembers } from '@/core/db';
import { logApiError } from '@/core/infra/observability';
import { getPayPalOrder } from '@/core/infra/paypal';
import { formatEuroCents } from '@/core/utils/money';
import { and, asc, eq, lt } from 'drizzle-orm';
import { parsePayPalAmountCents, terminalPayPalCaptureOutcome } from '../paypal-settlement';
import { withExpensePaymentLock } from './expense-payments';

const STALE_CAPTURE_MS = 15 * 60 * 1000;
/** Grace after the order expired before an unapproved `capturing` row is given up. */
const ABANDONED_BUFFER_MS = 60 * 60 * 1000;

/**
 * Resolves stuck `capturing` payments whose payer never finished the flow.
 * While one exists, it blocks expenses and settlement for the whole WG.
 */
export async function reconcileStaleCapturingPayments(
	now = new Date(),
): Promise<{ completed: number; failed: number; pending: number }> {
	const stale = await db
		.select()
		.from(expensePayments)
		.where(
			and(
				eq(expensePayments.status, 'capturing'),
				lt(expensePayments.createdAt, new Date(now.getTime() - STALE_CAPTURE_MS)),
			),
		)
		.orderBy(asc(expensePayments.createdAt))
		.limit(20);
	const result = { completed: 0, failed: 0, pending: 0 };

	for (const payment of stale) {
		const finish = (status: 'completed' | 'failed') =>
			withExpensePaymentLock(payment.wgId, async (tx) => {
				const [updated] = await tx
					.update(expensePayments)
					.set(status === 'completed' ? { status, completedAt: new Date() } : { status })
					.where(and(eq(expensePayments.id, payment.id), eq(expensePayments.status, 'capturing')))
					.returning({ id: expensePayments.id });
				return Boolean(updated);
			});

		if (payment.providerOrderId.startsWith('pending:')) {
			if (await finish('failed')) result.failed += 1;
			continue;
		}

		// An order nobody approved can never complete; without this it blocks the WG forever.
		const abandoned = payment.expiresAt.getTime() + ABANDONED_BUFFER_MS < now.getTime();

		let order: Awaited<ReturnType<typeof getPayPalOrder>>;
		try {
			order = await getPayPalOrder(payment.providerOrderId, payment.payeeMerchantId);
		} catch (err) {
			logApiError('[paypal reconcile] order lookup failed', err);
			if (abandoned && err instanceof Error && err.message.startsWith('paypal_api_404')) {
				if (await finish('failed')) result.failed += 1;
			} else {
				result.pending += 1;
			}
			continue;
		}

		if (order.id !== payment.providerOrderId) {
			logApiError(
				'[paypal reconcile] order identity mismatch',
				new Error(`paypal_order_mismatch:${payment.id}`),
			);
			result.pending += 1;
			continue;
		}

		const units = order.purchase_units ?? [];
		const captures = units.flatMap((unit) => unit.payments?.captures ?? []);
		const captureUnit = units.find((unit) =>
			unit.payments?.captures?.some((item) => item.status === 'COMPLETED'),
		);
		const capture = captureUnit?.payments?.captures?.find((item) => item.status === 'COMPLETED');

		if (order.status !== 'COMPLETED' || !capture) {
			if (
				(terminalPayPalCaptureOutcome(
					order.status,
					captures.map((item) => item.status),
				) ||
					(abandoned && !captures.some((item) => item.status === 'PENDING'))) &&
				(await finish('failed'))
			) {
				result.failed += 1;
			} else {
				result.pending += 1;
			}
			continue;
		}

		const matches =
			units.length === 1 &&
			captureUnit?.payee?.merchant_id === payment.payeeMerchantId &&
			parsePayPalAmountCents(capture.amount?.value) === payment.amountCents &&
			capture.amount?.currency_code === payment.currency;
		if (!matches) {
			// Money arrived at PayPal but does not match the order: check manually.
			logApiError(
				'[paypal reconcile] captured order does not match payment',
				new Error(`paypal_capture_mismatch:${payment.id}`),
			);
			if (await finish('failed')) result.failed += 1;
			continue;
		}

		if (!(await finish('completed'))) continue;
		result.completed += 1;
		try {
			const [payer] = await db
				.select({ name: wgMembers.name })
				.from(wgMembers)
				.where(eq(wgMembers.id, payment.fromMemberId))
				.limit(1);
			await recordAuditEvent({
				wgId: payment.wgId,
				memberId: payment.fromMemberId,
				eventType: 'expense.debt.paid.paypal',
				entityType: 'expense_payment',
				entityId: payment.id,
				summary: `${payer?.name ?? 'Jemand'} hat ${formatEuroCents(payment.amountCents, payment.currency)} per PayPal beglichen.`,
				metadata: {
					fromMemberId: payment.fromMemberId,
					toMemberId: payment.toMemberId,
					amountCents: payment.amountCents,
					providerOrderId: payment.providerOrderId,
				},
			});
		} catch (auditError) {
			logApiError('[paypal reconcile] audit failed', auditError);
		}
	}
	return result;
}
