import { KEY_RENDER_CONTEXT, type RenderContext } from '@/core/audit-messages';
import { berlinDayKey, prevBerlinDayStart, startOfBerlinDay } from '@/core/utils/berlin-day';
import { formatShortDate } from '@/core/utils/time';
import type { MessageKey } from '@/shared/i18n/message';
import {
	ACTIVITY_HIDDEN_AUDIT_EVENT_TYPES,
	auditActivitySentence,
	auditDetail,
	getAuditHref,
} from './activity-audit';
import type { ActivityFilter, ActivityItem, ActivityKind } from './activity-types';

export {
	type ActivityReminder,
	buildActivityInbox,
	getActivityReminders,
	REMINDER_ANNOUNCEMENT_KINDS,
} from './activity-reminders';
export type { ActivityFilter, ActivityItem, ActivityKind };
export { ACTIVITY_HIDDEN_AUDIT_EVENT_TYPES };

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

function shortDateRange(startIso: string, endIso: string, locale: RenderContext['locale']): string {
	return `${formatShortDate(startIso, 'Europe/Berlin', locale)}-${formatShortDate(endIso, 'Europe/Berlin', locale)}`;
}

/** Sentences are rendered in the reader's locale; without a translator the keys stay and audit rows keep their stored summary. */
export function buildActivityTimeline(
	input: ActivityTimelineInput,
	ctx?: RenderContext,
): ActivityItem[] {
	const { locale, render } = ctx ?? KEY_RENDER_CONTEXT;
	const say = (key: MessageKey, values?: Record<string, string>) =>
		render(values ? { key, values } : { key });
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
			href: `/expenses?highlight=${encodeURIComponent(item.id)}`,
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
			text: say(item.boughtAt ? 'audit.timeline.shoppingBought' : 'audit.timeline.shoppingAdded', {
				name: item.name,
			}),
			completed: item.boughtAt !== null,
			href: `/shopping?highlight=${encodeURIComponent(item.id)}`,
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
			href: `/pinboard#announcement-${encodeURIComponent(item.id)}`,
		});
	}

	for (const item of input.choreCompletions) {
		items.push({
			id: item.id,
			kind: 'chore',
			timestamp: item.completedAt,
			memberId: item.completedByMemberId,
			memberName: memberName(members, item.completedByMemberId),
			text: say('audit.timeline.choreDone', { title: item.choreTitle }),
			completed: true,
			href: `/chores?highlight=${encodeURIComponent(item.choreId)}`,
		});
	}

	for (const item of input.recurringExpenses ?? []) {
		items.push({
			id: item.id,
			kind: 'recurring',
			timestamp: item.lastCreatedAt ?? item.createdAt,
			memberId: item.paidByMemberId,
			memberName: memberName(members, item.paidByMemberId),
			text: say(
				item.lastCreatedAt
					? 'audit.timeline.recurringFromTemplate'
					: 'audit.timeline.recurringCreated',
				{ description: item.description },
			),
			completed: false,
			detail: say('audit.timeline.recurringLabel'),
			amountCents: item.amountCents,
			currency: item.currency ?? 'EUR',
			href: `/expenses?recurring=${encodeURIComponent(item.id)}`,
		});
	}

	for (const item of input.absences ?? []) {
		items.push({
			id: item.id,
			kind: 'absence',
			timestamp: item.createdAt,
			memberId: item.memberId,
			memberName: memberName(members, item.memberId),
			text: say('audit.timeline.absenceAway', { self: 'no' }),
			selfText: say('audit.timeline.absenceAway', { self: 'yes' }),
			completed: false,
			sentence: true,
			detail: item.reason
				? `${shortDateRange(item.startDate, item.endDate, locale)} · ${item.reason}`
				: shortDateRange(item.startDate, item.endDate, locale),
			href: `/chores?panel=absences&absence=${encodeURIComponent(item.id)}`,
		});
	}

	for (const item of input.auditEvents ?? []) {
		const detail = auditDetail(item.metadataJson, ctx);
		const href = getAuditHref(item);
		const actorName = item.memberId
			? memberName(members, item.memberId)
			: say('audit.timeline.system');
		const { text, selfText } = auditActivitySentence(item, actorName, ctx);
		items.push({
			id: item.id,
			kind: 'audit',
			timestamp: item.createdAt,
			memberId: item.memberId,
			memberName: actorName,
			text,
			...(selfText ? { selfText } : {}),
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

/** Groups items by Berlin calendar day, newest day first; the page labels the days in the reader's language. */
export function groupActivityItemsByDay(items: ActivityItem[]): ActivityChronicleGroup[] {
	// Berlin day, so entries around midnight land under the day the reader sees.
	const groups = new Map<string, ActivityItem[]>();
	for (const item of items) {
		const key = berlinDayKey(new Date(item.timestamp));
		groups.set(key, [...(groups.get(key) ?? []), item]);
	}
	return Array.from(groups.entries())
		.sort(([a], [b]) => b.localeCompare(a))
		.map(([date, groupItems]) => ({ date, items: groupItems }));
}

/** Whether a Berlin day key is today or yesterday. */
export function activityDayRelation(date: string, now = Date.now()): 'today' | 'yesterday' | null {
	if (date === berlinDayKey(new Date(now))) return 'today';
	// Not `now - 24h`: on the day after spring-forward (23h) that lands two days back.
	if (date === berlinDayKey(prevBerlinDayStart(startOfBerlinDay(new Date(now)))))
		return 'yesterday';
	return null;
}
