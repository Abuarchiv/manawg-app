import { berlinDayKey, endOfBerlinDay, startOfBerlinDay } from '@/core/utils/berlin-day';
import { formatEuroCents } from '@/core/utils/money';
import { MS_PER_DAY, formatShortDate, parseTimestamp } from '@/core/utils/time';
import type { EventOccurrence } from '@/features/events/events';
import { simplifyDebts } from '@/features/expenses/debt-reduction';

export type TodayImportantKind =
	| 'chore'
	| 'shopping'
	| 'announcement'
	| 'debt'
	| 'recurring'
	| 'absence';

export interface TodayImportantItem {
	kind: TodayImportantKind;
	title: string;
	detail: string;
	href: string;
	tone: 'danger' | 'accent' | 'neutral';
	isPersonal: boolean;
	entityId?: string;
	expectedNextDueAt?: string;
	expectedAssignedMemberId?: string | null;
	amountCents?: number;
	currency?: string;
}

export interface TodayImportantInput {
	shareCode: string;
	currentMemberId: string;
	openShoppingCount: number;
	openShoppingTop: string[];
	dueChores: Array<{
		id: string;
		title: string;
		nextDueAt: string;
		overdue: boolean;
		assignedMemberId?: string | null;
		assignedMemberName?: string | null;
	}>;
	myOpenAnnouncements: Array<{
		id: string;
		kind: string;
		content: string;
	}>;
	balances?: Array<{
		memberId: string;
		memberName: string;
		color: string | null;
		balanceCents: number;
		currency: string;
	}>;
	dueRecurringExpenses?: Array<{
		id: string;
		description: string;
		amountCents: number;
		currency?: string;
		nextDueAt?: string;
	}>;
	absentMembers?: Array<{
		id?: string;
		memberId: string;
		name: string;
		endDate: string;
		isCurrentMember: boolean;
	}>;
	now?: number;
}

interface WgHealthInput {
	shareCode: string;
	openShoppingCount: number;
	overdueChoreCount: number;
	openDebtCents?: number;
	openDebtByCurrency?: Readonly<Record<string, number>>;
	openAnnouncementCount: number;
	absentMemberCount: number;
	dueRecurringCount: number;
}

export interface WgHealth {
	score: number;
	label: string;
	items: Array<{ label: string; value: string; tone: 'ok' | 'warn' | 'danger'; href: string }>;
}

function formatEuro(cents: number, currency = 'EUR'): string {
	return formatEuroCents(cents, currency);
}

function formatCurrencyTotals(totals: Readonly<Record<string, number>>): string {
	const entries = Object.entries(totals)
		.filter(([, cents]) => cents !== 0)
		.sort(([left], [right]) => left.localeCompare(right));
	return entries.length > 0
		? entries.map(([currency, cents]) => formatEuro(cents, currency)).join(' · ')
		: formatEuro(0);
}

function calendarDayDistance(iso: string, now: number): number | null {
	const dueAt = parseTimestamp(iso);
	if (dueAt === null) return null;
	// Calendar-day difference in Berlin time — a plain ms/24h rounding put
	// same-day-evening chores under "morgen" and 13h-overdue items at "1 T.".
	const dueKey = berlinDayKey(new Date(dueAt));
	const nowKey = berlinDayKey(new Date(now));
	return Math.round(
		(Date.parse(`${dueKey}T12:00:00Z`) - Date.parse(`${nowKey}T12:00:00Z`)) / MS_PER_DAY,
	);
}

function dueLabel(iso: string, now: number): string {
	const days = calendarDayDistance(iso, now);
	if (days === null) return 'Datum prüfen';
	if (days < 0) return `seit ${Math.abs(days)} T. offen`;
	if (days === 0) return 'heute fällig';
	if (days === 1) return 'morgen fällig';
	return `in ${days} Tagen`;
}

function choreUrgency(iso: string, now: number): number {
	const days = calendarDayDistance(iso, now);
	if (days === null) return 4;
	if (days < 0) return 0;
	if (days === 0) return 1;
	if (days <= 3) return 2;
	return 3;
}

export function getTodayImportantItems(input: TodayImportantInput): TodayImportantItem[] {
	const now = input.now ?? Date.now();
	const base = `/wg/${encodeURIComponent(input.shareCode)}`;
	const ranked: Array<{
		item: TodayImportantItem;
		urgency: number;
		isPersonal: boolean;
		dueAt: number;
		kindOrder: number;
		index: number;
	}> = [];

	const choreItems = input.dueChores
		.map((chore, index) => {
			const urgency = choreUrgency(chore.nextDueAt, now);
			const isPersonal = chore.assignedMemberId === input.currentMemberId;
			const due = dueLabel(chore.nextDueAt, now);
			const ownership = isPersonal
				? 'Für dich'
				: chore.assignedMemberName
					? chore.assignedMemberName
					: 'Noch nicht zugewiesen';
			return {
				item: {
					kind: 'chore' as const,
					title: chore.title,
					detail: ownership ? `${ownership} · ${due}` : due,
					href: `${base}/putzen?highlight=${encodeURIComponent(chore.id)}`,
					tone: urgency === 0 ? ('danger' as const) : ('accent' as const),
					isPersonal,
					entityId: chore.id,
					expectedNextDueAt: chore.nextDueAt,
					expectedAssignedMemberId: chore.assignedMemberId ?? null,
				},
				urgency,
				isPersonal,
				dueAt: parseTimestamp(chore.nextDueAt) ?? Number.POSITIVE_INFINITY,
				index,
			};
		})
		.filter(({ urgency }) => urgency !== 3)
		.map(({ item, urgency, isPersonal, dueAt, index }) => ({
			item,
			urgency,
			isPersonal,
			dueAt,
			kindOrder: 0,
			index,
		}));
	ranked.push(...choreItems);

	if (input.openShoppingCount > 0) {
		ranked.push({
			item: {
				kind: 'shopping',
				title: input.openShoppingTop[0]
					? `${input.openShoppingTop[0]} fehlt noch`
					: 'Einkauf offen',
				detail: `WG · ${input.openShoppingCount} ${input.openShoppingCount === 1 ? 'offener Artikel' : 'offene Artikel'}`,
				href: `${base}/einkauf`,
				tone: 'neutral',
				isPersonal: false,
			},
			urgency: 3,
			isPersonal: false,
			dueAt: Number.POSITIVE_INFINITY,
			kindOrder: 2,
			index: 0,
		});
	}

	for (const [index, announcement] of input.myOpenAnnouncements.entries()) {
		ranked.push({
			item: {
				kind: 'announcement',
				title: announcement.content,
				detail: announcement.kind === 'request' ? 'Übernahme offen' : 'Pinnwand offen',
				href: `${base}/pinnwand#announcement-${encodeURIComponent(announcement.id)}`,
				tone: 'accent',
				isPersonal: true,
				entityId: announcement.id,
			},
			urgency: 3,
			isPersonal: true,
			dueAt: Number.POSITIVE_INFINITY,
			kindOrder: 1,
			index,
		});
	}

	for (const [index, recurring] of (input.dueRecurringExpenses ?? []).entries()) {
		const urgency = recurring.nextDueAt === undefined ? 0 : choreUrgency(recurring.nextDueAt, now);
		ranked.push({
			item: {
				kind: 'recurring',
				title: `${recurring.description} ist fällig`,
				detail: recurring.nextDueAt
					? `WG-Fixkosten · ${formatEuro(recurring.amountCents, recurring.currency)} · ${dueLabel(recurring.nextDueAt, now)}`
					: `WG-Fixkosten · ${formatEuro(recurring.amountCents, recurring.currency)}`,
				href: `${base}/ausgaben?recurring=${encodeURIComponent(recurring.id)}`,
				tone: urgency === 0 ? 'danger' : 'accent',
				isPersonal: false,
				entityId: recurring.id,
			},
			urgency,
			isPersonal: false,
			dueAt: recurring.nextDueAt
				? (parseTimestamp(recurring.nextDueAt) ?? Number.POSITIVE_INFINITY)
				: Number.POSITIVE_INFINITY,
			kindOrder: 1,
			index,
		});
	}

	const balances = (input.balances ?? []).map(({ balanceCents, ...balance }) => ({
		...balance,
		cents: balanceCents,
	}));
	for (const [index, debt] of simplifyDebts(balances).entries()) {
		const outgoing = debt.fromId === input.currentMemberId;
		if (!outgoing && debt.toId !== input.currentMemberId) continue;
		ranked.push({
			item: {
				kind: 'debt',
				title: outgoing ? `An ${debt.toName}` : `Von ${debt.fromName}`,
				detail: 'Ausgleich offen',
				href: `${base}/ausgaben`,
				tone: outgoing ? 'danger' : 'neutral',
				isPersonal: true,
				entityId: `settlement:${debt.fromId}:${debt.toId}:${debt.currency ?? 'EUR'}`,
				amountCents: outgoing ? -debt.cents : debt.cents,
				currency: debt.currency ?? 'EUR',
			},
			urgency: outgoing ? 2 : 3,
			isPersonal: true,
			dueAt: Number.POSITIVE_INFINITY,
			kindOrder: outgoing ? 1 : 2,
			index,
		});
	}

	for (const [index, absence] of (input.absentMembers ?? []).entries()) {
		ranked.push({
			item: {
				kind: 'absence',
				title: absence.isCurrentMember
					? 'Du bist als abwesend markiert'
					: `${absence.name} ist abwesend`,
				detail: `bis ${formatShortDate(absence.endDate)}`,
				href: absence.id
					? `${base}/putzen?panel=absences&absence=${encodeURIComponent(absence.id)}`
					: `${base}/putzen?panel=absences`,
				tone: 'neutral',
				isPersonal: absence.isCurrentMember,
				...(absence.id ? { entityId: absence.id } : {}),
			},
			urgency: 3,
			isPersonal: absence.isCurrentMember,
			dueAt: Number.POSITIVE_INFINITY,
			kindOrder: 3,
			index,
		});
	}

	return ranked
		.sort(
			(a, b) =>
				a.urgency - b.urgency ||
				Number(b.isPersonal) - Number(a.isPersonal) ||
				a.dueAt - b.dueAt ||
				a.kindOrder - b.kindOrder ||
				a.index - b.index,
		)
		.map(({ item }) => item);
}

export function getForYouItems(input: TodayImportantInput): TodayImportantItem[] {
	return getTodayImportantItems(input).filter(
		(item) => item.isPersonal || item.kind === 'shopping' || item.kind === 'recurring',
	);
}

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
		if (chore.assignedMemberId === input.currentMemberId) continue;
		const at = parseTimestamp(chore.nextDueAt);
		if (at === null) continue;
		const dayKey = berlinDayKey(new Date(at));
		if (dayKey > window.sundayKey) continue;
		const who = chore.assignedMemberName ?? 'Noch nicht zugewiesen';
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
			href: `${base}/kalender`,
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

export function getWgHealth(input: WgHealthInput): WgHealth {
	const base = `/wg/${encodeURIComponent(input.shareCode)}`;
	const openDebtByCurrency =
		input.openDebtByCurrency ??
		(input.openDebtCents !== undefined ? { EUR: input.openDebtCents } : {});
	const openDebtCurrencies = Object.entries(openDebtByCurrency).filter(([, cents]) => cents > 0);
	// Never add cents from different currencies. The score penalty is a count of
	// outstanding debt bands, not a pretend converted monetary total.
	const openDebtPenalty = Math.min(
		25,
		openDebtCurrencies.reduce(
			(penalty, [, cents]) => penalty + Math.min(Math.ceil(cents / 2500) * 5, 25),
			0,
		),
	);
	const penalties =
		Math.min(input.overdueChoreCount * 18, 36) +
		Math.min(input.openShoppingCount * 4, 16) +
		openDebtPenalty +
		Math.min(input.openAnnouncementCount * 6, 18) +
		Math.min(input.dueRecurringCount * 10, 20);
	const score = Math.max(0, 100 - penalties);
	return {
		score,
		label: score >= 80 ? 'ruhig' : score >= 55 ? 'im Blick behalten' : 'braucht Aufmerksamkeit',
		items: [
			{
				label: 'Putzlücken',
				value: String(input.overdueChoreCount),
				tone: input.overdueChoreCount > 0 ? 'danger' : 'ok',
				href: `${base}/putzen?filter=overdue`,
			},
			{
				label: 'Offene Schulden',
				value: formatCurrencyTotals(openDebtByCurrency),
				tone: openDebtCurrencies.length > 0 ? 'warn' : 'ok',
				href: `${base}/ausgaben`,
			},
			{
				label: 'Einkauf offen',
				value: String(input.openShoppingCount),
				tone: input.openShoppingCount > 3 ? 'warn' : 'ok',
				href: `${base}/einkauf`,
			},
			{
				label: 'Pinnwand offen',
				value: String(input.openAnnouncementCount),
				tone: input.openAnnouncementCount > 0 ? 'warn' : 'ok',
				href: `${base}/pinnwand?status=open`,
			},
			{
				label: 'Abwesend',
				value: String(input.absentMemberCount),
				tone: input.absentMemberCount > 0 ? 'warn' : 'ok',
				href: `${base}/putzen?panel=absences`,
			},
			{
				label: 'Fixkosten fällig',
				value: String(input.dueRecurringCount),
				tone: input.dueRecurringCount > 0 ? 'warn' : 'ok',
				href: `${base}/ausgaben?filter=recurring`,
			},
		],
	};
}
