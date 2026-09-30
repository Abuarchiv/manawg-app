import { recordAuditEvent } from '@/core/audit';
import { db, idempotencyResponses, recurringExpenses, wgMembers } from '@/core/db';
import { TransactionAbort } from '@/core/db/transaction';
import { apiError, badRequest, conflict, notFound, serverError, tooMany } from '@/core/errors';
import { requireOwnerOrAdmin } from '@/core/guards/admin';
import {
	ReplayCache,
	type ReplayReservation,
	claimReplaySlotWithRetry,
	replayKey,
} from '@/core/guards/idempotency';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { readShareCode } from '@/core/guards/route-preamble';
import { withWgRoute } from '@/core/guards/with-wg-route';
import {
	RESPONSE_REPLAY_TTL_SECONDS,
	getCachedResponse,
	readIdempotencyKey,
} from '@/core/idempotency';
import type { RouteCtx } from '@/core/infra/api-types';
import { logApiError } from '@/core/infra/observability';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { currencySchema } from '@/core/validators/currency';
import {
	isRecurringDueAtEditAllowed,
	recurringDueAtSchema,
} from '@/core/validators/recurring-due-date';
import { withExpensePaymentLock } from '@/features/expenses/expense-payments';
import { checkPaidByGuard } from '@/features/expenses/expenses';
import {
	buildRecurringAdvance,
	parseRecurringSplits,
	recurringDueDateMatchesExpected,
} from '@/features/expenses/recurring-expenses';
import { splitValidationErrorCode, validateSplits } from '@/features/expenses/split-math';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const RECURRING_EXPENSES_LIST_LIMIT = 500;

type RecurringCreateResponseBody = { recurringExpense: unknown };

const recurringCreateReplay = new ReplayCache<RecurringCreateResponseBody>(IDEMPOTENCY_TTL_MS);

function recurringCreateIdempotencyScope(wgId: string, memberId: string): string {
	return `recurring-expenses-create:${wgId}:${memberId}`;
}

const splitSchema = z.object({
	debtorMemberId: z.string().uuid(),
	amountCents: z.number().int().min(0),
});

const createRecurringSchema = z.object({
	description: z.string().trim().min(1).max(200),
	amountCents: z.number().int().min(1).max(100_000_000),
	currency: currencySchema.optional().default('EUR'),
	paidByMemberId: z.string().uuid(),
	intervalMonths: z.number().int().min(1).max(24).default(1),
	nextDueAt: recurringDueAtSchema,
	splits: z.array(splitSchema).min(1).max(50),
});

function serialize(row: typeof recurringExpenses.$inferSelect) {
	return {
		...row,
		currency: 'EUR',
		nextDueAt: row.nextDueAt.toISOString(),
		lastCreatedAt: row.lastCreatedAt?.toISOString() ?? null,
		pausedAt: row.pausedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		splits: parseRecurringSplits(row.splitsJson),
	};
}

const advanceSchema = z.object({
	id: z.string().uuid(),
	description: z.string().trim().min(1).max(200).optional(),
	amountCents: z.number().int().min(1).max(100_000_000).optional(),
	currency: currencySchema.optional(),
	paidByMemberId: z.string().uuid().optional(),
	intervalMonths: z.number().int().min(1).max(24).optional(),
	nextDueAt: z.string().datetime({ offset: true }).optional(),
	expectedNextDueAt: z.string().datetime({ offset: true }).optional(),
	splits: z.array(splitSchema).min(1).max(50).optional(),
});

const deleteRecurringSchema = z.object({
	id: z.string().uuid(),
});

export const GET = withWgRoute(
	'recurring-expenses GET',
	async (req, { code }) => {
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;
		const rows = await db
			.select()
			.from(recurringExpenses)
			.where(eq(recurringExpenses.wgId, wg.id))
			.orderBy(asc(recurringExpenses.nextDueAt))
			.limit(RECURRING_EXPENSES_LIST_LIMIT);
		return NextResponse.json({ recurringExpenses: rows.map(serialize) });
	},
	{
		fixture: (fixture) => {
			return NextResponse.json({
				recurringExpenses: [
					{
						id: 'a1ef32d5-d40a-4df2-9977-7684dce7df3f',
						wgId: fixture.id,
						createdByMemberId: fixture.members[0]?.id ?? '',
						paidByMemberId: fixture.members[0]?.id ?? '',
						description: 'Internet',
						amountCents: 3290,
						currency: 'EUR',
						intervalMonths: 1,
						nextDueAt: new Date(Date.now() - 86_400_000).toISOString(),
						lastCreatedAt: null,
						pausedAt: null,
						createdAt: new Date().toISOString(),
						splits: [
							{
								debtorMemberId: fixture.members[0]?.id ?? '',
								amountCents: 3290,
							},
						],
					},
				],
			});
		},
	},
);

export async function POST(
	req: NextRequest,
	ctx: RouteCtx<{ code: string }>,
): Promise<NextResponse> {
	const codeResult = await readShareCode(ctx);
	if (!codeResult.ok) return codeResult.response;
	const { code } = codeResult;

	let raw: unknown;
	let replayReservation: Extract<
		ReplayReservation<RecurringCreateResponseBody>,
		{ owned: true }
	> | null = null;

	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}

	const idemKey = readIdempotencyKey(req);

	const parsed = createRecurringSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.flatten();
		if (issues.fieldErrors.amountCents) return badRequest('amount_invalid');
		if (issues.fieldErrors.currency) return badRequest('currency_invalid');
		if (issues.fieldErrors.description) return badRequest('description_invalid');
		if (issues.fieldErrors.paidByMemberId) return badRequest('member_id_invalid');
		if (issues.fieldErrors.intervalMonths) return badRequest('interval_invalid');
		if (issues.fieldErrors.nextDueAt) return badRequest('due_date_invalid');
		if (issues.fieldErrors.splits) return badRequest('splits_invalid');
		return badRequest('invalid_body');
	}
	if (parsed.data.currency !== 'EUR') return badRequest('recurring_currency_unsupported');
	const splitCheck = validateSplits(parsed.data.amountCents, parsed.data.splits);
	if (!splitCheck.ok) {
		return badRequest(splitValidationErrorCode(splitCheck.reason));
	}

	try {
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;

		const idemScope = idemKey ? recurringCreateIdempotencyScope(wg.id, auth.member.memberId) : null;
		const idemReplayKey = idemScope && idemKey ? replayKey(idemScope, idemKey) : null;

		if (idemScope && idemKey && idemReplayKey) {
			const localReplay = recurringCreateReplay.get(idemReplayKey);
			if (localReplay) return NextResponse.json(await localReplay);

			const cached = await getCachedResponse<RecurringCreateResponseBody>(idemScope, idemKey);
			if (cached) {
				recurringCreateReplay.remember(idemReplayKey, cached);
				return NextResponse.json(cached);
			}
		}

		const limited = await checkRateLimit(
			wgWriteLimiter,
			`recurring-expense:${wg.id}:${auth.member.memberId}`,
		);
		if (!limited.success) return tooMany();
		const paidByGuard = checkPaidByGuard(
			parsed.data.paidByMemberId,
			auth.member.memberId,
			parsed.data.splits,
		);
		if (!paidByGuard.ok) {
			return apiError('paid_by_must_include_caller', 403, 'paid_by_must_include_caller');
		}
		const memberIds = Array.from(
			new Set([
				parsed.data.paidByMemberId,
				...parsed.data.splits.map((split) => split.debtorMemberId),
			]),
		);
		const memberRows = await db
			.select({ id: wgMembers.id })
			.from(wgMembers)
			.where(
				and(
					eq(wgMembers.wgId, wg.id),
					inArray(wgMembers.id, memberIds),
					isNull(wgMembers.deactivatedAt),
				),
			);
		if (memberRows.length !== memberIds.length) return badRequest('member_not_in_wg');

		const replaySlot = idemReplayKey === null ? null : recurringCreateReplay.reserve(idemReplayKey);
		if (replaySlot?.owned === false) {
			return NextResponse.json(await replaySlot.promise);
		}
		replayReservation = replaySlot;

		// Cross-process dedup: claim a Postgres slot so a concurrent cold Lambda
		// with the same Idempotency-Key sees our claim and fetches the cached
		// response instead of inserting a duplicate recurring-expense template.
		if (idemScope && idemKey) {
			const slot = await claimReplaySlotWithRetry<RecurringCreateResponseBody>(idemScope, idemKey);
			if (!slot.won) {
				replayReservation?.resolve(slot.cached);
				return NextResponse.json(slot.cached);
			}
		}

		let written:
			| { replayed: true; body: RecurringCreateResponseBody }
			| {
					replayed: false;
					template: typeof recurringExpenses.$inferSelect;
					body: RecurringCreateResponseBody;
			  };
		try {
			written = await withExpensePaymentLock(wg.id, async (tx) => {
				if (idemScope && idemKey) {
					const [slot] = await tx
						.select({
							body: idempotencyResponses.responseBody,
							expiresAt: idempotencyResponses.expiresAt,
						})
						.from(idempotencyResponses)
						.where(
							and(eq(idempotencyResponses.scope, idemScope), eq(idempotencyResponses.key, idemKey)),
						)
						.limit(1)
						.for('update');
					if (!slot) throw new TransactionAbort('idempotency_claim_missing');
					if (slot.body && typeof slot.body === 'object' && 'recurringExpense' in slot.body) {
						return { replayed: true as const, body: slot.body as RecurringCreateResponseBody };
					}
					if (
						slot.expiresAt <= new Date() ||
						!slot.body ||
						typeof slot.body !== 'object' ||
						Array.isArray(slot.body) ||
						Object.keys(slot.body).length !== 1 ||
						(slot.body as Record<string, unknown>)._claimed !== true
					) {
						throw new TransactionAbort('idempotency_claim_invalid');
					}
				}
				const [template] = await tx
					.insert(recurringExpenses)
					.values({
						wgId: wg.id,
						createdByMemberId: auth.member.memberId,
						paidByMemberId: parsed.data.paidByMemberId,
						description: parsed.data.description,
						amountCents: parsed.data.amountCents,
						intervalMonths: parsed.data.intervalMonths,
						nextDueAt: new Date(parsed.data.nextDueAt),
						anchorAt: new Date(parsed.data.nextDueAt),
						splitsJson: JSON.stringify(parsed.data.splits),
					})
					.returning();
				if (!template) throw new TransactionAbort('insert_failed');
				const body: RecurringCreateResponseBody = { recurringExpense: serialize(template) };
				if (idemScope && idemKey) {
					const rows = await tx
						.update(idempotencyResponses)
						.set({
							responseBody: body,
							expiresAt: new Date(Date.now() + RESPONSE_REPLAY_TTL_SECONDS * 1000),
						})
						.where(
							and(
								eq(idempotencyResponses.scope, idemScope),
								eq(idempotencyResponses.key, idemKey),
								gt(idempotencyResponses.expiresAt, new Date()),
								sql`${idempotencyResponses.responseBody} = '{"_claimed":true}'::jsonb`,
							),
						)
						.returning({ scope: idempotencyResponses.scope });
					if (rows.length !== 1) throw new TransactionAbort('idempotency_claim_missing');
				}
				return { replayed: false as const, template, body };
			});
		} catch (writeErr) {
			replayReservation?.reject(writeErr);
			throw writeErr;
		}
		if (written.replayed) {
			replayReservation?.resolve(written.body);
			return NextResponse.json(written.body);
		}
		const { template } = written;
		await recordAuditEvent({
			wgId: wg.id,
			memberId: auth.member.memberId,
			eventType: 'recurring.created',
			entityType: 'recurring_expense',
			entityId: template.id,
			summary: `${auth.member.name} hat ${template.description} als Fixkosten-Vorlage angelegt.`,
			metadata: {
				description: template.description,
				amountCents: template.amountCents,
				currency: 'EUR',
				intervalMonths: template.intervalMonths,
				nextDueAt: template.nextDueAt.toISOString(),
				splitCount: parsed.data.splits.length,
			},
		});
		replayReservation?.resolve(written.body);
		return NextResponse.json(written.body);
	} catch (err) {
		replayReservation?.reject(err);
		if (err instanceof TransactionAbort) {
			logApiError('[recurring-expenses POST] transaction aborted');
			return serverError('transaction_aborted');
		}
		logApiError('[recurring-expenses POST]', err);
		return serverError(err);
	}
}

export const PATCH = withWgRoute('recurring-expenses PATCH', async (req, { code }) => {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}
	const parsed = advanceSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.flatten();
		if (issues.fieldErrors.amountCents) return badRequest('amount_invalid');
		if (issues.fieldErrors.currency) return badRequest('currency_invalid');
		if (issues.fieldErrors.description) return badRequest('description_invalid');
		if (issues.fieldErrors.paidByMemberId) return badRequest('member_id_invalid');
		if (issues.fieldErrors.intervalMonths) return badRequest('interval_invalid');
		if (issues.fieldErrors.nextDueAt || issues.fieldErrors.expectedNextDueAt)
			return badRequest('due_date_invalid');
		if (issues.fieldErrors.splits) return badRequest('splits_invalid');
		return badRequest('invalid_body');
	}
	if (parsed.data.currency !== undefined && parsed.data.currency !== 'EUR') {
		return badRequest('recurring_currency_unsupported');
	}
	const isTemplateUpdate =
		parsed.data.description !== undefined ||
		parsed.data.amountCents !== undefined ||
		parsed.data.currency !== undefined ||
		parsed.data.paidByMemberId !== undefined ||
		parsed.data.intervalMonths !== undefined ||
		parsed.data.nextDueAt !== undefined ||
		parsed.data.splits !== undefined;
	if (isTemplateUpdate && parsed.data.splits) {
		// amountCents may be omitted on a partial update (kept from the existing
		// template); fall back to the splits' own sum so only shape issues
		// (duplicates, invalid amounts) are caught here — the real sum-vs-amount
		// check runs later once the template's current amount is known.
		const effectiveAmount =
			parsed.data.amountCents ??
			parsed.data.splits.reduce((total, split) => total + split.amountCents, 0);
		const splitCheck = validateSplits(effectiveAmount, parsed.data.splits);
		if (!splitCheck.ok) {
			return badRequest(splitValidationErrorCode(splitCheck.reason));
		}
	}
	if (!isTemplateUpdate && !parsed.data.expectedNextDueAt) {
		return badRequest('due_date_invalid');
	}
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;
	const limited = await checkRateLimit(
		wgWriteLimiter,
		`recurring-expense:${wg.id}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();
	const rows = await db
		.select()
		.from(recurringExpenses)
		.where(and(eq(recurringExpenses.id, parsed.data.id), eq(recurringExpenses.wgId, wg.id)))
		.limit(1);
	const template = rows[0];
	if (!template) return notFound('recurring_expense_not_found');
	if (isTemplateUpdate) {
		// Editing the template is the owner's (or admin's) call. The plain
		// advance below is what every member's "Erfassen" sends after booking
		// the charge; it only moves nextDueAt by one interval, guarded by the
		// expectedNextDueAt compare-and-set.
		const denied = await requireOwnerOrAdmin(wg.id, auth.member, template.createdByMemberId);
		if (denied) return denied;
		if (
			parsed.data.nextDueAt !== undefined &&
			!isRecurringDueAtEditAllowed(parsed.data.nextDueAt, template.nextDueAt)
		) {
			return badRequest('due_date_invalid');
		}
		const paidByMemberId = parsed.data.paidByMemberId ?? template.paidByMemberId;
		const templateSplits = parseRecurringSplits(template.splitsJson);
		const splits = parsed.data.splits ?? templateSplits;
		const amountCents = parsed.data.amountCents ?? template.amountCents;
		const finalSplitCheck = validateSplits(amountCents, splits);
		if (!finalSplitCheck.ok) {
			switch (finalSplitCheck.reason) {
				case 'empty':
				case 'invalid_amount':
					return badRequest('splits_invalid');
				case 'duplicate_debtor':
					return badRequest('splits_duplicate_debtor');
				case 'sum_mismatch':
					return badRequest('splits_sum_mismatch');
			}
		}
		const memberIds = Array.from(
			new Set([paidByMemberId, ...splits.map((split) => split.debtorMemberId)]),
		);
		const memberRows = await db
			.select({ id: wgMembers.id })
			.from(wgMembers)
			.where(
				and(
					eq(wgMembers.wgId, wg.id),
					inArray(wgMembers.id, memberIds),
					isNull(wgMembers.deactivatedAt),
				),
			);
		if (memberRows.length !== memberIds.length) return badRequest('member_not_in_wg');
		const existingSplitAmounts = new Map(
			templateSplits.map(
				({ debtorMemberId, amountCents }) => [debtorMemberId, amountCents] as const,
			),
		);
		const hasSplitChange =
			parsed.data.splits !== undefined &&
			(splits.length !== templateSplits.length ||
				splits.some(
					({ debtorMemberId, amountCents }) =>
						existingSplitAmounts.get(debtorMemberId) !== amountCents,
				));
		const hasFinancialChange =
			(parsed.data.amountCents !== undefined && parsed.data.amountCents !== template.amountCents) ||
			(parsed.data.paidByMemberId !== undefined &&
				parsed.data.paidByMemberId !== template.paidByMemberId) ||
			hasSplitChange;
		if (hasFinancialChange && !checkPaidByGuard(paidByMemberId, auth.member.memberId, splits).ok) {
			return apiError('paid_by_must_include_caller', 403, 'paid_by_must_include_caller');
		}

		const [updated] = await db
			.update(recurringExpenses)
			.set({
				description: parsed.data.description ?? template.description,
				amountCents,
				paidByMemberId,
				intervalMonths: parsed.data.intervalMonths ?? template.intervalMonths,
				nextDueAt: parsed.data.nextDueAt ? new Date(parsed.data.nextDueAt) : template.nextDueAt,
				// An explicit due-date edit re-anchors the cadence.
				anchorAt: parsed.data.nextDueAt
					? new Date(parsed.data.nextDueAt)
					: (template.anchorAt ?? template.nextDueAt),
				splitsJson: JSON.stringify(splits),
				updatedAt: new Date(),
			})
			.where(and(eq(recurringExpenses.id, parsed.data.id), eq(recurringExpenses.wgId, wg.id)))
			.returning();
		if (!updated) return notFound('recurring_expense_not_found');
		await recordAuditEvent({
			wgId: wg.id,
			memberId: auth.member.memberId,
			eventType: 'recurring.updated',
			entityType: 'recurring_expense',
			entityId: updated.id,
			summary: `${auth.member.name} hat die Fixkosten-Vorlage ${updated.description} aktualisiert.`,
			metadata: {
				description: updated.description,
				amountCents: updated.amountCents,
				currency: 'EUR',
				intervalMonths: updated.intervalMonths,
				nextDueAt: updated.nextDueAt.toISOString(),
				splitCount: splits.length,
			},
		});
		return NextResponse.json({ recurringExpense: serialize(updated) });
	}
	if (
		parsed.data.expectedNextDueAt &&
		!recurringDueDateMatchesExpected(
			template.nextDueAt.toISOString(),
			parsed.data.expectedNextDueAt,
		)
	) {
		return conflict('recurring_expense_already_advanced');
	}
	if (template.pausedAt) return badRequest('abo_paused');
	const advance = buildRecurringAdvance({
		nextDueAt: template.nextDueAt.toISOString(),
		intervalMonths: template.intervalMonths,
		anchorAt: template.anchorAt ? template.anchorAt.toISOString() : null,
	});
	const [updated] = await db
		.update(recurringExpenses)
		.set(advance)
		.where(
			and(
				eq(recurringExpenses.id, parsed.data.id),
				eq(recurringExpenses.wgId, wg.id),
				eq(recurringExpenses.nextDueAt, template.nextDueAt),
				isNull(recurringExpenses.pausedAt),
			),
		)
		.returning();
	if (!updated) {
		const currentRows = await db
			.select()
			.from(recurringExpenses)
			.where(and(eq(recurringExpenses.id, parsed.data.id), eq(recurringExpenses.wgId, wg.id)))
			.limit(1);
		const current = currentRows[0];
		if (!current) return notFound('recurring_expense_not_found');
		if (
			!recurringDueDateMatchesExpected(
				current.nextDueAt.toISOString(),
				template.nextDueAt.toISOString(),
			)
		) {
			return conflict('recurring_expense_already_advanced');
		}
		if (current.pausedAt) return badRequest('abo_paused');
		return conflict('recurring_expense_already_advanced');
	}
	await recordAuditEvent({
		wgId: wg.id,
		memberId: auth.member.memberId,
		eventType: 'recurring.advanced',
		entityType: 'recurring_expense',
		entityId: updated.id,
		summary: `${updated.description} wurde aus einer Fixkosten-Vorlage übernommen.`,
		metadata: {
			description: updated.description,
			amountCents: updated.amountCents,
			currency: 'EUR',
			intervalMonths: updated.intervalMonths,
			nextDueAt: updated.nextDueAt.toISOString(),
			lastCreatedAt: updated.lastCreatedAt?.toISOString() ?? null,
			splitCount: parseRecurringSplits(updated.splitsJson).length,
		},
	});
	return NextResponse.json({ recurringExpense: serialize(updated) });
});

export const DELETE = withWgRoute('recurring-expenses DELETE', async (req, { code }) => {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}
	const parsed = deleteRecurringSchema.safeParse(raw);
	if (!parsed.success) {
		const { fieldErrors } = parsed.error.flatten();
		if (fieldErrors.id) return badRequest('id_invalid');
		return badRequest('invalid_body');
	}
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;
	const limited = await checkRateLimit(
		wgWriteLimiter,
		`recurring-expense:${wg.id}:${auth.member.memberId}`,
	);
	if (!limited.success) return tooMany();

	const rows = await db
		.select({
			id: recurringExpenses.id,
			createdByMemberId: recurringExpenses.createdByMemberId,
			description: recurringExpenses.description,
			amountCents: recurringExpenses.amountCents,
			intervalMonths: recurringExpenses.intervalMonths,
			nextDueAt: recurringExpenses.nextDueAt,
		})
		.from(recurringExpenses)
		.where(and(eq(recurringExpenses.id, parsed.data.id), eq(recurringExpenses.wgId, wg.id)))
		.limit(1);
	const template = rows[0];
	if (!template) return notFound('recurring_expense_not_found');
	const denied = await requireOwnerOrAdmin(wg.id, auth.member, template.createdByMemberId);
	if (denied) return denied;

	const deleted = await db
		.delete(recurringExpenses)
		.where(and(eq(recurringExpenses.id, parsed.data.id), eq(recurringExpenses.wgId, wg.id)))
		.returning({ id: recurringExpenses.id });
	if (deleted.length === 0) return notFound('recurring_expense_not_found');

	await recordAuditEvent({
		wgId: wg.id,
		memberId: auth.member.memberId,
		eventType: 'recurring.deleted',
		entityType: 'recurring_expense',
		entityId: template.id,
		summary: `${auth.member.name} hat die Fixkosten-Vorlage ${template.description} gelöscht.`,
		metadata: {
			description: template.description,
			amountCents: template.amountCents,
			currency: 'EUR',
			intervalMonths: template.intervalMonths,
			nextDueAt: template.nextDueAt.toISOString(),
		},
	});
	return NextResponse.json({ deleted: true });
});
