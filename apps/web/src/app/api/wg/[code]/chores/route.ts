import { recordAuditEvent } from '@/core/audit';
import {
	CHORE_RECURRENCE_TYPES,
	choreCompletions,
	chores,
	db,
	idempotencyResponses,
	wgMembers,
} from '@/core/db';
import { TransactionAbort, withTransaction } from '@/core/db/transaction';
import { badRequest, serverError, tooMany } from '@/core/errors';
import {
	ReplayCache,
	type ReplayReservation,
	claimReplaySlotWithRetry,
	replayKey,
} from '@/core/guards/idempotency';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import {
	RESPONSE_REPLAY_TTL_SECONDS,
	getCachedResponse,
	readIdempotencyKey,
} from '@/core/idempotency';
import { logApiError } from '@/core/infra/observability';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { berlinDayKey, startOfBerlinDay } from '@/core/utils/berlin-day';
import { MS_PER_DAY } from '@/core/utils/time';
import { computeOpenGapsByMember } from '@/features/chores/chore-fairness';
import { computeNextDueAt } from '@/features/chores/chore-recurrence';
import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const TITLE_MIN = 1;
const TITLE_MAX = 120;
const INTERVAL_MIN = 1;
// Cap depends on unit: 365 days OR 60 months (=5y) — both reasonable for a WG.
const INTERVAL_MAX_DAYS = 365;
const INTERVAL_MAX_MONTHS = 60;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

type ChoreCreateWarning = null | 'notification_delivery_failed' | 'notification_delivery_unknown';

type ChoreCreateResponseBody = { chore: unknown; warning: ChoreCreateWarning };

const choreCreateReplay = new ReplayCache<ChoreCreateResponseBody>(IDEMPOTENCY_TTL_MS);

function choreCreateIdempotencyScope(wgId: string, memberId: string): string {
	return `chores-create:${wgId}:${memberId}`;
}
const createChoreSchema = z
	.object({
		title: z.string().trim().min(TITLE_MIN).max(TITLE_MAX),
		intervalDays: z.number().int().min(INTERVAL_MIN).optional().default(7),
		// z.enum requires a mutable tuple; spread the readonly schema constant.
		recurrenceType: z
			.enum([...CHORE_RECURRENCE_TYPES])
			.optional()
			.default('days'),
		assignedMemberId: z.string().uuid().optional().nullable(),
		nextDueAt: z.string().datetime({ offset: true }).optional(),
	})
	.superRefine((data, ctx) => {
		const cap = data.recurrenceType === 'months' ? INTERVAL_MAX_MONTHS : INTERVAL_MAX_DAYS;
		if (data.intervalDays > cap) {
			ctx.addIssue({
				code: z.ZodIssueCode.too_big,
				maximum: cap,
				inclusive: true,
				type: 'number',
				path: ['intervalDays'],
				message: `intervalDays must be <= ${cap} for recurrenceType=${data.recurrenceType}`,
			});
		}
	});

export const GET = withWgRoute(
	'chores GET',
	async (req, { code }) => {
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wgId = auth.wg.id;
		const items = await db
			.select()
			.from(chores)
			.where(eq(chores.wgId, wgId))
			.orderBy(asc(chores.nextDueAt));

		if (items.length === 0) {
			return NextResponse.json({ chores: [] });
		}

		const choreIds = items.map((item) => item.id);
		const now = Date.now();
		const monthStart = startOfBerlinDay(new Date(`${berlinDayKey(new Date(now)).slice(0, 7)}-01`));
		// Only the latest completion per chore and this month's per-member counts
		// are returned, so load exactly that instead of the full history. The
		// (chore_id, completed_at) index serves the DISTINCT ON; counts keep the
		// previous key order (most recent completer first).
		const [latestRows, monthRows] = await Promise.all([
			db
				.selectDistinctOn([choreCompletions.choreId], {
					choreId: choreCompletions.choreId,
					completedAt: choreCompletions.completedAt,
					completedByName: wgMembers.name,
				})
				.from(choreCompletions)
				.innerJoin(wgMembers, eq(wgMembers.id, choreCompletions.completedByMemberId))
				.where(inArray(choreCompletions.choreId, choreIds))
				.orderBy(choreCompletions.choreId, desc(choreCompletions.completedAt)),
			db
				.select({
					memberId: choreCompletions.completedByMemberId,
					count: sql<number>`count(*)::int`,
				})
				.from(choreCompletions)
				.where(
					and(
						inArray(choreCompletions.choreId, choreIds),
						gte(choreCompletions.completedAt, monthStart),
					),
				)
				.groupBy(choreCompletions.completedByMemberId)
				.orderBy(sql`max(${choreCompletions.completedAt}) desc`),
		]);

		const latestCompletionByChore = new Map<
			string,
			{ completedAt: Date; completedByName: string }
		>();
		for (const row of latestRows) {
			latestCompletionByChore.set(row.choreId, {
				completedAt: row.completedAt,
				completedByName: row.completedByName,
			});
		}

		const monthCompletions: Record<string, number> = {};
		for (const row of monthRows) monthCompletions[row.memberId] = Number(row.count);

		const openGapsByMember = computeOpenGapsByMember(
			items.map((item) => ({
				assignedMemberId: item.assignedMemberId,
				nextDueAt: item.nextDueAt.toISOString(),
			})),
			now,
		);

		return NextResponse.json({
			monthCompletions,
			chores: items.map((item) => {
				const latest = latestCompletionByChore.get(item.id) ?? null;
				return {
					...item,
					lastCompletedAt: latest?.completedAt ?? null,
					lastCompletedByName: latest?.completedByName ?? null,
					openGapCountForAssignee: item.assignedMemberId
						? (openGapsByMember.get(item.assignedMemberId) ?? 0)
						: 0,
				};
			}),
		});
	},
	{
		fixture: (fixture) => {
			return NextResponse.json({
				chores: [
					{
						id: 'dc02a93f-59f6-4cf9-80a7-53d4a407cb49',
						wgId: fixture.id,
						title: 'Bad putzen',
						intervalDays: 7,
						recurrenceType: 'days',
						assignedMemberId: fixture.members[0]?.id ?? null,
						nextDueAt: new Date(Date.now() + MS_PER_DAY).toISOString(),
						createdAt: new Date().toISOString(),
						lastCompletedAt: null,
						lastCompletedByName: null,
						openGapCountForAssignee: 0,
					},
				],
			});
		},
	},
);

export const POST = withWgRoute('chores POST', async (req, { code }) => {
	let replayReservation: Extract<
		ReplayReservation<ChoreCreateResponseBody>,
		{ owned: true }
	> | null = null;
	let claimedLeaseExpiresAt: Date | null = null;
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}

	const parsed = createChoreSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.flatten();
		if (issues.fieldErrors.title) return badRequest('title_invalid');
		if (issues.fieldErrors.intervalDays) return badRequest('interval_invalid');
		if (issues.fieldErrors.recurrenceType) return badRequest('recurrence_type_invalid');
		if (issues.fieldErrors.assignedMemberId) return badRequest('member_id_invalid');
		if (issues.fieldErrors.nextDueAt) return badRequest('due_date_invalid');
		return badRequest('invalid_body');
	}

	const {
		title,
		intervalDays,
		recurrenceType,
		assignedMemberId = null,
		nextDueAt: nextDueAtStr,
	} = parsed.data;
	const createdAt = new Date();
	const nextDueAt = nextDueAtStr
		? new Date(nextDueAtStr)
		: // Calendar-aware initial due: months-based chores anchor on
			// today + N months (not today + 30N days), matching the cadence the
			// completion handler will use later. See chore-recurrence.ts.
			computeNextDueAt(createdAt, intervalDays, createdAt, recurrenceType);
	// Store the unclamped cadence anchor: a monthly chore created on 31.01 is
	// first due 28.02 but must keep day 31 for 31.03, 30.04, …
	const anchorAt = nextDueAtStr ? nextDueAt : createdAt;
	const idemKey = readIdempotencyKey(req);
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;
	const idemScope = idemKey ? choreCreateIdempotencyScope(wg.id, auth.member.memberId) : null;
	const idemReplayKey = idemScope && idemKey ? replayKey(idemScope, idemKey) : null;
	if (idemScope && idemKey && idemReplayKey) {
		const localReplay = choreCreateReplay.get(idemReplayKey);
		if (localReplay) return NextResponse.json(await localReplay);
		const cached = await getCachedResponse<ChoreCreateResponseBody>(idemScope, idemKey);
		if (cached) {
			choreCreateReplay.remember(idemReplayKey, cached);
			return NextResponse.json(cached);
		}
	}

	const limited = await checkRateLimit(wgWriteLimiter, `chore:${wg.id}:${auth.member.memberId}`);
	if (!limited.success) return tooMany();

	if (assignedMemberId) {
		// A chore may only be assigned to an active member — never to someone
		// who has moved out (deactivated).
		const memberExists = await db
			.select({ id: wgMembers.id })
			.from(wgMembers)
			.where(
				and(
					eq(wgMembers.id, assignedMemberId),
					eq(wgMembers.wgId, wg.id),
					isNull(wgMembers.deactivatedAt),
				),
			)
			.limit(1);
		if (memberExists.length === 0) return badRequest('member_not_in_wg');
	}
	const replaySlot = idemReplayKey === null ? null : choreCreateReplay.reserve(idemReplayKey);
	if (replaySlot?.owned === false) return NextResponse.json(await replaySlot.promise);
	replayReservation = replaySlot;

	try {
		if (idemScope && idemKey) {
			const slot = await claimReplaySlotWithRetry<ChoreCreateResponseBody>(idemScope, idemKey);
			if (!slot.won) {
				replayReservation?.resolve(slot.cached);
				return NextResponse.json(slot.cached);
			}
		}
		const written = await withTransaction(async (tx) => {
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
				if (slot.body && typeof slot.body === 'object' && 'chore' in slot.body) {
					return { replayed: true as const, body: slot.body as ChoreCreateResponseBody };
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
				claimedLeaseExpiresAt = slot.expiresAt;
			}
			const [chore] = await tx
				.insert(chores)
				.values({
					wgId: wg.id,
					title,
					intervalDays,
					recurrenceType,
					assignedMemberId,
					nextDueAt,
					anchorAt,
				})
				.returning();
			if (!chore) throw new TransactionAbort('insert_failed');
			const body: ChoreCreateResponseBody = { chore, warning: null };
			if (idemScope && idemKey) {
				let rows: Array<{ scope: string }>;
				try {
					rows = await tx
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
				} catch (err) {
					logApiError('[chores POST] replay write failed', err);
					throw new TransactionAbort('idempotency_response_write_failed');
				}
				if (rows.length !== 1) throw new TransactionAbort('idempotency_response_write_failed');
			}
			return { replayed: false as const, chore, body };
		});
		if (written.replayed) {
			replayReservation?.resolve(written.body);
			return NextResponse.json(written.body);
		}
		const chore = written.chore;
		await recordAuditEvent({
			wgId: wg.id,
			memberId: auth.member.memberId,
			eventType: 'chore.created',
			entityType: 'chore',
			entityId: chore.id,
			summary: `${auth.member.name} hat ${chore.title} im Putzplan angelegt.`,
			metadata: {
				title: chore.title,
				intervalDays: chore.intervalDays,
				recurrenceType: chore.recurrenceType,
				assignedMemberId: chore.assignedMemberId,
				nextDueAt: chore.nextDueAt,
			},
		});
		let warning: ChoreCreateWarning = null;
		if (assignedMemberId && nextDueAt.getTime() <= Date.now() + MS_PER_DAY) {
			({ warning } = await dispatchNotificationSafely({
				wg,
				event: 'chore.due',
				payload: { title, choreId: chore.id, nextDueAt: nextDueAt.toISOString() },
				targetMemberIds: [assignedMemberId],
			}));
		}
		let responseBody: ChoreCreateResponseBody = { ...written.body, warning };
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
							sql`${idempotencyResponses.responseBody}->'chore'->>'id' = ${chore.id}`,
							sql`${idempotencyResponses.responseBody}->'warning' = 'null'::jsonb`,
						),
					)
					.returning({ scope: idempotencyResponses.scope });
				if (rows.length !== 1) {
					responseBody = written.body;
					logApiError(
						'[chores POST] warning replay update missed',
						new Error('replay_warning_missed'),
					);
				}
			} catch (err) {
				responseBody = written.body;
				logApiError('[chores POST] warning replay update failed', err);
			}
		}
		replayReservation?.resolve(responseBody);
		return NextResponse.json(responseBody);
	} catch (err) {
		replayReservation?.reject(err);
		if (err instanceof TransactionAbort) {
			if (
				idemScope &&
				idemKey &&
				claimedLeaseExpiresAt &&
				['insert_failed', 'idempotency_response_write_failed'].includes(err.code)
			) {
				try {
					await db
						.delete(idempotencyResponses)
						.where(
							and(
								eq(idempotencyResponses.scope, idemScope),
								eq(idempotencyResponses.key, idemKey),
								eq(idempotencyResponses.expiresAt, claimedLeaseExpiresAt),
								sql`${idempotencyResponses.responseBody} = '{"_claimed":true}'::jsonb`,
							),
						);
				} catch (releaseErr) {
					logApiError('[chores POST] claim release failed', releaseErr);
				}
			}
			return serverError(err.code);
		}
		throw err;
	}
});
