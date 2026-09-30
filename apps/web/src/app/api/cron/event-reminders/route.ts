import { db, idempotencyResponses, wgEvents, wgMembers, wgs } from '@/core/db';
import { verifyCronSecret } from '@/core/infra/cron-auth';
import { withCronLogging } from '@/core/infra/observability';
import { dispatchNotification } from '@/core/notifications/notification-dispatch';
import { startOfBerlinDay } from '@/core/utils/berlin-day';
import { MS_PER_DAY } from '@/core/utils/time';
import {
	EVENT_REMINDER_BUDGET,
	type EventReminderCopy,
	collectReminderOccurrences,
	processReminderBatches,
	reminderCopyForOccurrence,
} from '@/features/events/event-reminder-dispatch';
import {
	buildEventsWindowFilter,
	computeTomorrowUtcWindow,
	withEventWindowCandidates,
} from '@/features/events/event-reminder-window';
import { type EventInput, expandRecurrence } from '@/features/events/events';
import { and, asc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

const REMINDER_CLAIM_SCOPE = 'event-reminders';
const REMINDER_CLAIM_TTL_MS = 32 * MS_PER_DAY;
const REMINDER_CLAIM_LEASE_MS = 60 * 60 * 1000;

interface EventRow {
	id: string;
	title: string;
	description: string | null;
	startsAt: Date;
	endsAt: Date | null;
	allDay: boolean;
	location: string | null;
	recurrence: string | null;
	wgId: string;
	wgName: string;
	shareCode: string;
}

function toEventInput(row: EventRow): EventInput {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		startsAt: row.startsAt.toISOString(),
		endsAt: row.endsAt ? row.endsAt.toISOString() : null,
		allDay: row.allDay,
		location: row.location,
		recurrence: row.recurrence,
	};
}

type ReminderDelivery = EventRow & {
	occurrenceStartsAt: string;
	occurrenceEndsAt: string | null;
	memberId: string;
	reminderCopy: EventReminderCopy;
};

function legacyReminderClaimKey(
	item: Pick<EventRow, 'id'> & { occurrenceStartsAt: string },
): string {
	return `${item.id}:${item.occurrenceStartsAt}`;
}

function reminderClaimKey(item: ReminderDelivery): string {
	return `${legacyReminderClaimKey(item)}:${item.memberId}`;
}

async function claimReminderDispatch(item: ReminderDelivery, now: Date): Promise<boolean> {
	const key = reminderClaimKey(item);
	const responseBody = {
		eventId: item.id,
		occurrenceStartsAt: item.occurrenceStartsAt,
		occurrenceEndsAt: item.occurrenceEndsAt,
		memberId: item.memberId,
	};
	const inserted = await db
		.insert(idempotencyResponses)
		.values({
			scope: REMINDER_CLAIM_SCOPE,
			key,
			responseBody,
			expiresAt: new Date(now.getTime() + REMINDER_CLAIM_LEASE_MS),
		})
		.onConflictDoUpdate({
			target: [idempotencyResponses.scope, idempotencyResponses.key],
			set: { responseBody, expiresAt: new Date(now.getTime() + REMINDER_CLAIM_LEASE_MS) },
			where: lte(idempotencyResponses.expiresAt, now),
		})
		.returning({ key: idempotencyResponses.key });

	return inserted.length > 0;
}

async function keepReminderDispatchClaim(item: ReminderDelivery, now: Date): Promise<void> {
	const occurrenceEndMs = Date.parse(item.occurrenceEndsAt ?? item.occurrenceStartsAt);
	const expiresAt = new Date(
		Math.max(now.getTime(), Number.isFinite(occurrenceEndMs) ? occurrenceEndMs : now.getTime()) +
			REMINDER_CLAIM_TTL_MS,
	);
	await db
		.update(idempotencyResponses)
		.set({ expiresAt })
		.where(
			and(
				eq(idempotencyResponses.scope, REMINDER_CLAIM_SCOPE),
				eq(idempotencyResponses.key, reminderClaimKey(item)),
			),
		);
}

/** Free the claim so a failed dispatch retries on the next cron run. */
async function releaseReminderDispatchClaim(item: ReminderDelivery): Promise<void> {
	await db
		.delete(idempotencyResponses)
		.where(
			and(
				eq(idempotencyResponses.scope, REMINDER_CLAIM_SCOPE),
				eq(idempotencyResponses.key, reminderClaimKey(item)),
			),
		);
}

export const GET = withCronLogging(
	'event-reminders',
	async (req: NextRequest): Promise<NextResponse> => {
		const secret = process.env.CRON_SECRET;
		if (!secret) return new NextResponse('cron_secret_missing', { status: 503 });
		if (!verifyCronSecret(req.headers.get('authorization'), secret)) {
			return new NextResponse('unauthorized', { status: 401 });
		}

		const now = new Date();
		const todayStart = startOfBerlinDay(now);
		const { start: tomorrowStart, end: tomorrowEnd } = computeTomorrowUtcWindow(now);

		return withEventWindowCandidates(
			todayStart,
			async (cursor, pageLimit) => {
				const cursorFilter = cursor
					? or(
							gt(wgEvents.startsAt, cursor.startsAt),
							and(eq(wgEvents.startsAt, cursor.startsAt), gt(wgEvents.id, cursor.id)),
						)
					: undefined;
				const windowFilter = buildEventsWindowFilter(todayStart, tomorrowEnd);
				const where = cursorFilter ? and(windowFilter, cursorFilter) : windowFilter;
				return db
					.select({
						id: wgEvents.id,
						title: wgEvents.title,
						description: wgEvents.description,
						startsAt: wgEvents.startsAt,
						endsAt: wgEvents.endsAt,
						allDay: wgEvents.allDay,
						location: wgEvents.location,
						recurrence: wgEvents.recurrence,
						wgId: wgs.id,
						wgName: wgs.name,
						shareCode: wgs.shareCode,
					})
					.from(wgEvents)
					.innerJoin(wgs, eq(wgEvents.wgId, wgs.id))
					.where(where)
					.orderBy(asc(wgEvents.startsAt), asc(wgEvents.id))
					.limit(pageLimit);
			},
			() => NextResponse.json({ error: 'events_window_too_large' }, { status: 503 }),
			async (candidateRows) => {
				const occurrences = collectReminderOccurrences(candidateRows, (row) =>
					expandRecurrence(toEventInput(row), todayStart, tomorrowEnd).flatMap((occ) => {
						const reminderCopy = reminderCopyForOccurrence(
							occ,
							now,
							todayStart,
							tomorrowStart,
							tomorrowEnd,
						);
						return reminderCopy
							? [
									{
										...row,
										occurrenceStartsAt: occ.startsAt,
										occurrenceEndsAt: occ.endsAt,
										reminderCopy,
									},
								]
							: [];
					}),
				);
				if (occurrences === null) {
					return NextResponse.json({ error: 'events_window_too_large' }, { status: 503 });
				}

				if (occurrences.length === 0) return NextResponse.json({ ok: true, sent: 0 });

				const legacyKeys = [...new Set(occurrences.map(legacyReminderClaimKey))];
				const legacyClaims = await db
					.select({ key: idempotencyResponses.key })
					.from(idempotencyResponses)
					.where(
						and(
							eq(idempotencyResponses.scope, REMINDER_CLAIM_SCOPE),
							gt(idempotencyResponses.expiresAt, now),
							inArray(idempotencyResponses.key, legacyKeys),
						),
					);
				const legacyClaimKeys = new Set(legacyClaims.map((claim) => claim.key));
				const eligibleOccurrences = occurrences.filter(
					(occurrence) => !legacyClaimKeys.has(legacyReminderClaimKey(occurrence)),
				);
				if (eligibleOccurrences.length === 0) return NextResponse.json({ ok: true, sent: 0 });

				const wgIds = [...new Set(eligibleOccurrences.map((occurrence) => occurrence.wgId))];
				const members = await db
					.select({ id: wgMembers.id, wgId: wgMembers.wgId })
					.from(wgMembers)
					.where(and(inArray(wgMembers.wgId, wgIds), isNull(wgMembers.deactivatedAt)));
				const membersByWg = new Map<string, string[]>();
				for (const member of members) {
					const memberIds = membersByWg.get(member.wgId) ?? [];
					memberIds.push(member.id);
					membersByWg.set(member.wgId, memberIds);
				}

				const deliveries = collectReminderOccurrences(eligibleOccurrences, (occurrence) =>
					(membersByWg.get(occurrence.wgId) ?? []).map((memberId) => ({
						...occurrence,
						memberId,
					})),
				);
				if (deliveries === null) {
					return NextResponse.json({ error: 'events_window_too_large' }, { status: 503 });
				}
				if (deliveries.length === 0) return NextResponse.json({ ok: true, sent: 0 });

				// ponytail: retry while the occurrence is current; use durable state if recovery after it ends matters.
				const { sent, failed } = await processReminderBatches(
					deliveries,
					(item) => claimReminderDispatch(item, now),
					async (item) => {
						try {
							// A partial retry may repeat a successful device for this member.
							// ponytail: per-subscription claims only if that duplication matters.
							const result = await dispatchNotification({
								wg: { id: item.wgId, name: item.wgName, shareCode: item.shareCode },
								event: item.reminderCopy === 'today' ? 'event.today' : 'event.upcoming',
								targetMemberIds: [item.memberId],
								payload: {
									eventId: item.id,
									title: item.title,
									startsAt: item.occurrenceStartsAt,
									allDay: item.allDay,
									ongoing:
										item.reminderCopy === 'today' &&
										!item.allDay &&
										Date.parse(item.occurrenceStartsAt) < now.getTime(),
								},
							});
							if (result.sent > 0 && result.failures.length === 0) {
								await keepReminderDispatchClaim(item, now);
							}
							return result;
						} catch (err) {
							console.warn('[event-reminders] notification dispatch failed');
							return { sent: 0, failures: [err] };
						}
					},
					(item) => releaseReminderDispatchClaim(item),
				);

				return NextResponse.json(
					{ ok: failed === 0, sent, failed },
					{ status: failed > 0 ? 503 : 200 },
				);
			},
			EVENT_REMINDER_BUDGET,
		);
	},
);
