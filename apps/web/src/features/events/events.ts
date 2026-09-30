import type { wgEvents } from '@/core/db';
import { berlinDayKey, berlinWallMinutes, instantAtBerlinWallTime } from '@/core/utils/berlin-day';
import { MS_PER_DAY, parseTimestamp } from '@/core/utils/time';

export const EVENTS_LIST_LIMIT = 1000;

export type RecurrenceFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
type RecurrenceByDay = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

interface RecurrenceRule {
	freq: RecurrenceFreq;
	interval: number;
	byDay?: RecurrenceByDay[];
	count?: number;
	until?: string;
}

export interface EventInput {
	id: string;
	title: string;
	description: string | null;
	startsAt: string;
	endsAt: string | null;
	allDay: boolean;
	location: string | null;
	recurrence: string | null;
	createdAt?: string;
	updatedAt?: string;
}

export interface EventOccurrence {
	eventId: string;
	title: string;
	description: string | null;
	startsAt: string;
	endsAt: string | null;
	allDay: boolean;
	location: string | null;
	recurring: boolean;
	occurrenceIndex: number;
	createdAt?: string;
	updatedAt?: string;
}

const FREQS: ReadonlySet<RecurrenceFreq> = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const BYDAYS: ReadonlySet<RecurrenceByDay> = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
export const RECURRENCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: '', label: 'Einmalig' },
	{ value: 'DAILY', label: 'Täglich' },
	{ value: 'WEEKLY', label: 'Wöchentlich' },
	{ value: 'MONTHLY', label: 'Monatlich' },
	{ value: 'YEARLY', label: 'Jährlich' },
];
const BYDAY_TO_INDEX: Record<RecurrenceByDay, number> = {
	SU: 0,
	MO: 1,
	TU: 2,
	WE: 3,
	TH: 4,
	FR: 5,
	SA: 6,
};
const MAX_EXPAND_ITERATIONS = 366;
const MAX_OCCURRENCES = 366;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

/** UTC-midnight date whose UTC fields represent the instant's Berlin calendar date. */
export function berlinCalendarDate(date: Date): Date {
	return new Date(`${berlinDayKey(date)}T00:00:00.000Z`);
}

function isRecurrenceFreq(value: string): value is RecurrenceFreq {
	return FREQS.has(value as RecurrenceFreq);
}

function isRecurrenceByDay(value: string): value is RecurrenceByDay {
	return BYDAYS.has(value as RecurrenceByDay);
}

export function parseRecurrenceRule(value: string | null | undefined): RecurrenceRule | null {
	if (!value || typeof value !== 'string') return null;
	const parts = value.split(';').filter(Boolean);
	const map: Record<string, string> = {};
	for (const part of parts) {
		const eq = part.indexOf('=');
		if (eq <= 0) return null;
		const key = part.slice(0, eq).trim().toUpperCase();
		const val = part.slice(eq + 1).trim();
		if (!key || !val) return null;
		map[key] = val;
	}
	const freq = map.FREQ?.toUpperCase();
	if (!freq || !isRecurrenceFreq(freq)) return null;
	const intervalRaw = map.INTERVAL ?? '1';
	const interval = Number.parseInt(intervalRaw, 10);
	if (!Number.isFinite(interval) || interval < 1 || interval > 365) return null;
	const rule: RecurrenceRule = { freq, interval };
	if (map.BYDAY) {
		const days = map.BYDAY.split(',')
			.map((d) => d.trim().toUpperCase())
			.filter((d) => d.length > 0);
		const filtered: RecurrenceByDay[] = [];
		for (const day of days) {
			if (!isRecurrenceByDay(day)) return null;
			filtered.push(day);
		}
		if (filtered.length === 0) return null;
		rule.byDay = filtered;
	}
	if (map.COUNT) {
		const count = Number.parseInt(map.COUNT, 10);
		if (!Number.isFinite(count) || count < 1 || count > MAX_OCCURRENCES) return null;
		rule.count = count;
	}
	if (map.UNTIL) {
		const ts = parseTimestamp(map.UNTIL);
		if (ts === null) return null;
		rule.until = new Date(ts).toISOString();
	}
	return rule;
}

export function formatRecurrenceRule(rule: RecurrenceRule): string {
	const parts: string[] = [`FREQ=${rule.freq}`];
	if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
	if (rule.byDay && rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.join(',')}`);
	if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
	if (rule.until !== undefined) parts.push(`UNTIL=${rule.until}`);
	return parts.join(';');
}

function addToDate(date: Date, freq: RecurrenceFreq, interval: number): Date {
	const next = new Date(date);
	if (freq === 'DAILY') {
		next.setUTCDate(next.getUTCDate() + interval);
	} else if (freq === 'WEEKLY') {
		next.setUTCDate(next.getUTCDate() + 7 * interval);
	} else if (freq === 'MONTHLY') {
		const day = next.getUTCDate();
		next.setUTCMonth(next.getUTCMonth() + interval, 1);
		const lastDay = new Date(
			Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
		).getUTCDate();
		next.setUTCDate(Math.min(day, lastDay));
	} else {
		next.setUTCFullYear(next.getUTCFullYear() + interval);
	}
	return next;
}

interface ExpansionWindow {
	from: number;
	to: number;
}

function withinWindow(
	occurrenceStart: number,
	occurrenceEnd: number,
	window: ExpansionWindow,
	allDay: boolean,
): boolean {
	return (
		(allDay ? occurrenceEnd >= window.from : occurrenceEnd > window.from) &&
		occurrenceStart <= window.to
	);
}

function buildOccurrence(
	event: EventInput,
	startMs: number,
	durationMs: number,
	occurrenceIndex: number,
	isRecurring: boolean,
): EventOccurrence {
	const start = new Date(startMs);
	const end = new Date(startMs + durationMs);
	return {
		eventId: event.id,
		title: event.title,
		description: event.description,
		startsAt: start.toISOString(),
		endsAt: event.endsAt ? end.toISOString() : null,
		allDay: event.allDay,
		location: event.location,
		recurring: isRecurring,
		occurrenceIndex,
		...(event.createdAt !== undefined ? { createdAt: event.createdAt } : {}),
		...(event.updatedAt !== undefined ? { updatedAt: event.updatedAt } : {}),
	};
}

function durationMsFor(event: EventInput, startMs: number): number {
	if (!event.endsAt) return DEFAULT_DURATION_MS;
	const endMs = parseTimestamp(event.endsAt);
	if (event.allDay && endMs === startMs) return 0;
	if (endMs === null || endMs <= startMs) return DEFAULT_DURATION_MS;
	return endMs - startMs;
}

interface ForwardSkip {
	/** ms timestamp of the first occurrence to resume iterating from. */
	startMs: number;
	/** occurrenceIndex of that occurrence (0-based, counting from the original startsAt). */
	index: number;
}

/**
 * expandRecurrence() used to always walk forward from the event's original
 * startsAt, one period at a time, bounded by MAX_EXPAND_ITERATIONS. For an
 * old event with no end date, the entire iteration budget could be spent
 * before ever reaching the query window, silently returning zero
 * occurrences. This analytically fast-forwards to the last occurrence at or
 * before window.from — preserving the exact recurrence phase (day-of-week /
 * day-of-month / time-of-day) — so the bounded loop always has budget left
 * to cover the window itself, regardless of the event's age.
 *
 * MONTHLY/YEARLY are included too: with INTERVAL=1 (the common case),
 * MAX_EXPAND_ITERATIONS=366 is only ~30.5 years for MONTHLY and 366 years
 * for YEARLY — both reachable in practice, not "centuries away" as a
 * previous version of this comment assumed.
 */
function computeForwardSkip(
	rule: RecurrenceRule,
	startMs: number,
	anchorWeekStartMs: number,
	windowFromMs: number,
	weeklyByDay: boolean,
	weeklyAllowedDays: Set<number> | null,
): ForwardSkip {
	const noSkip: ForwardSkip = { startMs, index: 0 };
	if (windowFromMs <= startMs) return noSkip;

	if (rule.freq === 'DAILY') {
		const periodMs = rule.interval * MS_PER_DAY;
		const steps = Math.floor((windowFromMs - startMs) / periodMs);
		if (steps <= 0) return noSkip;
		return { startMs: startMs + steps * periodMs, index: steps };
	}

	if (rule.freq === 'WEEKLY' && !weeklyByDay) {
		const periodMs = rule.interval * 7 * MS_PER_DAY;
		const steps = Math.floor((windowFromMs - startMs) / periodMs);
		if (steps <= 0) return noSkip;
		return { startMs: startMs + steps * periodMs, index: steps };
	}

	if (rule.freq === 'WEEKLY' && weeklyByDay && weeklyAllowedDays) {
		if (windowFromMs <= anchorWeekStartMs) return noSkip;
		const targetWeekOffset = Math.floor((windowFromMs - anchorWeekStartMs) / (7 * MS_PER_DAY));
		const weekBlocks = Math.floor(targetWeekOffset / rule.interval);
		if (weekBlocks <= 0) return noSkip;
		const skippedMs = anchorWeekStartMs + weekBlocks * rule.interval * 7 * MS_PER_DAY;
		if (skippedMs <= startMs) return noSkip;
		// The anchor week can be partial: iteration starts at the event's
		// weekday, not at Sunday. Count that prefix separately so fast-forwarding
		// preserves COUNT and stable occurrence UIDs.
		const anchorWeekday = new Date(startMs).getUTCDay();
		const anchorWeekCount = [...weeklyAllowedDays].filter((day) => day >= anchorWeekday).length;
		return {
			startMs: skippedMs,
			index: anchorWeekCount + Math.max(0, weekBlocks - 1) * weeklyAllowedDays.size,
		};
	}

	if (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') {
		return computeAnchoredSkip(new Date(startMs), rule.freq, rule.interval, windowFromMs);
	}

	return noSkip;
}

/**
 * Analytic fast-forward for MONTHLY/YEARLY, mirroring the DAILY/WEEKLY skip
 * above but using calendar-unit arithmetic (months/years vary in length, so
 * this can't be a fixed-ms period). Uses the same addFromAnchor() the main
 * loop uses, so the day-of-month clamping behavior (e.g. Jan 31 -> Feb 28)
 * stays identical to the unskipped walk. Overshoot (possible near month
 * boundaries because month length is uneven) is corrected by stepping back
 * one interval at a time until the candidate is at or before the window.
 */
function computeAnchoredSkip(
	anchor: Date,
	freq: 'MONTHLY' | 'YEARLY',
	interval: number,
	windowFromMs: number,
): ForwardSkip {
	const startMs = anchor.getTime();
	const noSkip: ForwardSkip = { startMs, index: 0 };

	const unitsDiff =
		freq === 'MONTHLY'
			? (new Date(windowFromMs).getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
				(new Date(windowFromMs).getUTCMonth() - anchor.getUTCMonth())
			: new Date(windowFromMs).getUTCFullYear() - anchor.getUTCFullYear();

	let steps = Math.floor(unitsDiff / interval);
	if (steps <= 0) return noSkip;

	let candidateMs = addFromAnchor(anchor, freq, interval * steps).getTime();
	while (candidateMs > windowFromMs && steps > 0) {
		steps -= 1;
		candidateMs = steps > 0 ? addFromAnchor(anchor, freq, interval * steps).getTime() : startMs;
	}
	if (steps <= 0) return noSkip;

	return { startMs: candidateMs, index: steps };
}

export function expandRecurrence(
	event: EventInput,
	from: Date | string,
	to: Date | string,
): EventOccurrence[] {
	const startMs = parseTimestamp(event.startsAt);
	const fromMs = parseTimestamp(from instanceof Date ? from.toISOString() : from);
	const toMs = parseTimestamp(to instanceof Date ? to.toISOString() : to);
	if (startMs === null || fromMs === null || toMs === null || fromMs > toMs) return [];

	const window: ExpansionWindow = { from: fromMs, to: toMs };
	const baseDuration = durationMsFor(event, startMs);
	const rule = parseRecurrenceRule(event.recurrence);

	if (!rule) {
		if (!withinWindow(startMs, startMs + baseDuration, window, event.allDay)) return [];
		return [buildOccurrence(event, startMs, baseDuration, 0, false)];
	}

	const untilMs =
		rule.until !== undefined ? (parseTimestamp(rule.until) ?? Number.POSITIVE_INFINITY) : null;
	const occurrences: EventOccurrence[] = [];
	const anchor = new Date(startMs);
	const recurrenceAnchor = event.allDay ? anchor : berlinCalendarDate(anchor);
	const recurrenceStartMs = recurrenceAnchor.getTime();
	const weeklyByDay = rule.freq === 'WEEKLY' && !!rule.byDay && rule.byDay.length > 0;
	const weeklyAllowedDays = weeklyByDay ? new Set(rule.byDay?.map((d) => BYDAY_TO_INDEX[d])) : null;
	const anchorWeekStartMs = recurrenceStartMs - recurrenceAnchor.getUTCDay() * MS_PER_DAY;
	// Wall time (Berlin minutes since midnight) the anchor starts at; every
	// occurrence is re-aligned to it so DST transitions keep 20:00 at 20:00.
	const anchorWallMinutes = berlinWallMinutes(anchor);
	const skipFromMs = window.from - baseDuration;
	const recurrenceSkipFromMs = event.allDay
		? skipFromMs
		: berlinCalendarDate(new Date(skipFromMs)).getTime();
	const skip = computeForwardSkip(
		rule,
		recurrenceStartMs,
		anchorWeekStartMs,
		recurrenceSkipFromMs,
		weeklyByDay,
		weeklyAllowedDays,
	);
	let current = new Date(skip.startMs);
	let index = skip.index;
	// For MONTHLY/YEARLY, skip.index counts the same calendar-unit steps that
	// stepIndex tracks below, so resume from there. Other freqs don't use
	// stepIndex, so 0 is harmless for them.
	let stepIndex = rule.freq === 'MONTHLY' || rule.freq === 'YEARLY' ? skip.index : 0;
	let iterations = 0;

	while (iterations < MAX_EXPAND_ITERATIONS) {
		iterations += 1;
		const occurrenceDayMs = current.getTime();
		// Resolve the anchor's Berlin wall time on each recurrence date. If that
		// time falls in the spring gap, preserve the old raw-instant fallback.
		const occurrenceMs = event.allDay
			? occurrenceDayMs
			: (instantAtBerlinWallTime(berlinDayKey(current), anchorWallMinutes)?.getTime() ??
				startMs + occurrenceDayMs - recurrenceStartMs);
		if (occurrenceMs > window.to) break;
		if (untilMs !== null && occurrenceMs > untilMs) break;
		if (rule.count !== undefined && index >= rule.count) break;

		let emit = true;
		if (weeklyAllowedDays) {
			const weekOffset = Math.floor((occurrenceDayMs - anchorWeekStartMs) / (7 * MS_PER_DAY));
			emit = weeklyAllowedDays.has(current.getUTCDay()) && weekOffset % rule.interval === 0;
		}

		if (emit) {
			if (withinWindow(occurrenceMs, occurrenceMs + baseDuration, window, event.allDay)) {
				occurrences.push(buildOccurrence(event, occurrenceMs, baseDuration, index, true));
			}
			index += 1;
			if (occurrences.length >= MAX_OCCURRENCES) break;
		}

		if (weeklyByDay) {
			current = new Date(current.getTime() + MS_PER_DAY);
		} else if (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') {
			stepIndex += 1;
			current = addFromAnchor(recurrenceAnchor, rule.freq, rule.interval * stepIndex);
		} else {
			current = addToDate(current, rule.freq, rule.interval);
		}
	}

	return occurrences;
}

function addFromAnchor(anchor: Date, freq: RecurrenceFreq, totalInterval: number): Date {
	const next = new Date(anchor);
	const anchorDay = anchor.getUTCDate();
	if (freq === 'MONTHLY') {
		next.setUTCDate(1);
		next.setUTCMonth(next.getUTCMonth() + totalInterval);
		const lastDay = new Date(
			Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
		).getUTCDate();
		next.setUTCDate(Math.min(anchorDay, lastDay));
	} else {
		next.setUTCFullYear(anchor.getUTCFullYear() + totalInterval);
	}
	return next;
}

/** Browser agenda: all-day events occupy inclusive local calendar dates, not one hour. */
export function expandAgendaRecurrence(event: EventInput, from: Date, to: Date): EventOccurrence[] {
	if (!event.allDay) return expandRecurrence(event, from, to);
	if (from.getTime() > to.getTime()) return [];
	// Widen candidate selection for UTC dates, legacy local instants and ongoing spans.
	const start = getCalendarDayBounds(from).start;
	start.setTime(start.getTime() - durationMsFor(event, Date.parse(event.startsAt)));
	return expandRecurrence(event, start, getCalendarDayBounds(to).end).filter((occurrence) => {
		const first = eventDateForDisplay(occurrence.startsAt, true);
		first.setHours(0, 0, 0, 0);
		const endExclusive = eventDateForDisplay(occurrence.endsAt ?? occurrence.startsAt, true);
		endExclusive.setHours(0, 0, 0, 0);
		endExclusive.setDate(endExclusive.getDate() + 1);
		return first.getTime() <= to.getTime() && endExclusive.getTime() > from.getTime();
	});
}

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });
const ALL_DAY_WEEKDAY_FORMATTER = new Intl.DateTimeFormat('de-DE', {
	weekday: 'short',
	timeZone: 'UTC',
});
const DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const DATE_FULL_FORMATTER = new Intl.DateTimeFormat('de-DE', {
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
	timeZone: 'UTC',
});
const TIME_FORMATTER = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

function isSameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

export function formatEventTimeRange(occurrence: EventOccurrence): string {
	const start = new Date(occurrence.startsAt);
	if (occurrence.allDay) {
		const display = eventDateForDisplay(occurrence.startsAt, true);
		const date = new Date(Date.UTC(display.getFullYear(), display.getMonth(), display.getDate()));
		return `${ALL_DAY_WEEKDAY_FORMATTER.format(date)} ${DATE_FULL_FORMATTER.format(date)} · ganztägig`;
	}
	const end = occurrence.endsAt ? new Date(occurrence.endsAt) : null;
	const startLabel = `${WEEKDAY_FORMATTER.format(start)} ${DATE_FORMATTER.format(start)} ${TIME_FORMATTER.format(
		start,
	)}`;
	if (!end) return startLabel;
	if (isSameDay(start, end)) {
		return `${startLabel}–${TIME_FORMATTER.format(end)}`;
	}
	return `${startLabel} – ${WEEKDAY_FORMATTER.format(end)} ${DATE_FORMATTER.format(end)} ${TIME_FORMATTER.format(end)}`;
}

/** Nur die Uhrzeit, für Listen, die den Tag schon daneben zeigen. */
export function formatEventTimeOfDay(occurrence: EventOccurrence): string {
	if (occurrence.allDay) return 'ganztägig';
	const start = new Date(occurrence.startsAt);
	const end = occurrence.endsAt ? new Date(occurrence.endsAt) : null;
	const startLabel = TIME_FORMATTER.format(start);
	if (!end) return startLabel;
	if (isSameDay(start, end)) return `${startLabel}–${TIME_FORMATTER.format(end)}`;
	return `${startLabel} – ${WEEKDAY_FORMATTER.format(end)} ${DATE_FORMATTER.format(end)} ${TIME_FORMATTER.format(end)}`;
}

export function getMonthBounds(reference: Date): { start: Date; end: Date } {
	const year = reference.getFullYear();
	const month = reference.getMonth();
	// Include local timed events and UTC calendar dates at either month boundary.
	const start = new Date(Math.min(new Date(year, month, 1).getTime(), Date.UTC(year, month, 1)));
	const end = new Date(
		Math.max(new Date(year, month + 1, 1).getTime(), Date.UTC(year, month + 1, 1)) - 1,
	);
	return { start, end };
}

/** Query both UTC date values and device-local legacy instants for a calendar day. */
export function getCalendarDayBounds(reference: Date): { start: Date; end: Date } {
	const year = reference.getFullYear();
	const month = reference.getMonth();
	const day = reference.getDate();
	return {
		start: new Date(Math.min(new Date(year, month, day).getTime(), Date.UTC(year, month, day))),
		end: new Date(
			Math.max(new Date(year, month, day + 1).getTime(), Date.UTC(year, month, day + 1)) - 1,
		),
	};
}

/**
 * Exact UTC midnight is canonical, including indistinguishable legacy midnight values.
 * Other all-day timestamps retain the old device-local display. The original timezone
 * was never stored, so it cannot be recovered or made invariant across viewers.
 */
export function eventDateForDisplay(iso: string, allDay: boolean): Date {
	const date = new Date(iso);
	const utcMidnight =
		date.getUTCHours() === 0 &&
		date.getUTCMinutes() === 0 &&
		date.getUTCSeconds() === 0 &&
		date.getUTCMilliseconds() === 0;
	return allDay && utcMidnight
		? new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
		: date;
}

export function eventOverlapsCalendarDay(
	event: Pick<EventOccurrence, 'startsAt' | 'endsAt' | 'allDay'>,
	day: Date,
): boolean {
	const first = eventDateForDisplay(event.startsAt, event.allDay);
	const target = new Date(day.getFullYear(), day.getMonth(), day.getDate());
	if (event.allDay) {
		const last = eventDateForDisplay(event.endsAt ?? event.startsAt, true);
		first.setHours(0, 0, 0, 0);
		last.setHours(0, 0, 0, 0);
		return first.getTime() <= target.getTime() && target.getTime() <= last.getTime();
	}

	const end = event.endsAt
		? new Date(event.endsAt)
		: new Date(first.getTime() + DEFAULT_DURATION_MS);
	const nextDay = new Date(target);
	nextDay.setDate(nextDay.getDate() + 1);
	return first.getTime() < nextDay.getTime() && end.getTime() > target.getTime();
}

/**
 * Wire shape of a calendar event: dates as ISO strings, everything else as
 * stored. Both event routes carried an identical copy.
 */
export function serializeWgEvent(row: typeof wgEvents.$inferSelect) {
	return {
		id: row.id,
		wgId: row.wgId,
		title: row.title,
		description: row.description,
		startsAt: row.startsAt.toISOString(),
		endsAt: row.endsAt ? row.endsAt.toISOString() : null,
		allDay: row.allDay,
		location: row.location,
		recurrence: row.recurrence,
		createdByMemberId: row.createdByMemberId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

export type SerializedWgEvent = ReturnType<typeof serializeWgEvent>;

type EventFormValidation =
	| { ok: true; startsAt: Date; endsAt: Date | null }
	| { ok: false; error: string; field: 'title' | 'startsAt' | 'endsAt' };

export function normalizeEventDateTime(value: string, allDay: boolean): string {
	if (!allDay || value.length < 10) return value;
	return `${value.slice(0, 10)}T00:00`;
}

/**
 * The three checks both event modals ran before submitting, in the order they
 * report them. Pure, so the rules can be tested without rendering a dialog.
 */
export function validateEventForm(input: {
	title: string;
	startsAt: string;
	endsAt: string;
	allDay?: boolean;
	original?: Pick<EventInput, 'startsAt' | 'endsAt' | 'allDay'>;
}): EventFormValidation {
	if (input.title.trim().length === 0) {
		return { ok: false, error: 'Titel fehlt.', field: 'title' };
	}
	if (!input.startsAt) {
		return { ok: false, error: 'Startzeitpunkt fehlt.', field: 'startsAt' };
	}

	const allDay = input.allDay === true;
	const startsAt = new Date(
		`${normalizeEventDateTime(input.startsAt, allDay)}${allDay ? 'Z' : ''}`,
	);
	const endsAt = input.endsAt
		? new Date(`${normalizeEventDateTime(input.endsAt, allDay)}${allDay ? 'Z' : ''}`)
		: null;
	if (endsAt && endsAt.getTime() < startsAt.getTime()) {
		return { ok: false, error: 'Endzeit liegt vor Startzeit.', field: 'endsAt' };
	}
	const original = input.original;
	if (
		allDay &&
		original?.allDay &&
		isSameDay(
			eventDateForDisplay(startsAt.toISOString(), true),
			eventDateForDisplay(original.startsAt, true),
		) &&
		(endsAt && original.endsAt
			? isSameDay(
					eventDateForDisplay(endsAt.toISOString(), true),
					eventDateForDisplay(original.endsAt, true),
				)
			: endsAt === null && original.endsAt === null)
	) {
		// Preserve both legacy instants when only title/metadata changed. An explicit
		// date edit writes the pair canonically, avoiding mixed old/new end ordering.
		return {
			ok: true,
			startsAt: new Date(original.startsAt),
			endsAt: original.endsAt ? new Date(original.endsAt) : null,
		};
	}
	return { ok: true, startsAt, endsAt };
}
