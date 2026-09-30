'use client';

import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SubNav } from '@/components/wg/SubNav';
import { ThumbAction } from '@/components/wg/ThumbAction';
import { useWg } from '@/components/wg/WgContextProvider';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import { copyText } from '@/core/utils/clipboard';
import { MS_PER_DAY } from '@/core/utils/time';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import { CalendarMonth } from '@/features/events/components/CalendarMonth';
import {
	CalendarUpcomingList,
	downloadOccurrenceIcs,
} from '@/features/events/components/CalendarUpcomingList';
import {
	type CreateEventPayload,
	EventCreateModal,
} from '@/features/events/components/EventCreateModal';
import {
	type EditableEvent,
	EventEditModal,
	type UpdateEventPayload,
} from '@/features/events/components/EventEditModal';
import {
	type EventInput,
	type EventOccurrence,
	expandAgendaRecurrence,
	expandRecurrence,
	getCalendarDayBounds,
	getMonthBounds,
} from '@/features/events/events';
import { haptic } from '@/shared/lib/haptics';
import {
	CalendarDays,
	ChevronRight,
	ExternalLink,
	List,
	Loader2,
	Plus,
	RefreshCw,
	RotateCcw,
	Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface CalendarEvent {
	id: string;
	title: string;
	description: string | null;
	startsAt: string;
	endsAt: string | null;
	allDay: boolean;
	location: string | null;
	recurrence: string | null;
}

type CalendarCreateWarning =
	| null
	| 'notification_delivery_failed'
	| 'notification_delivery_unknown';
type CalendarCreateResponse = { event: CalendarEvent; warning: CalendarCreateWarning };

interface ChoreSummary {
	id: string;
	title: string;
	nextDueAt: string;
}

interface CalendarSubscription {
	feedUrl: string;
	createdAt: string;
	updatedAt: string;
}

interface CalendarSubscriptionResponse {
	subscription: CalendarSubscription | null;
}

type ViewMode = 'month' | 'list';

const UPCOMING_DAYS = 30;

function eventToInput(event: CalendarEvent): EventInput {
	return {
		id: event.id,
		title: event.title,
		description: event.description,
		startsAt: event.startsAt,
		endsAt: event.endsAt,
		allDay: event.allDay,
		location: event.location,
		recurrence: event.recurrence,
	};
}

function buildChoreOccurrences(
	chores: ChoreSummary[],
	from: Date,
	to: Date,
): Array<{ choreId: string; title: string; startsAt: string }> {
	const fromMs = from.getTime();
	const toMs = to.getTime();
	return chores
		.filter((chore) => {
			const ts = Date.parse(chore.nextDueAt);
			return ts >= fromMs && ts <= toMs;
		})
		.map((chore) => ({ choreId: chore.id, title: chore.title, startsAt: chore.nextDueAt }))
		.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

// craftsman-ignore: TS002 — Next.js App Router requires default export from page.tsx
export default function KalenderPage() {
	const { wg, identity } = useWg();
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const wgBaseHref = `/wg/${encodedShareCode}`;
	const [month, setMonth] = useState<Date>(() => {
		const now = new Date();
		return new Date(now.getFullYear(), now.getMonth(), 1);
	});
	const calendarEventsUrl = useMemo(() => {
		const bounds = getMonthBounds(month);
		const upcomingFrom = new Date();
		const upcomingTo = new Date(upcomingFrom.getTime() + UPCOMING_DAYS * MS_PER_DAY);
		const fromParam = new Date(
			Math.min(bounds.start.getTime(), getCalendarDayBounds(upcomingFrom).start.getTime()),
		).toISOString();
		const toParam = new Date(
			Math.max(bounds.end.getTime(), getCalendarDayBounds(upcomingTo).end.getTime()),
		).toISOString();
		return `/api/wg/${encodedShareCode}/events?from=${encodeURIComponent(fromParam)}&to=${encodeURIComponent(toParam)}`;
	}, [encodedShareCode, month]);
	const choresUrl = `/api/wg/${encodedShareCode}/chores`;
	const subscriptionEndpoint = `/api/wg/${encodedShareCode}/calendar-subscription`;
	const {
		data: cachedEvents,
		error: eventsReadError,
		refresh: refreshEvents,
		setData: setCachedEvents,
	} = useCachedFetch<{ events: CalendarEvent[] }>(calendarEventsUrl, {
		memberId: identity.memberId,
	});
	const {
		data: cachedChores,
		error: choresReadError,
		refresh: refreshChores,
	} = useCachedFetch<{ chores: ChoreSummary[] }>(choresUrl, { memberId: identity.memberId });
	const subscriptionScope = `${encodedShareCode}\u0000${identity.memberId}`;
	const subscriptionScopeRef = useRef(subscriptionScope);
	subscriptionScopeRef.current = subscriptionScope;
	const subscriptionRequestIdRef = useRef(0);
	const subscriptionBusyRef = useRef(false);
	const subscriptionBusyScopeRef = useRef<string | null>(null);
	const [events, setEvents] = useState<CalendarEvent[]>(() => cachedEvents?.events ?? []);
	function updateEvents(update: (current: CalendarEvent[]) => CalendarEvent[]): void {
		setEvents(update);
		setCachedEvents((current) => {
			const previous = current?.events ?? events;
			const next = update(previous);
			if (!current && next === previous) return current;
			return { ...(current ?? { events: previous }), events: next };
		});
	}
	const createEventRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const [chores, setChores] = useState<ChoreSummary[]>(() => cachedChores?.chores ?? []);
	const [loading, setLoading] = useState(!cachedEvents || !cachedChores);
	const hasCalendarDataRef = useRef(Boolean(cachedEvents && cachedChores));
	const [loadError, setLoadError] = useState<string | null>(null);
	// Liste als Default: eine WG hat selten mehr als eine Handvoll Termine im
	// Monat — das Grid ist die Ausnahme-Ansicht, nicht der Einstieg.
	const [view, setView] = useState<ViewMode>('list');
	const [selectedDay, setSelectedDay] = useState<Date | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [editing, setEditing] = useState<EditableEvent | null>(null);
	const [editingOccurrence, setEditingOccurrence] = useState<EventOccurrence | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [subscriptionRecord, setSubscriptionRecord] = useState<{
		scope: string;
		value: CalendarSubscription | null;
	} | null>(null);
	const subscription =
		subscriptionRecord?.scope === subscriptionScope ? subscriptionRecord.value : null;
	const [subscriptionLoadingState, setSubscriptionLoadingState] = useState<{
		scope: string;
		loading: boolean;
	} | null>(null);
	const subscriptionLoading =
		subscriptionLoadingState?.scope !== subscriptionScope || subscriptionLoadingState.loading;
	const [subscriptionBusy, setSubscriptionBusy] = useState(false);
	const [subscriptionErrorState, setSubscriptionErrorState] = useState<{
		scope: string;
		message: string | null;
	} | null>(null);
	const subscriptionError =
		subscriptionErrorState?.scope === subscriptionScope ? subscriptionErrorState.message : null;
	const [subscriptionNotice, setSubscriptionNotice] = useState<string | null>(null);
	const subscriptionRequestKeysRef = useRef(new Map<string, string>());
	const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
	const [subscriptionConfirm, setSubscriptionConfirm] = useState<'rotate' | 'revoke' | null>(null);
	function updateSubscription(next: CalendarSubscription | null): void {
		setSubscriptionRecord({ scope: subscriptionScope, value: next });
	}
	function setSubscriptionError(message: string | null): void {
		setSubscriptionErrorState({ scope: subscriptionScope, message });
	}
	function invalidateSubscriptionRead(scope: string): void {
		if (subscriptionScopeRef.current !== scope) return;
		subscriptionRequestIdRef.current += 1;
		setSubscriptionLoadingState({ scope, loading: false });
	}
	const load = useCallback(
		async (isInitial: boolean): Promise<void> => {
			if (isInitial && !hasCalendarDataRef.current) setLoading(true);

			const [eventsRes, choreRes] = await Promise.all([refreshEvents(), refreshChores()]);

			let nextError: string | null = null;
			if (eventsRes.ok) setEvents(eventsRes.data.events);
			else nextError = 'Termine konnten nicht geladen werden.';
			if (choreRes.ok) {
				setChores(
					choreRes.data.chores.map((chore) => ({
						id: chore.id,
						title: chore.title,
						nextDueAt: chore.nextDueAt,
					})),
				);
			} else if (!nextError) nextError = 'Putzplan-Aufgaben konnten nicht geladen werden.';
			setLoadError(nextError);
			if (isInitial) setLoading(false);
		},
		[refreshChores, refreshEvents],
	);

	useEffect(() => {
		if (cachedEvents) setEvents(cachedEvents.events);
		if (cachedChores) {
			hasCalendarDataRef.current = true;
			setChores(cachedChores.chores.map(({ id, title, nextDueAt }) => ({ id, title, nextDueAt })));
		}
		if (cachedEvents && cachedChores) {
			setLoadError(null);
			setLoading(false);
		} else if (eventsReadError || choresReadError) {
			setLoadError('Termine oder Putzplan-Aufgaben konnten nicht geladen werden.');
			setLoading(false);
		}
	}, [cachedChores, cachedEvents, choresReadError, eventsReadError]);

	// Auto-Refresh wie auf dem Dashboard — ersetzt den manuellen Reload-Button.
	useVisibilityPausedInterval(() => void load(false), 30_000);
	useEffect(() => {
		void load(true);
	}, [load]);

	const loadSubscription = useCallback(async (): Promise<void> => {
		const requestedScope = subscriptionScope;
		if (subscriptionBusyScopeRef.current === requestedScope) return;
		const requestId = ++subscriptionRequestIdRef.current;
		setSubscriptionLoadingState({ scope: requestedScope, loading: true });
		const res = await apiFetch<CalendarSubscriptionResponse>(subscriptionEndpoint, {
			memberId: identity.memberId,
			memberToken: identity.memberToken,
		});
		if (
			subscriptionScopeRef.current !== requestedScope ||
			subscriptionRequestIdRef.current !== requestId
		) {
			return;
		}
		if (res.ok) {
			setSubscriptionRecord({ scope: requestedScope, value: res.data.subscription ?? null });
			setSubscriptionErrorState({ scope: requestedScope, message: null });
		} else {
			setSubscriptionErrorState({
				scope: requestedScope,
				message: 'Kalender-Feed konnte nicht geladen werden.',
			});
		}
		setSubscriptionLoadingState({ scope: requestedScope, loading: false });
	}, [identity.memberId, identity.memberToken, subscriptionEndpoint, subscriptionScope]);

	useEffect(() => {
		void loadSubscription();
		const onFocus = () => void loadSubscription();
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	}, [loadSubscription]);

	const monthOccurrences = useMemo<EventOccurrence[]>(() => {
		const bounds = getMonthBounds(month);
		return events.flatMap((event) =>
			expandRecurrence(eventToInput(event), bounds.start, bounds.end),
		);
	}, [events, month]);

	const upcomingOccurrences = useMemo<EventOccurrence[]>(() => {
		const from = new Date();
		const to = new Date(from.getTime() + UPCOMING_DAYS * MS_PER_DAY);
		const all = events.flatMap((event) => expandAgendaRecurrence(eventToInput(event), from, to));
		return all.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
	}, [events]);

	const upcomingChoreOccurrences = useMemo(() => {
		const from = new Date();
		const to = new Date(from.getTime() + UPCOMING_DAYS * MS_PER_DAY);
		return buildChoreOccurrences(chores, from, to);
	}, [chores]);

	function handleSelectOccurrence(occ: EventOccurrence): void {
		const event = events.find((e) => e.id === occ.eventId);
		if (!event) return;
		setEditingOccurrence(occ);
		setEditing(event);
	}

	async function handleCreate(payload: CreateEventPayload): Promise<void> {
		const fingerprint = JSON.stringify(payload);
		const pending = createEventRequestRef.current;
		const idempotencyKey =
			pending?.fingerprint === fingerprint ? pending.key : createOfflineIdempotencyKey();
		if (!idempotencyKey) throw new Error('Termin konnte nicht sicher gesendet werden.');
		createEventRequestRef.current = { fingerprint, key: idempotencyKey };
		const optimisticId = `pending:${idempotencyKey}`;
		const optimisticEvent: CalendarEvent = { id: optimisticId, ...payload };
		updateEvents((current) => [...current, optimisticEvent]);
		const res = await apiFetch<CalendarCreateResponse>(`/api/wg/${encodedShareCode}/events`, {
			method: 'POST',
			memberId: identity.memberId,
			memberToken: identity.memberToken,
			headers: { 'Idempotency-Key': idempotencyKey },
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			if (res.status > 0 && res.status < 500 && res.status !== 429)
				createEventRequestRef.current = null;
			updateEvents((current) => current.filter((event) => event.id !== optimisticId));
			toast.error('Termin konnte nicht gespeichert werden.');
			throw new Error('Termin konnte nicht gespeichert werden.');
		}
		createEventRequestRef.current = null;
		haptic('medium');
		updateEvents((current) => {
			const withoutOptimistic = current.filter((event) => event.id !== optimisticId);
			return withoutOptimistic.some((event) => event.id === res.data.event.id)
				? withoutOptimistic
				: [...withoutOptimistic, res.data.event];
		});
		setCreateOpen(false);
		if (res.data.warning) {
			toast.info('Termin gespeichert. Push-Versand konnte nicht bestätigt werden.');
		} else {
			toast.success('Termin gespeichert.');
		}
	}

	async function handleUpdate(id: string, payload: UpdateEventPayload): Promise<void> {
		const previous = events.find((event) => event.id === id);
		if (previous) {
			updateEvents((current) =>
				current.map((event) => (event.id === id ? { id, ...payload } : event)),
			);
		}
		const res = await apiFetch<{ event: CalendarEvent }>(
			`/api/wg/${encodedShareCode}/events/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				body: JSON.stringify(payload),
			},
		);
		if (!res.ok) {
			if (previous) {
				updateEvents((current) => current.map((event) => (event.id === id ? previous : event)));
			}
			toast.error('Termin konnte nicht aktualisiert werden.');
			throw new Error('Termin konnte nicht aktualisiert werden.');
		}
		updateEvents((current) => current.map((event) => (event.id === id ? res.data.event : event)));
		setEditing(null);
	}

	async function handleDelete(id: string): Promise<void> {
		const previousEventIndex = events.findIndex((event) => event.id === id);
		const previousEvent = events[previousEventIndex];
		updateEvents((current) => current.filter((event) => event.id !== id));
		const res = await apiFetch<unknown>(
			`/api/wg/${encodedShareCode}/events/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
			},
		);
		if (!res.ok) {
			if (previousEvent) {
				updateEvents((current) => {
					if (current.some((event) => event.id === id)) return current;
					const restored = [...current];
					restored.splice(Math.min(previousEventIndex, restored.length), 0, previousEvent);
					return restored;
				});
			}
			setActionError('Termin konnte nicht gelöscht werden.');
			toast.error('Termin konnte nicht gelöscht werden.');
			return;
		}
		updateEvents((current) => current.filter((event) => event.id !== id));
		setEditing(null);
	}

	async function saveSubscription(method: 'POST' | 'PATCH', message: string): Promise<void> {
		if (subscriptionBusyRef.current) return;
		subscriptionBusyRef.current = true;
		const requestedScope = subscriptionScope;
		subscriptionBusyScopeRef.current = requestedScope;
		invalidateSubscriptionRead(requestedScope);
		setSubscriptionBusy(true);
		setSubscriptionError(null);
		setSubscriptionNotice(null);
		const requestKeyId = `subscription:${method}`;
		const idempotencyKey =
			subscriptionRequestKeysRef.current.get(requestKeyId) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setSubscriptionError(
				'Kalender-Feed konnte nicht sicher gespeichert werden. Versuche es erneut.',
			);
			subscriptionBusyRef.current = false;
			subscriptionBusyScopeRef.current = null;
			invalidateSubscriptionRead(requestedScope);
			setSubscriptionBusy(false);
			return;
		}
		subscriptionRequestKeysRef.current.set(requestKeyId, idempotencyKey);
		const res = await apiFetch<CalendarSubscriptionResponse>(subscriptionEndpoint, {
			method,
			memberId: identity.memberId,
			memberToken: identity.memberToken,
			headers: { 'Idempotency-Key': idempotencyKey },
		});
		if (res.ok && res.data.subscription) {
			subscriptionRequestKeysRef.current.delete(requestKeyId);
			updateSubscription(res.data.subscription);
			setCopyState('idle');
			setSubscriptionNotice(message);
		} else {
			if (!res.ok && res.status > 0 && res.status < 500 && res.status !== 429) {
				subscriptionRequestKeysRef.current.delete(requestKeyId);
			}
			setSubscriptionError('Kalender-Feed konnte nicht gespeichert werden.');
		}
		subscriptionBusyRef.current = false;
		subscriptionBusyScopeRef.current = null;
		invalidateSubscriptionRead(requestedScope);
		setSubscriptionBusy(false);
	}

	async function revokeSubscription(): Promise<void> {
		if (subscriptionBusyRef.current) return;
		subscriptionBusyRef.current = true;
		const requestedScope = subscriptionScope;
		subscriptionBusyScopeRef.current = requestedScope;
		invalidateSubscriptionRead(requestedScope);
		setSubscriptionBusy(true);
		setSubscriptionError(null);
		setSubscriptionNotice(null);
		const requestKeyId = 'subscription:DELETE';
		const idempotencyKey =
			subscriptionRequestKeysRef.current.get(requestKeyId) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setSubscriptionError(
				'Kalender-Feed konnte nicht sicher widerrufen werden. Versuche es erneut.',
			);
			subscriptionBusyRef.current = false;
			subscriptionBusyScopeRef.current = null;
			invalidateSubscriptionRead(requestedScope);
			setSubscriptionBusy(false);
			return;
		}
		subscriptionRequestKeysRef.current.set(requestKeyId, idempotencyKey);
		const previousSubscription = subscription;
		updateSubscription(null);
		const res = await apiFetch<unknown>(subscriptionEndpoint, {
			method: 'DELETE',
			memberId: identity.memberId,
			memberToken: identity.memberToken,
			headers: { 'Idempotency-Key': idempotencyKey },
		});
		if (res.ok) {
			subscriptionRequestKeysRef.current.delete(requestKeyId);
			setCopyState('idle');
			setSubscriptionNotice('Kalender-Feed widerrufen.');
		} else {
			updateSubscription(previousSubscription);
			if (!res.ok && res.status > 0 && res.status < 500 && res.status !== 429) {
				subscriptionRequestKeysRef.current.delete(requestKeyId);
			}
			setSubscriptionError('Kalender-Feed konnte nicht widerrufen werden.');
			toast.error('Kalender-Feed konnte nicht widerrufen werden.');
		}
		subscriptionBusyRef.current = false;
		subscriptionBusyScopeRef.current = null;
		invalidateSubscriptionRead(requestedScope);
		setSubscriptionBusy(false);
	}

	async function copySubscriptionUrl(): Promise<void> {
		if (!subscription) return;
		setCopyState((await copyText(subscription.feedUrl)) ? 'copied' : 'failed');
	}

	function changeMonth(delta: number): void {
		setMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
		setSelectedDay(null);
	}

	function handlePrevMonth(): void {
		haptic('light');
		changeMonth(-1);
	}

	function handleNextMonth(): void {
		haptic('light');
		changeMonth(1);
	}

	function handleDaySelect(day: Date): void {
		haptic('light');
		setSelectedDay(day);
	}

	function handleFabClick(): void {
		haptic('light');
		setCreateOpen(true);
	}

	const now = new Date();
	const isCurrentMonth =
		month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth();

	function handleJumpToToday(): void {
		haptic('light');
		setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
		setSelectedDay(null);
	}

	return (
		<div data-household-content className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4">
			<SubNav />
			{/* Der Tab oben benennt die Seite schon; Titel und Zähler bleiben für Screenreader. */}
			<header className="sr-only">
				<h1>Kalender</h1>
				<p>{loading ? 'Lädt…' : `${events.length} WG-Termin${events.length === 1 ? '' : 'e'}`}</p>
			</header>

			{actionError && (
				<Alert variant="destructive">
					<AlertDescription>{actionError}</AlertDescription>
				</Alert>
			)}

			{loadError && (
				<Alert variant="destructive">
					<AlertTitle>Kalender konnte nicht geladen werden</AlertTitle>
					<AlertDescription className="flex flex-wrap items-center justify-between gap-2">
						<span>{loadError}</span>
						<Button type="button" variant="outline" onClick={() => void load(true)}>
							Erneut laden
						</Button>
					</AlertDescription>
				</Alert>
			)}

			<Tabs
				value={view}
				onValueChange={(value) => {
					haptic('light');
					setView(value as ViewMode);
				}}
				className="gap-3"
			>
				<TabsList className="w-full">
					<TabsTrigger value="list" className="min-w-max whitespace-nowrap">
						<List data-icon="inline-start" aria-hidden />
						Agenda
					</TabsTrigger>
					<TabsTrigger value="month" className="min-w-max whitespace-nowrap">
						<CalendarDays data-icon="inline-start" aria-hidden />
						Monat
					</TabsTrigger>
				</TabsList>
				<TabsContent value="list" className="flex flex-col gap-3">
					<section aria-labelledby="calendar-upcoming-heading" className="flex flex-col gap-3">
						<h2 id="calendar-upcoming-heading" className="sr-only">
							Nächste 30 Tage
						</h2>
						{loading ? (
							<output aria-live="polite" className="block text-sm text-muted-foreground">
								Agenda wird geladen…
							</output>
						) : loadError ? null : (
							<CalendarUpcomingList
								occurrences={upcomingOccurrences}
								choreOccurrences={upcomingChoreOccurrences}
								onSelect={handleSelectOccurrence}
								wgBaseHref={wgBaseHref}
							/>
						)}
					</section>
				</TabsContent>
				<TabsContent value="month" className="flex flex-col gap-2">
					{!isCurrentMonth && (
						<Button
							variant="outline"
							size="icon"
							className="self-end"
							onClick={handleJumpToToday}
							aria-label="Zum aktuellen Monat springen"
							title="Heute"
						>
							<RotateCcw aria-hidden />
						</Button>
					)}
					<CalendarMonth
						month={month}
						occurrences={monthOccurrences}
						onPrev={handlePrevMonth}
						onNext={handleNextMonth}
						onSelectDay={handleDaySelect}
						onSelectOccurrence={handleSelectOccurrence}
						selectedDay={selectedDay}
					/>
				</TabsContent>
			</Tabs>

			<details className="group rounded-xl border border-border">
				<summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
					Kalender abonnieren
					<ChevronRight
						aria-hidden
						className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
					/>
				</summary>
				<div className="flex flex-col gap-3 border-t border-border px-4 py-4">
					<p className="text-sm text-muted-foreground">
						Neue WG-Termine automatisch in Apple Kalender oder Google Kalender erhalten.
					</p>
					{subscriptionError && (
						<Alert variant="destructive">
							<AlertDescription>{subscriptionError}</AlertDescription>
						</Alert>
					)}
					{subscriptionLoading ? (
						<p className="text-sm text-muted-foreground">Feed wird geladen…</p>
					) : subscription ? (
						<div className="flex flex-col gap-3">
							<Field>
								<FieldLabel htmlFor="calendar-feed-url">Persönlicher Feed-Link</FieldLabel>
								<div className="flex min-w-0 flex-wrap gap-2">
									<Input
										id="calendar-feed-url"
										type="url"
										readOnly
										value={subscription.feedUrl}
										className="min-w-0 flex-1 text-sm"
									/>
									<Button
										type="button"
										variant="outline"
										onClick={() => void copySubscriptionUrl()}
										className="max-w-full shrink whitespace-normal"
									>
										{copyState === 'copied' ? 'Kopiert' : 'Link kopieren'}
									</Button>
								</div>
							</Field>
							<div className="flex flex-wrap gap-2">
								<Button
									nativeButton={false}
									render={
										<a href={subscription.feedUrl} target="_blank" rel="noopener noreferrer">
											<ExternalLink data-icon="inline-start" aria-hidden />
											Feed öffnen
										</a>
									}
								/>
								<Button
									type="button"
									variant="outline"
									disabled={subscriptionBusy}
									onClick={() => setSubscriptionConfirm('rotate')}
								>
									<RefreshCw data-icon="inline-start" aria-hidden />
									Link erneuern
								</Button>
								<Button
									type="button"
									variant="destructive"
									disabled={subscriptionBusy}
									onClick={() => setSubscriptionConfirm('revoke')}
								>
									<Trash2 data-icon="inline-start" aria-hidden />
									Abo widerrufen
								</Button>
							</div>
							{copyState === 'failed' && (
								<Alert variant="destructive">
									<AlertDescription>
										Kopieren fehlgeschlagen. Markiere den Link und kopiere ihn manuell.
									</AlertDescription>
								</Alert>
							)}
							<details className="rounded-lg border border-border px-3 py-2">
								<summary className="cursor-pointer text-sm font-medium">
									Apple- und Android-Anleitung
								</summary>
								<div className="mt-3 flex flex-col gap-3 text-sm text-muted-foreground">
									<div>
										<p className="font-medium text-foreground">Apple (iPhone/iPad)</p>
										<p>
											Kalender-App → Kalender → Kalender hinzufügen → Abonnementkalender hinzufügen.
											Den Feed-Link einfügen.
										</p>
									</div>
									<div>
										<p className="font-medium text-foreground">Android (Google Kalender)</p>
										<p>
											Google Kalender am Computer im Browser öffnen → Weitere Kalender → + → Über
											URL. Den Feed-Link einfügen; die Android-App unterstützt das Hinzufügen per
											URL nicht direkt.
										</p>
									</div>
								</div>
							</details>
							<p className="text-xs text-muted-foreground">
								Der Feed enthält WG-Termine. Putzplan-Aufgaben bleiben in ManaWG und werden nicht
								exportiert.
							</p>
						</div>
					) : (
						<Button
							type="button"
							variant="outline"
							disabled={subscriptionBusy}
							onClick={() => void saveSubscription('POST', 'Kalender-Feed erstellt.')}
							className="max-w-full self-start whitespace-normal text-left"
						>
							{subscriptionBusy ? <Loader2 data-icon="inline-start" aria-hidden /> : null}
							Kalender-Feed erstellen
						</Button>
					)}
					{subscriptionNotice && (
						<Alert>
							<AlertDescription aria-live="polite">{subscriptionNotice}</AlertDescription>
						</Alert>
					)}
				</div>
			</details>

			<EventCreateModal
				open={createOpen}
				onClose={() => setCreateOpen(false)}
				onSubmit={handleCreate}
				defaultDate={selectedDay ?? undefined}
			/>
			<EventEditModal
				event={editing}
				onClose={() => setEditing(null)}
				onUpdate={handleUpdate}
				onDelete={handleDelete}
				actionError={actionError}
				onExportIcs={editingOccurrence ? () => downloadOccurrenceIcs(editingOccurrence) : undefined}
			/>
			<ConfirmDialog
				open={subscriptionConfirm !== null}
				onClose={() => setSubscriptionConfirm(null)}
				onConfirm={() => {
					if (subscriptionConfirm === 'rotate') {
						void saveSubscription('PATCH', 'Kalender-Feed erneuert.');
					} else {
						void revokeSubscription();
					}
				}}
				title={
					subscriptionConfirm === 'rotate' ? 'Feed-Link erneuern?' : 'Kalender-Feed widerrufen?'
				}
				description={
					subscriptionConfirm === 'rotate'
						? 'Der bisherige Link wird sofort ungültig. Kalender-Apps müssen mit dem neuen Link aktualisiert werden.'
						: 'Der bisherige Link funktioniert sofort nicht mehr. Du kannst später einen neuen Feed erstellen.'
				}
				confirmLabel={subscriptionConfirm === 'rotate' ? 'Link erneuern' : 'Widerrufen'}
				variant={subscriptionConfirm === 'revoke' ? 'danger' : 'default'}
				icon={subscriptionConfirm === 'revoke' ? Trash2 : RefreshCw}
			/>
			<ThumbAction>
				<Button type="button" onClick={handleFabClick} className="min-h-11 w-full">
					<Plus data-icon="inline-start" aria-hidden />
					Termin hinzufügen
				</Button>
			</ThumbAction>
		</div>
	);
}
