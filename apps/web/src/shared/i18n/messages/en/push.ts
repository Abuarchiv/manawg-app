import type { Catalog } from '../catalog';
import type de from '../de/push';

export default {
	fallback: {
		wgName: 'your flat',
		someone: 'Someone',
		expense: 'an expense',
		fixedCostTemplate: 'A fixed-cost template',
		creditor: 'someone',
		task: 'A task',
		shoppingItem: 'something',
		event: 'Event',
		supply: 'Supply item',
		post: 'Post',
		newMessage: 'New message',
		newReply: 'New reply',
		newMention: 'New mention',
		soon: 'soon',
	},
	eventTime: {
		allDay: '{date} (all day)',
	},
	test: {
		title: 'ManaWG test',
		body: 'Notifications are working for {wgName}.',
	},
	expenseCreated: {
		title: 'New expense',
		body: '{actorName} added {title} for {amount} in {wgName}.',
	},
	recurringCharged: {
		title: 'New fixed-cost entry',
		body: 'New fixed-cost entry: {description} {amount}',
	},
	expenseReminder: {
		title: 'Reminder',
		body: '{amount} to {creditor}, still open.',
		bodyAged:
			'{amount} to {creditor}, still open (oldest item {days, plural, one {{days, number, ::group-off} day} other {{days, number, ::group-off} days}} old).',
	},
	debtSettled: {
		title: 'Settlement recorded',
		received: '{actorName} confirmed receiving {amount} from you.',
		paid: '{actorName} paid you {amount}. If that is not right, open Expenses and dispute it there.',
	},
	paymentVoided: {
		title: 'Cash payment reversed',
		body: '{actorName} reversed the cash payment of {amount}. The amount is open again.',
	},
	importCompleted: {
		title: 'Import finished',
		body: '{actorName} imported {inserted, plural, one {{inserted, number, ::group-off} expense} other {{inserted, number, ::group-off} expenses}} into {wgName}.',
	},
	announcementPosted: {
		title: 'New noticeboard post',
		body: '{actorName} in {wgName}: {title}',
	},
	announcementCommented: {
		title: 'New reply',
		body: '{actorName} replied on the noticeboard: {title}',
	},
	announcementResolved: {
		title: 'Noticeboard post resolved',
		body: '{actorName} marked a post as resolved: {title}',
	},
	choreDue: {
		title: 'Cleaning rota',
		today: '{title} is due today in {wgName}.',
		tomorrow: '{title} is due tomorrow in {wgName}.',
		onDate: '{title} is due on {date} in {wgName}.',
		overdue:
			'{title} has been open in {wgName} for {days, plural, one {{days, number, ::group-off} day} other {{days, number, ::group-off} days}}.',
		unassigned: 'Nobody is assigned.',
	},
	shoppingAdded: {
		title: 'Shopping list',
		body: '{actorName} added {title} to the shopping list in {wgName}.',
	},
	eventCreated: {
		title: 'New event',
		body: '{actorName} added “{title}” in {wgName} on {when}.',
	},
	eventMoved: {
		title: 'Event moved',
		series: '{actorName} moved the recurring event “{title}” in {wgName}.',
		single: '{actorName} moved “{title}” in {wgName} to {when}.',
	},
	eventCancelled: {
		title: 'Event cancelled',
		series: '{actorName} cancelled the recurring event “{title}” in {wgName}.',
		single: '{actorName} cancelled “{title}” on {when} in {wgName}.',
	},
	eventUpcoming: {
		title: 'Event tomorrow',
		allDay: 'Tomorrow in {wgName}: “{title}” on {when}.',
		timed: 'Tomorrow in {wgName}: “{title}”, {when}.',
	},
	eventToday: {
		title: 'Event today',
		allDay: 'Today in {wgName}: “{title}” is all day.',
		ongoing: 'Today in {wgName}: “{title}” is still on.',
		timed: 'Today in {wgName}: “{title}”, {when}.',
	},
	lowStock: {
		title: 'Supply running low',
		body: 'Running low in {wgName}: {itemName}.',
		bodyDetail: 'Running low in {wgName}: {itemName} ({quantity} of {threshold}).',
	},
	chatMessage: {
		title: 'Chat – {wgName}',
		body: '{sender}: {preview}',
	},
	chatMention: {
		title: '{sender} mentioned you',
		body: '{sender} mentioned you: {preview}',
	},
} satisfies Catalog<typeof de>;
