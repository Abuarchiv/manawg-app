export interface MentionTrigger {
	query: string;
	startIndex: number;
}

export function detectMention(value: string, cursor: number): MentionTrigger | null {
	const upTo = value.slice(0, cursor);
	// Unicode letters like the mention check on send, otherwise the picker stops at "René" after the é.
	const match = /(?:^|\s)@([\p{L}\p{N}_-]{1,40})$/u.exec(upTo);
	if (!match) return null;
	const start = upTo.length - (match[1]?.length ?? 0) - 1;
	return { query: match[1] ?? '', startIndex: start };
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface MentionSegment {
	text: string;
	/** Name of the mentioned member, set for "@Name" segments only. */
	mention?: string;
}

export interface MentionMatch {
	index: number;
	text: string;
	name: string;
}

/**
 * Finds "@Name" mentions of the given member names. Longest name first, matched ranges are
 * consumed, so "@Anna Lena" never also counts as "@Anna". The "@" must follow the start or a
 * non-word character ("info@anna.de" is no mention). No lookbehind: Safari < 16.4 rejects it.
 */
export function findMentions(body: string, names: readonly string[]): MentionMatch[] {
	const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
	if (sorted.length === 0 || !body.includes('@')) return [];
	// The trailing lookahead is Unicode-aware: a plain `\b` fails after "René".
	const pattern = new RegExp(
		`(^|[^\\p{L}\\p{N}_])@(${sorted.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_-])`,
		'gu',
	);
	return [...body.matchAll(pattern)].map((match) => {
		const lead = match[1]?.length ?? 0;
		return { index: match.index + lead, text: match[0].slice(lead), name: match[2] ?? '' };
	});
}

/** Splits a message body into plain text and "@Name" segments for the given member names. */
export function splitMentions(body: string, names: readonly string[]): MentionSegment[] {
	const segments: MentionSegment[] = [];
	let last = 0;
	for (const match of findMentions(body, names)) {
		if (match.index > last) segments.push({ text: body.slice(last, match.index) });
		segments.push({ text: match.text, mention: match.name });
		last = match.index + match.text.length;
	}
	if (last < body.length) segments.push({ text: body.slice(last) });
	return segments.length > 0 ? segments : [{ text: body }];
}

/** Distinct http(s) links in a message, without trailing sentence punctuation. */
export function extractLinks(body: string, max = 3): string[] {
	const links = new Set<string>();
	for (const match of body.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
		const candidate = match[0].replace(/[.,;:!?)\]}]+$/u, '');
		try {
			const url = new URL(candidate);
			if (url.protocol === 'http:' || url.protocol === 'https:') links.add(url.href);
		} catch {
			// Not a valid URL: skip it.
		}
		if (links.size >= max) break;
	}
	return [...links];
}

const dayLabelFormats = new Map<string, Intl.DateTimeFormat>();

/** "Heute", "Gestern", else weekday and date; the year is added for days before this year. */
export function formatChatDayLabel(day: Date, now: Date = new Date(), locale = 'de-DE'): string {
	const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	if (dayStart === today.getTime()) return 'Heute';
	if (dayStart === new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime())
		return 'Gestern';
	const withYear = day.getFullYear() !== now.getFullYear();
	const cacheKey = `${locale}|${withYear}`;
	let format = dayLabelFormats.get(cacheKey);
	if (!format) {
		format = new Intl.DateTimeFormat(locale, {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			...(withYear ? { year: 'numeric' as const } : {}),
		});
		dayLabelFormats.set(cacheKey, format);
	}
	return format.format(day);
}
