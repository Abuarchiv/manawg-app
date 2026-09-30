'use client';

import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@/components/ui/empty';
import {
	type EventOccurrence,
	eventDateForDisplay,
	formatEventTimeOfDay,
} from '@/features/events/events';
import { occurrenceToIcs } from '@/features/events/ics';
import { cn } from '@/shared/lib/cn';
import { CalendarClock, ChevronRight, Sparkles } from 'lucide-react';
import Link from 'next/link';

interface CalendarUpcomingListProps {
	occurrences: EventOccurrence[];
	choreOccurrences: ReadonlyArray<{
		choreId: string;
		title: string;
		startsAt: string;
	}>;
	onSelect: (occurrence: EventOccurrence) => void;
	wgBaseHref: string;
}

const ROW_CLASS =
	'flex min-h-11 w-full min-w-0 items-center gap-2 py-1.5 pr-3 pl-1 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 active:bg-muted';

const DAY_FORMATTER = new Intl.DateTimeFormat('de-DE', {
	weekday: 'long',
	day: 'numeric',
	month: 'long',
});
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });

function formatDayLabel(date: Date, now = new Date()): string {
	const dayMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const diff = Math.round((dayMs - todayMs) / 86_400_000);
	if (diff === 0) return `Heute · ${DAY_FORMATTER.format(date)}`;
	if (diff === 1) return `Morgen · ${DAY_FORMATTER.format(date)}`;
	return DAY_FORMATTER.format(date);
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
}: CalendarUpcomingListProps) {
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
					<EmptyTitle>Die nächsten 30 Tage sind frei</EmptyTitle>
					<EmptyDescription>Trag euren nächsten Termin ein.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	const days = new Map<string, { label: string; date: Date; entries: typeof entries }>();
	for (const entry of entries) {
		const date =
			entry.kind === 'event'
				? eventDateForDisplay(entry.startsAt, entry.occurrence.allDay)
				: new Date(entry.startsAt);
		const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
		const day = days.get(key) ?? { label: formatDayLabel(date), date, entries: [] };
		day.entries.push(entry);
		days.set(key, day);
	}

	// Eine Liste, Datum links: Tage lassen sich wie in einem Taschenkalender überfliegen.
	return (
		<ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
			{[...days.entries()].map(([key, day]) => {
				const isToday = day.label.startsWith('Heute');
				return (
					<li key={key} className="grid grid-cols-[3.25rem_minmax(0,1fr)]">
						<h3
							className={cn(
								'flex flex-col items-center pt-2 leading-tight',
								isToday ? 'text-foreground' : 'text-muted-foreground',
							)}
						>
							<span className="sr-only">{day.label}</span>
							<span aria-hidden className="text-[11px] uppercase">
								{isToday ? 'Heute' : WEEKDAY_FORMATTER.format(day.date).replace('.', '')}
							</span>
							<span
								aria-hidden
								className={cn('text-base font-semibold tabular-nums', isToday && 'text-foreground')}
							>
								{day.date.getDate()}
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
													<Sparkles className="size-3.5 shrink-0" aria-hidden />
													Putzplan
												</span>
											</span>
											<ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
										</Link>
									</li>
								) : (
									<li key={`${entry.occurrence.eventId}-${entry.occurrence.occurrenceIndex}`}>
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
													<CalendarClock
														className="mr-1 inline size-3.5 align-[-2px]"
														aria-hidden
													/>
													{formatEventTimeOfDay(entry.occurrence)}
													{entry.occurrence.location && ` · ${entry.occurrence.location}`}
													{entry.occurrence.recurring && ' · wiederholt sich'}
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
