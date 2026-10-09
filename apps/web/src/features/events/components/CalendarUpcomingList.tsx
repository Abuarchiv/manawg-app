'use client';

import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import { MS_PER_DAY } from '@/core/utils/time';
import {
	type EventOccurrence,
	RECURRENCE_OPTIONS,
	eventDateForDisplay,
	formatEventTimeOfDay,
	formatEventTimeRange,
	parseRecurrenceRule,
} from '@/features/events/events';
import { occurrenceToIcs } from '@/features/events/ics';
import { cn } from '@/shared/lib/cn';
import { CalendarClock, ChevronRight, Repeat, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';

interface CalendarUpcomingListProps {
	occurrences: EventOccurrence[];
	choreOccurrences: ReadonlyArray<{
		choreId: string;
		title: string;
		startsAt: string;
	}>;
	onSelect: (occurrence: EventOccurrence) => void;
	wgBaseHref: string;
	/** Rule per event (eventId); it yields the interval behind the time. */
	recurrenceByEventId?: ReadonlyMap<string, string | null>;
	/** Event from the push link (`?highlight=`); its next occurrence is marked and scrolled to. */
	highlightEventId?: string | null;
}

const ROW_CLASS =
	'flex min-h-11 w-full min-w-0 items-center gap-2 py-1.5 pr-3 pl-1 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 active:bg-muted';

const DAY_FORMATTER = new Intl.DateTimeFormat('de-DE', {
	weekday: 'long',
	day: 'numeric',
	month: 'long',
});
const MONTH_SHORT_FORMATTER = new Intl.DateTimeFormat('de-DE', { month: 'short' });
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });

/** Short interval like "wöchentlich"; more complex rules are labeled generically as "wiederkehrend". */
function recurrenceLabel(rule: string | null | undefined): string {
	const parsed = parseRecurrenceRule(rule);
	const simple = parsed && parsed.interval === 1 && parsed.byDay === undefined;
	const option = simple ? RECURRENCE_OPTIONS.find((o) => o.value === parsed.freq) : undefined;
	return option ? option.label.toLowerCase() : 'wiederkehrend';
}

function formatDayLabel(date: Date, now = new Date()): string {
	const dayMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const diff = Math.round((dayMs - todayMs) / MS_PER_DAY);
	if (diff === 0) return `Heute · ${DAY_FORMATTER.format(date)}`;
	if (diff === 1) return `Morgen · ${DAY_FORMATTER.format(date)}`;
	return DAY_FORMATTER.format(date);
}

/** Time of day; a timed span that began before today names its start day too. */
function timeLabel(occurrence: EventOccurrence, todayStart: Date): string {
	return !occurrence.allDay && new Date(occurrence.startsAt) < todayStart
		? formatEventTimeRange(occurrence)
		: formatEventTimeOfDay(occurrence);
}

export function downloadOccurrenceIcs(occ: EventOccurrence): void {
	const blob = new Blob([occurrenceToIcs(occ)], { type: 'text/calendar;charset=utf-8' });
	const href = window.URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = href;
	a.download = `${occ.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'termin'}.ics`;
	a.style.display = 'none';
	document.body.appendChild(a);
	a.click();
	a.remove();
	window.setTimeout(() => window.URL.revokeObjectURL(href), 0);
}

export function CalendarUpcomingList({
	occurrences,
	choreOccurrences,
	onSelect,
	wgBaseHref,
	recurrenceByEventId,
	highlightEventId = null,
}: CalendarUpcomingListProps) {
	useEffect(() => {
		if (!highlightEventId) return;
		document.getElementById(`event-${highlightEventId}`)?.scrollIntoView({ block: 'center' });
	}, [highlightEventId]);

	const entries = [
		...occurrences.map((occurrence) => ({
			kind: 'event' as const,
			startsAt: occurrence.startsAt,
			occurrence,
		})),
		...choreOccurrences.map((chore) => ({
			kind: 'chore' as const,
			startsAt: chore.startsAt,
			chore,
		})),
	].sort((a, b) => a.startsAt.localeCompare(b.startsAt));

	if (entries.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<CalendarClock aria-hidden />
					</EmptyMedia>
					<EmptyTitle>Keine Termine in den nächsten 30 Tagen</EmptyTitle>
					<EmptyDescription>Tippe auf +, um einen Termin anzulegen.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	// For series, only the first occurrence carries the anchor.
	const highlightedEntry = highlightEventId
		? entries.find(
				(entry) => entry.kind === 'event' && entry.occurrence.eventId === highlightEventId,
			)
		: undefined;
	const days = new Map<string, { label: string; date: Date; entries: typeof entries }>();
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	for (const entry of entries) {
		const startDate =
			entry.kind === 'event'
				? eventDateForDisplay(entry.startsAt, entry.occurrence.allDay)
				: new Date(entry.startsAt);
		// A span that began before today is still running: list it under today, not under a past day.
		const date = startDate < todayStart ? todayStart : startDate;
		const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
		const day = days.get(key) ?? { label: formatDayLabel(date), date, entries: [] };
		day.entries.push(entry);
		days.set(key, day);
	}

	// One list, date on the left: days can be skimmed like in a pocket calendar.
	return (
		<ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
			{[...days.entries()].map(([key, day], index, all) => {
				const prevDate = index > 0 ? all[index - 1]?.[1].date : undefined;
				const showMonth = !prevDate || prevDate.getMonth() !== day.date.getMonth();
				const isToday = day.label.startsWith('Heute');
				return (
					<li key={key} className="grid grid-cols-[3.25rem_minmax(0,1fr)]">
						<h3
							className={cn(
								'flex flex-col items-center py-2 leading-tight',
								isToday ? 'text-foreground' : 'text-muted-foreground',
							)}
						>
							<span className="sr-only">{day.label}</span>
							<span aria-hidden className="text-[12px]">
								{isToday ? 'Heute' : WEEKDAY_FORMATTER.format(day.date).replace('.', '')}
							</span>
							<span aria-hidden className="flex items-baseline gap-0.5">
								<span className="text-base font-semibold tabular-nums">{day.date.getDate()}</span>
								{showMonth && (
									<span className="text-[12px] font-normal">
										{MONTH_SHORT_FORMATTER.format(day.date).replace('.', '')}
									</span>
								)}
							</span>
						</h3>
						<ul aria-label={day.label} className="flex min-w-0 flex-col divide-y divide-border/60">
							{day.entries.map((entry) =>
								entry.kind === 'chore' ? (
									<li key={`chore-${entry.chore.choreId}-${entry.chore.startsAt}`}>
										<Link
											href={`${wgBaseHref}/putzen?highlight=${encodeURIComponent(entry.chore.choreId)}`}
											aria-label={`Putzaufgabe öffnen: ${entry.chore.title}`}
											className={ROW_CLASS}
										>
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="text-[14px] font-medium break-words">
													{entry.chore.title}
												</span>
												<span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
													<Sparkles className="size-4 shrink-0" aria-hidden />
													Putzplan
												</span>
											</span>
											<ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
										</Link>
									</li>
								) : (
									<li
										key={`${entry.occurrence.eventId}-${entry.occurrence.occurrenceIndex}`}
										id={
											entry === highlightedEntry ? `event-${entry.occurrence.eventId}` : undefined
										}
										className={cn(
											'scroll-mt-24',
											entry === highlightedEntry && 'ring-2 ring-inset ring-ring',
										)}
									>
										<button
											type="button"
											onClick={() => onSelect(entry.occurrence)}
											aria-label={`Termin bearbeiten: ${entry.occurrence.title}`}
											className={ROW_CLASS}
										>
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="text-[14px] font-medium break-words">
													{entry.occurrence.title}
												</span>
												<span className="text-[12px] break-words text-muted-foreground">
													<CalendarClock className="mr-1 inline size-4 align-[-2px]" aria-hidden />
													{timeLabel(entry.occurrence, todayStart)}
													{entry.occurrence.location && ` · ${entry.occurrence.location}`}
													{entry.occurrence.recurring && (
														<>
															{' · '}
															<span className="whitespace-nowrap">
																<Repeat className="mr-0.5 inline size-3 align-[-1px]" aria-hidden />
																{recurrenceLabel(
																	recurrenceByEventId?.get(entry.occurrence.eventId),
																)}
															</span>
														</>
													)}
												</span>
											</span>
											<ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
										</button>
									</li>
								),
							)}
						</ul>
					</li>
				);
			})}
		</ul>
	);
}
