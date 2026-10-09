import { berlinDayKey, endOfBerlinDay, startOfBerlinDay } from '@/core/utils/berlin-day';
import { parseTimestamp } from '@/core/utils/time';
import type { EventOccurrence } from '@/features/events/events';
import { type TodayImportantInput, choreUrgency, dueLabel } from './dashboard-today';

export interface BerlinWeekWindow {
	todayKey: string;
	weekStartKey: string;
	sundayKey: string;
	from: Date;
	to: Date;
}

function shiftDayKey(dayKey: string, amount: number): string {
	const [year, month, day] = dayKey.split('-').map(Number);
	return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + amount))
		.toISOString()
		.slice(0, 10);
}

export function getBerlinWeekWindow(now = Date.now()): BerlinWeekWindow {
	const todayKey = berlinDayKey(new Date(now));
	const weekday = new Date(`${todayKey}T00:00:00.000Z`).getUTCDay();
	const weekStartKey = shiftDayKey(todayKey, -((weekday + 6) % 7));
	const sundayKey = shiftDayKey(weekStartKey, 6);
	const today = new Date(`${todayKey}T12:00:00.000Z`);
	const sunday = new Date(`${sundayKey}T12:00:00.000Z`);
	return {
		todayKey,
		weekStartKey,
		sundayKey,
		from: startOfBerlinDay(today),
		to: endOfBerlinDay(sunday),
	};
}

export interface WeekAgendaItem {
	key: string;
	kind: 'event' | 'chore';
	title: string;
	detail: string;
	href: string;
	dayKey: string;
	at: number;
}

export interface WeekAgenda {
	todayKey: string;
	weekStartKey: string;
	sundayKey: string;
	overdue: WeekAgendaItem[];
	upcoming: WeekAgendaItem[];
}

const AGENDA_TIME_FORMATTER = new Intl.DateTimeFormat('de-DE', {
	hour: '2-digit',
	minute: '2-digit',
	timeZone: 'Europe/Berlin',
});

export function getWeekAgenda(input: {
	shareCode: string;
	currentMemberId: string;
	dueChores: TodayImportantInput['dueChores'];
	events: EventOccurrence[];
	now?: number;
}): WeekAgenda {
	const now = input.now ?? Date.now();
	const window = getBerlinWeekWindow(now);
	const base = `/wg/${encodeURIComponent(input.shareCode)}`;
	const overdue: WeekAgendaItem[] = [];
	const upcoming: WeekAgendaItem[] = [];

	for (const chore of input.dueChores) {
		const isOwn = chore.assignedMemberId === input.currentMemberId;
		// Own chores live in "Für dich" — except those 4+ days out, which it drops.
		if (isOwn && choreUrgency(chore.nextDueAt, now) !== 3) continue;
		const at = parseTimestamp(chore.nextDueAt);
		if (at === null) continue;
		const dayKey = berlinDayKey(new Date(at));
		if (dayKey > window.sundayKey) continue;
		const who = isOwn ? 'Du' : (chore.assignedMemberName ?? 'Noch nicht zugewiesen');
		const item: WeekAgendaItem = {
			key: `chore:${chore.id}`,
			kind: 'chore',
			title: chore.title,
			detail: dayKey < window.todayKey ? `${who} · ${dueLabel(chore.nextDueAt, now)}` : who,
			href: `${base}/putzen?highlight=${encodeURIComponent(chore.id)}`,
			dayKey,
			at,
		};
		(dayKey < window.todayKey ? overdue : upcoming).push(item);
	}

	for (const event of input.events) {
		const start = parseTimestamp(event.startsAt);
		if (start === null) continue;
		const end = parseTimestamp(event.endsAt ?? event.startsAt) ?? start;
		const startKey = berlinDayKey(new Date(start));
		const endKey = berlinDayKey(new Date(end));
		if (endKey < window.todayKey || startKey > window.sundayKey) continue;
		const dayKey = startKey < window.todayKey ? window.todayKey : startKey;
		const ongoing = start <= now && now < end;
		const when = event.allDay
			? 'ganztägig'
			: ongoing
				? 'läuft'
				: startKey < window.todayKey
					? `Endete heute um ${AGENDA_TIME_FORMATTER.format(new Date(end))}`
					: AGENDA_TIME_FORMATTER.format(new Date(start));
		upcoming.push({
			key: `event:${event.eventId}:${event.occurrenceIndex}`,
			kind: 'event',
			title: event.title,
			detail: event.location ? `${when} · ${event.location}` : when,
			href: `${base}/kalender?highlight=${encodeURIComponent(event.eventId)}`,
			dayKey,
			at: event.allDay
				? startOfBerlinDay(new Date(`${dayKey}T12:00:00.000Z`)).getTime()
				: Math.max(start, window.from.getTime()),
		});
	}

	const sortByDate = (a: WeekAgendaItem, b: WeekAgendaItem) =>
		a.dayKey.localeCompare(b.dayKey) || a.at - b.at;
	return {
		todayKey: window.todayKey,
		weekStartKey: window.weekStartKey,
		sundayKey: window.sundayKey,
		overdue: overdue.sort(sortByDate),
		upcoming: upcoming.sort(sortByDate),
	};
}
