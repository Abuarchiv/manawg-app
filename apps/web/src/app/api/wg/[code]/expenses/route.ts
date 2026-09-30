import { db, expenseSplits, expenses, idempotencyResponses } from '@/core/db';
import { TransactionAbort } from '@/core/db/transaction';
import { apiError, badRequest, serverError, tooMany } from '@/core/errors';
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
import { checkRateLimit, wgReadLimiter, wgWriteLimiter } from '@/core/rate-limit';
import { currencySchema } from '@/core/validators/currency';
import { imageUrlSchema, isAllowedImageUrlForWg } from '@/core/validators/image-url';
import { AMOUNT_MAX_CENTS, AMOUNT_MIN_CENTS } from '@/features/expenses/expense-constants';
import {
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
import { and, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const DESCRIPTION_MIN = 1;
const DESCRIPTION_MAX = 200;
const MAX_SPLITS = 50;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

// GET pagination, mirroring `members`: the default keeps the historic
// full-history payload (the ausgaben/mahnungen pages compute net balances
// from this list), while the hard ceiling is what bounds the read — it keeps
// the `inArray(expenseId, ids)` below Postgres' 65,535 bind-parameter cap
// (a WG past that row count answered 500 instead of data) and lets clients
// page with limit/offset.
const EXPENSES_PAGE_LIMIT_DEFAULT = 50_000;
const EXPENSES_PAGE_LIMIT_MAX = 50_000;

function readPageParams(req: NextRequest): { limit: number; offset: number } {
	const params = req.nextUrl.searchParams;
	const rawLimit = Number.parseInt(params.get('limit') ?? '', 10);
	const rawOffset = Number.parseInt(params.get('offset') ?? '', 10);
	const limit = Number.isFinite(rawLimit)
		? Math.min(Math.max(rawLimit, 1), EXPENSES_PAGE_LIMIT_MAX)
		: EXPENSES_PAGE_LIMIT_DEFAULT;
	const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
	return { limit, offset };
}

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

export const GET = withWgRoute(
	'expenses GET',
	async (req, { code }) => {
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wgId = auth.wg.id;

		// Route-level read budget on top of the middleware's per-IP limit: keyed
		// per member so flatmates behind one NAT share neither the scrape budget
		// nor the lockout (same rationale as the dashboard throttle).
		const limited = await checkRateLimit(wgReadLimiter, `expenses:${wgId}:${auth.member.memberId}`);
		if (!limited.success) return tooMany();

		const { limit, offset } = readPageParams(req);
		const [rows, totalRows] = await Promise.all([
			db
				.select()
				.from(expenses)
				.where(eq(expenses.wgId, wgId))
				.orderBy(desc(expenses.occurredAt), desc(expenses.id))
				.limit(limit)
				.offset(offset),
			db.select({ total: count() }).from(expenses).where(eq(expenses.wgId, wgId)),
		]);

		const pagination = { total: totalRows[0]?.total ?? 0, limit, offset };
		if (rows.length === 0) return NextResponse.json({ expenses: [], pagination });

		// Bounded by the page limit above (≤ EXPENSES_PAGE_LIMIT_MAX < 65,535),
		// so this inArray can never exceed Postgres' bind-parameter cap.
		const expenseIds = rows.map((r) => r.id);
		const [splits, payments] = await Promise.all([
			db.select().from(expenseSplits).where(inArray(expenseSplits.expenseId, expenseIds)),
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
			pagination,
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

	const {
		amountCents,
		description,
		currency,
		imageUrl,
		occurredAt: occurredAtStr,
		splits: validatedSplits,
		paidByMemberId,
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
					if (slot.body && typeof slot.body === 'object' && 'expense' in slot.body) {
						return { replayed: true as const, body: slot.body as ExpenseCreateResponseBody };
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
				const created = await insertExpenseWithSplits(tx, {
					wgId: wg.id,
					paidByMemberId: paidBy,
					amountCents,
					currency,
					description,
					imageUrl: safeImageUrl,
					occurredAt,
					splits: validatedSplits,
				});
				const body: ExpenseCreateResponseBody = {
					expense: { ...created.expense, splits: created.splits },
					warning: null,
				};
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
				return { replayed: false as const, expense: created.expense, body };
			});
		} catch (writeErr) {
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
		logApiError('[expenses POST]', err);
		return serverError(err);
	}
}
