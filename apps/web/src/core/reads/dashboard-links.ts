import { type ActivityKind, getAuditHref } from './activity';

export function getDashboardActivityHref(
	shareCode: string,
	kind: ActivityKind,
	id: string,
): string {
	const base = `/wg/${encodeURIComponent(shareCode)}`;
	const encodedId = encodeURIComponent(id);
	if (kind === 'expense') return `${base}/ausgaben?highlight=${encodedId}`;
	if (kind === 'recurring') return `${base}/ausgaben?recurring=${encodedId}`;
	if (kind === 'shopping') return `${base}/einkauf?highlight=${encodedId}`;
	if (kind === 'announcement') return `${base}/pinnwand#announcement-${encodedId}`;
	if (kind === 'absence') return `${base}/putzen?panel=absences&absence=${encodedId}`;
	return `${base}/putzen?highlight=${encodedId}`;
}

export function getDashboardAnnouncementHref(shareCode: string, id: string): string {
	return getDashboardActivityHref(shareCode, 'announcement', id);
}

export function getDashboardAuditHref(
	shareCode: string,
	event: {
		eventType: string;
		entityType?: string;
		entityId?: string | null;
		metadataJson?: string | null;
	},
): string | undefined {
	const href = getAuditHref(event);
	return href ? `/wg/${encodeURIComponent(shareCode)}${href}` : undefined;
}

export function getDashboardAuditKind(event: {
	eventType: string;
	entityType?: string;
}): ActivityKind {
	if (event.entityType === 'shopping_item') return 'shopping';
	if (
		event.entityType === 'announcement' ||
		event.entityType === 'announcement_comment' ||
		event.entityType === 'announcement_reaction'
	) {
		return 'announcement';
	}
	if (event.entityType === 'recurring_expense' || event.eventType.startsWith('recurring')) {
		return 'recurring';
	}
	if (event.entityType === 'absence' || event.entityType === 'member_absence') return 'absence';
	if (
		event.entityType === 'expense' ||
		event.entityType === 'expense_split' ||
		event.entityType === 'expense_debt' ||
		event.eventType.startsWith('expense')
	) {
		return 'expense';
	}
	return 'audit';
}
