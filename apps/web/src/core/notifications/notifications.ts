import { serverT } from '@/core/i18n/server-t';
import { formatDecimal } from '@/core/utils/amount';
import { berlinCalendarDayDistance } from '@/core/utils/berlin-day';
import { formatEuroCents } from '@/core/utils/money';
import { dayMonthOptions, formatShortDate } from '@/core/utils/time';
import { dateTimeFormat } from '@/shared/i18n/intl';
import type { Locale } from '@/shared/i18n/locale';

export type NotificationEvent =
	| 'expense.created'
	| 'expense.recurring_charged'
	| 'expense.reminder'
	| 'expense.debt_settled'
	| 'expense.payment_voided'
	| 'import.completed'
	| 'notification.test'
	| 'announcement.posted'
	| 'announcement.commented'
	| 'announcement.resolved'
	| 'chore.due'
	| 'shopping.added'
	| 'event.created'
	| 'event.moved'
	| 'event.cancelled'
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
type NotificationPriority = 'urgent' | 'normal';

export interface NotificationMessage {
	title: string;
	body: string;
	urlPath: string;
}

type PushT = ReturnType<typeof serverT<'push'>>;

function money(amountCents: unknown, currency: unknown, locale: Locale): string {
	const cents = typeof amountCents === 'number' && Number.isFinite(amountCents) ? amountCents : 0;
	const code = typeof currency === 'string' && currency.trim().length > 0 ? currency : 'EUR';
	// Replace non-breaking spaces (Intl uses U+00A0) with regular spaces for plain-text channels (push, SMS).
	return formatEuroCents(cents, code, { locale }).replace(/\u00a0/g, ' ');
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
	if (event === 'notification.test') return 'normal';
	return 'normal';
}

function chatUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.messageId === 'string' ? payload.messageId.trim() : '';
	return id ? `/chat#message-${encodeURIComponent(id)}` : '/chat';
}

function announcementUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.announcementId === 'string' ? payload.announcementId.trim() : '';
	return id ? `/pinboard#announcement-${encodeURIComponent(id)}` : '/pinboard';
}

function expenseUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.expenseId === 'string' ? payload.expenseId.trim() : '';
	return id ? `/expenses?highlight=${encodeURIComponent(id)}` : '/expenses';
}

function choreUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.choreId === 'string' ? payload.choreId.trim() : '';
	return id ? `/chores?highlight=${encodeURIComponent(id)}` : '/chores';
}

function shoppingUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.shoppingItemId === 'string' ? payload.shoppingItemId.trim() : '';
	return id ? `/shopping?highlight=${encodeURIComponent(id)}` : '/shopping';
}

function eventUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
	return id ? `/calendar?highlight=${encodeURIComponent(id)}` : '/calendar';
}

function formatEventTime(t: PushT, locale: Locale, value: unknown, allDay = false): string {
	if (typeof value !== 'string' || value.length === 0) return t('fallback.soon');
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return t('fallback.soon');
	// All-day events start at Berlin midnight; a clock time would be noise.
	if (allDay) {
		return t('eventTime.allDay', { date: formatShortDate(value, 'Europe/Berlin', locale) });
	}
	return dateTimeFormat(locale, {
		...dayMonthOptions(locale),
		hour: '2-digit',
		minute: '2-digit',
		timeZone: 'Europe/Berlin',
	}).format(date);
}

// Reminders also fire for chores overdue up to a week and for new chores due
// tomorrow, so the copy follows the Berlin calendar distance to nextDueAt.
function choreDueBody(
	t: PushT,
	locale: Locale,
	payload: Record<string, unknown>,
	wgName: string,
): string {
	const body = choreDueSentence(t, locale, payload, wgName);
	return payload.unassigned === true ? `${body} ${t('choreDue.unassigned')}` : body;
}

function choreDueSentence(
	t: PushT,
	locale: Locale,
	payload: Record<string, unknown>,
	wgName: string,
): string {
	const title = text(payload.title, t('fallback.task'));
	const dueAt = typeof payload.nextDueAt === 'string' ? new Date(payload.nextDueAt) : null;
	if (!dueAt || Number.isNaN(dueAt.getTime())) return t('choreDue.today', { title, wgName });
	const diffDays = berlinCalendarDayDistance(new Date(), dueAt);
	if (diffDays < 0) return t('choreDue.overdue', { title, wgName, days: -diffDays });
	if (diffDays === 0) return t('choreDue.today', { title, wgName });
	if (diffDays === 1) return t('choreDue.tomorrow', { title, wgName });
	const date = formatShortDate(dueAt.toISOString(), 'Europe/Berlin', locale);
	return t('choreDue.onDate', { title, wgName, date });
}

function inventoryUrlPath(payload: Record<string, unknown>): string {
	const id = typeof payload.inventoryItemId === 'string' ? payload.inventoryItemId.trim() : '';
	return id ? `/supplies?highlight=${encodeURIComponent(id)}` : '/supplies';
}

function quantityNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatNotificationMessage(
	event: NotificationEvent,
	payload: Record<string, unknown>,
	locale: Locale = 'de',
): NotificationMessage {
	const t = serverT(locale, 'push');
	const wgName = text(payload.wgName, t('fallback.wgName'));
	const actorName = text(payload.actorName, t('fallback.someone'));
	const amount = () => money(payload.amountCents, payload.currency, locale);
	const when = () => formatEventTime(t, locale, payload.startsAt, payload.allDay === true);

	switch (event) {
		case 'notification.test':
			return {
				title: t('test.title'),
				body: t('test.body', { wgName }),
				urlPath: '/settings#notifications',
			};
		case 'expense.created':
			return {
				title: t('expenseCreated.title'),
				body: t('expenseCreated.body', {
					actorName,
					wgName,
					title: text(payload.title, t('fallback.expense')),
					amount: amount(),
				}),
				urlPath: expenseUrlPath(payload),
			};
		case 'expense.recurring_charged':
			return {
				title: t('recurringCharged.title'),
				body: t('recurringCharged.body', {
					description: text(payload.description, t('fallback.fixedCostTemplate')),
					amount: amount(),
				}),
				urlPath: expenseUrlPath(payload),
			};
		case 'expense.reminder': {
			const creditor = text(payload.creditorName, t('fallback.creditor'));
			const days = typeof payload.oldestDebtAgeDays === 'number' ? payload.oldestDebtAgeDays : 0;
			return {
				title: t('expenseReminder.title'),
				body:
					days >= 1
						? t('expenseReminder.bodyAged', { creditor, amount: amount(), days })
						: t('expenseReminder.body', { creditor, amount: amount() }),
				urlPath: '/reminders',
			};
		}
		case 'expense.debt_settled':
			return {
				title: t('debtSettled.title'),
				body: t(payload.direction === 'received' ? 'debtSettled.received' : 'debtSettled.paid', {
					actorName,
					amount: amount(),
				}),
				urlPath: '/expenses',
			};
		case 'expense.payment_voided':
			return {
				title: t('paymentVoided.title'),
				body: t('paymentVoided.body', { actorName, amount: amount() }),
				urlPath: '/expenses',
			};
		case 'import.completed': {
			const inserted =
				typeof payload.inserted === 'number' && Number.isFinite(payload.inserted)
					? payload.inserted
					: 0;
			return {
				title: t('importCompleted.title'),
				body: t('importCompleted.body', { actorName, inserted, wgName }),
				urlPath: '/expenses',
			};
		}
		case 'announcement.posted':
			return {
				title: t('announcementPosted.title'),
				body: t('announcementPosted.body', {
					actorName,
					wgName,
					title: text(payload.title, t('fallback.newMessage')),
				}),
				urlPath: announcementUrlPath(payload),
			};
		case 'announcement.commented':
			return {
				title: t('announcementCommented.title'),
				body: t('announcementCommented.body', {
					actorName,
					title: text(payload.title, t('fallback.newReply')),
				}),
				urlPath: announcementUrlPath(payload),
			};
		case 'announcement.resolved':
			return {
				title: t('announcementResolved.title'),
				body: t('announcementResolved.body', {
					actorName,
					title: text(payload.title, t('fallback.post')),
				}),
				urlPath: announcementUrlPath(payload),
			};
		case 'chore.due':
			return {
				title: t('choreDue.title'),
				body: choreDueBody(t, locale, payload, wgName),
				urlPath: choreUrlPath(payload),
			};
		case 'shopping.added':
			return {
				title: t('shoppingAdded.title'),
				body: t('shoppingAdded.body', {
					actorName,
					wgName,
					title: text(payload.title, t('fallback.shoppingItem')),
				}),
				urlPath: shoppingUrlPath(payload),
			};
		case 'event.created':
			return {
				title: t('eventCreated.title'),
				body: t('eventCreated.body', {
					actorName,
					wgName,
					title: text(payload.title, t('fallback.event')),
					when: when(),
				}),
				urlPath: eventUrlPath(payload),
			};
		case 'event.moved': {
			const title = text(payload.title, t('fallback.event'));
			return {
				title: t('eventMoved.title'),
				body:
					payload.recurring === true
						? t('eventMoved.series', { actorName, title, wgName })
						: t('eventMoved.single', { actorName, title, wgName, when: when() }),
				urlPath: eventUrlPath(payload),
			};
		}
		case 'event.cancelled': {
			const title = text(payload.title, t('fallback.event'));
			return {
				title: t('eventCancelled.title'),
				body:
					payload.recurring === true
						? t('eventCancelled.series', { actorName, title, wgName })
						: t('eventCancelled.single', { actorName, title, wgName, when: when() }),
				urlPath: eventUrlPath(payload),
			};
		}
		case 'event.upcoming': {
			const title = text(payload.title, t('fallback.event'));
			const allDay = payload.allDay === true;
			return {
				title: t('eventUpcoming.title'),
				body: t(allDay ? 'eventUpcoming.allDay' : 'eventUpcoming.timed', {
					wgName,
					title,
					when: formatEventTime(t, locale, payload.startsAt, allDay),
				}),
				urlPath: eventUrlPath(payload),
			};
		}
		case 'event.today': {
			const title = text(payload.title, t('fallback.event'));
			const values = { wgName, title };
			const body =
				payload.allDay === true
					? t('eventToday.allDay', values)
					: payload.ongoing === true
						? t('eventToday.ongoing', values)
						: t('eventToday.timed', {
								...values,
								when: formatEventTime(t, locale, payload.startsAt),
							});
			return { title: t('eventToday.title'), body, urlPath: eventUrlPath(payload) };
		}
		case 'inventory.low_stock': {
			const itemName = text(payload.title, t('fallback.supply'));
			const quantity = quantityNumber(payload.quantity);
			const threshold = quantityNumber(payload.threshold);
			return {
				title: t('lowStock.title'),
				body:
					quantity !== null && threshold !== null
						? t('lowStock.bodyDetail', {
								itemName,
								wgName,
								quantity: formatDecimal(quantity, locale),
								threshold: formatDecimal(threshold, locale),
							})
						: t('lowStock.body', { itemName, wgName }),
				urlPath: inventoryUrlPath(payload),
			};
		}
		case 'chat.message':
			return {
				title: t('chatMessage.title', { wgName }),
				body: t('chatMessage.body', {
					sender: actorName,
					preview: text(payload.preview, t('fallback.newMessage')),
				}),
				urlPath: chatUrlPath(payload),
			};
		case 'chat.mention':
			return {
				title: t('chatMention.title', { sender: actorName }),
				body: t('chatMention.body', {
					sender: actorName,
					preview: text(payload.preview, t('fallback.newMention')),
				}),
				urlPath: chatUrlPath(payload),
			};
	}
}
