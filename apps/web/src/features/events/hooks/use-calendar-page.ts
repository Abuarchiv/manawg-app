import { useToast } from '@/components/ui/Toast';
import { useWg } from '@/components/wg/WgContextProvider';
import { useCachedFetch } from '@/core/hooks/useCachedFetch';
import { RATE_LIMITED_MESSAGE, isNetworkError, isRateLimited } from '@/core/http/error-codes';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import { MS_PER_DAY } from '@/core/utils/time';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import type { CreateEventPayload } from '@/features/events/components/EventCreateModal';
import type {
	EditableEvent,
	UpdateEventPayload,
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
	/** Absent only on optimistic rows; the API always sends it. */
	createdByMemberId?: string | null;
}

type CalendarCreateResponse = {
	event: CalendarEvent;
	warning: null | 'notification_delivery_failed' | 'notification_delivery_unknown';
};

interface ChoreSummary {
	id: string;
	title: string;
	nextDueAt: string;
}

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

/** Offline, 429 and missing permissions need a concrete next step instead of the generic message. */
function eventSaveError(base: string, res: { status: number; error: string }): string {
	if (isNetworkError(res.error, res.status)) {
		return `${base}: Prüfe deine Verbindung und versuche es erneut.`;
	}
	if (isRateLimited(res.error, res.status)) return RATE_LIMITED_MESSAGE;
	// The API lets only the person who created the event, and WG admins, change or delete it.
	if (res.status === 403) {
		return `${base}: Das dürfen nur WG-Admins und wer den Termin angelegt hat.`;
	}
	if (res.status === 404) return `${base}: Der Termin existiert nicht mehr.`;
	return `${base}.`;
}

/** The event has been deleted by someone else in the meantime; restoring it locally would be wrong. */
function isEventGone(res: { status: number; error: string }): boolean {
	return res.status === 404 && res.error === 'event_not_found';
}

/** Loads events and cleaning-plan due dates; create/update/delete optimistically. */
export function useCalendarPage(month: Date) {
	const { wg, identity } = useWg();
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(wg.shareCode);
	const eventsBaseUrl = `/api/wg/${encodedShareCode}/events`;

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
		return `${eventsBaseUrl}?from=${encodeURIComponent(fromParam)}&to=${encodeURIComponent(toParam)}`;
	}, [eventsBaseUrl, month]);
	const choresUrl = `/api/wg/${encodedShareCode}/chores`;

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

	const [events, setEvents] = useState<CalendarEvent[]>(() => cachedEvents?.events ?? []);
	const [chores, setChores] = useState<ChoreSummary[]>(() => cachedChores?.chores ?? []);
	const [loading, setLoading] = useState(!cachedEvents || !cachedChores);
	const [loadError, setLoadError] = useState<string | null>(null);
	const hasCalendarDataRef = useRef(Boolean(cachedEvents && cachedChores));
	const createEventRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);

	const [createOpen, setCreateOpen] = useState(false);
	const [editing, setEditing] = useState<EditableEvent | null>(null);
	const [editingOccurrence, setEditingOccurrence] = useState<EventOccurrence | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	function updateEvents(update: (current: CalendarEvent[]) => CalendarEvent[]): void {
		setEvents(update);
		setCachedEvents((current) => {
			const previous = current?.events ?? events;
			const next = update(previous);
			if (!current && next === previous) return current;
			return { ...(current ?? { events: previous }), events: next };
		});
	}

	const load = useCallback(
		async (isInitial: boolean): Promise<void> => {
			if (isInitial && !hasCalendarDataRef.current) setLoading(true);

			const [eventsRes, choreRes] = await Promise.all([refreshEvents(), refreshChores()]);

			// Offline with an existing cache: keep showing data, no error state.
			const keepCached = (res: { ok: boolean; status?: number; error?: string }): boolean =>
				hasCalendarDataRef.current && !res.ok && isNetworkError(res.error ?? null, res.status);
			let nextError: string | null = null;
			if (eventsRes.ok) setEvents(eventsRes.data.events);
			else if (!keepCached(eventsRes)) nextError = 'Termine konnten nicht geladen werden.';
			if (choreRes.ok) {
				setChores(
					choreRes.data.chores.map(({ id, title, nextDueAt }) => ({ id, title, nextDueAt })),
				);
			} else if (!nextError && !keepCached(choreRes))
				nextError = 'Putzplan-Aufgaben konnten nicht geladen werden.';
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

	// Auto-refresh as on the dashboard; replaces the manual reload button.
	useVisibilityPausedInterval(() => void load(false), 30_000);
	useEffect(() => {
		void load(true);
	}, [load]);

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

	// For series, the agenda names the interval; the occurrence itself only carries a flag.
	const recurrenceByEventId = useMemo(
		() => new Map(events.map((event) => [event.id, event.recurrence])),
		[events],
	);

	const upcomingChoreOccurrences = useMemo(() => {
		// From the start of today: a chore due this morning is still today's chore.
		const from = new Date();
		const to = new Date(from.getTime() + UPCOMING_DAYS * MS_PER_DAY);
		from.setHours(0, 0, 0, 0);
		return buildChoreOccurrences(chores, from, to);
	}, [chores]);

	// The month grid is not limited to the agenda's 30 days.
	const monthChoreOccurrences = useMemo(() => {
		const bounds = getMonthBounds(month);
		return buildChoreOccurrences(chores, bounds.start, bounds.end);
	}, [chores, month]);

	function selectOccurrence(occurrence: EventOccurrence): void {
		const event = events.find((e) => e.id === occurrence.eventId);
		// An optimistic row has no server id yet; editing it would PATCH a non-existent event.
		if (!event || event.id.startsWith('pending:')) return;
		setActionError(null);
		setEditingOccurrence(occurrence);
		setEditing(event);
	}

	function openCreate(): void {
		setActionError(null);
		setCreateOpen(true);
	}

	async function createEvent(payload: CreateEventPayload): Promise<void> {
		const fingerprint = JSON.stringify(payload);
		const pending = createEventRequestRef.current;
		const idempotencyKey =
			pending?.fingerprint === fingerprint ? pending.key : createOfflineIdempotencyKey();
		if (!idempotencyKey) throw new Error('Termin konnte nicht sicher gesendet werden.');
		createEventRequestRef.current = { fingerprint, key: idempotencyKey };
		const optimisticId = `pending:${idempotencyKey}`;
		const optimisticEvent: CalendarEvent = {
			id: optimisticId,
			...payload,
			createdByMemberId: identity.memberId,
		};
		updateEvents((current) => [...current, optimisticEvent]);
		const res = await apiFetch<CalendarCreateResponse>(eventsBaseUrl, {
			method: 'POST',
			memberId: identity.memberId,
			headers: { 'Idempotency-Key': idempotencyKey },
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			if (res.status > 0 && res.status < 500 && res.status !== 429)
				createEventRequestRef.current = null;
			updateEvents((current) => current.filter((event) => event.id !== optimisticId));
			const message = eventSaveError('Termin konnte nicht gespeichert werden', res);
			toast.error(message);
			throw new Error(message);
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

	async function updateEvent(id: string, payload: UpdateEventPayload): Promise<void> {
		setActionError(null);
		const previous = events.find((event) => event.id === id);
		if (previous) {
			updateEvents((current) =>
				current.map((event) => (event.id === id ? { ...event, ...payload } : event)),
			);
		}
		const res = await apiFetch<{ event: CalendarEvent }>(
			`${eventsBaseUrl}/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				body: JSON.stringify(payload),
			},
		);
		if (!res.ok) {
			if (isEventGone(res)) {
				updateEvents((current) => current.filter((event) => event.id !== id));
			} else if (previous) {
				updateEvents((current) => current.map((event) => (event.id === id ? previous : event)));
			}
			const message = eventSaveError('Termin konnte nicht aktualisiert werden', res);
			toast.error(message);
			throw new Error(message);
		}
		updateEvents((current) => current.map((event) => (event.id === id ? res.data.event : event)));
		setEditing(null);
	}

	async function deleteEvent(id: string): Promise<void> {
		setActionError(null);
		const previousEventIndex = events.findIndex((event) => event.id === id);
		const previousEvent = events[previousEventIndex];
		updateEvents((current) => current.filter((event) => event.id !== id));
		const res = await apiFetch<unknown>(`${eventsBaseUrl}/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			memberId: identity.memberId,
		});
		// Already deleted by someone else: goal reached, do not restore.
		if (!res.ok && !isEventGone(res)) {
			if (previousEvent) {
				updateEvents((current) => {
					if (current.some((event) => event.id === id)) return current;
					const restored = [...current];
					restored.splice(Math.min(previousEventIndex, restored.length), 0, previousEvent);
					return restored;
				});
			}
			const message = eventSaveError('Termin konnte nicht gelöscht werden', res);
			setActionError(message);
			toast.error(message);
			return;
		}
		updateEvents((current) => current.filter((event) => event.id !== id));
		setEditing(null);
		if (res.ok) toast.success('Termin gelöscht.');
	}

	return {
		eventCount: events.length,
		loading,
		loadError,
		reload: () => load(true),
		monthOccurrences,
		upcomingOccurrences,
		recurrenceByEventId,
		upcomingChoreOccurrences,
		monthChoreOccurrences,
		createOpen,
		setCreateOpen,
		editing,
		setEditing,
		editingOccurrence,
		actionError,
		selectOccurrence,
		openCreate,
		createEvent,
		updateEvent,
		deleteEvent,
	};
}
