import { type ActivityKind, formatAuditActivityText } from './activity';
import {
	getDashboardActivityHref,
	getDashboardAuditHref,
	getDashboardAuditKind,
} from './dashboard-links';
import { ACTIVITY_LIMIT, type PrimaryRows, type SecondaryRows } from './dashboard-queries';

const AUDIT_DEDUPE_WINDOW_MS = 60_000;

// Code points, not UTF-16 units: slicing mid-surrogate leaves a broken "�".
function clip(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

export interface ActivityItem {
	kind: 'expense' | 'shopping' | 'announcement' | 'chore' | 'recurring' | 'absence' | 'audit';
	timestamp: string;
	/** Lets the UI show own entries as "Du …". */
	memberId?: string | null;
	memberName: string;
	text: string;
	/** True when `text` is a server-built sentence ("hat …"), not user content. */
	sentence?: boolean;
	amountCents?: number;
	currency?: string;
	href?: string;
}

function isDuplicateAuditActivity(
	rawByKey: Map<string, number>,
	kind: ActivityKind,
	entityId: string | null | undefined,
	timestampMs: number,
): boolean {
	if (!entityId) return false;
	const rawMs = rawByKey.get(`${kind}:${entityId}`);
	return rawMs !== undefined && Math.abs(timestampMs - rawMs) <= AUDIT_DEDUPE_WINDOW_MS;
}

export function buildPrimaryActivity(
	expenseRows: PrimaryRows[1],
	recentShopping: PrimaryRows[5],
	announcementRows: PrimaryRows[7],
	memberById: Map<string, { name: string }>,
	shareCode: string,
): { activity: ActivityItem[]; rawActivityByKey: Map<string, number> } {
	const activity: ActivityItem[] = [];
	const rawActivityByKey = new Map<string, number>();
	for (const e of expenseRows.slice(0, ACTIVITY_LIMIT)) {
		activity.push({
			kind: 'expense',
			timestamp: e.occurredAt.toISOString(),
			memberId: e.paidByMemberId,
			memberName: memberById.get(e.paidByMemberId)?.name ?? '—',
			text: e.description,
			amountCents: e.amountCents,
			currency: e.currency,
			href: getDashboardActivityHref(shareCode, 'expense', e.id),
		});
		rawActivityByKey.set(`expense:${e.id}`, new Date(e.occurredAt).getTime());
	}
	for (const s of recentShopping) {
		// A purchase belongs to the buyer, not to whoever added the item.
		const actorId = s.boughtAt ? (s.boughtByMemberId ?? s.addedByMemberId) : s.addedByMemberId;
		activity.push({
			kind: 'shopping',
			timestamp: (s.boughtAt ?? s.createdAt).toISOString(),
			memberId: actorId,
			memberName: memberById.get(actorId)?.name ?? '—',
			text: s.boughtAt ? `${s.name} gekauft` : s.name,
			href: getDashboardActivityHref(shareCode, 'shopping', s.id),
		});
		rawActivityByKey.set(`shopping:${s.id}`, (s.boughtAt ?? s.createdAt).getTime());
	}
	for (const a of announcementRows) {
		activity.push({
			kind: 'announcement',
			timestamp: a.createdAt.toISOString(),
			memberId: a.authorMemberId,
			memberName: memberById.get(a.authorMemberId)?.name ?? '—',
			text: clip(a.content, 80),
			href: getDashboardActivityHref(shareCode, 'announcement', a.id),
		});
		rawActivityByKey.set(`announcement:${a.id}`, a.createdAt.getTime());
	}
	activity.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	return { activity, rawActivityByKey };
}

export function appendSecondaryActivity(
	activity: ActivityItem[],
	rawActivityByKey: Map<string, number>,
	absenceRows: SecondaryRows[1],
	recurringRows: SecondaryRows[2],
	auditRows: SecondaryRows[3],
	memberById: Map<string, { name: string }>,
	shareCode: string,
): void {
	// Rows are unordered (they also feed absentMembers), so pick the newest here.
	// Entry time, not start date: a future absence must not stick to the top.
	const newestAbsences = [...absenceRows]
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
		.slice(0, ACTIVITY_LIMIT);
	for (const absence of newestAbsences) {
		activity.push({
			kind: 'absence',
			timestamp: absence.createdAt.toISOString(),
			memberId: absence.memberId,
			memberName: memberById.get(absence.memberId)?.name ?? '—',
			text: 'Abwesenheit eingetragen',
			href: getDashboardActivityHref(shareCode, 'absence', absence.id),
		});
		rawActivityByKey.set(`absence:${absence.id}`, absence.createdAt.getTime());
	}
	const recurringTime = (r: SecondaryRows[2][number]) => (r.lastCreatedAt ?? r.createdAt).getTime();
	const newestRecurring = [...recurringRows]
		.sort((a, b) => recurringTime(b) - recurringTime(a))
		.slice(0, ACTIVITY_LIMIT);
	for (const recurring of newestRecurring) {
		const recurringTs = (recurring.lastCreatedAt ?? recurring.createdAt).getTime();
		activity.push({
			kind: 'recurring',
			timestamp: new Date(recurringTs).toISOString(),
			memberName: 'System',
			text: recurring.lastCreatedAt
				? `${recurring.description} aus Vorlage erstellt`
				: `${recurring.description} als Vorlage angelegt`,
			amountCents: recurring.amountCents,
			currency: 'EUR',
			href: getDashboardActivityHref(shareCode, 'recurring', recurring.id),
		});
		rawActivityByKey.set(`recurring:${recurring.id}`, recurringTs);
	}
	for (const audit of auditRows) {
		const kind = getDashboardAuditKind(audit);
		if (isDuplicateAuditActivity(rawActivityByKey, kind, audit.entityId, audit.createdAt.getTime()))
			continue;
		const actorName = audit.memberId ? (memberById.get(audit.memberId)?.name ?? '—') : 'System';
		const href = getDashboardAuditHref(shareCode, audit);
		activity.push({
			kind,
			timestamp: audit.createdAt.toISOString(),
			memberId: audit.memberId ?? null,
			memberName: actorName,
			text: formatAuditActivityText(audit.summary, actorName),
			sentence: true,
			...(href ? { href } : {}),
		});
	}
	activity.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
