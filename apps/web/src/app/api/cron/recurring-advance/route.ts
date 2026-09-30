import { recordAuditEvent } from '@/core/audit';
import { db, expenseSplits, expenses, recurringExpenses, wgs } from '@/core/db';
import { TransactionAbort } from '@/core/db/transaction';
import { verifyCronSecret } from '@/core/infra/cron-auth';
import { logApiError } from '@/core/infra/observability';
import { withCronLogging } from '@/core/infra/observability';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import { withExpensePaymentLock } from '@/features/expenses/expense-payments';
import {
	type RecurringSplit,
	addMonthsFromAnchor,
	parseRecurringSplits,
	recurringSplitsMatchAmount,
} from '@/features/expenses/recurring-expenses';
import { settledAtForOwnShare } from '@/features/expenses/split-math';
import { and, eq, isNull, lte } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

interface DueRecurring {
	id: string;
	wgId: string;
	paidByMemberId: string;
	description: string;
	amountCents: number;
	intervalMonths: number;
	nextDueAt: Date;
	anchorAt: Date | null;
	splitsJson: string;
	wgName: string;
	shareCode: string;
}

interface CreatedAdvance {
	template: DueRecurring;
	expenseId: string;
}

async function createExpenseForDueAt(
	template: DueRecurring,
	splits: RecurringSplit[],
	dueAt: Date,
): Promise<string | 'duplicate' | null> {
	try {
		// The expense and its splits are one fact and are written in one
		// transaction. This used to be two statements with a compensating
		// delete, but that delete is itself a database call: when it failed the
		// orphaned expense stayed behind and skewed the balances of a WG that
		// nobody was watching, because the cron runs unattended.
		return await withExpensePaymentLock(template.wgId, async (tx) => {
			const [inserted] = await tx
				.insert(expenses)
				.values({
					wgId: template.wgId,
					paidByMemberId: template.paidByMemberId,
					amountCents: template.amountCents,
					currency: 'EUR',
					description: template.description,
					recurringExpenseId: template.id,
					recurringDueAt: dueAt,
					occurredAt: dueAt,
				})
				.returning({ id: expenses.id });
			if (!inserted) throw new TransactionAbort('insert_failed');

			await tx.insert(expenseSplits).values(
				splits.map((split: RecurringSplit) => ({
					expenseId: inserted.id,
					debtorMemberId: split.debtorMemberId,
					amountCents: split.amountCents,
					settledAt: settledAtForOwnShare(split.debtorMemberId, template.paidByMemberId),
				})),
			);

			return inserted.id;
		});
	} catch (err) {
		if (err instanceof TransactionAbort) return null;
		// Unique (recurring_expense_id, recurring_due_at) ⇒ already advanced for this window.
		const code =
			err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : null;
		if (code === '23505') return 'duplicate';
		logApiError('[cron/recurring-advance] insert failed', err);
		return null;
	}
}

async function advanceTemplate(template: DueRecurring): Promise<CreatedAdvance[]> {
	const splits = parseRecurringSplits(template.splitsJson);
	if (!recurringSplitsMatchAmount(splits, template.amountCents)) return [];

	const now = new Date();
	const intervalMonths = Math.max(1, Math.floor(template.intervalMonths));
	// Anchor day keeps month-end due dates from drifting (31. → 28.02 → 31.03).
	// Legacy rows adopt their current nextDueAt as anchor on first advance.
	const anchorDay = (template.anchorAt ?? template.nextDueAt).getUTCDate();
	const created: CreatedAdvance[] = [];
	let dueAt = template.nextDueAt;
	let nextDueAt = dueAt;
	let shouldUpdateTemplate = false;

	while (dueAt <= now) {
		const followingDueAt = addMonthsFromAnchor(dueAt, anchorDay, intervalMonths);
		const expenseId = await createExpenseForDueAt(template, splits, dueAt);
		if (expenseId === null) break;

		shouldUpdateTemplate = true;
		nextDueAt = followingDueAt;
		if (expenseId !== 'duplicate') {
			created.push({ template, expenseId });
		}
		dueAt = followingDueAt;
	}

	if (shouldUpdateTemplate) {
		await db
			.update(recurringExpenses)
			.set({
				nextDueAt,
				lastCreatedAt: now,
				updatedAt: now,
				// Legacy rows adopt the PRE-advance due date as anchor (same as
				// buildRecurringAdvance). Storing `nextDueAt` here would freeze the
				// clamped successor — a template due on the 31st would drift to the
				// 28th forever instead of staying at month end.
				...(template.anchorAt ? {} : { anchorAt: template.nextDueAt }),
			})
			.where(eq(recurringExpenses.id, template.id));
	}

	return created;
}

export const GET = withCronLogging(
	'recurring-advance',
	async (req: NextRequest): Promise<NextResponse> => {
		const secret = process.env.CRON_SECRET;
		if (!secret) {
			return new NextResponse('cron_secret_missing', { status: 503 });
		}
		if (!verifyCronSecret(req.headers.get('authorization'), secret)) {
			return new NextResponse('unauthorized', { status: 401 });
		}

		const now = new Date();
		const due = (await db
			.select({
				id: recurringExpenses.id,
				wgId: recurringExpenses.wgId,
				paidByMemberId: recurringExpenses.paidByMemberId,
				description: recurringExpenses.description,
				amountCents: recurringExpenses.amountCents,
				intervalMonths: recurringExpenses.intervalMonths,
				nextDueAt: recurringExpenses.nextDueAt,
				anchorAt: recurringExpenses.anchorAt,
				splitsJson: recurringExpenses.splitsJson,
				wgName: wgs.name,
				shareCode: wgs.shareCode,
			})
			.from(recurringExpenses)
			.innerJoin(wgs, eq(recurringExpenses.wgId, wgs.id))
			.where(
				and(lte(recurringExpenses.nextDueAt, now), isNull(recurringExpenses.pausedAt)),
			)) as DueRecurring[];

		if (due.length === 0) return NextResponse.json({ ok: true, charged: 0 });

		// allSettled, not all: one corrupt template (DB error, constraint
		// violation) must not block advancing every other WG's templates.
		const settled = await Promise.allSettled(due.map((template) => advanceTemplate(template)));
		const created: CreatedAdvance[] = [];
		let failedTemplates = 0;
		for (const result of settled) {
			if (result.status === 'fulfilled') {
				created.push(...result.value);
			} else {
				failedTemplates += 1;
				console.error('[cron/recurring-advance] template advance failed', result.reason);
			}
		}

		await Promise.allSettled(
			created.map(async ({ template, expenseId }) => {
				await recordAuditEvent({
					wgId: template.wgId,
					memberId: null,
					eventType: 'recurring.charged',
					entityType: 'expense',
					entityId: expenseId,
					summary: `Abo-Buchung ${template.description} wurde automatisch eingetragen.`,
					metadata: {
						recurringExpenseId: template.id,
						amountCents: template.amountCents,
						currency: 'EUR',
						description: template.description,
					},
				});
				await dispatchNotificationSafely({
					wg: { id: template.wgId, name: template.wgName, shareCode: template.shareCode },
					event: 'expense.recurring_charged',
					payload: {
						description: template.description,
						amountCents: template.amountCents,
						currency: 'EUR',
						expenseId,
					},
				});
			}),
		);

		return NextResponse.json({
			ok: failedTemplates === 0,
			charged: created.length,
			failedTemplates,
		});
	},
);
