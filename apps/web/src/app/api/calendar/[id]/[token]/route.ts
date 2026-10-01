import { calendarSubscriptions, wgEvents, wgMembers, wgs } from '@/core/db';
import { withTransaction } from '@/core/db/transaction';
import { notFound, serverError, tooMany } from '@/core/errors';
import { isUuid } from '@/core/guards/api-auth';
import type { RouteCtx } from '@/core/infra/api-types';
import { logApiError } from '@/core/infra/observability';
import { checkRateLimit, clientIpKey, wgReadLimiter } from '@/core/rate-limit';
import { endOfBerlinDay, startOfBerlinDay } from '@/core/utils/berlin-day';
import { MS_PER_DAY } from '@/core/utils/time';
import {
	isCalendarFeedToken,
	verifyCalendarFeedToken,
} from '@/features/events/calendar-subscription';
import { type EventInput, expandRecurrence } from '@/features/events/events';
import { type CalendarFeedOccurrence, calendarFeedToIcs } from '@/features/events/ics';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

const FEED_HORIZON_DAYS = 365;

function eventToInput(row: typeof wgEvents.$inferSelect): EventInput {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		startsAt: row.startsAt.toISOString(),
		endsAt: row.endsAt?.toISOString() ?? null,
		allDay: row.allDay,
		location: row.location,
		recurrence: row.recurrence,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export async function GET(
	req: NextRequest,
	ctx: RouteCtx<{ id: string; token: string }>,
): Promise<NextResponse> {
	const { id, token } = await ctx.params;
	if (!isUuid(id) || !isCalendarFeedToken(token)) return notFound('calendar_feed_not_found');

	const limit = await checkRateLimit(wgReadLimiter, `calendar-feed:${clientIpKey(req)}`);
	if (!limit.success) return tooMany('rate_limited');

	try {
		const events = await withTransaction(async (tx) => {
			const [beforeLock] = await tx
				.select({ wgId: calendarSubscriptions.wgId })
				.from(calendarSubscriptions)
				.where(and(eq(calendarSubscriptions.id, id), isNull(calendarSubscriptions.revokedAt)))
				.limit(1);
			if (!beforeLock) return null;
			const [wg] = await tx
				.select({ id: wgs.id })
				.from(wgs)
				.where(eq(wgs.id, beforeLock.wgId))
				.for('update');
			if (!wg) return null;

			const [subscription] = await tx
				.select({
					id: calendarSubscriptions.id,
					wgId: calendarSubscriptions.wgId,
					tokenSeed: calendarSubscriptions.tokenSeed,
				})
				.from(calendarSubscriptions)
				.innerJoin(wgMembers, eq(wgMembers.id, calendarSubscriptions.memberId))
				.where(
					and(
						eq(calendarSubscriptions.id, id),
						isNull(calendarSubscriptions.revokedAt),
						isNull(wgMembers.deactivatedAt),
						isNotNull(wgMembers.authUserId),
					),
				)
				.limit(1);
			if (!subscription || !verifyCalendarFeedToken(id, subscription.tokenSeed, token)) return null;
			return tx
				.select()
				.from(wgEvents)
				.where(eq(wgEvents.wgId, subscription.wgId))
				.orderBy(asc(wgEvents.startsAt));
		});
		if (!events) return notFound('calendar_feed_not_found');

		const from = new Date();
		const to = new Date(from.getTime() + FEED_HORIZON_DAYS * MS_PER_DAY);
		const berlinFrom = startOfBerlinDay(from);
		const berlinTo = endOfBerlinDay(to);
		const occurrences: CalendarFeedOccurrence[] = events.flatMap((row) => {
			const event = eventToInput(row);
			return expandRecurrence(
				event,
				event.allDay ? berlinFrom : from,
				event.allDay ? berlinTo : to,
			);
		});
		const body = calendarFeedToIcs(occurrences, 'ManaWG');
		return new NextResponse(body, {
			headers: {
				'Cache-Control': 'no-store',
				'Content-Disposition': 'inline; filename="manawg-kalender.ics"',
				'Content-Type': 'text/calendar; charset=utf-8',
				'X-Content-Type-Options': 'nosniff',
			},
		});
	} catch (err) {
		logApiError('[calendar feed GET]', err);
		return serverError('db_error');
	}
}
