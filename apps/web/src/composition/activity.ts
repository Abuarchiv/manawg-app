import { berlinDayKey, prevBerlinDayStart, startOfBerlinDay } from '@/core/utils/berlin-day';
import { formatShortDateRange as formatSharedShortDateRange } from '@/core/utils/time';
import {
	ACTIVITY_HIDDEN_AUDIT_EVENT_TYPES,
	MEMBER_ANNOUNCEMENT_SOURCES,
	auditDetail,
	formatAuditActivityText,
	getAuditHref,
} from './activity-audit';
import type { ActivityFilter, ActivityItem, ActivityKind, ActivityScope } from './activity-types';

export type { ActivityFilter, ActivityItem, ActivityKind, ActivityScope };
export {
	ACTIVITY_HIDDEN_AUDIT_EVENT_TYPES,
	MEMBER_ANNOUNCEMENT_SOURCES,
	formatAuditActivityText,
	getAuditHref,
};
export {
	type ActivityReminder,
	REMINDER_ANNOUNCEMENT_KINDS,
	buildActivityInbox,
	getActivityReminders,
} from './activity-reminders';

export function activityItemKey(
	item: Pick<ActivityItem, 'kind' | 'timestamp' | 'memberName' | 'text' | 'href'> & {
		id?: string;
	},
	index: number,
): string {
	// Dashboard items have no id and hrefs repeat (several events per entity),
	// so the key must always carry the index.
	return item.id ?? `${item.kind}:${item.timestamp}:${item.href ?? item.text}:${index}`;
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
		boughtByMemberId?: string | null;
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

interface ActivityChronicleGroup {
	date: string;
	label: string;
	items: ActivityItem[];
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
		// A purchase belongs to the buyer, not to whoever added the item.
		const actorId = item.boughtAt
			? (item.boughtByMemberId ?? item.addedByMemberId)
			: item.addedByMemberId;
		items.push({
			id: item.id,
			kind: 'shopping',
			timestamp: item.boughtAt ?? item.createdAt,
			memberId: actorId,
			memberName: memberName(members, actorId),
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
			sentence: true,
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
			sentence: true,
			completed: false,
			...(detail ? { detail } : {}),
			...(href ? { href } : {}),
		});
	}

	return items.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, input.limit ?? 50);
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
		timeZone: 'Europe/Berlin',
	});
	// Group by Berlin calendar day so entries around midnight land under the
	// label the user actually sees (labels are formatted in Berlin time).
	const todayKey = berlinDayKey(new Date(now));
	// Not `now - 24h`: on the day after spring-forward (23h) that lands two days back.
	const yesterdayKey = berlinDayKey(prevBerlinDayStart(startOfBerlinDay(new Date(now))));
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
