import { formatDecimal } from '@/core/utils/amount';
import { isRecord } from '@/core/utils/is-record';
import { formatEuroCents } from '@/core/utils/money';
import type { Locale } from '@/shared/i18n/locale';
import type { Message, MessageKey } from '@/shared/i18n/message';

/** Turns a message into text; the server passes a translator, pure callers pass nothing. */
export interface RenderContext {
	locale: Locale;
	render: (message: Message) => string;
}

/** Echoes message keys; for pure callers that have no translator and only read legacy rows. */
export const KEY_RENDER_CONTEXT: RenderContext = { locale: 'de', render: (message) => message.key };

type Values = Record<string, string | number | Message>;

interface AuditEventDef {
	/** Metadata keys the sentence needs; a row missing one is a legacy row. */
	keys?: readonly string[];
	/** Sentences without an actor ("… wurde …"); they are their own summary. */
	passive?: true;
	/** Arguments derived from the metadata in the reader's locale. */
	derive?: (metadata: Record<string, unknown>, locale: Locale) => Values | null;
}

const REACTIONS = ['seen', 'take', 'ok'];
// Mirrors INVENTORY_UNITS (features/inventory); core cannot import features.
const UNITS = ['piece', 'litre', 'kilogram', 'roll', 'pack'];

function withAmount(metadata: Record<string, unknown>, locale: Locale): Values | null {
	if (typeof metadata.amountCents !== 'number') return null;
	const currency = typeof metadata.currency === 'string' ? metadata.currency : 'EUR';
	return { amount: formatEuroCents(metadata.amountCents, currency, { locale }) };
}

const TITLE = { keys: ['title'] } as const;
const NAME = { keys: ['name'] } as const;
const DESCRIPTION = { keys: ['description'] } as const;
const NONE = {} as const;

/** Every event type with an `audit.<type>.feed` message and the parameters its sentence needs. */
const EVENTS: Readonly<Record<string, AuditEventDef>> = {
	'absence.created': NONE,
	'absence.deleted': NONE,
	'announcement.comment.created': NONE,
	'announcement.comment.updated': NONE,
	'announcement.comment.deleted': { keys: ['moderated'] },
	'announcement.reaction.added': {
		keys: ['reaction'],
		derive: (metadata) => {
			const reaction = String(metadata.reaction);
			return {
				reaction: REACTIONS.includes(reaction)
					? { key: `pinboard.reaction.${reaction}` as MessageKey }
					: reaction,
			};
		},
	},
	'announcement.reaction.removed': NONE,
	'announcement.created': NONE,
	'announcement.updated': {
		derive: (metadata) => ({
			change: metadata.statusChanged === true ? String(metadata.status) : 'none',
		}),
	},
	'announcement.deleted': NONE,
	'calendar.feed_created': NONE,
	'calendar.feed_rotated': NONE,
	'calendar.feed_revoked': NONE,
	'chat.message.created': NONE,
	'chat.message.edited': NONE,
	'chat.message.deleted': NONE,
	'chore.created': TITLE,
	'chore.updated': TITLE,
	'chore.deleted': TITLE,
	'chore.completed': TITLE,
	'event.created': TITLE,
	'event.updated': {
		...TITLE,
		derive: (metadata) => ({
			occurrence: metadata.action === 'cancel' ? 'cancel' : metadata.action ? 'change' : 'none',
		}),
	},
	'event.deleted': TITLE,
	'expense.created': DESCRIPTION,
	'expense.updated': DESCRIPTION,
	'expense.deleted': DESCRIPTION,
	'expense.split.settled': DESCRIPTION,
	'expense.split.reopened': DESCRIPTION,
	'expense.debt.settled': { keys: ['count'] },
	'expense.debt.settled.manual': { derive: withAmount },
	'expense.debt.settled.manual.voided': { derive: withAmount },
	'expense.reminder.sent': { keys: ['debtorName', 'creditorName'] },
	'import.completed': { keys: ['inserted'] },
	'import.undone': { keys: ['removed'] },
	'inventory.created': NAME,
	'inventory.updated': NAME,
	'inventory.deleted': {
		derive: (metadata) => ({
			hasName: typeof metadata.name === 'string' ? 'yes' : 'no',
			name: typeof metadata.name === 'string' ? metadata.name : '',
		}),
	},
	'inventory.consumed': {
		keys: ['name', 'unit'],
		derive: (metadata, locale) =>
			typeof metadata.appliedDelta === 'number'
				? {
						quantity: formatDecimal(Math.abs(metadata.appliedDelta), locale),
						count: Math.abs(metadata.appliedDelta),
						unitKey: UNITS.includes(String(metadata.unit)) ? String(metadata.unit) : 'other',
					}
				: null,
	},
	'member.invited': NONE,
	'member.joined': NONE,
	'member.reactivated': NAME,
	'member.deactivated': NAME,
	'member.renamed': { keys: ['before', 'after', 'byOther'] },
	'member.admin_transferred': NAME,
	'member.account_deletion_requested': {
		derive: (metadata) => ({
			hasNewAdmin: typeof metadata.newAdminName === 'string' ? 'yes' : 'no',
			newAdminName: typeof metadata.newAdminName === 'string' ? metadata.newAdminName : '',
		}),
	},
	'notification.settings.updated': NONE,
	'notification.push.subscribed': NONE,
	'notification.push.unsubscribed': NONE,
	'recurring.created': DESCRIPTION,
	'recurring.paused': DESCRIPTION,
	'recurring.resumed': DESCRIPTION,
	'recurring.updated': DESCRIPTION,
	'recurring.deleted': DESCRIPTION,
	'recurring.charged': { ...DESCRIPTION, passive: true },
	'recurring.auto_paused': { ...DESCRIPTION, passive: true },
	'recurring.advanced': { ...DESCRIPTION, passive: true },
	'shopping.created': TITLE,
	'shopping.updated': NAME,
	'shopping.bought': NAME,
	'shopping.reopened': NAME,
	'shopping.deleted': NAME,
	'shopping.cleared_bought': { keys: ['count'] },
	'wg.created': NONE,
	'wg.updated': NONE,
	'wg.invite_created': NONE,
	'wg.invite_revoked': NONE,
};

/** `chore.completed` → `choreCompleted`, the key of the event's message group. */
function auditMessageGroup(eventType: string): string {
	return eventType
		.split(/[._]/u)
		.map((part, index) => (index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
		.join('');
}

export const AUDIT_EVENT_TYPES = Object.keys(EVENTS);

export function parseAuditMetadata(
	metadataJson: string | null | undefined,
): Record<string, unknown> | null {
	if (!metadataJson) return null;
	try {
		const parsed: unknown = JSON.parse(metadataJson);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function scalar(value: unknown): string | number | null {
	if (typeof value === 'string' || typeof value === 'number') return value;
	if (typeof value === 'boolean') return value ? 'yes' : 'no';
	return null;
}

/**
 * The sentence of an audit event without its actor ("hat Brot gekauft."), or null when the
 * type has no message or the metadata lacks a parameter (rows written before the messages).
 * `self` picks the verb forms for the reader's own rows.
 */
export function auditFeedMessage(
	eventType: string,
	metadata: Record<string, unknown> | null,
	locale: Locale,
	self: boolean,
): Message | null {
	const def = EVENTS[eventType];
	if (!def) return null;
	const source = metadata ?? {};
	const values: Values = { self: self ? 'yes' : 'no' };
	for (const key of def.keys ?? []) {
		const value = scalar(source[key]);
		if (value === null) return null;
		values[key] = value;
	}
	if (def.derive) {
		const derived = def.derive(source, locale);
		if (!derived) return null;
		Object.assign(values, derived);
	}
	return { key: `audit.${auditMessageGroup(eventType)}.feed` as MessageKey, values };
}

export function isPassiveAuditEvent(eventType: string): boolean {
	return EVENTS[eventType]?.passive === true;
}

/** The message of the stored German `summary` column: "<actor> <sentence>", or the sentence alone. */
export function auditSummaryMessage(
	eventType: string,
	actorName: string,
	metadata: Record<string, unknown> | null,
): Message | null {
	const feed = auditFeedMessage(eventType, metadata, 'de', false);
	if (!feed || isPassiveAuditEvent(eventType)) return feed;
	return { key: 'audit.summary', values: { actorName, text: feed } };
}
