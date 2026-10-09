import { berlinDayKey } from '@/core/utils/berlin-day';
import { DEFAULT_DURATION_MS, type EventOccurrence } from '@/features/events/events';

const UTF8_ENCODER = new TextEncoder();

export interface CalendarFeedOccurrence extends EventOccurrence {
	createdAt?: string;
	updatedAt?: string;
}

/**
 * RFC 5545 TEXT escaping — backslash first, or the escapes it inserts below
 * would themselves get escaped.
 */
function escapeIcsText(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r\n|\r|\n/g, '\\n');
}

function takeUtf8Prefix(value: string, maxBytes: number): [string, string] {
	let bytes = 0;
	let end = 0;
	for (const character of value) {
		const characterBytes = UTF8_ENCODER.encode(character).byteLength;
		if (bytes + characterBytes > maxBytes) break;
		bytes += characterBytes;
		end += character.length;
	}
	return [value.slice(0, end), value.slice(end)];
}

/** RFC 5545 line folding, measured in UTF-8 octets rather than JS characters. */
function foldLine(line: string): string {
	if (UTF8_ENCODER.encode(line).byteLength <= 75) return line;
	let result = '';
	let rest = line;
	let first = true;
	while (rest.length > 0) {
		const [part, remaining] = takeUtf8Prefix(rest, first ? 75 : 74);
		result += `${first ? '' : '\r\n '}${part}`;
		rest = remaining;
		first = false;
	}
	return result;
}

function toIcsUtc(iso: string): string {
	return new Date(iso)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}Z$/, 'Z');
}

function berlinDayToIcsDate(day: string): string {
	return day.replace(/-/g, '');
}

function toIcsDate(iso: string): string {
	return berlinDayToIcsDate(berlinDayKey(new Date(iso)));
}

function toIcsExclusiveDate(iso: string): string {
	const day = berlinDayKey(new Date(iso));
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match) return toIcsDate(iso);
	const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
	return next.toISOString().slice(0, 10).replace(/-/g, '');
}

function occurrenceUid(occ: EventOccurrence): string {
	return `${occ.eventId}-${occ.occurrenceIndex}@manawg.app`;
}

function sequenceFor(iso: string | undefined): number {
	if (!iso) return 0;
	const timestamp = new Date(iso).getTime();
	return Number.isFinite(timestamp) ? Math.max(0, Math.floor(timestamp / 1000)) : 0;
}

function eventLines(
	occ: CalendarFeedOccurrence,
	includeUpdateMetadata: boolean,
	generatedAt: string,
): string[] {
	const lines = [
		'BEGIN:VEVENT',
		`UID:${occurrenceUid(occ)}`,
		`DTSTAMP:${toIcsUtc(
			includeUpdateMetadata ? (occ.createdAt ?? occ.updatedAt ?? generatedAt) : generatedAt,
		)}`,
	];
	if (includeUpdateMetadata) {
		const updatedAt = occ.updatedAt ?? occ.createdAt ?? generatedAt;
		lines.push(`LAST-MODIFIED:${toIcsUtc(updatedAt)}`, `SEQUENCE:${sequenceFor(updatedAt)}`);
	}
	if (occ.allDay) {
		lines.push(`DTSTART;VALUE=DATE:${toIcsDate(occ.startsAt)}`);
		// ICS all-day DTEND is exclusive; the app's end date is an inclusive
		// Berlin calendar date. Add a calendar day, not 24 elapsed hours, so
		// DST boundaries cannot shift the exported date.
		lines.push(`DTEND;VALUE=DATE:${toIcsExclusiveDate(occ.endsAt ?? occ.startsAt)}`);
	} else {
		lines.push(`DTSTART:${toIcsUtc(occ.startsAt)}`);
		// Without DTEND calendar apps show an instant; the app itself shows such events as one hour.
		lines.push(
			`DTEND:${toIcsUtc(occ.endsAt ?? new Date(Date.parse(occ.startsAt) + DEFAULT_DURATION_MS).toISOString())}`,
		);
	}
	lines.push(`SUMMARY:${escapeIcsText(occ.title)}`);
	if (occ.description) lines.push(`DESCRIPTION:${escapeIcsText(occ.description)}`);
	if (occ.location) lines.push(`LOCATION:${escapeIcsText(occ.location)}`);
	lines.push('END:VEVENT');
	return lines;
}

function serializeCalendar(
	occurrences: ReadonlyArray<CalendarFeedOccurrence>,
	calendarName: string | null,
	includeUpdateMetadata: boolean,
	generatedAt: string,
): string {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//ManaWG//Kalender//DE',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
	];
	if (calendarName) lines.push(`X-WR-CALNAME:${escapeIcsText(calendarName)}`);
	// Subscribed feeds: ask clients to re-fetch hourly (default is often once a day or less).
	if (includeUpdateMetadata)
		lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H');
	for (const occurrence of occurrences) {
		lines.push(...eventLines(occurrence, includeUpdateMetadata, generatedAt));
	}
	lines.push('END:VCALENDAR');
	return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/**
 * Serializes one resolved occurrence (not the recurring series) to a single
 * VEVENT — calendar apps get one concrete instance to import, no RRULE
 * translation needed.
 */
export function occurrenceToIcs(occ: EventOccurrence): string {
	return serializeCalendar([occ], null, false, new Date().toISOString());
}

/** Serializes the read-only WG feed with stable occurrence UIDs and updates. */
export function calendarFeedToIcs(
	occurrences: ReadonlyArray<CalendarFeedOccurrence>,
	calendarName: string,
	generatedAt = new Date().toISOString(),
): string {
	const sorted = [...occurrences].sort(
		(a, b) =>
			a.startsAt.localeCompare(b.startsAt) || occurrenceUid(a).localeCompare(occurrenceUid(b)),
	);
	return serializeCalendar(sorted, calendarName, true, generatedAt);
}
