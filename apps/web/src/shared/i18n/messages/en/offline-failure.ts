import type { Catalog } from '../catalog';
import type de from '../de/offline-failure';

export default {
	noConnection: {
		title: 'No connection yet',
		detail: 'The action stays saved and is tried again once you are back online.',
	},
	rateLimited: {
		title: 'Too many requests',
		detail: 'The action stays in the queue and is sent again automatically in a moment.',
	},
	tooLarge: {
		title: 'Image or entry is too large',
		detail: 'Remove the attachment or choose a smaller image, then try again.',
	},
	accessMissing: {
		title: 'Access missing',
		detail: 'Open the flat again or check that your membership still has access.',
	},
	sessionExpired: {
		title: 'Session expired',
		detail: 'Sign in again, then retry the action.',
	},
	targetGone: {
		title: 'Entry not found',
		detail:
			'The entry or the flat has changed in the meantime. Check the action before trying again.',
	},
	serverNotReady: {
		title: 'Server not ready',
		detail: 'The action stays in the queue. Try again in a moment.',
	},
	syncFailed: {
		title: 'Sync failed',
		detail: 'The action stays in the queue. Try again later.',
	},
	rejected: {
		title: 'Rejected by the server',
		detail: 'The action is not sent again. Edit or discard it here.',
	},
	maintenance: {
		title: 'App under maintenance',
		detail: 'The action stays in the queue and is sent once maintenance is over.',
	},
	memberInvalid: {
		title: 'Membership no longer valid',
		detail: 'Open the flat again or join with a current invite link before you send this action.',
	},
	movedOut: {
		title: 'You have moved out',
		detail:
			'Your membership is marked as moved out in this flat. Signing in again does not help. Ask an admin to reactivate you before you send this action.',
	},
	memberInAction: {
		title: 'Check people involved',
		detail:
			'A member involved is no longer in the flat. Edit the assignment or split before sending again.',
	},
	flatLinkInvalid: {
		title: 'Flat link no longer valid',
		detail: 'Check the invite link or ask for a new one before you send this action.',
	},
	templateMissing: {
		title: 'Fixed-cost template missing',
		detail:
			'The template no longer exists. Remove this offline action or create the fixed cost again.',
	},
	recurringPaused: {
		title: 'Fixed cost paused',
		detail:
			'The fixed cost has been paused in the meantime. Remove this offline action or resume the fixed cost.',
	},
	shoppingMissing: {
		title: 'Shopping item missing',
		detail: 'The item no longer exists. Remove this offline action or add the item again.',
	},
	templateChanged: {
		title: 'Fixed-cost template changed',
		detail:
			'Someone has changed the template in the meantime. Remove this offline action and book the fixed cost with the current values.',
	},
	shoppingChanged: {
		title: 'Shopping status changed',
		detail:
			'Someone has changed the item in the meantime. Check the current state before you queue the action again.',
	},
	choreChanged: {
		title: 'Cleaning task changed',
		detail:
			'The task has been completed or reassigned in the meantime. Check the current rota before you queue the action again.',
	},
	choreMissing: {
		title: 'Cleaning rota task missing',
		detail: 'The task no longer exists. Remove this offline action or add the task again.',
	},
	expenseChanged: {
		title: 'Expense changed',
		detail:
			'Someone has changed the expense in the meantime. Check the current values before you queue the change again.',
	},
	expenseSettled: {
		title: 'Share already settled',
		detail:
			'A share has been settled in the meantime. Discard the change and edit the expense again.',
	},
	recurringAdvanced: {
		title: 'Fixed cost already booked',
		detail:
			'This fixed cost was already booked for this due date. Remove this offline action and check the expenses.',
	},
	expenseMissing: {
		title: 'Expense missing',
		detail: 'The expense no longer exists. Remove this offline action or record the expense again.',
	},
	splitMissing: {
		title: 'Expense share missing',
		detail: 'The share no longer exists. Remove this offline action or check the expense again.',
	},
	imageInvalid: {
		title: 'Check attachment',
		detail: 'Remove the attachment or choose a valid image before you send again.',
	},
	amountInvalid: {
		title: 'Check amount',
		detail: 'Edit the amount and split before you send this action again.',
	},
	currencyInvalid: {
		title: 'Check currency',
		detail: 'Record the expense again in euros.',
	},
	splitsInvalid: {
		title: 'Check split',
		detail: 'Edit the amount and split before you send this action again.',
	},
	entryInvalid: {
		title: 'Check entry',
		detail: 'Edit the highlighted fields before you send this action again.',
	},
	kindInvalid: {
		title: 'Check category',
		detail: 'Choose a current noticeboard category before you send the post again.',
	},
	sourceInvalid: {
		title: 'Check source link',
		detail: 'Remove the old source link or write the noticeboard post again.',
	},
	quantityInvalid: {
		title: 'Check quantity',
		detail: 'Shorten or remove the quantity before you send this shopping item again.',
	},
	dateInvalid: {
		title: 'Check date',
		detail: 'Edit the date or period before you send this action again.',
	},
	absenceOverlaps: {
		title: 'Time away overlaps',
		detail:
			'This person is already away in that period. Remove this offline action or adjust the period.',
	},
	actionInvalid: {
		title: 'Check offline action',
		detail:
			'The saved action no longer matches the current version of the app. Remove it and record the entry again.',
	},
	targetInvalid: {
		title: 'Check entry',
		detail:
			'The saved entry reference is not valid. Remove this offline action and open the entry again.',
	},
	statusInvalid: {
		title: 'Check status',
		detail: 'Check the shopping status before you send this action again.',
	},
	intervalInvalid: {
		title: 'Check interval',
		detail: 'Edit the interval before you send this action again.',
	},
	reasonInvalid: {
		title: 'Check reason',
		detail: 'Shorten or remove the reason for the time away before you send this action again.',
	},
	choreIncomplete: {
		title: 'Cleaning rota only partly saved',
		detail:
			'The task may have rotated but was not logged in the history. Reload the cleaning rota and check the history before you send again.',
	},
	expenseIncomplete: {
		title: 'Expense only partly saved',
		detail:
			'The expense or its split was not saved completely. Reload the expenses and check the entry before you send again.',
	},
	saveUnconfirmed: {
		title: 'Save not confirmed',
		detail:
			'The server did not confirm the entry. Reload the flat and check whether the action has already arrived.',
	},
	removeUnconfirmed: {
		title: 'Removal not confirmed',
		detail:
			'The server did not confirm the removal. Reload the flat and check the entry before you send again.',
	},
	updateUnconfirmed: {
		title: 'Update not confirmed',
		detail:
			'The server did not confirm the change. Reload the flat and check the current state before you send again.',
	},
} satisfies Catalog<typeof de>;
