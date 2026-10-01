/**
 * Day-boundary helpers for Europe/Berlin.
 *
 * Vercel functions run in UTC, so `setHours(0, 0, 0, 0)` yields UTC midnight —
 * one or two hours after the Berlin day already started. These helpers resolve
 * "today" the way WG members experience it: by the Berlin wall clock,
 * including both DST transitions (23h spring-forward and 25h fall-back days).
 */

const BERLIN_TZ = 'Europe/Berlin';
const MS_PER_HOUR = 60 * 60 * 1000;
// Berlin is UTC+1 (CET) in winter and UTC+2 (CEST) in summer.
const BERLIN_UTC_OFFSET_HOURS = [1, 2];
// From any Berlin midnight, +30h lands mid-morning of the following Berlin
// day regardless of whether the current day is 23, 24, or 25 hours long.
const NEXT_DAY_PROBE_MS = 30 * MS_PER_HOUR;

// en-CA formats as YYYY-MM-DD, which doubles as a sortable bucket key.
const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
	timeZone: BERLIN_TZ,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

const hourFormat = new Intl.DateTimeFormat('en-US', {
	timeZone: BERLIN_TZ,
	hour: 'numeric',
	hourCycle: 'h23',
});

/** Calendar date (YYYY-MM-DD) of the given instant in Berlin. */
export function berlinDayKey(date: Date): string {
	return dayKeyFormat.format(date);
}

function berlinHour(date: Date): number {
	return Number(hourFormat.format(date));
}

/** Instant at which the Berlin day containing `date` began (Berlin midnight). */
export function startOfBerlinDay(date: Date): Date {
	const key = berlinDayKey(date);
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
	if (!match) throw new Error(`Unexpected Berlin day key: ${key}`);
	const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	for (const offsetHours of BERLIN_UTC_OFFSET_HOURS) {
		const candidate = new Date(utcMidnight - offsetHours * MS_PER_HOUR);
		if (berlinDayKey(candidate) === key && berlinHour(candidate) === 0) {
			return candidate;
		}
	}
	// Unreachable while Berlin observes CET/CEST; guards against tz-data drift.
	throw new Error(`Cannot resolve Berlin midnight for ${key}`);
}

/** Last millisecond of the Berlin day containing `date`. */
export function endOfBerlinDay(date: Date): Date {
	return new Date(nextBerlinDayStart(startOfBerlinDay(date)).getTime() - 1);
}

const wallTimeFormat = new Intl.DateTimeFormat('en-GB', {
	timeZone: BERLIN_TZ,
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});

/** Minutes since Berlin midnight of the given instant's Berlin day. */
export function berlinWallMinutes(date: Date): number {
	const [h, m] = wallTimeFormat.format(date).split(':');
	return Number(h) * 60 + Number(m);
}

/**
 * The UTC instant at which the Berlin wall clock reads `minutes` on `dayKey`.
 * Returns null only for wall times inside the spring-forward gap (02:00–03:00
 * that do not exist that day).
 */
export function instantAtBerlinWallTime(dayKey: string, minutes: number): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
	if (!match) throw new Error(`Unexpected Berlin day key: ${dayKey}`);
	const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	for (const offsetHours of BERLIN_UTC_OFFSET_HOURS) {
		const candidate = new Date(utcMidnight + minutes * 60_000 - offsetHours * MS_PER_HOUR);
		if (berlinDayKey(candidate) === dayKey && berlinWallMinutes(candidate) === minutes) {
			return candidate;
		}
	}
	return null;
}

/**
 * Add `days` calendar days in Berlin time, preserving the wall clock.
 *
 * `date.getTime() + days * MS_PER_DAY` is an absolute duration: when Berlin
 * switches between CET and CEST the UTC offset moves by one hour, so the
 * result is an hour off and — for wall times near midnight — lands on the
 * wrong Berlin day (Berlin 25.10 00:00 + 1 raw day = 25.10 23:00, the day
 * before the intended one). Stepping the calendar day and re-resolving the
 * wall time keeps 00:00 at 00:00 through both transitions: this is the same
 * re-alignment `features/events/events.ts` applies to recurrence occurrences.
 *
 * A wall time inside the spring-forward gap (02:00–02:59 on the transition
 * day, which never occurs) cannot be resolved; it is shifted forward by the
 * missing hour so a 02:30 chore fires at 03:30 instead of disappearing.
 */
export function addBerlinDays(date: Date, days: number): Date {
	const targetKey = shiftDayKey(berlinDayKey(date), days);
	const minutes = berlinWallMinutes(date);
	const resolved = instantAtBerlinWallTime(targetKey, minutes);
	if (resolved) return resolved;
	return (
		instantAtBerlinWallTime(targetKey, minutes + 60) ??
		new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
	);
}

/** Shift a `YYYY-MM-DD` key by whole days, letting `Date` handle rollover. */
function shiftDayKey(dayKey: string, days: number): string {
	const [year, month, day] = dayKey.split('-').map(Number);
	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Berlin midnight following the given Berlin-day start (DST-safe stepping). */
export function nextBerlinDayStart(dayStart: Date): Date {
	return startOfBerlinDay(new Date(dayStart.getTime() + NEXT_DAY_PROBE_MS));
}

/** Berlin midnight preceding the given Berlin-day start (DST-safe stepping). */
export function prevBerlinDayStart(dayStart: Date): Date {
	return startOfBerlinDay(new Date(dayStart.getTime() - 1));
}
