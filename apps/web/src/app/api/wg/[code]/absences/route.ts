import { recordAuditEvent } from '@/core/audit';
import { db, idempotencyResponses, memberAbsences, wgMembers } from '@/core/db';
import { TransactionAbort, withTransaction } from '@/core/db/transaction';
import { badRequest, conflict, forbidden, serverError, tooMany } from '@/core/errors';
import { isVerifiedWgAdmin } from '@/core/guards/admin';
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
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { berlinDayKey, endOfBerlinDay, startOfBerlinDay } from '@/core/utils/berlin-day';
import { and, asc, eq, gt, gte, isNull, lte, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

type AbsenceCreateResponseBody = {
	absence: {
		id: string;
		wgId: string;
		memberId: string;
		startDate: string;
		endDate: string;
		reason: string | null;
	};
};

const absenceCreateReplay = new ReplayCache<AbsenceCreateResponseBody>(IDEMPOTENCY_TTL_MS);

function absenceCreateIdempotencyScope(wgId: string, memberId: string): string {
	return `absences-create:${wgId}:${memberId}`;
}

const createAbsenceSchema = z.object({
	memberId: z.string().uuid(),
	startDate: z.string().datetime({ offset: true }),
	endDate: z.string().datetime({ offset: true }),
	reason: z.string().trim().max(120).optional().nullable(),
});

export const GET = withWgRoute(
	'absences GET',
	async (req, { code }) => {
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;
		const rows = await db
			.select({
				id: memberAbsences.id,
				memberId: memberAbsences.memberId,
				memberName: wgMembers.name,
				startDate: memberAbsences.startDate,
				endDate: memberAbsences.endDate,
				reason: memberAbsences.reason,
			})
			.from(memberAbsences)
			.innerJoin(wgMembers, eq(wgMembers.id, memberAbsences.memberId))
			.where(
				and(
					eq(memberAbsences.wgId, wg.id),
					gte(memberAbsences.endDate, startOfBerlinDay(new Date())),
				),
			)
			.orderBy(asc(memberAbsences.startDate));

		return NextResponse.json({
			absences: rows.map((row) => ({
				...row,
				startDate: row.startDate.toISOString(),
				endDate: row.endDate.toISOString(),
			})),
		});
	},
	{
		fixture: () => {
			return NextResponse.json({ absences: [] });
		},
	},
);

export const POST = withWgRoute('absences POST', async (req, { code }) => {
	let replayReservation: Extract<
		ReplayReservation<AbsenceCreateResponseBody>,
		{ owned: true }
	> | null = null;
	let claimedLeaseExpiresAt: Date | null = null;
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}
	const parsed = createAbsenceSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.flatten();
		if (issues.fieldErrors.memberId) return badRequest('member_id_invalid');
		if (issues.fieldErrors.startDate || issues.fieldErrors.endDate)
			return badRequest('date_range_invalid');
		if (issues.fieldErrors.reason) return badRequest('reason_invalid');
		return badRequest('invalid_body');
	}
	const startDate = new Date(parsed.data.startDate);
	const endDate = new Date(parsed.data.endDate);
	if (endDate.getTime() < startDate.getTime()) return badRequest('date_range_invalid');
	if (berlinDayKey(endDate) < berlinDayKey(startDate)) return badRequest('date_range_invalid');
	const idemKey = readIdempotencyKey(req);
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;
	const idemScope = idemKey ? absenceCreateIdempotencyScope(wg.id, auth.member.memberId) : null;
	const idemReplayKey = idemScope && idemKey ? replayKey(idemScope, idemKey) : null;
	if (idemScope && idemKey && idemReplayKey) {
		const localReplay = absenceCreateReplay.get(idemReplayKey);
		if (localReplay) return NextResponse.json(await localReplay);
		const cached = await getCachedResponse<AbsenceCreateResponseBody>(idemScope, idemKey);
		if (cached) {
			absenceCreateReplay.remember(idemReplayKey, cached);
			return NextResponse.json(cached);
		}
	}
	const limited = await checkRateLimit(wgWriteLimiter, `absence:${wg.id}:${auth.member.memberId}`);
	if (!limited.success) return tooMany();

	const member = await db
		.select({ id: wgMembers.id })
		.from(wgMembers)
		.where(
			and(
				eq(wgMembers.wgId, wg.id),
				eq(wgMembers.id, parsed.data.memberId),
				isNull(wgMembers.deactivatedAt),
			),
		)
		.limit(1);
	if (member.length === 0) return badRequest('member_not_in_wg');

	// A bare x-manawg-member-id is spoofable, so self-ownership only counts
	// with a verified HMAC token.
	const isOwner = auth.member.verified && parsed.data.memberId === auth.member.memberId;
	if (!isOwner && !(await isVerifiedWgAdmin(wg.id, auth.member.memberId, auth.member.verified))) {
		return forbidden('not_owner', 'not_owner');
	}

	const replaySlot = idemReplayKey === null ? null : absenceCreateReplay.reserve(idemReplayKey);
	if (replaySlot?.owned === false) return NextResponse.json(await replaySlot.promise);
	replayReservation = replaySlot;

	try {
		if (idemScope && idemKey) {
			const slot = await claimReplaySlotWithRetry<AbsenceCreateResponseBody>(idemScope, idemKey);
			if (!slot.won) {
				replayReservation?.resolve(slot.cached);
				return NextResponse.json(slot.cached);
			}
		}
		const creation = await withTransaction(async (tx) => {
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
				if (slot.body && typeof slot.body === 'object' && 'absence' in slot.body) {
					return { kind: 'replayed' as const, body: slot.body as AbsenceCreateResponseBody };
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
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${`absence:${wg.id}:${parsed.data.memberId}`}))`,
			);
			const overlappingAbsence = await tx
				.select({ id: memberAbsences.id })
				.from(memberAbsences)
				.where(
					and(
						eq(memberAbsences.wgId, wg.id),
						eq(memberAbsences.memberId, parsed.data.memberId),
						lte(memberAbsences.startDate, endOfBerlinDay(endDate)),
						gte(memberAbsences.endDate, startOfBerlinDay(startDate)),
					),
				)
				.limit(1);
			if (overlappingAbsence.length > 0) return { kind: 'overlap' as const };
			const [created] = await tx
				.insert(memberAbsences)
				.values({
					wgId: wg.id,
					memberId: parsed.data.memberId,
					startDate,
					endDate,
					reason: parsed.data.reason || null,
				})
				.returning();
			if (!created) throw new TransactionAbort('insert_failed');
			const body: AbsenceCreateResponseBody = {
				absence: {
					...created,
					startDate: created.startDate.toISOString(),
					endDate: created.endDate.toISOString(),
				},
			};
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
					logApiError('[absences POST] replay write failed', err);
					throw new TransactionAbort('idempotency_response_write_failed');
				}
				if (rows.length !== 1) throw new TransactionAbort('idempotency_response_write_failed');
			}
			return { kind: 'created' as const, absence: created, body };
		});
		if (creation.kind === 'replayed') {
			replayReservation?.resolve(creation.body);
			return NextResponse.json(creation.body);
		}
		if (creation.kind === 'overlap') {
			const err = new Error('absence_overlaps_existing');
			replayReservation?.reject(err);
			if (idemScope && idemKey && claimedLeaseExpiresAt) {
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
					logApiError('[absences POST] claim release failed', releaseErr);
				}
			}
			return conflict('absence_overlaps_existing', 'absence_overlaps_existing');
		}
		const absence = creation.absence;
		await recordAuditEvent({
			wgId: wg.id,
			memberId: auth.member.memberId,
			eventType: 'absence.created',
			entityType: 'absence',
			entityId: absence.id,
			summary: `${auth.member.name} hat eine Abwesenheit eingetragen.`,
			metadata: {
				memberId: parsed.data.memberId,
				startDate: absence.startDate.toISOString(),
				endDate: absence.endDate.toISOString(),
				reason: absence.reason,
			},
		});
		replayReservation?.resolve(creation.body);
		return NextResponse.json(creation.body);
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
					logApiError('[absences POST] claim release failed', releaseErr);
				}
			}
			return serverError(err.code);
		}
		throw err;
	}
});
