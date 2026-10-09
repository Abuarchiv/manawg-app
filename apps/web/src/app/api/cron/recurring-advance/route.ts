import { postSystemNotice } from '@/core/activity-feed';
import { recordAuditEvent } from '@/core/audit';
import { db, expenseSplits, expenses, recurringExpenses, wgMembers, wgs } from '@/core/db';
import { TransactionAbort } from '@/core/db/transaction';
import { requireCronSecret } from '@/core/infra/cron-auth';
import { logApiError } from '@/core/infra/observability';
import { withCronLogging } from '@/core/infra/observability';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import {
	type RecurringSplit,
	addMonthsFromAnchor,
	parseRecurringSplits,
	recurringSplitsMatchAmount,
} from '@/features/expenses/recurring-expenses';
import {
	hasCapturingExpensePayment,
	withExpensePaymentLock,
} from '@/features/expenses/server/expense-payments';
import { settledAtForOwnShare } from '@/features/expenses/split-math';
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

// Per-run cap and concurrency: an unbounded Promise.all over every due template
// opens one transaction each and exhausts the connection pool. Overdue templates
// stay due, so the remainder is drained by the following runs.
const TEMPLATE_LIMIT = 500;
const TEMPLATE_BATCH_SIZE = 10;
/** A blocked template is announced by the first run after it fell due only; runs are daily. */
const BLOCKED_NOTICE_WINDOW_MS = 25 * 60 * 60 * 1000;

interface DueRecurring {
	id: string;
	wgId: string;
	paidByMemberId: string;
	createdByMemberId: string;
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
): Promise<string | 'duplicate' | 'blocked' | null> {
	try {
		// The expense and its splits are one fact and are written in one
		// transaction: a compensating delete is itself a database call, and if it
		// failed the orphaned expense would skew the balances of a WG that nobody is
		// watching, because the cron runs unattended.
		return await withExpensePaymentLock(template.wgId, async (tx) => {
			const [wg] = await tx
				.select({ id: wgs.id })
				.from(wgs)
				.where(eq(wgs.id, template.wgId))
				.for('key share');
			if (!wg) return null;

			const [current] = await tx
				.select({
					paidByMemberId: recurringExpenses.paidByMemberId,
					description: recurringExpenses.description,
					amountCents: recurringExpenses.amountCents,
					intervalMonths: recurringExpenses.intervalMonths,
					nextDueAt: recurringExpenses.nextDueAt,
					anchorAt: recurringExpenses.anchorAt,
					splitsJson: recurringExpenses.splitsJson,
					pausedAt: recurringExpenses.pausedAt,
				})
				.from(recurringExpenses)
				.where(
					and(eq(recurringExpenses.id, template.id), eq(recurringExpenses.wgId, template.wgId)),
				)
				.for('update');
			if (
				!current ||
				current.pausedAt !== null ||
				current.paidByMemberId !== template.paidByMemberId ||
				current.description !== template.description ||
				current.amountCents !== template.amountCents ||
				current.intervalMonths !== template.intervalMonths ||
				current.nextDueAt.getTime() !== template.nextDueAt.getTime() ||
				(current.anchorAt?.getTime() ?? null) !== (template.anchorAt?.getTime() ?? null) ||
				current.splitsJson !== template.splitsJson
			) {
				return null;
			}
			if (await hasCapturingExpensePayment(tx, template.wgId)) return null;
			// A payer or debtor who moved out must not be charged new shares.
			// Skip without advancing: the template stays due, so it is booked
			// once someone edits or pauses it, and the loop stops here for this
			// run instead of spinning.
			const memberIds = Array.from(
				new Set([template.paidByMemberId, ...splits.map((split) => split.debtorMemberId)]),
			);
			const activeMembers = await tx
				.select({ id: wgMembers.id })
				.from(wgMembers)
				.where(
					and(
						eq(wgMembers.wgId, template.wgId),
						inArray(wgMembers.id, memberIds),
						isNull(wgMembers.deactivatedAt),
					),
				);
			if (activeMembers.length !== memberIds.length) {
				logApiError('[cron/recurring-advance] skipped template with inactive members', {
					recurringExpenseId: template.id,
					wgId: template.wgId,
				});
				return 'blocked';
			}
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
		for (const candidate of [err, err instanceof Error ? err.cause : null]) {
			if (!candidate || typeof candidate !== 'object') continue;
			const pgError = candidate as {
				code?: unknown;
				constraint?: unknown;
				constraint_name?: unknown;
			};
			if (
				pgError.code === '23505' &&
				(pgError.constraint === 'expenses_recurring_due_unique_idx' ||
					pgError.constraint_name === 'expenses_recurring_due_unique_idx')
			) {
				return 'duplicate';
			}
		}
		logApiError('[cron/recurring-advance] insert failed', err);
		return null;
	}
}

/** Tells the WG that a template is not booked because a member of it moved out. */
function announceBlockedTemplate(template: DueRecurring): Promise<void> {
	return postSystemNotice({
		wgId: template.wgId,
		authorMemberId: template.createdByMemberId,
		kind: 'info',
		source: 'expense',
		content: `Die Fixkosten „${template.description}“ werden nicht gebucht, weil ein beteiligtes Mitglied ausgezogen ist. Passe die Anteile an oder pausiere die Fixkosten.`,
	});
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
		if (expenseId === 'blocked') {
			// Ceiling: there is no stored "already told" flag, so if exactly that first run is missed the WG hears nothing.
			if (now.getTime() - template.nextDueAt.getTime() < BLOCKED_NOTICE_WINDOW_MS) {
				await announceBlockedTemplate(template);
			}
			break;
		}
		if (expenseId === null) break;

		shouldUpdateTemplate = true;
		nextDueAt = followingDueAt;
		if (expenseId !== 'duplicate') {
			created.push({ template, expenseId });
		}
		dueAt = followingDueAt;
	}

	if (shouldUpdateTemplate) {
		const [updated] = await db
			.update(recurringExpenses)
			.set({
				nextDueAt,
				lastCreatedAt: now,
				updatedAt: now,
				...(template.anchorAt ? {} : { anchorAt: template.nextDueAt }),
			})
			.where(
				and(
					eq(recurringExpenses.id, template.id),
					eq(recurringExpenses.wgId, template.wgId),
					eq(recurringExpenses.nextDueAt, template.nextDueAt),
					eq(recurringExpenses.intervalMonths, template.intervalMonths),
					eq(recurringExpenses.paidByMemberId, template.paidByMemberId),
					eq(recurringExpenses.amountCents, template.amountCents),
					eq(recurringExpenses.description, template.description),
					eq(recurringExpenses.splitsJson, template.splitsJson),
					isNull(recurringExpenses.pausedAt),
					template.anchorAt
						? eq(recurringExpenses.anchorAt, template.anchorAt)
						: isNull(recurringExpenses.anchorAt),
				),
			)
			.returning({ id: recurringExpenses.id });
		if (!updated) return created;
	}

	return created;
}

/** Runs `task` over `items` at most {@link TEMPLATE_BATCH_SIZE} at a time. */
async function settleInBatches<T, R>(
	items: readonly T[],
	task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const settled: PromiseSettledResult<R>[] = [];
	for (let index = 0; index < items.length; index += TEMPLATE_BATCH_SIZE) {
		settled.push(
			...(await Promise.allSettled(items.slice(index, index + TEMPLATE_BATCH_SIZE).map(task))),
		);
	}
	return settled;
}

export const GET = withCronLogging(
	'recurring-advance',
	async (req: NextRequest): Promise<NextResponse> => {
		const denied = requireCronSecret(req);
		if (denied) return denied;

		const now = new Date();
		const due = (await db
			.select({
				id: recurringExpenses.id,
				wgId: recurringExpenses.wgId,
				paidByMemberId: recurringExpenses.paidByMemberId,
				createdByMemberId: recurringExpenses.createdByMemberId,
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
			.where(and(lte(recurringExpenses.nextDueAt, now), isNull(recurringExpenses.pausedAt)))
			.orderBy(asc(recurringExpenses.nextDueAt), asc(recurringExpenses.id))
			.limit(TEMPLATE_LIMIT)) as DueRecurring[];

		if (due.length === 0) return NextResponse.json({ ok: true, charged: 0 });

		// allSettled, not all: one corrupt template (DB error, constraint
		// violation) must not block advancing every other WG's templates.
		const settled = await settleInBatches(due, advanceTemplate);
		const created: CreatedAdvance[] = [];
		let failedTemplates = 0;
		for (const result of settled) {
			if (result.status === 'fulfilled') {
				created.push(...result.value);
			} else {
				failedTemplates += 1;
				logApiError('[cron/recurring-advance] template advance failed', result.reason);
			}
		}

		// Batched like the advances: on the 1st of the month hundreds of bookings
		// fire at once, and an unbounded fan-out would exhaust the small
		// connection pool (audit rows are then lost silently).
		await settleInBatches(created, async ({ template, expenseId }) => {
			await recordAuditEvent({
				wgId: template.wgId,
				memberId: null,
				eventType: 'recurring.charged',
				entityType: 'expense',
				entityId: expenseId,
				summary: `Fixkosten-Buchung ${template.description} wurde automatisch eingetragen.`,
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
		});

		return NextResponse.json({
			ok: failedTemplates === 0,
			charged: created.length,
			failedTemplates,
		});
	},
);
