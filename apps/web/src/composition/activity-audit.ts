import { formatEuroCents } from '@/core/utils/money';
import {
	formatShortDateRange as formatSharedShortDateRange,
	formatShortDate,
} from '@/core/utils/time';
import { KIND_LABELS } from '@/features/pinnwand/components/constants';

/** Announcement sources a member wrote by hand; the rest are system notices. */
export const MEMBER_ANNOUNCEMENT_SOURCES = ['manual', 'chore_swap'] as const;

/** Chat audits carry no content worth a feed row and would crowd out real events. */
export const CHAT_AUDIT_EVENT_TYPES = [
	'chat.message.created',
	'chat.message.edited',
	'chat.message.deleted',
] as const;

/**
 * Audit events the chronicle never shows: chat noise, plus events whose raw
 * row (expense, shopping item, completion, ...) is already a timeline entry.
 */
export const ACTIVITY_HIDDEN_AUDIT_EVENT_TYPES = [
	...CHAT_AUDIT_EVENT_TYPES,
	'expense.created',
	'recurring.charged',
	'recurring.created',
	'recurring.advanced',
	'shopping.created',
	'shopping.bought',
	'chore.completed',
	'announcement.created',
	'absence.created',
] as const;

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

export function auditDetail(metadataJson?: string | null): string | undefined {
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
		// Only known pinboard kinds: chat audits carry kind 'text'/'image', which is not user text.
		const kindLabel =
			typeof metadata.kind === 'string'
				? (KIND_LABELS as Record<string, string | undefined>)[metadata.kind]
				: undefined;
		if (kindLabel) parts.push(`Typ: ${kindLabel}`);
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
			parts.push(`nächste Fälligkeit ${formatShortDate(metadata.nextDueAt, 'Europe/Berlin')}`);
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
