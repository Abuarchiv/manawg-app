import type { Catalog } from '../catalog';
import type de from '../de/audit';

/** English verbs do not change for the reader's own rows; the argument keeps both languages in step. */
const same = (sentence: string) => `{self, select, yes {${sentence}} other {${sentence}}}`;

export default {
	summary: '{actorName} {text}',
	absenceCreated: { feed: same('added time away.') },
	absenceDeleted: { feed: same('removed time away.') },
	announcementCommentCreated: { feed: same('wrote a reply.') },
	announcementCommentUpdated: { feed: same('updated a reply.') },
	announcementCommentDeleted: {
		feed: same('removed a reply{moderated, select, yes { as admin} other {}}.'),
	},
	announcementReactionAdded: { feed: same('reacted with “{reaction}”.') },
	announcementReactionRemoved: { feed: same('removed a reaction.') },
	announcementCreated: { feed: same('created a noticeboard post.') },
	announcementUpdated: {
		feed: same(
			'{change, select, resolved {marked a noticeboard post as resolved.} open {reopened a noticeboard post.} other {updated a noticeboard post.}}',
		),
	},
	announcementDeleted: { feed: same('removed a noticeboard post.') },
	calendarFeedCreated: { feed: same('created the calendar feed.') },
	calendarFeedRotated: { feed: same('renewed the calendar feed.') },
	calendarFeedRevoked: { feed: same('revoked the calendar feed.') },
	chatMessageCreated: { feed: same('sent a message in the chat.') },
	chatMessageEdited: { feed: same('edited a chat message.') },
	chatMessageDeleted: { feed: same('deleted a chat message.') },
	choreCreated: { feed: same('added {title} to the cleaning rota.') },
	choreUpdated: { feed: same('updated {title}.') },
	choreDeleted: { feed: same('removed {title} from the cleaning rota.') },
	choreCompleted: { feed: same('marked {title} as done.') },
	eventCreated: { feed: same('added the event “{title}”.') },
	eventUpdated: {
		feed: same(
			'{occurrence, select, cancel {removed an occurrence of the series “{title}”.} change {changed an occurrence of the series “{title}”.} other {updated the event “{title}”.}}',
		),
	},
	eventDeleted: { feed: same('removed the event “{title}”.') },
	expenseCreated: { feed: same('added {description}.') },
	expenseUpdated: { feed: same('updated {description}.') },
	expenseDeleted: { feed: same('removed {description}.') },
	expenseSplitSettled: { feed: same('settled a share for {description}.') },
	expenseSplitReopened: { feed: same('reopened a share for {description}.') },
	expenseDebtSettled: {
		feed: same('settled {count, plural, one {# open share} other {# open shares}}.'),
	},
	expenseDebtSettledManual: { feed: same('recorded a cash payment of {amount}.') },
	expenseDebtSettledManualVoided: { feed: same('reversed a cash payment of {amount}.') },
	expenseReminderSent: {
		feed: same('reminded {debtorName} about amounts open to {creditorName}.'),
	},
	importCompleted: {
		feed: same('imported {inserted, plural, one {# expense} other {# expenses}}.'),
	},
	importUndone: {
		feed: same('undid an import ({removed, plural, one {# expense} other {# expenses}}).'),
	},
	inventoryCreated: { feed: same('added {name} to supplies.') },
	inventoryUpdated: { feed: same('updated {name} in supplies.') },
	inventoryDeleted: {
		feed: same('removed {hasName, select, yes {{name}} other {a supply item}} from supplies.'),
	},
	inventoryConsumed: {
		feed: same(
			'took {quantity} {unitKey, select, piece {pcs} litre {L} kilogram {kg} roll {{count, plural, =1 {roll} other {rolls}}} pack {{count, plural, =1 {pack} other {packs}}} other {{unit}}} of {name}.',
		),
	},
	memberInvited: { feed: same('sent an invitation by email.') },
	memberJoined: { feed: same('joined the flat by invitation.') },
	memberReactivated: { feed: same('reactivated {name}.') },
	memberDeactivated: { feed: same('marked {name} as moved out.') },
	memberRenamed: {
		feed: '{self, select, yes {{byOther, select, yes {renamed {before} to {after}.} other {changed your name (was {before}).}}} other {{byOther, select, yes {renamed {before} to {after}.} other {changed their name (was {before}).}}}}',
	},
	memberAdminTransferred: { feed: same('handed the admin role to {name}.') },
	memberAccountDeletionRequested: {
		feed: same(
			'requested account deletion and left the flat.{hasNewAdmin, select, yes { {newAdminName} is now admin.} other {}}',
		),
	},
	notificationSettingsUpdated: { feed: same('changed notification settings.') },
	notificationPushSubscribed: { feed: same('turned on Web Push.') },
	notificationPushUnsubscribed: { feed: same('turned off Web Push.') },
	recurringCreated: { feed: same('saved {description} as a fixed-cost template.') },
	recurringPaused: { feed: same('paused the fixed cost {description}.') },
	recurringResumed: { feed: same('resumed the fixed cost {description}.') },
	recurringUpdated: { feed: same('updated the fixed-cost template {description}.') },
	recurringDeleted: { feed: same('deleted the fixed-cost template {description}.') },
	recurringCharged: {
		feed: '{description} was added automatically from fixed costs.',
	},
	recurringAutoPaused: {
		feed: 'Fixed-cost template {description} was paused automatically.',
	},
	recurringAdvanced: {
		feed: '{description} was taken from a fixed-cost template.',
	},
	shoppingCreated: { feed: same('added {title} to the shopping list.') },
	shoppingUpdated: { feed: same('changed {name}.') },
	shoppingBought: { feed: same('bought {name}.') },
	shoppingReopened: { feed: same('reopened {name}.') },
	shoppingDeleted: { feed: same('removed {name} from the shopping list.') },
	shoppingClearedBought: {
		feed: same('removed {count, plural, one {# bought item} other {# bought items}}.'),
	},
	wgCreated: { feed: same('created the flat.') },
	wgUpdated: { feed: same('changed the flat settings.') },
	wgInviteCreated: { feed: same('created an invitation.') },
	wgInviteRevoked: { feed: same('revoked an invitation.') },
	timeline: {
		system: 'System',
		shoppingBought: '{name} bought',
		shoppingAdded: '{name} added',
		choreDone: '{title} done',
		recurringFromTemplate: '{description} created from template',
		recurringCreated: '{description} saved as a fixed-cost template',
		recurringLabel: 'Fixed costs',
		absenceAway: '{self, select, yes {are} other {is}} away',
		absenceEntered: 'Time away added',
	},
	detail: {
		kind: 'Type: {kind}',
		withImage: 'with image',
		pushOn: 'Web Push on',
		pushOff: 'Web Push off',
		quietHours: 'Quiet hours {start}:00 to {end}:00',
		quietHoursOff: 'Quiet hours off',
		splitCount: '{count, plural, one {# split} other {# splits}}',
		reaction: 'Reaction: {reaction}',
		everyDays: '{days, plural, =1 {daily} other {every # days}}',
		everyMonths: '{months, plural, =1 {monthly} other {every # months}}',
		away: 'away {range}',
		nextDue: 'next due {date}',
		shares: '{count, plural, one {# share} other {# shares}}',
		fields: {
			pushOptIn: 'Web Push',
			notifyAnnouncements: 'Noticeboard',
			notifyChores: 'Cleaning rota',
			notifyExpenses: 'Expenses',
			notifyShopping: 'Shopping',
			notifyInventory: 'Supplies',
			notifyReminders: 'Reminders',
			notifyChat: 'Chat',
			notifyEvents: 'Calendar',
			notifyStatementEmail: 'Monthly statement by email',
			quietStartHour: 'Quiet hours start',
			quietEndHour: 'Quiet hours end',
		},
	},
} satisfies Catalog<typeof de>;
