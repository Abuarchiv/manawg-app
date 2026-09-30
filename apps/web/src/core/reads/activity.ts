import { berlinDayKey } from '@/core/utils/berlin-day';
import { formatEuroCents } from '@/core/utils/money';
import {
	MS_PER_DAY,
	formatShortDateRange as formatSharedShortDateRange,
	formatShortDate,
	parseTimestamp,
} from '@/core/utils/time';
import { getChoreStatus } from '@/features/chores/chore-status';

const STALE_SHOPPING_DAYS = 3;
const STALE_ANNOUNCEMENT_DAYS = 2;

export type ActivityKind =
	| 'expense'
	| 'shopping'
	| 'announcement'
	| 'chore'
	| 'recurring'
	| 'absence'
	| 'audit';

export interface ActivityItem {
	id: string;
	kind: ActivityKind;
	timestamp: string;
	memberId?: string | null;
	memberName: string;
	text: string;
	completed: boolean;
	detail?: string;
	amountCents?: number;
	currency?: string;
	href?: string;
}

export function activityItemKey(
	item: Pick<ActivityItem, 'kind' | 'timestamp' | 'memberName' | 'text' | 'href'> & {
		id?: string;
	},
	index: number,
): string {
	return (
		item.id ??
		item.href ??
		`${item.kind}:${item.timestamp}:${item.memberName}:${item.text}:${index}`
	);
}

interface MemberInput {
	id: string;
	name: string;
}

interface ActivityTimelineInput {
	members: MemberInput[];
	expenses: Array<{
		id: string;
		paidByMemberId: string;
		description: string;
		amountCents: number;
		currency?: string;
		occurredAt: string;
	}>;
	shoppingItems: Array<{
		id: string;
		addedByMemberId: string;
		name: string;
		createdAt: string;
		boughtAt: string | null;
	}>;
	announcements: Array<{
		id: string;
		authorMemberId: string;
		content: string;
		createdAt: string;
		source: string;
	}>;
	choreCompletions: Array<{
		id: string;
		choreId: string;
		choreTitle: string;
		completedByMemberId: string;
		completedAt: string;
	}>;
	recurringExpenses?: Array<{
		id: string;
		description: string;
		amountCents: number;
		currency?: string;
		paidByMemberId: string;
		createdAt: string;
		lastCreatedAt: string | null;
	}>;
	absences?: Array<{
		id: string;
		memberId: string;
		startDate: string;
		endDate: string;
		reason: string | null;
		createdAt: string;
	}>;
	auditEvents?: Array<{
		id: string;
		memberId: string | null;
		eventType: string;
		entityType?: string;
		entityId?: string | null;
		summary: string;
		metadataJson?: string | null;
		createdAt: string;
	}>;
	limit?: number;
}

export interface ActivityReminder {
	kind: 'shopping' | 'chore' | 'announcement';
	title: string;
	detail: string;
	href: string;
}

interface ActivityReminderInput {
	openShoppingItems: Array<{ id: string; name: string; createdAt: string }>;
	dueChores: Array<{
		id: string;
		title: string;
		nextDueAt: string;
		assignedName: string | null;
	}>;
	openAnnouncements?: Array<{
		id: string;
		content: string;
		kind: string;
		createdAt: string;
	}>;
}

export interface ActivityFilter {
	kind: ActivityKind | 'all';
	mineOnly: boolean;
	query: string;
}

export type ActivityScope = 'all' | 'system' | 'mine' | 'changes' | 'done';

interface ActivityChronicleGroup {
	date: string;
	label: string;
	items: ActivityItem[];
}

interface ActivityInboxItem {
	id: string;
	priority: 'high' | 'normal';
	title: string;
	detail: string;
	href: string;
	kind: ActivityKind | ActivityReminder['kind'];
}

interface ActivityInboxInput {
	reminders: ActivityReminder[];
	items: ActivityItem[];
	currentMemberName: string;
	currentMemberId?: string | null;
}

function memberName(members: Map<string, MemberInput>, id: string): string {
	return members.get(id)?.name ?? '—';
}

function isCurrentMemberActivity(
	item: ActivityItem,
	currentMemberName: string,
	currentMemberId?: string | null,
): boolean {
	if (currentMemberId && item.memberId) return item.memberId === currentMemberId;
	return item.memberName === currentMemberName;
}

function shortDateRange(startIso: string, endIso: string): string {
	return formatSharedShortDateRange(startIso, endIso).replace(' bis ', '-');
}

function parseAuditMetadata(metadataJson?: string | null): Record<string, unknown> | null {
	if (!metadataJson) return null;
	try {
		const metadata = JSON.parse(metadataJson) as unknown;
		if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
		return metadata as Record<string, unknown>;
	} catch {
		return null;
	}
}

function auditDetail(metadataJson?: string | null): string | undefined {
	const metadata = parseAuditMetadata(metadataJson);
	if (!metadata) return undefined;
	try {
		const parts: string[] = [];
		if (typeof metadata.description === 'string' && metadata.description.length > 0) {
			parts.push(metadata.description);
		}
		if (typeof metadata.title === 'string' && metadata.title.length > 0) {
			parts.push(metadata.title);
		}
		if (typeof metadata.quantity === 'string' && metadata.quantity.length > 0) {
			parts.push(metadata.quantity);
		}
		if (typeof metadata.contentPreview === 'string' && metadata.contentPreview.length > 0) {
			parts.push(`„${metadata.contentPreview}“`);
		}
		if (typeof metadata.kind === 'string' && metadata.kind.length > 0) {
			parts.push(`Typ: ${metadata.kind}`);
		}
		if (metadata.hasImage === true) {
			parts.push('mit Bild');
		}
		if (Array.isArray(metadata.notificationFields)) {
			const fields = metadata.notificationFields.filter(
				(field): field is string => typeof field === 'string' && field.length > 0,
			);
			if (fields.length > 0) parts.push(fields.join(', '));
		}
		if (typeof metadata.pushOptIn === 'boolean') {
			parts.push(metadata.pushOptIn ? 'Web Push aktiv' : 'Web Push aus');
		}
		if ('quietStartHour' in metadata || 'quietEndHour' in metadata) {
			const start = typeof metadata.quietStartHour === 'number' ? metadata.quietStartHour : null;
			const end = typeof metadata.quietEndHour === 'number' ? metadata.quietEndHour : null;
			if (start !== null || end !== null) {
				parts.push(`Ruhezeit ${start ?? '?'}-${end ?? '?'} Uhr`);
			} else {
				parts.push('Ruhezeit aus');
			}
		}
		if (typeof metadata.reason === 'string' && metadata.reason.length > 0) {
			parts.push(metadata.reason);
		}
		if (typeof metadata.amountCents === 'number') {
			const currency = typeof metadata.currency === 'string' ? metadata.currency : 'EUR';
			parts.push(formatEuroCents(metadata.amountCents, currency));
		}
		if (typeof metadata.splitCount === 'number') {
			parts.push(`${metadata.splitCount} Aufteilungen`);
		}
		if (typeof metadata.reaction === 'string') {
			parts.push(`Reaktion: ${metadata.reaction}`);
		}
		if (typeof metadata.nameBefore === 'string' && typeof metadata.nameAfter === 'string') {
			if (metadata.nameBefore !== metadata.nameAfter) {
				parts.push(`${metadata.nameBefore} → ${metadata.nameAfter}`);
			}
		}
		if (
			typeof metadata.joiningEnabledBefore === 'boolean' &&
			typeof metadata.joiningEnabledAfter === 'boolean' &&
			metadata.joiningEnabledBefore !== metadata.joiningEnabledAfter
		) {
			parts.push(metadata.joiningEnabledAfter ? 'Beitritt offen' : 'Beitritt gesperrt');
		}
		if (metadata.shareCodeRotated === true) {
			parts.push('neuer WG-Code');
		}
		if (typeof metadata.intervalDays === 'number') {
			parts.push(metadata.intervalDays === 1 ? 'täglich' : `alle ${metadata.intervalDays} Tage`);
		}
		if (typeof metadata.intervalMonths === 'number') {
			parts.push(
				metadata.intervalMonths === 1 ? 'monatlich' : `alle ${metadata.intervalMonths} Monate`,
			);
		}
		if (typeof metadata.startDate === 'string' && typeof metadata.endDate === 'string') {
			parts.push(`abwesend ${formatSharedShortDateRange(metadata.startDate, metadata.endDate)}`);
		}
		if (typeof metadata.nextDueAt === 'string') {
			parts.push(`nächste Fälligkeit ${formatShortDate(metadata.nextDueAt)}`);
		}
		if (Array.isArray(metadata.splitIds)) {
			parts.push(`${metadata.splitIds.length} Anteil${metadata.splitIds.length === 1 ? '' : 'e'}`);
		}
		return parts.length > 0 ? parts.join(' · ') : undefined;
	} catch {
		return undefined;
	}
}

export function getAuditHref(event: {
	eventType: string;
	entityType?: string;
	entityId?: string | null;
	metadataJson?: string | null;
}): string | undefined {
	const metadata = parseAuditMetadata(event.metadataJson);
	const announcementId =
		typeof metadata?.announcementId === 'string' && metadata.announcementId.length > 0
			? metadata.announcementId
			: event.entityType === 'announcement' && event.entityId
				? event.entityId
				: null;

	if (announcementId) return `/pinnwand#announcement-${encodeURIComponent(announcementId)}`;
	if (event.entityType === 'shopping_item' && event.entityId) {
		return `/einkauf?highlight=${encodeURIComponent(event.entityId)}`;
	}
	if (event.entityType === 'chore' && event.entityId) {
		return `/putzen?highlight=${encodeURIComponent(event.entityId)}`;
	}
	if ((event.entityType === 'absence' || event.entityType === 'member_absence') && event.entityId) {
		return `/putzen?panel=absences&absence=${encodeURIComponent(event.entityId)}`;
	}
	if (event.entityType === 'recurring_expense' && event.eventType === 'recurring.deleted') {
		return '/ausgaben?filter=recurring';
	}
	if (event.entityType === 'recurring_expense' && event.entityId) {
		return `/ausgaben?recurring=${encodeURIComponent(event.entityId)}`;
	}
	if (
		event.entityType === 'expense' ||
		event.entityType === 'expense_split' ||
		event.entityType === 'expense_debt'
	) {
		return event.entityType === 'expense' && event.entityId
			? `/ausgaben?highlight=${encodeURIComponent(event.entityId)}`
			: '/ausgaben';
	}
	if (event.entityType === 'member' && event.eventType.startsWith('notification.')) {
		return '/einstellungen#benachrichtigungen';
	}
	if (event.entityType === 'wg') return '/einstellungen#zugang';
	return undefined;
}

export function formatAuditActivityText(summary: string, actorName: string): string {
	const trimmed = summary.trim();
	const prefix = `${actorName} `;
	if (trimmed.toLocaleLowerCase('de-DE').startsWith(prefix.toLocaleLowerCase('de-DE'))) {
		return trimmed.slice(prefix.length);
	}
	return trimmed;
}

export function buildActivityTimeline(input: ActivityTimelineInput): ActivityItem[] {
	const members = new Map(input.members.map((member) => [member.id, member]));
	const items: ActivityItem[] = [];

	for (const item of input.expenses) {
		items.push({
			id: item.id,
			kind: 'expense',
			timestamp: item.occurredAt,
			memberId: item.paidByMemberId,
			memberName: memberName(members, item.paidByMemberId),
			text: item.description,
			completed: false,
			amountCents: item.amountCents,
			currency: item.currency ?? 'EUR',
			href: `/ausgaben?highlight=${encodeURIComponent(item.id)}`,
		});
	}

	for (const item of input.shoppingItems) {
		items.push({
			id: item.id,
			kind: 'shopping',
			timestamp: item.boughtAt ?? item.createdAt,
			memberId: item.addedByMemberId,
			memberName: memberName(members, item.addedByMemberId),
			text: item.boughtAt ? `${item.name} gekauft` : `${item.name} hinzugefügt`,
			completed: item.boughtAt !== null,
			href: `/einkauf?highlight=${encodeURIComponent(item.id)}`,
		});
	}

	for (const item of input.announcements) {
		items.push({
			id: item.id,
			kind: 'announcement',
			timestamp: item.createdAt,
			memberId: item.authorMemberId,
			memberName: memberName(members, item.authorMemberId),
			text: item.content,
			completed: false,
			href: `/pinnwand#announcement-${encodeURIComponent(item.id)}`,
		});
	}

	for (const item of input.choreCompletions) {
		items.push({
			id: item.id,
			kind: 'chore',
			timestamp: item.completedAt,
			memberId: item.completedByMemberId,
			memberName: memberName(members, item.completedByMemberId),
			text: `${item.choreTitle} erledigt`,
			completed: true,
			href: `/putzen?highlight=${encodeURIComponent(item.choreId)}`,
		});
	}

	for (const item of input.recurringExpenses ?? []) {
		items.push({
			id: item.id,
			kind: 'recurring',
			timestamp: item.lastCreatedAt ?? item.createdAt,
			memberId: item.paidByMemberId,
			memberName: memberName(members, item.paidByMemberId),
			text: item.lastCreatedAt
				? `${item.description} aus Vorlage erstellt`
				: `${item.description} als Fixkosten-Vorlage angelegt`,
			completed: false,
			detail: 'Fixkosten',
			amountCents: item.amountCents,
			currency: item.currency ?? 'EUR',
			href: `/ausgaben?recurring=${encodeURIComponent(item.id)}`,
		});
	}

	for (const item of input.absences ?? []) {
		items.push({
			id: item.id,
			kind: 'absence',
			timestamp: item.createdAt,
			memberId: item.memberId,
			memberName: memberName(members, item.memberId),
			text: 'ist abwesend',
			completed: false,
			detail: item.reason
				? `${shortDateRange(item.startDate, item.endDate)} · ${item.reason}`
				: shortDateRange(item.startDate, item.endDate),
			href: `/putzen?panel=absences&absence=${encodeURIComponent(item.id)}`,
		});
	}

	for (const item of input.auditEvents ?? []) {
		const detail = auditDetail(item.metadataJson);
		const href = getAuditHref(item);
		const actorName = item.memberId ? memberName(members, item.memberId) : 'System';
		items.push({
			id: item.id,
			kind: 'audit',
			timestamp: item.createdAt,
			memberId: item.memberId,
			memberName: actorName,
			text: formatAuditActivityText(item.summary, actorName),
			completed: false,
			...(detail ? { detail } : {}),
			...(href ? { href } : {}),
		});
	}

	return items.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, input.limit ?? 50);
}

/** Announcement kinds that turn into a reminder once they stay open too long. */
export const REMINDER_ANNOUNCEMENT_KINDS = ['question', 'request', 'task'] as const;

export function getActivityReminders(
	input: ActivityReminderInput,
	now = Date.now(),
): ActivityReminder[] {
	const reminders: Array<{ item: ActivityReminder; priority: number; ageDays: number }> = [];

	for (const chore of input.dueChores) {
		const status = getChoreStatus(chore.nextDueAt, now);
		if (!status.escalated) continue;
		reminders.push({
			priority: 0,
			ageDays: status.overdueDays,
			item: {
				kind: 'chore',
				title: `${chore.title} hängt seit ${status.overdueDays} Tagen`,
				href: `/putzen?highlight=${encodeURIComponent(chore.id)}`,
				detail: `${chore.assignedName ?? 'Niemand'} ist eingetragen. Nachholen, übernehmen oder kurz klären.`,
			},
		});
	}

	for (const item of input.openAnnouncements ?? []) {
		if (!(REMINDER_ANNOUNCEMENT_KINDS as readonly string[]).includes(item.kind)) continue;
		const createdAt = parseTimestamp(item.createdAt);
		if (createdAt === null) continue;
		const days = Math.floor((now - createdAt) / MS_PER_DAY);
		if (days < STALE_ANNOUNCEMENT_DAYS) continue;
		reminders.push({
			priority: 1,
			ageDays: days,
			item: {
				kind: 'announcement',
				title: `Pinnwand offen seit ${days} Tagen`,
				href: `/pinnwand#announcement-${encodeURIComponent(item.id)}`,
				detail: item.content,
			},
		});
	}

	for (const item of input.openShoppingItems) {
		const createdAt = parseTimestamp(item.createdAt);
		if (createdAt === null) continue;
		const days = Math.floor((now - createdAt) / MS_PER_DAY);
		if (days < STALE_SHOPPING_DAYS) continue;
		reminders.push({
			priority: 2,
			ageDays: days,
			item: {
				kind: 'shopping',
				title: `${item.name} liegt seit ${days} Tagen offen`,
				href: `/einkauf?highlight=${encodeURIComponent(item.id)}`,
				detail: 'Prüft kurz, ob ihr das noch braucht.',
			},
		});
	}

	return reminders
		.sort((a, b) => a.priority - b.priority || b.ageDays - a.ageDays)
		.slice(0, 6)
		.map(({ item }) => item);
}

export function filterActivityItems(
	items: ActivityItem[],
	filter: ActivityFilter,
	currentMemberName: string,
	currentMemberId?: string | null,
): ActivityItem[] {
	const query = filter.query.trim().toLocaleLowerCase('de-DE');
	return items.filter((item) => {
		if (filter.kind !== 'all' && item.kind !== filter.kind) return false;
		if (filter.mineOnly && !isCurrentMemberActivity(item, currentMemberName, currentMemberId))
			return false;
		if (!query) return true;
		return `${item.memberName} ${item.text} ${item.detail ?? ''}`
			.toLocaleLowerCase('de-DE')
			.includes(query);
	});
}

export function filterActivityByScope(
	items: ActivityItem[],
	scope: ActivityScope,
	currentMemberName: string,
	currentMemberId?: string | null,
): ActivityItem[] {
	if (scope === 'all') return items;
	return items.filter((item) => {
		const done = item.completed || /erledigt|gekauft|bezahlt/i.test(item.text);
		const system = item.memberName === 'System';
		if (scope === 'system') return system;
		if (scope === 'mine') return isCurrentMemberActivity(item, currentMemberName, currentMemberId);
		if (scope === 'done') return done;
		if (scope === 'changes') return !done;
		return true;
	});
}

export function groupActivityItemsByDay(
	items: ActivityItem[],
	now = Date.now(),
): ActivityChronicleGroup[] {
	const formatter = new Intl.DateTimeFormat('de-DE', {
		weekday: 'short',
		day: '2-digit',
		month: '2-digit',
	});
	// Group by Berlin calendar day so entries around midnight land under the
	// label the user actually sees (labels are formatted in Berlin time).
	const todayKey = berlinDayKey(new Date(now));
	const yesterdayKey = berlinDayKey(new Date(now - MS_PER_DAY));
	const groups = new Map<string, ActivityItem[]>();

	for (const item of items) {
		const key = berlinDayKey(new Date(item.timestamp));
		groups.set(key, [...(groups.get(key) ?? []), item]);
	}

	return Array.from(groups.entries())
		.sort(([a], [b]) => b.localeCompare(a))
		.map(([date, groupItems]) => ({
			date,
			label:
				date === todayKey
					? 'Heute'
					: date === yesterdayKey
						? 'Gestern'
						: formatter.format(new Date(`${date}T12:00:00.000Z`)),
			items: groupItems,
		}));
}

function inboxActivityDetail(kind: ActivityKind): string {
	switch (kind) {
		case 'expense':
			return 'Deine Ausgabe';
		case 'shopping':
			return 'Dein Einkauf';
		case 'announcement':
			return 'Dein Pinnwand-Beitrag';
		case 'chore':
			return 'Von dir erledigt';
		case 'recurring':
			return 'Deine Fixkosten';
		case 'absence':
			return 'Deine Abwesenheit';
		case 'audit':
			return 'Deine Änderung';
	}
}

export function buildActivityInbox(input: ActivityInboxInput): ActivityInboxItem[] {
	const urgent = input.reminders.map((item) => ({
		id: `reminder:${item.kind}:${item.href}`,
		priority: 'high' as const,
		title: item.title,
		detail: item.detail,
		href: item.href,
		kind: item.kind,
	}));
	const mine = input.items
		.filter(
			(item) =>
				isCurrentMemberActivity(item, input.currentMemberName, input.currentMemberId) && item.href,
		)
		.slice(0, 4)
		.map((item) => ({
			id: `activity:${item.kind}:${item.id}`,
			priority: 'normal' as const,
			title: item.text,
			detail: inboxActivityDetail(item.kind),
			href: item.href ?? '',
			kind: item.kind,
		}));

	return [...urgent, ...mine].slice(0, 6);
}
