import {
	berlinDayKey,
	berlinWallMinutes,
	instantAtBerlinWallTime,
	nextBerlinDayStart,
	startOfBerlinDay,
} from '@/core/utils/berlin-day';
import { and, eq, gt, gte, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { wgEvents } from '../../core/db/schema';
import {
	EVENTS_LIST_LIMIT,
	berlinCalendarDate,
	eventDateForDisplay,
	parseRecurrenceRule,
} from './events';

const EVENT_WINDOW_PAGE_SIZE = 500;
const EVENT_WINDOW_SCAN_LIMIT = 10_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const BYDAY_INDEX: Record<string, number> = {
	SU: 0,
	MO: 1,
	TU: 2,
	WE: 3,
	TH: 4,
	FR: 5,
	SA: 6,
};

interface EventWindowCandidate {
	id: string;
	startsAt: Date;
	endsAt: Date | null;
	allDay: boolean;
	recurrence: string | null;
}

interface EventWindowCursor {
	startsAt: Date;
	id: string;
}

type ParsedRecurrenceRule = NonNullable<ReturnType<typeof parseRecurrenceRule>>;

function recurrenceWeekdays(rule: ParsedRecurrenceRule): number[] {
	const weekdays = (rule.byDay ?? []).flatMap((day) => {
		const weekday = BYDAY_INDEX[day];
		return weekday === undefined ? [] : [weekday];
	});
	return [...new Set(weekdays)].sort((a, b) => a - b);
}

function recurrenceRawStartAtIndex(
	anchor: Date,
	rule: ParsedRecurrenceRule,
	index: number,
): number | null {
	if (!Number.isInteger(index) || index < 0) return null;
	const startMs = anchor.getTime();
	if (rule.freq === 'DAILY') return startMs + index * rule.interval * MS_PER_DAY;
	if (rule.freq === 'WEEKLY' && !rule.byDay) {
		return startMs + index * rule.interval * 7 * MS_PER_DAY;
	}
	if (rule.freq === 'WEEKLY' && rule.byDay) {
		const weekdays = recurrenceWeekdays(rule);
		if (weekdays.length === 0) return null;
		const anchorWeekday = anchor.getUTCDay();
		const firstWeekdays = weekdays.filter((weekday) => weekday >= anchorWeekday);
		let weekBlock: number;
		let weekday: number;
		if (index < firstWeekdays.length) {
			weekBlock = 0;
			const firstWeekday = firstWeekdays[index];
			if (firstWeekday === undefined) return null;
			weekday = firstWeekday;
		} else {
			const afterAnchorWeek = index - firstWeekdays.length;
			const laterWeek = Math.floor(afterAnchorWeek / weekdays.length) + 1;
			weekBlock = laterWeek * rule.interval;
			const nextWeekday = weekdays[afterAnchorWeek % weekdays.length];
			if (nextWeekday === undefined) return null;
			weekday = nextWeekday;
		}
		const anchorWeekStart = startMs - anchorWeekday * MS_PER_DAY;
		return anchorWeekStart + (weekBlock * 7 + weekday) * MS_PER_DAY;
	}
	if (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') {
		const candidate = new Date(anchor);
		const anchorDay = anchor.getUTCDate();
		if (rule.freq === 'MONTHLY') {
			candidate.setUTCDate(1);
			candidate.setUTCMonth(candidate.getUTCMonth() + rule.interval * index);
			const lastDay = new Date(
				Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 0),
			).getUTCDate();
			candidate.setUTCDate(Math.min(anchorDay, lastDay));
		} else {
			candidate.setUTCFullYear(anchor.getUTCFullYear() + rule.interval * index);
		}
		return candidate.getTime();
	}
	return null;
}

function lastRecurrenceIndexAtOrBefore(
	anchor: Date,
	rule: ParsedRecurrenceRule,
	untilMs: number,
): number {
	const startMs = anchor.getTime();
	if (!Number.isFinite(untilMs) || untilMs < startMs) return -1;
	if (rule.freq === 'DAILY') {
		return Math.floor((untilMs - startMs) / (rule.interval * MS_PER_DAY));
	}
	if (rule.freq === 'WEEKLY' && !rule.byDay) {
		return Math.floor((untilMs - startMs) / (rule.interval * 7 * MS_PER_DAY));
	}
	if (rule.freq === 'WEEKLY' && rule.byDay) {
		const weekdays = recurrenceWeekdays(rule);
		if (weekdays.length === 0) return -1;
		const anchorWeekday = anchor.getUTCDay();
		const firstWeekdays = weekdays.filter((weekday) => weekday >= anchorWeekday);
		const anchorWeekStart = startMs - anchorWeekday * MS_PER_DAY;
		const untilWeek = Math.floor((untilMs - anchorWeekStart) / (7 * MS_PER_DAY));
		let weekBlock = Math.floor(untilWeek / rule.interval) * rule.interval;
		for (let blockCount = 0; blockCount < 2 && weekBlock >= 0; blockCount += 1) {
			const available = weekBlock === 0 ? firstWeekdays : weekdays;
			for (let dayIndex = available.length - 1; dayIndex >= 0; dayIndex -= 1) {
				const weekday = available[dayIndex];
				if (weekday === undefined) continue;
				const rawStart = anchorWeekStart + (weekBlock * 7 + weekday) * MS_PER_DAY;
				if (rawStart > untilMs) continue;
				if (weekBlock === 0) return firstWeekdays.indexOf(weekday);
				const blockOrdinal = weekBlock / rule.interval;
				return (
					firstWeekdays.length + (blockOrdinal - 1) * weekdays.length + weekdays.indexOf(weekday)
				);
			}
			weekBlock -= rule.interval;
		}
		return -1;
	}
	if (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') {
		const until = new Date(untilMs);
		const units =
			rule.freq === 'MONTHLY'
				? (until.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
					(until.getUTCMonth() - anchor.getUTCMonth())
				: until.getUTCFullYear() - anchor.getUTCFullYear();
		let index = Math.floor(units / rule.interval);
		for (; index >= 0; index -= 1) {
			const rawStart = recurrenceRawStartAtIndex(anchor, rule, index);
			if (rawStart !== null && rawStart <= untilMs) return index;
		}
		return -1;
	}
	return -1;
}

function lastTimedRecurrenceIndexAtOrBefore(
	anchorMs: number,
	recurrenceAnchor: Date,
	rule: ParsedRecurrenceRule,
	untilMs: number,
	wallMinutes: number,
): number {
	const untilDate = berlinCalendarDate(new Date(untilMs));
	const index = lastRecurrenceIndexAtOrBefore(
		recurrenceAnchor,
		rule,
		untilDate.getTime() + MS_PER_DAY - 1,
	);
	if (index < 0) return index;

	const rawStart = recurrenceRawStartAtIndex(recurrenceAnchor, rule, index);
	if (rawStart === null) return -1;
	const wallStart = instantAtBerlinWallTime(berlinDayKey(new Date(rawStart)), wallMinutes);
	const occurrenceMs = wallStart?.getTime() ?? anchorMs + rawStart - recurrenceAnchor.getTime();
	if (occurrenceMs <= untilMs) return index;

	return lastRecurrenceIndexAtOrBefore(recurrenceAnchor, rule, rawStart - 1);
}

function lastRecurrenceStartMs(
	candidate: EventWindowCandidate,
	rule: ParsedRecurrenceRule,
): number | null {
	const anchorMs = candidate.startsAt.getTime();
	if (!Number.isFinite(anchorMs)) return null;
	const anchor = new Date(anchorMs);
	const recurrenceAnchor = candidate.allDay ? anchor : berlinCalendarDate(anchor);
	const wallMinutes = candidate.allDay ? 0 : berlinWallMinutes(anchor);
	let lastIndex = rule.count === undefined ? null : rule.count - 1;
	if (rule.until !== undefined) {
		const untilMs = Date.parse(rule.until);
		const untilIndex = candidate.allDay
			? lastRecurrenceIndexAtOrBefore(recurrenceAnchor, rule, untilMs)
			: lastTimedRecurrenceIndexAtOrBefore(anchorMs, recurrenceAnchor, rule, untilMs, wallMinutes);
		lastIndex = lastIndex === null ? untilIndex : Math.min(lastIndex, untilIndex);
	}
	if (lastIndex === null || lastIndex < 0) return lastIndex;
	const rawStart = recurrenceRawStartAtIndex(recurrenceAnchor, rule, lastIndex);
	if (rawStart === null || !Number.isFinite(rawStart)) return null;
	if (candidate.allDay) return rawStart;
	const rawYear = new Date(rawStart).getUTCFullYear();
	if (rawYear < 1000 || rawYear >= 9999) return null;
	const wallAligned = instantAtBerlinWallTime(berlinDayKey(new Date(rawStart)), wallMinutes);
	return (wallAligned ?? new Date(anchorMs + rawStart - recurrenceAnchor.getTime())).getTime();
}

function durationMs(candidate: EventWindowCandidate, rootStartMs: number): number | null {
	if (!candidate.endsAt) return DEFAULT_DURATION_MS;
	const endMs = candidate.endsAt.getTime();
	if (!Number.isFinite(endMs)) return null;
	if (candidate.allDay && endMs === rootStartMs) return 0;
	return endMs <= rootStartMs ? DEFAULT_DURATION_MS : endMs - rootStartMs;
}

function isExpiredFiniteRecurrence(candidate: EventWindowCandidate, from: Date): boolean {
	if (!candidate.recurrence) return false;
	const rule = parseRecurrenceRule(candidate.recurrence);
	if (!rule || (rule.count === undefined && rule.until === undefined)) return false;
	const lastStartMs = lastRecurrenceStartMs(candidate, rule);
	if (lastStartMs === null) return false;
	if (lastStartMs < 0) return true;
	const duration = durationMs(candidate, candidate.startsAt.getTime());
	if (duration === null || !Number.isFinite(lastStartMs + duration)) return false;
	if (!candidate.allDay) return lastStartMs + duration <= from.getTime();

	const endMs = candidate.endsAt ? lastStartMs + duration : lastStartMs;
	const lastEndDay = eventDateForDisplay(new Date(endMs).toISOString(), true);
	const fromDay = eventDateForDisplay(from.toISOString(), true);
	lastEndDay.setHours(0, 0, 0, 0);
	fromDay.setHours(0, 0, 0, 0);
	return lastEndDay.getTime() < fromDay.getTime();
}

export async function withEventWindowCandidates<
	T extends EventWindowCandidate,
	TOverflowResult,
	TResult,
>(
	from: Date | null,
	fetchPage: (cursor: EventWindowCursor | null, limit: number) => Promise<readonly T[]>,
	onOverflow: () => TOverflowResult | Promise<TOverflowResult>,
	processRows: (rows: readonly T[]) => TResult | Promise<TResult>,
	maxCandidates = EVENTS_LIST_LIMIT,
): Promise<TOverflowResult | TResult> {
	const rows: T[] = [];
	let cursor: EventWindowCursor | null = null;
	let scanned = 0;

	while (scanned < EVENT_WINDOW_SCAN_LIMIT) {
		const pageLimit = Math.min(EVENT_WINDOW_PAGE_SIZE, EVENT_WINDOW_SCAN_LIMIT - scanned);
		const page = await fetchPage(cursor, pageLimit);
		if (page.length > pageLimit) return onOverflow();
		if (page.length === 0) return processRows(rows);
		scanned += page.length;

		for (const candidate of page) {
			if (from && isExpiredFiniteRecurrence(candidate, from)) continue;
			rows.push(candidate);
			if (rows.length > maxCandidates) return onOverflow();
		}

		const last = page[page.length - 1];
		if (!last) return processRows(rows);
		cursor = { startsAt: last.startsAt, id: last.id };
		if (page.length < pageLimit) return processRows(rows);
		if (scanned >= EVENT_WINDOW_SCAN_LIMIT) {
			const sentinel = await fetchPage(cursor, 1);
			return sentinel.length === 0 ? processRows(rows) : onOverflow();
		}
	}
	return onOverflow();
}

/** Shared date filter for the calendar API and reminder cron; recurring roots have no age bound. */
export function buildEventsWindowFilter(from: Date | null, to: Date | null) {
	if (!from || !to) return undefined;

	return or(
		and(
			lte(wgEvents.startsAt, to),
			or(
				gte(wgEvents.startsAt, from),
				and(eq(wgEvents.allDay, true), gte(wgEvents.endsAt, from)),
				and(eq(wgEvents.allDay, false), gt(wgEvents.endsAt, from)),
				and(
					eq(wgEvents.allDay, false),
					isNull(wgEvents.endsAt),
					gt(wgEvents.startsAt, new Date(from.getTime() - DEFAULT_DURATION_MS)),
				),
			),
		),
		and(isNotNull(wgEvents.recurrence), lte(wgEvents.startsAt, to)),
	);
}

/**
 * "Tomorrow" in Europe/Berlin — the timezone users schedule events in. A UTC
 * day boundary misclassifies events between 00:00 and 02:00 Berlin time
 * (CET is UTC+1, CEST UTC+2), reminding a day early or late.
 */
export function computeTomorrowUtcWindow(now: Date): { start: Date; end: Date } {
	const todayStart = startOfBerlinDay(now);
	const start = nextBerlinDayStart(todayStart);
	const end = new Date(nextBerlinDayStart(start).getTime() - 1);
	return { start, end };
}
