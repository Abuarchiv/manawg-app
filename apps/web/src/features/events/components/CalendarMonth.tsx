'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { subscribeVisibility } from '@/core/hooks/use-online-status';
import {
	type ChoreOccurrence,
	buildDays,
	dayKey,
	groupChoresByDay,
	pickInitialFocusIndex,
	sameDay,
} from '@/features/events/calendar-grid';
import {
	type EventOccurrence,
	eventOverlapsCalendarDay,
	formatEventTimeOfDay,
} from '@/features/events/events';
import { cn } from '@/shared/lib/cn';
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface CalendarMonthProps {
	month: Date;
	occurrences: EventOccurrence[];
	onPrev: () => void;
	onNext: () => void;
	onSelectDay: (day: Date) => void;
	onSelectOccurrence: (occurrence: EventOccurrence) => void;
	selectedDay: Date | null;
	/** Chore due dates in the visible grid; they get a dot like events. */
	choreOccurrences: readonly ChoreOccurrence[];
	wgBaseHref: string;
	/** Events not loaded yet (or loading failed): the day list says so instead of "keine Termine". */
	status?: 'loading' | 'error' | undefined;
}

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;
const MONTH_FORMATTER = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
const FULL_DATE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
	weekday: 'long',
	day: 'numeric',
	month: 'long',
	year: 'numeric',
});

export function CalendarMonth({
	month,
	occurrences,
	onPrev,
	onNext,
	onSelectDay,
	onSelectOccurrence,
	selectedDay,
	choreOccurrences,
	wgBaseHref,
	status,
}: CalendarMonthProps) {
	const days = useMemo(
		() => buildDays(month, occurrences, groupChoresByDay(choreOccurrences)),
		[month, occurrences, choreOccurrences],
	);
	const monthLabel = MONTH_FORMATTER.format(month);
	const [today, setToday] = useState(() => new Date());
	useEffect(() => {
		const refresh = () =>
			setToday((prev) => (dayKey(prev) === dayKey(new Date()) ? prev : new Date()));
		window.addEventListener('focus', refresh);
		const unsubscribeVisibility = subscribeVisibility(refresh);
		return () => {
			window.removeEventListener('focus', refresh);
			unsubscribeVisibility();
		};
	}, []);

	const [focusedIndex, setFocusedIndex] = useState<number>(() =>
		pickInitialFocusIndex(days, selectedDay, today, month),
	);
	const gridRef = useRef<HTMLTableElement>(null);
	const shouldFocusRef = useRef(false);
	const sectionRef = useRef<HTMLElement>(null);

	// The day list sits below the grid; on small screens or at large font sizes
	// it would otherwise end up behind navigation and FAB (scroll-mb in className keeps the gap).
	useEffect(() => {
		if (!selectedDay) return;
		sectionRef.current?.scrollIntoView({
			block: 'nearest',
			behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
		});
	}, [selectedDay]);

	// Reset roving focus with the new month and restore it after keyboard navigation.
	useEffect(() => {
		const nextFocusedIndex = pickInitialFocusIndex(days, selectedDay, today, month);
		setFocusedIndex(nextFocusedIndex);
		if (!shouldFocusRef.current) return;
		shouldFocusRef.current = false;
		gridRef.current?.querySelectorAll<HTMLElement>('[data-day-cell]')[nextFocusedIndex]?.focus();
	}, [days, selectedDay, today, month]);

	useEffect(() => {
		if (!shouldFocusRef.current) return;
		shouldFocusRef.current = false;
		const cells = gridRef.current?.querySelectorAll<HTMLElement>('[data-day-cell]');
		cells?.[focusedIndex]?.focus();
	}, [focusedIndex]);

	const move = useCallback(
		(next: number): void => {
			if (next < 0 || next >= days.length) return;
			shouldFocusRef.current = true;
			setFocusedIndex(next);
		},
		[days.length],
	);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTableElement>): void => {
			const target = event.target as HTMLElement;
			if (!target.hasAttribute('data-day-cell')) return;
			switch (event.key) {
				case 'ArrowLeft':
					event.preventDefault();
					move(focusedIndex - 1);
					break;
				case 'ArrowRight':
					event.preventDefault();
					move(focusedIndex + 1);
					break;
				case 'ArrowUp':
					event.preventDefault();
					move(focusedIndex - 7);
					break;
				case 'ArrowDown':
					event.preventDefault();
					move(focusedIndex + 7);
					break;
				case 'Home':
					event.preventDefault();
					move(Math.floor(focusedIndex / 7) * 7);
					break;
				case 'End':
					event.preventDefault();
					move(Math.floor(focusedIndex / 7) * 7 + 6);
					break;
				case 'PageUp':
					event.preventDefault();
					shouldFocusRef.current = true;
					onPrev();
					break;
				case 'PageDown':
					event.preventDefault();
					shouldFocusRef.current = true;
					onNext();
					break;
			}
		},
		[focusedIndex, move, onPrev, onNext],
	);

	const handleGridClick = useCallback(
		(e: React.MouseEvent<HTMLTableElement>) => {
			const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-day-cell]');
			if (!cell) return;
			const iso = cell.dataset.dayDate;
			if (!iso) return;
			onSelectDay(new Date(iso));
		},
		[onSelectDay],
	);

	const selectedOccurrences = selectedDay
		? occurrences.filter((occurrence) => eventOverlapsCalendarDay(occurrence, selectedDay))
		: [];
	const selectedChores = selectedDay
		? (days.find((d) => sameDay(d.date, selectedDay))?.chores ?? [])
		: [];
	const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, index) =>
		days.slice(index * 7, index * 7 + 7),
	);

	return (
		<Card className="-mx-4 rounded-none border-x-0">
			<CardHeader className="px-[clamp(8px,4%,24px)]">
				<div className="flex items-center justify-between gap-2">
					<Button
						variant="ghost"
						size="icon"
						className="shrink-0"
						onClick={onPrev}
						aria-label="Vorheriger Monat"
					>
						<ChevronLeft aria-hidden />
					</Button>
					<CardTitle className="min-w-0 text-center">{monthLabel}</CardTitle>
					<Button
						variant="ghost"
						size="icon"
						className="shrink-0"
						onClick={onNext}
						aria-label="Nächster Monat"
					>
						<ChevronRight aria-hidden />
					</Button>
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4 px-[4px]">
				<table
					ref={gridRef}
					aria-busy={status === 'loading' || undefined}
					// biome-ignore lint/a11y/useSemanticElements: Calendar uses the existing roving-tabindex grid controller.
					role="grid"
					aria-label={`Kalender ${monthLabel}`}
					className="w-full table-fixed border-separate border-spacing-0"
					onKeyDown={handleKeyDown}
					onClick={handleGridClick}
				>
					<thead>
						<tr>
							{WEEKDAY_LABELS.map((label) => (
								<th
									key={label}
									scope="col"
									className="py-2 text-center text-xs font-normal text-muted-foreground"
								>
									{label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{weeks.map((week, weekIndex) => (
							<tr key={week[0]?.date.toISOString()}>
								{week.map((day, dayIndex) => {
									const isToday = sameDay(day.date, today);
									const isSelected = selectedDay !== null && sameDay(day.date, selectedDay);
									return (
										<td
											key={day.date.toISOString()}
											// biome-ignore lint/a11y/useSemanticElements: A table cell is required to carry selected-date state inside the calendar grid.
											// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: Grid cells are required for selection semantics; the child button handles keyboard interaction.
											role="gridcell"
											aria-selected={isSelected}
											tabIndex={-1}
											className="p-0 align-middle"
										>
											<Button
												type="button"
												variant="ghost"
												data-day-cell
												data-day-date={day.date.toISOString()}
												tabIndex={weekIndex * 7 + dayIndex === focusedIndex ? 0 : -1}
												aria-label={
													FULL_DATE_FORMATTER.format(day.date) +
													(day.occurrences.length === 1
														? ', 1 Termin'
														: day.occurrences.length
															? `, ${day.occurrences.length} Termine`
															: '') +
													(day.chores.length ? ', Putzplan' : '')
												}
												aria-current={isToday ? 'date' : undefined}
												className={cn(
													'relative min-h-11 w-full px-0 hover:bg-transparent active:bg-transparent dark:hover:bg-transparent',
													!day.inCurrentMonth && 'opacity-50',
												)}
											>
												<span
													className={cn(
														'grid aspect-square w-[min(2rem,100%)] place-items-center rounded-full',
														isSelected
															? 'bg-primary text-primary-foreground'
															: isToday
																? 'bg-secondary text-secondary-foreground'
																: 'group-active/button:bg-muted',
													)}
												>
													{day.date.getDate()}
												</span>
												{(day.occurrences.length > 0 || day.chores.length > 0) && (
													<span
														aria-hidden
														className="absolute bottom-0.5 size-1 rounded-full bg-current"
													/>
												)}
											</Button>
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
				{selectedDay && (
					<section
						ref={sectionRef}
						aria-label="Termine am ausgewählten Tag"
						className="flex scroll-mb-[calc(var(--app-nav-height,5rem)+4.5rem)] flex-col gap-2 px-4"
					>
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-sm font-medium">{FULL_DATE_FORMATTER.format(selectedDay)}</h3>
							{selectedOccurrences.length + selectedChores.length > 0 && (
								<Badge variant="secondary">
									{selectedOccurrences.length + selectedChores.length === 1
										? '1 Eintrag'
										: `${selectedOccurrences.length + selectedChores.length} Einträge`}
								</Badge>
							)}
						</div>
						{selectedOccurrences.length === 0 && selectedChores.length === 0 ? (
							status === 'loading' ? (
								<output aria-live="polite" className="text-sm text-muted-foreground">
									Termine werden geladen…
								</output>
							) : status === 'error' ? (
								<p className="text-sm text-muted-foreground">
									Termine konnten nicht geladen werden.
								</p>
							) : (
								<p className="text-sm text-muted-foreground">Keine Termine an diesem Tag.</p>
							)
						) : (
							<ul className="flex flex-col divide-y divide-border/60">
								{selectedOccurrences.map((occurrence) => (
									<li key={`${occurrence.eventId}-${occurrence.occurrenceIndex}`}>
										<button
											type="button"
											onClick={() => onSelectOccurrence(occurrence)}
											aria-label={`Termin öffnen: ${occurrence.title}`}
											className="flex min-h-11 w-full min-w-0 items-center gap-2 py-1.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 active:bg-muted"
										>
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="text-[14px] font-medium break-words">
													{occurrence.title}
												</span>
												<span className="text-[12px] break-words text-muted-foreground">
													{formatEventTimeOfDay(occurrence)}
													{occurrence.location && ` · ${occurrence.location}`}
												</span>
											</span>
											<ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
										</button>
									</li>
								))}
								{selectedChores.map((chore) => (
									<li key={`chore-${chore.choreId}-${chore.startsAt}`}>
										<Link
											href={`${wgBaseHref}/putzen?highlight=${encodeURIComponent(chore.choreId)}`}
											aria-label={`Putzaufgabe öffnen: ${chore.title}`}
											className="flex min-h-11 w-full min-w-0 items-center gap-2 py-1.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 active:bg-muted"
										>
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="text-[14px] font-medium break-words">{chore.title}</span>
												<span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
													<Sparkles className="size-4 shrink-0" aria-hidden />
													Putzplan
												</span>
											</span>
											<ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
										</Link>
									</li>
								))}
							</ul>
						)}
					</section>
				)}
			</CardContent>
		</Card>
	);
}
