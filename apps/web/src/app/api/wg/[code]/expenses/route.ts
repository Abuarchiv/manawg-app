import { db, expenseSplits, expenses, idempotencyResponses, recurringExpenses } from '@/core/db';
import { assertPrivateImageCanBeAttached } from '@/core/db/private-image-deletions';
import { type DbTransaction, TransactionAbort } from '@/core/db/transaction';
import { apiError, badRequest, conflict, notFound, serverError, tooMany } from '@/core/errors';
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
import type { NotificationDispatchWarning } from '@/core/notifications/notification-dispatch';
import { checkRateLimit, expensesReadLimiter, wgWriteLimiter } from '@/core/rate-limit';
import { currencySchema } from '@/core/validators/currency';
import { imageUrlSchema, isAllowedImageUrlForWg } from '@/core/validators/image-url';
import { AMOUNT_MAX_CENTS, AMOUNT_MIN_CENTS } from '@/features/expenses/expense-constants';
import {
	hasCapturingExpensePayment,
	loadCompletedExpensePayments,
	withExpensePaymentLock,
} from '@/features/expenses/expense-payments';
import {
	checkPaidByGuard,
	findExpenseMemberIds,
	insertExpenseWithSplits,
	recordExpenseCreatedSideEffects,
	resolveExpensePayer,
} from '@/features/expenses/expenses';
import { splitValidationErrorCode, validateSplits } from '@/features/expenses/split-math';
import { and, desc, eq, getTableColumns, gt, sql } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const DESCRIPTION_MIN = 1;
const DESCRIPTION_MAX = 200;
const MAX_SPLITS = 50;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

type ExpenseCreateResponseBody = { expense: unknown; warning: NotificationDispatchWarning };

const expenseCreateReplay = new ReplayCache<ExpenseCreateResponseBody>(IDEMPOTENCY_TTL_MS);

function expenseCreateIdempotencyScope(wgId: string, memberId: string): string {
	return `expenses-create:${wgId}:${memberId}`;
}

const splitSchema = z.object({
	debtorMemberId: z.string().uuid(),
	amountCents: z
		.number()
		.int('amountCents must be an integer')
		.min(0, 'amountCents must not be negative'),
});

const createExpenseSchema = z
	.object({
		paidByMemberId: z.string().uuid().optional(),
		amountCents: z
			.number()
			.int('amountCents must be an integer')
			.min(AMOUNT_MIN_CENTS)
			.max(AMOUNT_MAX_CENTS),
		currency: currencySchema.optional().default('EUR'),
		description: z.string().trim().min(DESCRIPTION_MIN).max(DESCRIPTION_MAX),
		imageUrl: imageUrlSchema,
		occurredAt: z.string().datetime({ offset: true }).optional(),
		recurringExpenseId: z.string().uuid().optional(),
		expectedRecurringNextDueAt: z.string().datetime({ offset: true }).optional(),
		splits: z.array(splitSchema).min(1).max(MAX_SPLITS),
	})
	.superRefine((value, ctx) => {
		// Structural shape alone would accept splits whose total does not match
		// the expense. The runtime validateSplits call below stays the source of
		// truth for duplicates/invalid amounts, but a bypassed or reordered
		// check can no longer produce a money-mismatched expense: the schema
		// itself refuses it and reports the same error code the runtime check
		// would have returned.
		const sum = value.splits.reduce((total, split) => total + split.amountCents, 0);
		if (sum !== value.amountCents) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'splits_sum_mismatch',
				path: ['splits'],
			});
		}
	});

async function lockExpenseCreateClaim(
	tx: DbTransaction,
	scope: string,
	key: string,
): Promise<ExpenseCreateResponseBody | null> {
	const [slot] = await tx
		.select({ body: idempotencyResponses.responseBody, expiresAt: idempotencyResponses.expiresAt })
		.from(idempotencyResponses)
		.where(and(eq(idempotencyResponses.scope, scope), eq(idempotencyResponses.key, key)))
		.limit(1)
		.for('update');
	if (!slot) throw new TransactionAbort('idempotency_claim_missing');
	if (slot.body && typeof slot.body === 'object' && 'expense' in slot.body) {
		return slot.body as ExpenseCreateResponseBody;
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
	return null;
}

async function findRecurringExpense(
	tx: DbTransaction,
	wgId: string,
	recurringExpenseId: string,
	recurringDueAt: Date,
): Promise<{
	expense: typeof expenses.$inferSelect;
	splits: (typeof expenseSplits.$inferSelect)[];
} | null> {
	const [expense] = await tx
		.select()
		.from(expenses)
		.where(
			and(
				eq(expenses.wgId, wgId),
				eq(expenses.recurringExpenseId, recurringExpenseId),
				eq(expenses.recurringDueAt, recurringDueAt),
			),
		)
		.limit(1);
	if (!expense) return null;
	const splits = await tx
		.select()
		.from(expenseSplits)
		.where(eq(expenseSplits.expenseId, expense.id));
	return { expense, splits };
}

async function finalizeExpenseCreateClaim(
	tx: DbTransaction,
	scope: string,
	key: string,
	body: ExpenseCreateResponseBody,
): Promise<void> {
	const rows = await tx
		.update(idempotencyResponses)
		.set({
			responseBody: body,
			expiresAt: new Date(Date.now() + RESPONSE_REPLAY_TTL_SECONDS * 1000),
		})
		.where(
			and(
				eq(idempotencyResponses.scope, scope),
				eq(idempotencyResponses.key, key),
				gt(idempotencyResponses.expiresAt, new Date()),
				sql`${idempotencyResponses.responseBody} = '{"_claimed":true}'::jsonb`,
			),
		)
		.returning({ scope: idempotencyResponses.scope });
	if (rows.length !== 1) throw new TransactionAbort('idempotency_claim_missing');
}

function expenseCreateAbortResponse(error: unknown): NextResponse | null {
	if (!(error instanceof TransactionAbort)) return null;
	if (error.code === 'image_removed') return conflict('image_removed', 'image_removed');
	if (error.code === 'paypal_payment_pending') return conflict('paypal_payment_pending');
	if (error.code === 'recurring_expense_not_found') return notFound('recurring_expense_not_found');
	if (error.code === 'abo_paused') return badRequest('abo_paused');
	if (error.code === 'recurring_expense_already_advanced') {
		return conflict('recurring_expense_already_advanced');
	}
	return null;
}

function isRecurringDueUniqueViolation(error: unknown): boolean {
	const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
	if (!cause || typeof cause !== 'object') return false;
	const pgError = cause as { code?: unknown; constraint?: unknown; constraint_name?: unknown };
	return (
		pgError.code === '23505' &&
		(pgError.constraint === 'expenses_recurring_due_unique_idx' ||
			pgError.constraint_name === 'expenses_recurring_due_unique_idx')
	);
}

export const GET = withWgRoute(
	'expenses GET',
	async (req, { code }) => {
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wgId = auth.wg.id;

		// Per-member bucket on top of the middleware's per-IP read limit: this
		// returns the WG's whole expense history.
		const limit = await checkRateLimit(
			expensesReadLimiter,
			`expenses:${wgId}:${auth.member.memberId}`,
		);
		if (!limit.success) return tooMany('rate_limited');

		const rows = await db
			.select()
			.from(expenses)
			.where(eq(expenses.wgId, wgId))
			.orderBy(desc(expenses.occurredAt));

		if (rows.length === 0) return NextResponse.json({ expenses: [] });

		// Balances need the full history, so the list stays complete. Splits are
		// joined by WG instead of `inArray(expenseIds)`: one bind parameter per
		// expense would exceed PostgreSQL's 65,535-parameter limit for large WGs.
		const [splits, payments] = await Promise.all([
			db
				.select(getTableColumns(expenseSplits))
				.from(expenseSplits)
				.innerJoin(expenses, eq(expenseSplits.expenseId, expenses.id))
				.where(eq(expenses.wgId, wgId)),
			loadCompletedExpensePayments(wgId),
		]);

		const splitsByExpense = new Map<string, typeof splits>();
		for (const s of splits) {
			const list = splitsByExpense.get(s.expenseId) ?? [];
			list.push(s);
			splitsByExpense.set(s.expenseId, list);
		}

		return NextResponse.json({
			expenses: rows.map((e) => ({
				...e,
				splits: splitsByExpense.get(e.id) ?? [],
			})),
			payments,
		});
	},
	{
		fixture: () => {
			return NextResponse.json({ expenses: [] });
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
		ReplayReservation<ExpenseCreateResponseBody>,
		{ owned: true }
	> | null = null;

	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}

	const idemKey = readIdempotencyKey(req);

	const parsed = createExpenseSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.flatten();
		if (issues.fieldErrors.amountCents) return badRequest('amount_invalid');
		if (issues.fieldErrors.description) return badRequest('description_invalid');
		if (issues.fieldErrors.paidByMemberId) return badRequest('member_id_invalid');
		if (issues.fieldErrors.currency) return badRequest('currency_invalid');
		if (issues.fieldErrors.imageUrl) return badRequest('image_invalid');
		if (issues.fieldErrors.occurredAt) return badRequest('occurred_at_invalid');
		if (issues.fieldErrors.recurringExpenseId) return badRequest('recurring_expense_invalid');
		if (issues.fieldErrors.expectedRecurringNextDueAt)
			return badRequest('recurring_due_at_invalid');
		if (issues.fieldErrors.splits) {
			// The schema-level sum check uses the runtime error code as its
			// message, so the API contract stays identical for clients.
			if (issues.fieldErrors.splits[0] === 'splits_sum_mismatch') {
				return badRequest('splits_sum_mismatch');
			}
			return badRequest('splits_invalid');
		}
		return badRequest('invalid_body');
	}
	if (
		(parsed.data.recurringExpenseId === undefined) !==
		(parsed.data.expectedRecurringNextDueAt === undefined)
	) {
		return badRequest('recurring_expense_fields_required');
	}

	const {
		amountCents,
		description,
		currency,
		imageUrl,
		occurredAt: occurredAtStr,
		splits: validatedSplits,
		paidByMemberId,
		recurringExpenseId,
		expectedRecurringNextDueAt,
	} = parsed.data;

	const occurredAt = occurredAtStr ? new Date(occurredAtStr) : new Date();
	const safeImageUrl = typeof imageUrl === 'string' && imageUrl.length > 0 ? imageUrl : null;

	const splitCheck = validateSplits(amountCents, validatedSplits);
	if (!splitCheck.ok) {
		return badRequest(splitValidationErrorCode(splitCheck.reason));
	}

	try {
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;
		if (!isAllowedImageUrlForWg(safeImageUrl, wg.id)) return badRequest('image_invalid');

		const idemScope = idemKey ? expenseCreateIdempotencyScope(wg.id, auth.member.memberId) : null;
		const idemReplayKey = idemScope && idemKey ? replayKey(idemScope, idemKey) : null;

		// Replay only after WG/member auth, scoped by both IDs to prevent
		// cross-WG or cross-member response leaks for client-provided keys.
		if (idemScope && idemKey && idemReplayKey) {
			const localReplay = expenseCreateReplay.get(idemReplayKey);
			if (localReplay) return NextResponse.json(await localReplay);

			const cached = await getCachedResponse<ExpenseCreateResponseBody>(idemScope, idemKey);
			if (cached) {
				expenseCreateReplay.remember(idemReplayKey, cached);
				return NextResponse.json(cached);
			}
		}

		const limited = await checkRateLimit(
			wgWriteLimiter,
			`expense:${wg.id}:${auth.member.memberId}`,
		);
		if (!limited.success) return tooMany();

		const paidBy = resolveExpensePayer(paidByMemberId, auth.member.memberId);
		if (paidBy === null) return badRequest('member_id_invalid');
		const debtorIds = Array.from(new Set(validatedSplits.map((s) => s.debtorMemberId)));

		const guard = checkPaidByGuard(paidBy, auth.member.memberId, validatedSplits);
		if (!guard.ok) {
			return apiError('paid_by_must_include_caller', 403, 'paid_by_must_include_caller');
		}
		const memberIds = Array.from(new Set([paidBy, ...debtorIds]));
		const foundMemberIds = await findExpenseMemberIds(wg.id, memberIds);
		if (foundMemberIds.size !== memberIds.length) {
			return badRequest('member_not_in_wg');
		}

		const replaySlot = idemReplayKey === null ? null : expenseCreateReplay.reserve(idemReplayKey);
		if (replaySlot?.owned === false) {
			return NextResponse.json(await replaySlot.promise);
		}
		replayReservation = replaySlot;

		// Cross-process dedup: claim a Postgres slot so a concurrent cold Lambda
		// with the same Idempotency-Key sees our claim and fetches the cached
		// response instead of inserting a duplicate expense.
		if (idemScope && idemKey) {
			const slot = await claimReplaySlotWithRetry<ExpenseCreateResponseBody>(idemScope, idemKey);
			if (!slot.won) {
				replayReservation?.resolve(slot.cached);
				return NextResponse.json(slot.cached);
			}
		}

		// Keep the expense, its splits and its durable replay response in one transaction.
		let written:
			| { replayed: true; body: ExpenseCreateResponseBody }
			| {
					replayed: false;
					expense: typeof expenses.$inferSelect;
					body: ExpenseCreateResponseBody;
			  };
		try {
			written = await withExpensePaymentLock(wg.id, async (tx) => {
				await assertPrivateImageCanBeAttached(tx, wg.id, safeImageUrl);
				if (idemScope && idemKey) {
					const replay = await lockExpenseCreateClaim(tx, idemScope, idemKey);
					if (replay) return { replayed: true as const, body: replay };
				}

				let recurringDueAt: Date | undefined;
				if (recurringExpenseId && expectedRecurringNextDueAt) {
					const expectedDueAt = new Date(expectedRecurringNextDueAt);
					const existing = await findRecurringExpense(tx, wg.id, recurringExpenseId, expectedDueAt);
					if (existing) {
						const body: ExpenseCreateResponseBody = {
							expense: { ...existing.expense, splits: existing.splits },
							warning: null,
						};
						if (idemScope && idemKey) {
							await finalizeExpenseCreateClaim(tx, idemScope, idemKey, body);
						}
						return { replayed: true as const, body };
					}

					const [template] = await tx
						.select()
						.from(recurringExpenses)
						.where(
							and(eq(recurringExpenses.id, recurringExpenseId), eq(recurringExpenses.wgId, wg.id)),
						)
						.limit(1)
						.for('update');
					if (!template) throw new TransactionAbort('recurring_expense_not_found');
					if (template.pausedAt) throw new TransactionAbort('abo_paused');
					if (template.nextDueAt.getTime() !== expectedDueAt.getTime()) {
						throw new TransactionAbort('recurring_expense_already_advanced');
					}
					recurringDueAt = template.nextDueAt;
				}
				if (await hasCapturingExpensePayment(tx, wg.id)) {
					throw new TransactionAbort('paypal_payment_pending');
				}
				const created = await insertExpenseWithSplits(tx, {
					wgId: wg.id,
					paidByMemberId: paidBy,
					amountCents,
					currency,
					description,
					imageUrl: safeImageUrl,
					occurredAt,
					splits: validatedSplits,
					...(recurringExpenseId && recurringDueAt ? { recurringExpenseId, recurringDueAt } : {}),
				});
				const body: ExpenseCreateResponseBody = {
					expense: { ...created.expense, splits: created.splits },
					warning: null,
				};
				if (idemScope && idemKey) {
					await finalizeExpenseCreateClaim(tx, idemScope, idemKey, body);
				}
				return { replayed: false as const, expense: created.expense, body };
			});
		} catch (writeErr) {
			if (
				recurringExpenseId &&
				expectedRecurringNextDueAt &&
				isRecurringDueUniqueViolation(writeErr)
			) {
				const replayed = await withExpensePaymentLock(wg.id, async (tx) => {
					if (idemScope && idemKey) {
						const replay = await lockExpenseCreateClaim(tx, idemScope, idemKey);
						if (replay) return replay;
					}
					const existing = await findRecurringExpense(
						tx,
						wg.id,
						recurringExpenseId,
						new Date(expectedRecurringNextDueAt),
					);
					if (!existing) return null;
					const body: ExpenseCreateResponseBody = {
						expense: { ...existing.expense, splits: existing.splits },
						warning: null,
					};
					if (idemScope && idemKey) {
						await finalizeExpenseCreateClaim(tx, idemScope, idemKey, body);
					}
					return body;
				});
				if (replayed) {
					replayReservation?.resolve(replayed);
					return NextResponse.json(replayed);
				}
			}

			const recurringErrorResponse = expenseCreateAbortResponse(writeErr);
			if (recurringErrorResponse) {
				if (idemScope && idemKey) {
					await withExpensePaymentLock(wg.id, async (tx) => {
						await tx
							.delete(idempotencyResponses)
							.where(
								and(
									eq(idempotencyResponses.scope, idemScope),
									eq(idempotencyResponses.key, idemKey),
									sql`${idempotencyResponses.responseBody} = '{"_claimed":true}'::jsonb`,
								),
							);
					});
				}
				replayReservation?.reject(writeErr);
				return recurringErrorResponse;
			}

			replayReservation?.reject(writeErr);
			if (writeErr instanceof TransactionAbort) return serverError(writeErr.code);
			throw writeErr;
		}
		if (written.replayed) {
			replayReservation?.resolve(written.body);
			return NextResponse.json(written.body);
		}

		const warning = await recordExpenseCreatedSideEffects({
			wg,
			actor: { memberId: auth.member.memberId, name: auth.member.name },
			expense: written.expense,
		});

		let responseBody = { ...written.body, warning };
		if (idemScope && idemKey && warning !== null) {
			try {
				const rows = await db
					.update(idempotencyResponses)
					.set({
						responseBody: sql`jsonb_set(${idempotencyResponses.responseBody}, '{warning}', to_jsonb(${warning}::text))`,
					})
					.where(
						and(
							eq(idempotencyResponses.scope, idemScope),
							eq(idempotencyResponses.key, idemKey),
							gt(idempotencyResponses.expiresAt, new Date()),
							sql`${idempotencyResponses.responseBody}->'expense'->>'id' = ${written.expense.id}`,
							sql`${idempotencyResponses.responseBody}->'warning' = 'null'::jsonb`,
						),
					)
					.returning({ scope: idempotencyResponses.scope });
				if (rows.length !== 1) {
					responseBody = written.body;
					logApiError(
						'[expenses POST] warning replay update missed',
						new Error('replay_warning_missed'),
					);
				}
			} catch (err) {
				responseBody = written.body;
				logApiError('[expenses POST] warning replay update failed', err);
			}
		}
		replayReservation?.resolve(responseBody);
		return NextResponse.json(responseBody);
	} catch (err) {
		replayReservation?.reject(err);
		const recurringErrorResponse = expenseCreateAbortResponse(err);
		if (recurringErrorResponse) return recurringErrorResponse;
		logApiError('[expenses POST]', err);
		return serverError(err);
	}
}
