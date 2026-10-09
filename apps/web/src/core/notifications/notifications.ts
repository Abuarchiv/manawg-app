import { berlinDayKey } from '@/core/utils/berlin-day';
import { formatEuroCents } from '@/core/utils/money';

export type NotificationEvent =
	| 'expense.created'
	| 'expense.recurring_charged'
	| 'expense.reminder'
	| 'expense.debt_settled'
	| 'import.completed'
	| 'notification.test'
	| 'announcement.posted'
	| 'announcement.commented'
	| 'announcement.reacted'
	| 'announcement.resolved'
	| 'chore.due'
	| 'shopping.added'
	| 'event.created'
	| 'event.upcoming'
	| 'event.today'
	| 'inventory.low_stock'
	| 'chat.message'
	| 'chat.mention';

type NotificationCategory =
	| 'announcements'
	| 'chores'
	| 'expenses'
	| 'shopping'
	| 'inventory'
	| 'events'
	| 'reminders'
	| 'chat';
type NotificationPriority = 'urgent' | 'normal' | 'silent';

interface NotificationMessage {
	title: string;
	body: string;
	urlPath: string;
}

function money(amountCents: unknown, currency: unknown): string {
	const cents = typeof amountCents === 'number' && Number.isFinite(amountCents) ? amountCents : 0;
	const code = typeof currency === 'string' && currency.trim().length > 0 ? currency : 'EUR';
	// Replace non-breaking spaces (Intl uses U+00A0) with regular spaces for plain-text channels (push, SMS).
	return formatEuroCents(cents, code).replace(/\u00a0/g, ' ');
}

function text(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export function notificationCategoryForEvent(event: NotificationEvent): NotificationCategory {
	if (event === 'notification.test') return 'announcements';
	if (event === 'expense.reminder') return 'reminders';
	if (event.startsWith('announcement.')) return 'announcements';
	if (event.startsWith('expense.') || event === 'import.completed') return 'expenses';
	if (event.startsWith('chore.')) return 'chores';
	if (event.startsWith('event.')) return 'events';
	if (event.startsWith('inventory.')) return 'inventory';
	if (event.startsWith('chat.')) return 'chat';
	return 'shopping';
}

export function notificationPriorityForEvent(event: NotificationEvent): NotificationPriority {
	if (event === 'chore.due') return 'urgent';
	if (event === 'event.upcoming' || event === 'event.today') return 'urgent';
	if (event === 'announcement.reacted') return 'silent';
	if (event === 'notification.test') return 'normal';
	return 'normal';
}

function chatUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.messageId === 'string' ? payload.messageId.trim() : '';
	return id ? `/chat#message-${encodeURIComponent(id)}` : '/chat';
}

function announcementUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.announcementId === 'string' ? payload.announcementId.trim() : '';
	return id ? `/pinnwand#announcement-${encodeURIComponent(id)}` : '/pinnwand';
}

function expenseUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.expenseId === 'string' ? payload.expenseId.trim() : '';
	return id ? `/ausgaben?highlight=${encodeURIComponent(id)}` : '/ausgaben';
}

function choreUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.choreId === 'string' ? payload.choreId.trim() : '';
	return id ? `/putzen?highlight=${encodeURIComponent(id)}` : '/putzen';
}

function shoppingUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.shoppingItemId === 'string' ? payload.shoppingItemId.trim() : '';
	return id ? `/einkauf?highlight=${encodeURIComponent(id)}` : '/einkauf';
}

function eventUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
	return id ? `/kalender?highlight=${encodeURIComponent(id)}` : '/kalender';
}

function formatEventTime(value: unknown, allDay = false): string {
	if (typeof value !== 'string' || value.length === 0) return 'demnächst';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return 'demnächst';
	// All-day events start at Berlin midnight; a clock time would be noise.
	if (allDay) {
		const day = new Intl.DateTimeFormat('de-DE', {
			day: '2-digit',
			month: '2-digit',
			timeZone: 'Europe/Berlin',
		}).format(date);
		return `${day} (ganztägig)`;
	}
	return new Intl.DateTimeFormat('de-DE', {
		day: '2-digit',
		month: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		timeZone: 'Europe/Berlin',
	}).format(date);
}

function berlinDayNumber(date: Date): number {
	const [year, month, day] = berlinDayKey(date).split('-').map(Number);
	return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / 86_400_000;
}

// Reminders also fire for chores overdue up to a week and for new chores due
// tomorrow, so the copy follows the Berlin calendar distance to nextDueAt.
function choreDueBody(payload: Record<string, unknown>, wgName: string): string {
	const title = text(payload.title, 'Eine Aufgabe');
	const dueAt = typeof payload.nextDueAt === 'string' ? new Date(payload.nextDueAt) : null;
	if (!dueAt || Number.isNaN(dueAt.getTime())) return `${title} ist heute in ${wgName} fällig.`;
	const diffDays = berlinDayNumber(dueAt) - berlinDayNumber(new Date());
	if (diffDays < 0) {
		const overdueDays = -diffDays;
		return `${title} ist in ${wgName} seit ${overdueDays} ${overdueDays === 1 ? 'Tag' : 'Tagen'} offen.`;
	}
	if (diffDays === 0) return `${title} ist heute in ${wgName} fällig.`;
	if (diffDays === 1) return `${title} ist morgen in ${wgName} fällig.`;
	const day = new Intl.DateTimeFormat('de-DE', {
		day: '2-digit',
		month: '2-digit',
		timeZone: 'Europe/Berlin',
	}).format(dueAt);
	return `${title} ist am ${day} in ${wgName} fällig.`;
}

function inventoryUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.inventoryItemId === 'string' ? payload.inventoryItemId.trim() : '';
	return id ? `/vorraete?highlight=${encodeURIComponent(id)}` : '/vorraete';
}

function quantityNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatNotificationMessage(
	event: NotificationEvent,
	payload: Record<string, unknown>,
): NotificationMessage {
	const wgName = text(payload.wgName, 'deiner WG');

	switch (event) {
		case 'notification.test':
			return {
				title: 'ManaWG Test',
				body: `Benachrichtigungen funktionieren für ${wgName}.`,
				urlPath: '/einstellungen#benachrichtigungen',
			};
		case 'expense.created': {
			const actorName = text(payload.actorName, 'Jemand');
			const title = text(payload.title, 'eine Ausgabe');
			return {
				title: 'Neue Ausgabe',
				body: `${actorName} hat in ${wgName} ${title} für ${money(payload.amountCents, payload.currency)} eingetragen.`,
				urlPath: expenseUrlPath(payload),
			};
		}
		case 'expense.recurring_charged': {
			const description = text(payload.description, 'Eine Fixkosten-Vorlage');
			return {
				title: 'Neue Fixkosten-Buchung',
				body: `Neue Fixkosten-Buchung: ${description} ${money(payload.amountCents, payload.currency)}`,
				urlPath: expenseUrlPath(payload),
			};
		}
		case 'expense.reminder': {
			const creditor = text(payload.creditorName, 'jemandem');
			const rawDays = typeof payload.oldestDebtAgeDays === 'number' ? payload.oldestDebtAgeDays : 0;
			const dayClause =
				rawDays >= 1 ? ` (ältester Posten ${rawDays} ${rawDays === 1 ? 'Tag' : 'Tage'} alt)` : '';
			return {
				title: 'Erinnerung',
				body: `Du schuldest ${creditor} noch ${money(payload.amountCents, payload.currency)}${dayClause} — bitte zeitnah ausgleichen.`,
				urlPath: '/mahnungen',
			};
		}
		case 'expense.debt_settled': {
			const actorName = text(payload.actorName, 'Jemand');
			const amount = money(payload.amountCents, payload.currency);
			return {
				title: 'Ausgleich eingetragen',
				body:
					payload.direction === 'received'
						? `${actorName} hat den Eingang von ${amount} von dir bestätigt.`
						: `${actorName} hat ${amount} an dich beglichen. Stimmt das nicht, öffne die Ausgaben und widersprich dort.`,
				urlPath: '/ausgaben',
			};
		}
		case 'import.completed': {
			const actorName = text(payload.actorName, 'Jemand');
			const insertedRaw = payload.inserted;
			const inserted =
				typeof insertedRaw === 'number' && Number.isFinite(insertedRaw) ? insertedRaw : 0;
			return {
				title: 'Import abgeschlossen',
				body: `${actorName} hat ${inserted === 1 ? '1 Ausgabe' : `${inserted} Ausgaben`} in ${wgName} importiert.`,
				urlPath: '/ausgaben',
			};
		}
		case 'announcement.posted':
			return {
				title: 'Neue Pinnwand-Nachricht',
				body: `${text(payload.actorName, 'Jemand')} in ${wgName}: ${text(payload.title, 'Neue Nachricht')}`,
				urlPath: announcementUrlPath(payload),
			};
		case 'announcement.commented':
			return {
				title: 'Neue Antwort',
				body: `${text(payload.actorName, 'Jemand')} hat auf der Pinnwand geantwortet: ${text(payload.title, 'Neue Antwort')}`,
				urlPath: announcementUrlPath(payload),
			};
		case 'announcement.reacted':
			return {
				title: 'Pinnwand-Reaktion',
				body: `${text(payload.actorName, 'Jemand')} hat auf deinen Beitrag reagiert: ${text(payload.title, 'Neue Reaktion')}`,
				urlPath: announcementUrlPath(payload),
			};
		case 'announcement.resolved':
			return {
				title: 'Pinnwand geklärt',
				body: `${text(payload.actorName, 'Jemand')} hat einen Beitrag als geklärt markiert: ${text(payload.title, 'Beitrag')}`,
				urlPath: announcementUrlPath(payload),
			};
		case 'chore.due':
			return {
				title: 'Putzplan',
				body: choreDueBody(payload, wgName),
				urlPath: choreUrlPath(payload),
			};
		case 'shopping.added':
			return {
				title: 'Einkaufsliste',
				body: `${text(payload.actorName, 'Jemand')} hat ${text(payload.title, 'etwas')} in ${wgName} hinzugefügt.`,
				urlPath: shoppingUrlPath(payload),
			};
		case 'event.created':
			return {
				title: 'Neuer Termin',
				body: `${text(payload.actorName, 'Jemand')} hat in ${wgName} „${text(
					payload.title,
					'Termin',
				)}“ am ${formatEventTime(payload.startsAt, payload.allDay === true)} eingetragen.`,
				urlPath: eventUrlPath(payload),
			};
		case 'event.upcoming': {
			const title = text(payload.title, 'Termin');
			return {
				title: 'Termin morgen',
				body:
					payload.allDay === true
						? `Morgen in ${wgName}: „${title}“ am ${formatEventTime(payload.startsAt, true)}.`
						: `Morgen in ${wgName}: „${title}“ um ${formatEventTime(payload.startsAt)}.`,
				urlPath: eventUrlPath(payload),
			};
		}
		case 'event.today': {
			const title = text(payload.title, 'Termin');
			const body =
				payload.allDay === true
					? `Heute in ${wgName}: „${title}“ ist ganztägig.`
					: payload.ongoing === true
						? `Heute in ${wgName}: „${title}“ läuft noch.`
						: `Heute in ${wgName}: „${title}“ um ${formatEventTime(payload.startsAt)}.`;
			return {
				title: 'Termin heute',
				body,
				urlPath: eventUrlPath(payload),
			};
		}
		case 'inventory.low_stock': {
			const itemName = text(payload.title, 'Vorrat');
			const quantity = quantityNumber(payload.quantity);
			const threshold = quantityNumber(payload.threshold);
			const detail =
				quantity !== null && threshold !== null ? ` (${quantity} von ${threshold})` : '';
			return {
				title: 'Vorrat bald leer',
				body: `Bald leer: ${itemName}${detail} in ${wgName}.`,
				urlPath: inventoryUrlPath(payload),
			};
		}
		case 'chat.message': {
			const sender = text(payload.actorName, 'Jemand');
			const preview = text(payload.preview, 'Neue Nachricht');
			return {
				title: `Chat — ${wgName}`,
				body: `${sender}: ${preview}`,
				urlPath: chatUrlPath(payload),
			};
		}
		case 'chat.mention': {
			const sender = text(payload.actorName, 'Jemand');
			const preview = text(payload.preview, 'Neue Erwähnung');
			return {
				title: `${sender} hat dich erwähnt`,
				body: `${sender} hat dich erwähnt: ${preview}`,
				urlPath: chatUrlPath(payload),
			};
		}
	}
}
