import { recordAuditEvent } from '@/core/audit';
import { db, expenseReminders, wgMembers } from '@/core/db';
import { type WriteOutcome, responseCodec, withIdempotentWrite } from '@/core/db/idempotent-write';
import { requireOwnerOrAdmin } from '@/core/guards/admin';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { HTTP, badRequest, conflict, forbidden, tooMany } from '@/core/http/api-errors';
import { parseBody } from '@/core/http/parse-body';
import { readIdempotencyKey, setReplayWarning } from '@/core/idempotency-store';
import { logApiError } from '@/core/infra/observability';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import { checkRateLimit, reminderSendLimiter } from '@/core/rate-limit';
import { MS_PER_DAY } from '@/core/utils/time';
import { currencySchema } from '@/core/validators/currency';
import {
	computeBalances,
	computeOldestDebtAgeDays,
	findPairBalance,
} from '@/features/expenses/debts';
import {
	REMINDER_COOLDOWN_HOURS,
	canSendReminder,
	formatReminderMessage,
} from '@/features/expenses/reminders';
import { loadCompletedExpensePayments } from '@/features/expenses/server/expense-payments';
import { loadOpenExpenses } from '@/features/expenses/server/open-expenses';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const REMINDER_HISTORY_WINDOW_DAYS = 30;
const REMINDER_PAGE_LIMIT = 50;
type ReminderResponseWarning =
	| null
	| 'notification_delivery_failed'
	| 'notification_delivery_unknown';

const postSchema = z.object({
	debtorMemberId: z.string().uuid(),
	creditorMemberId: z.string().uuid(),
	currency: currencySchema.optional().default('EUR'),
	channel: z.enum(['push', 'inapp']).optional().default('push'),
});

export const GET = withWgRoute('reminders GET', async (req, { code }) => {
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;

	const cutoff = new Date(Date.now() - REMINDER_HISTORY_WINDOW_DAYS * MS_PER_DAY);
	const reminders = await db
		.select()
		.from(expenseReminders)
		.where(and(eq(expenseReminders.wgId, wg.id), gte(expenseReminders.sentAt, cutoff)))
		.orderBy(desc(expenseReminders.sentAt))
		.limit(REMINDER_PAGE_LIMIT);

	return NextResponse.json({ reminders });
});

const reminderCodec = responseCodec();

type ReminderContext = { cooledDown: true } | { reminder: typeof expenseReminders.$inferSelect };

export const POST = withWgRoute('reminders POST', async (req, { code }) => {
	const parsed = await parseBody(req, postSchema, {
		fieldErrors: {
			debtorMemberId: 'member_ids_invalid',
			creditorMemberId: 'member_ids_invalid',
			currency: 'currency_invalid',
			channel: 'channel_invalid',
		},
	});
	if (!parsed.ok) return parsed.response;

	const { debtorMemberId, creditorMemberId, currency, channel } = parsed.data;
	if (debtorMemberId === creditorMemberId) return badRequest('same_member');
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;
	const denied = await requireOwnerOrAdmin(wg.id, auth.member, creditorMemberId, 'not_creditor');
	if (denied) return denied;

	const memberRows = await db
		.select({
			id: wgMembers.id,
			name: wgMembers.name,
			notifyReminders: wgMembers.notifyReminders,
		})
		.from(wgMembers)
		.where(
			and(
				eq(wgMembers.wgId, wg.id),
				inArray(wgMembers.id, [debtorMemberId, creditorMemberId]),
				isNull(wgMembers.deactivatedAt),
			),
		);
	if (memberRows.length !== 2) return badRequest('member_not_in_wg');

	const debtor = memberRows.find((row) => row.id === debtorMemberId);
	const creditor = memberRows.find((row) => row.id === creditorMemberId);
	if (!debtor || !creditor) return badRequest('member_not_in_wg');

	if (!debtor.notifyReminders) {
		return forbidden('debtor_opted_out', 'debtor_opted_out');
	}

	const rl = await checkRateLimit(reminderSendLimiter, `reminder:${auth.member.memberId}`);
	if (!rl.success) return tooMany('reminder_rate_limited', 'reminder_rate_limited');

	const [openExpenses, payments] = await Promise.all([
		loadOpenExpenses(wg.id),
		loadCompletedExpensePayments(wg.id),
	]);
	const balances = computeBalances(openExpenses, payments);
	const pair = findPairBalance(balances, debtorMemberId, creditorMemberId, currency);
	if (!pair || pair.amountCents <= 0) {
		return conflict('no_open_debt', 'no_open_debt');
	}

	const recentSince = new Date(Date.now() - REMINDER_COOLDOWN_HOURS * 60 * 60 * 1000);
	const scope = `reminder:${wg.id}:${auth.member.memberId}:${debtorMemberId}:${creditorMemberId}:${currency}:${channel}`;
	const key = readIdempotencyKey(req);
	const result = await withIdempotentWrite(
		{ scope, key, codec: reminderCodec },
		async (tx): Promise<WriteOutcome<unknown, ReminderContext>> => {
			// Cooldown check and insert must be atomic: two parallel requests would both pass the
			// check and push twice. A transaction-scoped advisory lock per (wg, debtor, creditor)
			// serializes them.
			const lockKey = `${wg.id}:${debtorMemberId}:${creditorMemberId}`;
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
			const recent = await tx
				.select({
					debtorMemberId: expenseReminders.debtorMemberId,
					creditorMemberId: expenseReminders.creditorMemberId,
					currency: expenseReminders.currency,
					sentAt: expenseReminders.sentAt,
				})
				.from(expenseReminders)
				.where(
					and(
						eq(expenseReminders.wgId, wg.id),
						eq(expenseReminders.debtorMemberId, debtorMemberId),
						eq(expenseReminders.creditorMemberId, creditorMemberId),
						eq(expenseReminders.currency, currency),
						gte(expenseReminders.sentAt, recentSince),
					),
				)
				.orderBy(desc(expenseReminders.sentAt))
				.limit(5);

			const history = recent.map((row) => ({
				debtorMemberId: row.debtorMemberId,
				creditorMemberId: row.creditorMemberId,
				currency: row.currency,
				sentAt: row.sentAt instanceof Date ? row.sentAt.toISOString() : String(row.sentAt),
			}));
			const cooldown = canSendReminder(
				debtorMemberId,
				creditorMemberId,
				history,
				new Date(),
				currency,
			);
			if (!cooldown.allowed) {
				return { status: HTTP.TOO_MANY, body: null, context: { cooledDown: true } };
			}

			const oldestAge = computeOldestDebtAgeDays(
				debtorMemberId,
				creditorMemberId,
				openExpenses,
				new Date(),
				currency,
			);
			const message = formatReminderMessage({
				debtorName: debtor.name,
				creditorName: creditor.name,
				amountCents: pair.amountCents,
				currency,
				oldestDebtAgeDays: oldestAge,
			});

			const [row] = await tx
				.insert(expenseReminders)
				.values({
					wgId: wg.id,
					debtorMemberId,
					creditorMemberId,
					amountCents: pair.amountCents,
					currency,
					sentByMemberId: auth.member.memberId,
					channel,
					message,
					oldestDebtAgeDays: oldestAge,
				})
				.returning();
			if (!row) {
				return { status: HTTP.TOO_MANY, body: null, context: { cooledDown: true } };
			}
			return { status: 200, body: { reminder: row, warning: null }, context: { reminder: row } };
		},
	);
	if (result.kind === 'replayed') return NextResponse.json(result.body, { status: result.status });
	if (!result.context || 'cooledDown' in result.context) {
		return tooMany('reminder_cooldown', 'reminder_cooldown');
	}
	const inserted = result.context.reminder;

	await recordAuditEvent({
		wgId: wg.id,
		memberId: auth.member.memberId,
		eventType: 'expense.reminder.sent',
		entityType: 'expense_reminder',
		entityId: inserted.id,
		summary: `${auth.member.name} hat ${debtor.name} an offene Schulden bei ${creditor.name} erinnert.`,
		metadata: {
			amountCents: pair.amountCents,
			currency,
			oldestDebtAgeDays: inserted.oldestDebtAgeDays,
			channel,
		},
	});

	const { warning }: { warning: ReminderResponseWarning } = await dispatchNotificationSafely({
		wg,
		event: 'expense.reminder',
		payload: {
			amountCents: pair.amountCents,
			currency,
			creditorName: creditor.name,
			debtorName: debtor.name,
			oldestDebtAgeDays: inserted.oldestDebtAgeDays,
		},
		targetMemberIds: [debtorMemberId],
	});
	if (key && warning !== null) {
		const target = {
			match: [{ path: ['body', 'reminder', 'id'], equals: inserted.id }],
			warningPath: ['body', 'warning'],
			replaces: [null],
		};
		const persisted = await setReplayWarning(scope, key, target, warning).catch((err: unknown) => {
			logApiError('[reminders POST] replay warning persistence failed', err);
			return true;
		});
		if (!persisted) {
			logApiError(
				'[reminders POST] replay warning persistence failed',
				new Error('replay_row_missing'),
			);
		}
	}

	return NextResponse.json({ reminder: inserted, warning });
});
