import { recordAuditEvent } from '@/core/audit';
import {
	announcements,
	choreCompletions,
	chores,
	db,
	idempotencyResponses,
	memberAbsences,
	wgMembers,
} from '@/core/db';
import { TransactionAbort, withTransaction } from '@/core/db/transaction';
import { badRequest, conflict, notFound, serverError, tooMany } from '@/core/errors';
import { UUID_PATTERN } from '@/core/guards/api-auth';
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
import { startOfBerlinDay } from '@/core/utils/berlin-day';
import { getAbsentMemberIds } from '@/features/chores/absence';
import {
	chooseNextAvailableMember,
	computeOpenGapsByMember,
} from '@/features/chores/chore-fairness';
import { computeNextDueAt, isLateCompletion } from '@/features/chores/chore-recurrence';
import { and, eq, gt, gte, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

type ChoreCompleteResponseBody = { chore: unknown };

const choreCompleteReplay = new ReplayCache<ChoreCompleteResponseBody>(IDEMPOTENCY_TTL_MS);

function choreCompleteIdempotencyScope(wgId: string, memberId: string, choreId: string): string {
	return `chores-complete:${wgId}:${memberId}:${choreId}`;
}

async function releaseChoreCompleteClaim(
	scope: string,
	key: string,
	expiresAt: Date,
): Promise<void> {
	try {
		await db
			.delete(idempotencyResponses)
			.where(
				and(
					eq(idempotencyResponses.scope, scope),
					eq(idempotencyResponses.key, key),
					eq(idempotencyResponses.expiresAt, expiresAt),
					sql`${idempotencyResponses.responseBody} = '{"_claimed":true}'::jsonb`,
				),
			);
	} catch (err) {
		logApiError('[chore complete POST] claim release failed', err);
	}
}

export const POST = withWgRoute<{ id: string }>(
	'chore complete POST',
	async (req, { code, id }) => {
		let replayReservation: Extract<
			ReplayReservation<ChoreCompleteResponseBody>,
			{ owned: true }
		> | null = null;
		let claimedLeaseExpiresAt: Date | null = null;
		if (!UUID_PATTERN.test(id)) return badRequest('id_invalid');
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const chore = await db
			.select({
				id: chores.id,
				wgId: chores.wgId,
				intervalDays: chores.intervalDays,
				recurrenceType: chores.recurrenceType,
				title: chores.title,
				assignedMemberId: chores.assignedMemberId,
				nextDueAt: chores.nextDueAt,
				anchorAt: chores.anchorAt,
			})
			.from(chores)
			.where(and(eq(chores.id, id), eq(chores.wgId, auth.wg.id)))
			.limit(1);
		const c = chore[0];
		if (!c) return notFound('chore_not_found');
		const idemKey = readIdempotencyKey(req);
		const idemScope = idemKey
			? choreCompleteIdempotencyScope(c.wgId, auth.member.memberId, c.id)
			: null;
		const idemReplayKey = idemScope && idemKey ? replayKey(idemScope, idemKey) : null;
		if (idemScope && idemKey && idemReplayKey) {
			const localReplay = choreCompleteReplay.get(idemReplayKey);
			if (localReplay) return NextResponse.json(await localReplay);
			const cached = await getCachedResponse<ChoreCompleteResponseBody>(idemScope, idemKey);
			if (cached) {
				choreCompleteReplay.remember(idemReplayKey, cached);
				return NextResponse.json(cached);
			}
		}
		let raw: unknown;
		try {
			raw = await req.json();
		} catch {
			return badRequest('invalid_json');
		}
		const body =
			raw !== null && typeof raw === 'object' && !Array.isArray(raw)
				? (raw as Record<string, unknown>)
				: {};
		const expectedNextDueAt = body.expectedNextDueAt;
		const hasExpectedAssignee = Object.hasOwn(body, 'expectedAssignedMemberId');
		const expectedAssignedMemberId = body.expectedAssignedMemberId;
		// Old queued actions contain only choreId. Keep them visible as a conflict;
		// never reinterpret them as a completion of the current occurrence.
		if (typeof expectedNextDueAt !== 'string' || !hasExpectedAssignee) {
			return conflict('chore_occurrence_changed');
		}
		if (
			!Number.isFinite(Date.parse(expectedNextDueAt)) ||
			(expectedAssignedMemberId !== null &&
				(typeof expectedAssignedMemberId !== 'string' ||
					!UUID_PATTERN.test(expectedAssignedMemberId)))
		) {
			return badRequest('expected_occurrence_invalid');
		}
		if (
			Date.parse(expectedNextDueAt) !== c.nextDueAt.getTime() ||
			expectedAssignedMemberId !== c.assignedMemberId
		) {
			return conflict('chore_occurrence_changed');
		}
		const limited = await checkRateLimit(wgWriteLimiter, `chore:${c.wgId}:${auth.member.memberId}`);
		if (!limited.success) return tooMany();

		// SECURITY: completedBy is always the authenticated caller. Any
		// body-supplied attribution remains ignored.
		const completedBy = auth.member.memberId;
		const replaySlot = idemReplayKey === null ? null : choreCompleteReplay.reserve(idemReplayKey);
		if (replaySlot?.owned === false) return NextResponse.json(await replaySlot.promise);
		replayReservation = replaySlot;

		try {
			if (idemScope && idemKey) {
				const slot = await claimReplaySlotWithRetry<ChoreCompleteResponseBody>(idemScope, idemKey);
				if (!slot.won) {
					replayReservation?.resolve(slot.cached);
					return NextResponse.json(slot.cached);
				}
				const [claimed] = await db
					.select({
						body: idempotencyResponses.responseBody,
						expiresAt: idempotencyResponses.expiresAt,
					})
					.from(idempotencyResponses)
					.where(
						and(eq(idempotencyResponses.scope, idemScope), eq(idempotencyResponses.key, idemKey)),
					)
					.limit(1);
				if (!claimed) throw new TransactionAbort('idempotency_claim_missing');
				if (
					!claimed.body ||
					typeof claimed.body !== 'object' ||
					Array.isArray(claimed.body) ||
					Object.keys(claimed.body).length !== 1 ||
					(claimed.body as { _claimed?: unknown })._claimed !== true
				) {
					throw new TransactionAbort('idempotency_claim_invalid');
				}
				claimedLeaseExpiresAt = claimed.expiresAt;
			}

			// Anchor next-due on the previous due (clamped to "now" if overdue) so
			// that early completions do not slide the cadence forward week-over-
			// week. See features/chores/chore-recurrence.ts.
			const completedAt = new Date();
			const nextDueAt = computeNextDueAt(
				c.nextDueAt,
				c.intervalDays,
				completedAt,
				c.recurrenceType,
				c.anchorAt,
			);
			// A late completion re-anchors the monthly cycle on completedAt;
			// otherwise keep the stored anchor (adopting nextDueAt for legacy rows).
			const late = isLateCompletion(c.nextDueAt, completedAt);
			const effectiveAnchor = late ? completedAt : (c.anchorAt ?? c.nextDueAt);
			// Only active members join the rotation. A moved-out ("deactivated")
			// member is skipped, so the next chore never lands on someone who left.
			// Score-aware rotation: fetch WG chore snapshot (just the fields the
			// fairness ranker needs) so chooseNextAvailableMember matches what the
			// UI's "Nächste:r" hint shows. Without this snapshot, server falls back
			// to pure round-robin and silently disagrees with the UI prediction.
			const [members, absenceRows, wgChoresSnapshot] = await Promise.all([
				db
					.select({ id: wgMembers.id, name: wgMembers.name })
					.from(wgMembers)
					.where(and(eq(wgMembers.wgId, c.wgId), isNull(wgMembers.deactivatedAt)))
					.orderBy(wgMembers.createdAt),
				db
					.select({
						memberId: memberAbsences.memberId,
						startDate: memberAbsences.startDate,
						endDate: memberAbsences.endDate,
					})
					.from(memberAbsences)
					.where(
						and(
							eq(memberAbsences.wgId, c.wgId),
							gte(memberAbsences.endDate, startOfBerlinDay(nextDueAt)),
						),
					),
				db
					.select({
						assignedMemberId: chores.assignedMemberId,
						nextDueAt: chores.nextDueAt,
					})
					.from(chores)
					.where(eq(chores.wgId, c.wgId)),
			]);
			const absentMemberIds = getAbsentMemberIds(
				absenceRows.map((absence) => ({
					memberId: absence.memberId,
					startDate: absence.startDate.toISOString(),
					endDate: absence.endDate.toISOString(),
				})),
				// The next assignee has to be available on the next due day, not
				// today: someone back tomorrow can take a chore due next week.
				nextDueAt.getTime(),
			);
			// Reuse the same shared helper GET /chores uses so
			// openGapCountForAssignee here matches the UI's "Nächste:r" prediction
			// exactly instead of being hardcoded to 0.
			const openGapsByMember = computeOpenGapsByMember(
				wgChoresSnapshot.map((row) => ({
					assignedMemberId: row.assignedMemberId,
					nextDueAt: row.nextDueAt.toISOString(),
				})),
				completedAt.getTime(),
			);
			const nextAssigned = chooseNextAvailableMember({
				members,
				currentMemberId: c.assignedMemberId,
				absentMemberIds,
				chores: wgChoresSnapshot.map((row) => ({
					assignedMemberId: row.assignedMemberId,
					openGapCountForAssignee: row.assignedMemberId
						? (openGapsByMember.get(row.assignedMemberId) ?? 0)
						: 0,
					nextDueAt: row.nextDueAt.toISOString(),
				})),
			});

			// Only advance the snapshot used for cadence and rotation. A concurrent
			// completion or edit must be retried against the new state.
			//
			// The rotation UPDATE and the choreCompletions INSERT are one atomic
			// unit: chore-fairness.ts reads choreCompletions to count who did what,
			// so a rotation that commits without its completion row would silently
			// undercount that person forever. Losing the CAS race is a normal,
			// expected outcome (someone else's click already won) and still commits
			// as a no-op — only a genuine insert failure rolls the rotation back.
			const previousNextDueAt = c.nextDueAt;
			const assigneeMatch = c.assignedMemberId
				? eq(chores.assignedMemberId, c.assignedMemberId)
				: isNull(chores.assignedMemberId);
			const guard = and(
				eq(chores.id, c.id),
				assigneeMatch,
				eq(chores.nextDueAt, previousNextDueAt),
				eq(chores.intervalDays, c.intervalDays),
				eq(chores.recurrenceType, c.recurrenceType),
			);
			// Reset lastReminderAt whenever assignee actually changes so the new
			// owner is not silently muted by the old assignee's 18h throttle. Keep
			// the stamp when assignee is unchanged (single-member WG) to avoid
			// double-firing reminders within the same day.
			const reminderReset = nextAssigned !== c.assignedMemberId ? { lastReminderAt: null } : {};

			let txResult:
				| { raced: true }
				| { raced: false; chore: typeof chores.$inferSelect }
				| { replayed: true; body: ChoreCompleteResponseBody };
			try {
				txResult = await withTransaction(async (tx) => {
					if (idemScope && idemKey) {
						const [slot] = await tx
							.select({
								body: idempotencyResponses.responseBody,
								expiresAt: idempotencyResponses.expiresAt,
							})
							.from(idempotencyResponses)
							.where(
								and(
									eq(idempotencyResponses.scope, idemScope),
									eq(idempotencyResponses.key, idemKey),
								),
							)
							.limit(1)
							.for('update');
						if (!slot) throw new TransactionAbort('idempotency_claim_missing');
						if (
							slot.body &&
							typeof slot.body === 'object' &&
							!Array.isArray(slot.body) &&
							'chore' in slot.body
						) {
							return { replayed: true as const, body: slot.body as ChoreCompleteResponseBody };
						}
						if (
							!slot.body ||
							typeof slot.body !== 'object' ||
							Array.isArray(slot.body) ||
							Object.keys(slot.body).length !== 1 ||
							(slot.body as { _claimed?: unknown })._claimed !== true
						) {
							throw new TransactionAbort('idempotency_claim_invalid');
						}
						claimedLeaseExpiresAt = slot.expiresAt;
					}
					const updatedRows = await tx
						.update(chores)
						.set({
							nextDueAt,
							assignedMemberId: nextAssigned,
							anchorAt: effectiveAnchor,
							...reminderReset,
						})
						.where(guard)
						.returning();
					const updated = updatedRows[0];
					if (!updated) {
						// Another concurrent completion already advanced the assignee.
						// Normal outcome — commit as a no-op rather than rotating again.
						return { raced: true as const };
					}

					const [completion] = await tx
						.insert(choreCompletions)
						.values({
							choreId: c.id,
							completedByMemberId: completedBy,
						})
						.returning({ id: choreCompletions.id });
					if (!completion) throw new TransactionAbort('completion_insert_failed');

					await tx
						.update(announcements)
						.set({
							status: 'resolved',
							resolvedAt: completedAt,
							resolvedByMemberId: completedBy,
							updatedAt: completedAt,
						})
						.where(
							and(
								eq(announcements.wgId, c.wgId),
								eq(announcements.status, 'open'),
								eq(announcements.source, 'chore_swap'),
								eq(announcements.sourcePath, `/putzen?highlight=${encodeURIComponent(c.id)}`),
							),
						);
					if (idemScope && idemKey && replayReservation?.owned) {
						if (!claimedLeaseExpiresAt) {
							throw new TransactionAbort('idempotency_claim_missing');
						}
						let replayRows: Array<{ scope: string }>;
						try {
							replayRows = await tx
								.update(idempotencyResponses)
								.set({
									responseBody: { chore: updated },
									expiresAt: new Date(Date.now() + RESPONSE_REPLAY_TTL_SECONDS * 1000),
								})
								.where(
									and(
										eq(idempotencyResponses.scope, idemScope),
										eq(idempotencyResponses.key, idemKey),
										eq(idempotencyResponses.expiresAt, claimedLeaseExpiresAt),
										gt(idempotencyResponses.expiresAt, new Date()),
										sql`${idempotencyResponses.responseBody} = '{"_claimed":true}'::jsonb`,
									),
								)
								.returning({ scope: idempotencyResponses.scope });
						} catch (err) {
							logApiError('[chore complete POST] replay write failed', err);
							throw new TransactionAbort('idempotency_response_write_failed');
						}
						if (replayRows.length !== 1) {
							throw new TransactionAbort('idempotency_response_write_failed');
						}
					}

					return { raced: false as const, chore: updated };
				});
			} catch (err) {
				if (err instanceof TransactionAbort) {
					replayReservation?.reject(err);
					if (idemScope && idemKey && claimedLeaseExpiresAt) {
						await releaseChoreCompleteClaim(idemScope, idemKey, claimedLeaseExpiresAt);
					}
					logApiError('[chore complete POST] completion insert failed', err);
					return serverError(err.code);
				}
				replayReservation?.reject(err);
				logApiError('[chore complete POST] transaction failed', err);
				return serverError('completion_insert_failed');
			}

			if ('replayed' in txResult) {
				replayReservation?.resolve(txResult.body);
				return NextResponse.json(txResult.body);
			}
			if (txResult.raced) {
				const err = new Error('chore_already_completed');
				replayReservation?.reject(err);
				if (idemScope && idemKey && claimedLeaseExpiresAt) {
					await releaseChoreCompleteClaim(idemScope, idemKey, claimedLeaseExpiresAt);
				}
				return conflict('chore_already_completed');
			}
			const updated = txResult.chore;

			await recordAuditEvent({
				wgId: c.wgId,
				memberId: completedBy,
				eventType: 'chore.completed',
				entityType: 'chore',
				entityId: c.id,
				summary: `${auth.member.name} hat ${c.title} erledigt.`,
				metadata: { nextAssignedMemberId: nextAssigned },
			});

			const responseBody = { chore: updated };
			if (idemScope && idemKey && replayReservation?.owned) {
				replayReservation.resolve(responseBody);
			}
			return NextResponse.json(responseBody);
		} catch (err) {
			replayReservation?.reject(err);
			throw err;
		}
	},
);
