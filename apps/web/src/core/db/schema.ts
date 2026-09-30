import { relations, sql } from 'drizzle-orm';
import {
	type AnyPgColumn,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

const SHARE_CODE_LENGTH = 8;
const NAME_MAX = 80;
const TEXT_MAX = 2000;
const URL_MAX = 500;

export const privateImageDeletions = pgTable(
	'private_image_deletions',
	{
		objectKey: text('object_key').primaryKey(),
		requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
		lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
		storageDeletedAt: timestamp('storage_deleted_at', { withTimezone: true }),
	},
	(t) => ({
		cleanupIdx: index('private_image_deletions_cleanup_idx').on(
			t.requestedAt,
			t.lastAttemptAt,
			t.storageDeletedAt,
		),
	}),
);

export const accountDeletions = pgTable(
	'account_deletions',
	{
		authUserId: uuid('auth_user_id').primaryKey(),
		requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
		completedAt: timestamp('completed_at', { withTimezone: true }),
		lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
	},
	(t) => ({
		pendingAttemptIdx: index('account_deletions_pending_attempt_idx')
			.on(t.lastAttemptAt, t.requestedAt, t.authUserId)
			.where(sql`${t.completedAt} IS NULL`),
	}),
);

export const wgs = pgTable(
	'wgs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		shareCode: text('share_code').notNull(),
		name: text('name').notNull(),
		joiningEnabled: boolean('joining_enabled').notNull().default(true),
		shareCodeRotatedAt: timestamp('share_code_rotated_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		shareCodeIdx: uniqueIndex('wgs_share_code_idx').on(t.shareCode),
	}),
);

// FK policy toward wgMembers (intentional placeholder — no member-removal feature exists yet,
// only whole-WG deletion, so this is currently dead protection):
// - onDelete: 'restrict' — financial/audit tables (expenses, expenseSplits, shoppingItems,
//   announcements, choreCompletions, recurringExpenses) where losing the historical member
//   reference would corrupt records once member-removal ships.
// - onDelete: 'cascade' — tables (absences, debts, chat) whose rows are meaningless without
//   the member and can safely disappear with them.
// When implementing member removal, keep 'restrict' tables intact (reassign/soft-delete the
// member instead of hard-deleting) rather than relaxing these to 'cascade'.
export const wgMembers = pgTable(
	'wg_members',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		authUserId: uuid('auth_user_id'),
		name: text('name').notNull(),
		role: text('role').notNull().default('member'),
		color: text('color'),
		paypalMerchantId: text('paypal_merchant_id'),
		pushOptIn: boolean('push_opt_in').notNull().default(false),
		notifyAnnouncements: boolean('notify_announcements').notNull().default(true),
		notifyChores: boolean('notify_chores').notNull().default(true),
		notifyExpenses: boolean('notify_expenses').notNull().default(true),
		notifyShopping: boolean('notify_shopping').notNull().default(true),
		notifyInventory: boolean('notify_inventory').notNull().default(true),
		notifyReminders: boolean('notify_reminders').notNull().default(true),
		notifyChat: boolean('notify_chat').notNull().default(true),
		notifyEvents: boolean('notify_events').notNull().default(true),
		quietStartHour: integer('quiet_start_hour'),
		quietEndHour: integer('quiet_end_hour'),
		// Soft-delete for "Auszug" (move-out). A member who ever paid an expense,
		// owes a split, added a shopping item, wrote an announcement, completed a
		// chore, or created a recurring expense cannot be hard-deleted — six
		// RESTRICT foreign keys reference wg_members. Instead we set this
		// timestamp: the member drops out of every *active* roster (chore
		// rotation, split candidates, identity picker, dropdowns) while all
		// history and balances stay intact. NULL = active. Reversible.
		deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('wg_members_wg_idx').on(t.wgId),
		uniqueNamePerWg: uniqueIndex('wg_members_unique_name_per_wg').on(t.wgId, t.name),
		uniqueWgAuthUser: uniqueIndex('wg_members_wg_auth_user_unique_idx')
			.on(t.wgId, t.authUserId)
			.where(sql`${t.authUserId} IS NOT NULL`),
		oneAdminPerWg: uniqueIndex('wg_members_one_admin_per_wg_idx')
			.on(t.wgId)
			.where(sql`${t.role} = 'admin'`),
		roleCheck: check('wg_members_role_check', sql`${t.role} in ('admin', 'member')`),
	}),
);

export const pushSubscriptions = pgTable(
	'push_subscriptions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		memberId: uuid('member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'cascade' }),
		endpoint: text('endpoint').notNull(),
		p256dh: text('p256dh').notNull(),
		authKey: text('auth_key').notNull(),
		userAgent: text('user_agent'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		memberIdx: index('push_subscriptions_member_idx').on(t.memberId),
		endpointIdx: uniqueIndex('push_subscriptions_endpoint_idx').on(t.endpoint),
	}),
);

export const expenseImports = pgTable(
	'expense_imports',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		source: text('source').notNull(),
		importedByMemberId: uuid('imported_by_member_id').references(() => wgMembers.id, {
			onDelete: 'set null',
		}),
		rowCountTotal: integer('row_count_total').notNull().default(0),
		rowCountInserted: integer('row_count_inserted').notNull().default(0),
		rowCountSkipped: integer('row_count_skipped').notNull().default(0),
		errorCount: integer('error_count').notNull().default(0),
		rawPayloadHash: text('raw_payload_hash'),
		memberMapping: jsonb('member_mapping'),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
	},
	(t) => ({
		wgStartedIdx: index('expense_imports_wg_started_idx').on(t.wgId, t.startedAt.desc()),
		sourceCheck: check(
			'expense_imports_source_check',
			sql`${t.source} in ('splitwise_csv', 'splid_csv', 'ocr_screenshot', 'manual')`,
		),
	}),
);

export const expenses = pgTable(
	'expenses',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		paidByMemberId: uuid('paid_by_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'restrict' }),
		amountCents: integer('amount_cents').notNull(),
		currency: text('currency').notNull().default('EUR'),
		description: text('description').notNull(),
		imageUrl: text('image_url'),
		recurringExpenseId: uuid('recurring_expense_id').references(
			(): AnyPgColumn => recurringExpenses.id,
			{ onDelete: 'set null' },
		),
		recurringDueAt: timestamp('recurring_due_at', { withTimezone: true }),
		importId: uuid('import_id').references(() => expenseImports.id, { onDelete: 'set null' }),
		importDuplicateKey: text('import_duplicate_key'),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('expenses_wg_idx').on(t.wgId),
		payerIdx: index('expenses_payer_idx').on(t.paidByMemberId),
		recurringUniqueIdx: uniqueIndex('expenses_recurring_due_unique_idx')
			.on(t.recurringExpenseId, t.recurringDueAt)
			.where(sql`${t.recurringExpenseId} IS NOT NULL AND ${t.recurringDueAt} IS NOT NULL`),
		importDuplicateUniqueIdx: uniqueIndex('expenses_import_duplicate_key_unique_idx')
			.on(t.wgId, t.importDuplicateKey)
			.where(sql`${t.importDuplicateKey} IS NOT NULL`),
		importIdx: index('expenses_import_idx').on(t.importId),
		// Every write path (POST/PATCH validators, import parsers, the recurring
		// cron) already rejects amountCents <= 0 in JS. Added NOT VALID in the
		// migration — this table predates that validation, so an old row from
		// before it existed could still be 0 or negative — new writes are
		// checked immediately either way.
		amountCheck: check('expenses_amount_cents_check', sql`${t.amountCents} > 0`),
	}),
);

export const expenseSplits = pgTable(
	'expense_splits',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		expenseId: uuid('expense_id')
			.notNull()
			.references(() => expenses.id, { onDelete: 'cascade' }),
		debtorMemberId: uuid('debtor_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'restrict' }),
		amountCents: integer('amount_cents').notNull(),
		settledAt: timestamp('settled_at', { withTimezone: true }),
	},
	(t) => ({
		expenseIdx: index('expense_splits_expense_idx').on(t.expenseId),
		debtorIdx: index('expense_splits_debtor_idx').on(t.debtorMemberId),
		// >= 0 (not > 0): a Hamilton-distributed split can legitimately land a
		// debtor's share at 0 cents (e.g. 1c over 3 debtors -> [1, 0, 0]). Added
		// NOT VALID — see the amount_cents_check comment on `expenses` above for
		// why pre-existing rows aren't force-validated here.
		amountCheck: check('expense_splits_amount_cents_check', sql`${t.amountCents} >= 0`),
	}),
);

export const expensePayments = pgTable(
	'expense_payments',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		fromMemberId: uuid('from_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'restrict' }),
		toMemberId: uuid('to_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'restrict' }),
		amountCents: integer('amount_cents').notNull(),
		currency: text('currency').notNull().default('EUR'),
		provider: text('provider').notNull().default('paypal'),
		providerOrderId: text('provider_order_id').notNull(),
		payeeMerchantId: text('payee_merchant_id').notNull(),
		status: text('status').notNull().default('created'),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		completedAt: timestamp('completed_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('expense_payments_wg_idx').on(t.wgId, t.createdAt),
		orderIdx: uniqueIndex('expense_payments_provider_order_idx').on(t.providerOrderId),
		activePairIdx: uniqueIndex('expense_payments_active_pair_idx')
			.on(t.wgId, t.fromMemberId, t.toMemberId)
			.where(sql`${t.status} in ('created', 'capturing')`),
		amountCheck: check('expense_payments_amount_cents_check', sql`${t.amountCents} > 0`),
		membersCheck: check(
			'expense_payments_members_check',
			sql`${t.fromMemberId} <> ${t.toMemberId}`,
		),
		providerCheck: check('expense_payments_provider_check', sql`${t.provider} = 'paypal'`),
		statusCheck: check(
			'expense_payments_status_check',
			sql`${t.status} in ('created', 'capturing', 'completed', 'failed')`,
		),
	}),
);

export const shoppingItems = pgTable(
	'shopping_items',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		addedByMemberId: uuid('added_by_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'restrict' }),
		name: text('name').notNull(),
		normalizedName: text('normalized_name').notNull().generatedAlwaysAs(sql`lower(btrim(name))`),
		quantity: text('quantity'),
		boughtAt: timestamp('bought_at', { withTimezone: true }),
		boughtByMemberId: uuid('bought_by_member_id').references(() => wgMembers.id, {
			onDelete: 'set null',
		}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('shopping_items_wg_idx').on(t.wgId),
		openIdx: index('shopping_items_open_idx').on(t.wgId, t.boughtAt),
		uniqueOpenName: uniqueIndex('shopping_items_unique_open_name')
			.on(t.wgId, t.normalizedName)
			.where(sql`${t.boughtAt} IS NULL`),
	}),
);

export const announcements = pgTable(
	'announcements',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		authorMemberId: uuid('author_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'restrict' }),
		content: text('content').notNull(),
		imageUrl: text('image_url'),
		kind: text('kind').notNull().default('info'),
		status: text('status').notNull().default('open'),
		source: text('source').notNull().default('manual'),
		sourcePath: text('source_path'),
		pinnedAt: timestamp('pinned_at', { withTimezone: true }),
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		resolvedByMemberId: uuid('resolved_by_member_id').references(() => wgMembers.id, {
			onDelete: 'set null',
		}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('announcements_wg_idx').on(t.wgId, t.createdAt),
		pinnedIdx: index('announcements_pinned_idx').on(t.wgId, t.pinnedAt),
		statusIdx: index('announcements_status_idx').on(t.wgId, t.status),
		// Values mirror ANNOUNCEMENT_KINDS / ANNOUNCEMENT_STATUS / ANNOUNCEMENT_SOURCES
		// in lib/announcement-workflow.ts, which every insert/update site already
		// validates through. Added NOT VALID: this table predates that shared
		// module, so an older row could carry a value dropped since then; new
		// writes are checked immediately either way.
		kindCheck: check(
			'announcements_kind_check',
			sql`${t.kind} in ('info', 'question', 'problem', 'request', 'decision')`,
		),
		statusCheck: check('announcements_status_check', sql`${t.status} in ('open', 'resolved')`),
		sourceCheck: check(
			'announcements_source_check',
			sql`${t.source} in ('manual', 'system', 'chore_swap', 'expense', 'shopping')`,
		),
	}),
);

export const announcementReactions = pgTable(
	'announcement_reactions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		announcementId: uuid('announcement_id')
			.notNull()
			.references(() => announcements.id, { onDelete: 'cascade' }),
		memberId: uuid('member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'cascade' }),
		reaction: text('reaction').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		announcementIdx: index('announcement_reactions_announcement_idx').on(t.announcementId),
		uniqueMemberReaction: uniqueIndex('announcement_reactions_unique_member_reaction').on(
			t.announcementId,
			t.memberId,
			t.reaction,
		),
	}),
);

export const announcementComments = pgTable(
	'announcement_comments',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		announcementId: uuid('announcement_id')
			.notNull()
			.references(() => announcements.id, { onDelete: 'cascade' }),
		memberId: uuid('member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'cascade' }),
		content: text('content').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		announcementIdx: index('announcement_comments_announcement_idx').on(
			t.announcementId,
			t.createdAt,
		),
	}),
);

export const chores = pgTable(
	'chores',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		intervalDays: integer('interval_days').notNull().default(7),
		// 'days' = legacy ms-based cadence; 'months' = calendar-month cadence
		// (no 5-day drift over a year). Default 'days' keeps existing rows on
		// their current cadence after the column is added in migration 0011.
		// $type<> narrows the column from raw string → ChoreRecurrenceType so
		// callers don't need to cast on every read.
		recurrenceType: varchar('recurrence_type', { length: 10 })
			.$type<'days' | 'months'>()
			.notNull()
			.default('days'),
		nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull().defaultNow(),
		// Monthly-cadence anchor, see recurring_expenses.anchor_at.
		anchorAt: timestamp('anchor_at', { withTimezone: true }),
		assignedMemberId: uuid('assigned_member_id').references(() => wgMembers.id, {
			onDelete: 'set null',
		}),
		lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('chores_wg_idx').on(t.wgId, t.nextDueAt),
		// Mirrors CHORE_RECURRENCE_TYPES below — every write goes through a zod
		// enum of the same two values, and the column has always defaulted to
		// 'days'. Added NOT VALID out of caution for any row from before that
		// zod validation existed; new writes are checked immediately either way.
		recurrenceTypeCheck: check(
			'chores_recurrence_type_check',
			sql`${t.recurrenceType} in ('days', 'months')`,
		),
	}),
);

export const choreCompletions = pgTable(
	'chore_completions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		choreId: uuid('chore_id')
			.notNull()
			.references(() => chores.id, { onDelete: 'cascade' }),
		completedByMemberId: uuid('completed_by_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'restrict' }),
		completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		choreIdx: index('chore_completions_chore_idx').on(t.choreId, t.completedAt),
	}),
);

export const memberAbsences = pgTable(
	'member_absences',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		memberId: uuid('member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'cascade' }),
		startDate: timestamp('start_date', { withTimezone: true }).notNull(),
		endDate: timestamp('end_date', { withTimezone: true }).notNull(),
		reason: text('reason'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('member_absences_wg_idx').on(t.wgId, t.startDate, t.endDate),
		memberIdx: index('member_absences_member_idx').on(t.memberId, t.startDate, t.endDate),
	}),
);

export const recurringExpenses = pgTable(
	'recurring_expenses',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		createdByMemberId: uuid('created_by_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'restrict' }),
		paidByMemberId: uuid('paid_by_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'restrict' }),
		description: text('description').notNull(),
		amountCents: integer('amount_cents').notNull(),
		intervalMonths: integer('interval_months').notNull().default(1),
		nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull(),
		// Original due date the monthly cadence anchors to. Monthly advances
		// keep this day-of-month (31. → 28.02 → 31.03) instead of chaining from
		// the clamped result (31.01 → 28.02 → 28.03 …). Null on legacy rows;
		// adopted from nextDueAt on the first advance after deploy.
		anchorAt: timestamp('anchor_at', { withTimezone: true }),
		lastCreatedAt: timestamp('last_created_at', { withTimezone: true }),
		pausedAt: timestamp('paused_at', { withTimezone: true }),
		splitsJson: text('splits_json').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('recurring_expenses_wg_idx').on(t.wgId, t.nextDueAt),
		amountCheck: check('recurring_expenses_amount_cents_check', sql`${t.amountCents} > 0`),
	}),
);

export const wgEvents = pgTable(
	'wg_events',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		description: text('description'),
		startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
		endsAt: timestamp('ends_at', { withTimezone: true }),
		allDay: boolean('all_day').notNull().default(false),
		location: text('location'),
		recurrence: text('recurrence'),
		createdByMemberId: uuid('created_by_member_id').references(() => wgMembers.id, {
			onDelete: 'set null',
		}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('wg_events_wg_idx').on(t.wgId),
		wgStartsIdx: index('wg_events_wg_starts_idx').on(t.wgId, t.startsAt),
		startsIdx: index('wg_events_starts_idx').on(t.startsAt),
	}),
);

export const calendarSubscriptions = pgTable(
	'calendar_subscriptions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		memberId: uuid('member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'cascade' }),
		// The bearer token is derived from this random seed and the server secret;
		// the usable token never sits in the database.
		tokenSeed: text('token_seed').notNull(),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgMemberIdx: uniqueIndex('calendar_subscriptions_wg_member_idx').on(t.wgId, t.memberId),
	}),
);

export const wgInventoryItems = pgTable(
	'wg_inventory_items',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		quantity: integer('quantity').notNull().default(0),
		unit: text('unit').notNull().default('Stück'),
		threshold: integer('threshold').notNull().default(1),
		category: text('category').notNull().default('sonstiges'),
		lastDecrementedAt: timestamp('last_decremented_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('wg_inventory_items_wg_idx').on(t.wgId),
		recentDecrementIdx: index('wg_inventory_items_recent_decrement_idx').on(
			t.wgId,
			t.lastDecrementedAt,
		),
	}),
);

export const wgInventoryLog = pgTable(
	'wg_inventory_log',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => wgInventoryItems.id, { onDelete: 'cascade' }),
		memberId: uuid('member_id').references(() => wgMembers.id, { onDelete: 'set null' }),
		delta: integer('delta').notNull(),
		kind: text('kind').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		itemIdx: index('wg_inventory_log_item_idx').on(t.itemId, t.createdAt),
	}),
);

export const expenseReminders = pgTable(
	'expense_reminders',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		debtorMemberId: uuid('debtor_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'cascade' }),
		creditorMemberId: uuid('creditor_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'cascade' }),
		amountCents: integer('amount_cents').notNull(),
		currency: text('currency').notNull().default('EUR'),
		sentByMemberId: uuid('sent_by_member_id').references(() => wgMembers.id, {
			onDelete: 'set null',
		}),
		channel: text('channel').notNull().default('push'),
		message: text('message'),
		oldestDebtAgeDays: integer('oldest_debt_age_days').notNull().default(0),
		sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('expense_reminders_wg_idx').on(t.wgId, t.sentAt.desc()),
		debtorIdx: index('expense_reminders_debtor_idx').on(t.wgId, t.debtorMemberId, t.sentAt.desc()),
		pairIdx: index('expense_reminders_pair_idx').on(
			t.wgId,
			t.debtorMemberId,
			t.creditorMemberId,
			t.sentAt.desc(),
		),
		amountCheck: check('expense_reminders_amount_cents_check', sql`${t.amountCents} >= 0`),
		// 'telegram' was dropped with the Telegram integration; the table is empty,
		// so the narrower check costs nothing.
		channelCheck: check('expense_reminders_channel_check', sql`${t.channel} in ('push', 'inapp')`),
	}),
);

export const auditEvents = pgTable(
	'audit_events',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		memberId: uuid('member_id').references(() => wgMembers.id, { onDelete: 'set null' }),
		eventType: text('event_type').notNull(),
		entityType: text('entity_type').notNull(),
		entityId: text('entity_id'),
		summary: text('summary').notNull(),
		metadataJson: text('metadata_json'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('audit_events_wg_idx').on(t.wgId, t.createdAt),
		entityIdx: index('audit_events_entity_idx').on(t.entityType, t.entityId),
	}),
);

export const wgChatMessages = pgTable(
	'wg_chat_messages',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		senderMemberId: uuid('sender_member_id').references(() => wgMembers.id, {
			onDelete: 'cascade',
		}),
		kind: text('kind').notNull(),
		body: text('body'),
		imageUrl: text('image_url'),
		systemKind: text('system_kind'),
		systemPayload: jsonb('system_payload'),
		replyToMessageId: uuid('reply_to_message_id').references((): AnyPgColumn => wgChatMessages.id, {
			onDelete: 'set null',
		}),
		editedAt: timestamp('edited_at', { withTimezone: true }),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgCreatedIdx: index('wg_chat_messages_wg_created_idx').on(t.wgId, t.createdAt),
		replyIdx: index('wg_chat_messages_reply_idx').on(t.wgId, t.replyToMessageId),
		// The only values ever written: 'text'/'image' in POST /chat/messages
		// and 'system' via appendSystemMessage (see chat-pure.ts's
		// TEXT_MESSAGE_KIND/SYSTEM_MESSAGE_KIND). Added NOT VALID out of caution
		// for any pre-existing row; new writes are checked immediately either way.
		kindCheck: check('wg_chat_messages_kind_check', sql`${t.kind} in ('text', 'image', 'system')`),
	}),
);

export const wgChatReactions = pgTable(
	'wg_chat_reactions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		messageId: uuid('message_id')
			.notNull()
			.references(() => wgChatMessages.id, { onDelete: 'cascade' }),
		memberId: uuid('member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'cascade' }),
		emoji: text('emoji').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		uniqueReaction: uniqueIndex('wg_chat_reactions_unique_idx').on(
			t.messageId,
			t.memberId,
			t.emoji,
		),
		messageIdx: index('wg_chat_reactions_message_idx').on(t.messageId),
	}),
);

export const wgChatReads = pgTable(
	'wg_chat_reads',
	{
		wgId: uuid('wg_id')
			.notNull()
			.references(() => wgs.id, { onDelete: 'cascade' }),
		memberId: uuid('member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'cascade' }),
		lastReadMessageId: uuid('last_read_message_id').references(() => wgChatMessages.id, {
			onDelete: 'set null',
		}),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.wgId, t.memberId] }),
		memberIdx: index('wg_chat_reads_member_idx').on(t.memberId),
	}),
);

export const wgChatMentions = pgTable(
	'wg_chat_mentions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		messageId: uuid('message_id')
			.notNull()
			.references(() => wgChatMessages.id, { onDelete: 'cascade' }),
		mentionedMemberId: uuid('mentioned_member_id')
			.notNull()
			.references(() => wgMembers.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		memberIdx: index('wg_chat_mentions_member_idx').on(t.mentionedMemberId, t.createdAt),
		messageIdx: index('wg_chat_mentions_message_idx').on(t.messageId),
	}),
);

export const wgsRelations = relations(wgs, ({ many }) => ({
	members: many(wgMembers),
	expenses: many(expenses),
	expensePayments: many(expensePayments),
	shoppingItems: many(shoppingItems),
	announcements: many(announcements),
	chores: many(chores),
	wgEvents: many(wgEvents),
	inventoryItems: many(wgInventoryItems),
	auditEvents: many(auditEvents),
	expenseReminders: many(expenseReminders),
	chatMessages: many(wgChatMessages),
	calendarSubscriptions: many(calendarSubscriptions),
}));

export const expenseRemindersRelations = relations(expenseReminders, ({ one }) => ({
	wg: one(wgs, { fields: [expenseReminders.wgId], references: [wgs.id] }),
	debtor: one(wgMembers, {
		fields: [expenseReminders.debtorMemberId],
		references: [wgMembers.id],
		relationName: 'reminderDebtor',
	}),
	creditor: one(wgMembers, {
		fields: [expenseReminders.creditorMemberId],
		references: [wgMembers.id],
		relationName: 'reminderCreditor',
	}),
	sentBy: one(wgMembers, {
		fields: [expenseReminders.sentByMemberId],
		references: [wgMembers.id],
		relationName: 'reminderSentBy',
	}),
}));

export const wgEventsRelations = relations(wgEvents, ({ one }) => ({
	wg: one(wgs, { fields: [wgEvents.wgId], references: [wgs.id] }),
	createdBy: one(wgMembers, {
		fields: [wgEvents.createdByMemberId],
		references: [wgMembers.id],
	}),
}));

export const calendarSubscriptionsRelations = relations(calendarSubscriptions, ({ one }) => ({
	wg: one(wgs, { fields: [calendarSubscriptions.wgId], references: [wgs.id] }),
	member: one(wgMembers, { fields: [calendarSubscriptions.memberId], references: [wgMembers.id] }),
}));

export const wgInventoryItemsRelations = relations(wgInventoryItems, ({ one, many }) => ({
	wg: one(wgs, { fields: [wgInventoryItems.wgId], references: [wgs.id] }),
	logs: many(wgInventoryLog),
}));

export const wgInventoryLogRelations = relations(wgInventoryLog, ({ one }) => ({
	item: one(wgInventoryItems, {
		fields: [wgInventoryLog.itemId],
		references: [wgInventoryItems.id],
	}),
	member: one(wgMembers, {
		fields: [wgInventoryLog.memberId],
		references: [wgMembers.id],
	}),
}));

export const wgChatMessagesRelations = relations(wgChatMessages, ({ one, many }) => ({
	wg: one(wgs, { fields: [wgChatMessages.wgId], references: [wgs.id] }),
	sender: one(wgMembers, {
		fields: [wgChatMessages.senderMemberId],
		references: [wgMembers.id],
	}),
	replyTo: one(wgChatMessages, {
		fields: [wgChatMessages.replyToMessageId],
		references: [wgChatMessages.id],
		relationName: 'wgChatMessageReply',
	}),
	replies: many(wgChatMessages, { relationName: 'wgChatMessageReply' }),
	reactions: many(wgChatReactions),
	mentions: many(wgChatMentions),
}));

export const wgChatReactionsRelations = relations(wgChatReactions, ({ one }) => ({
	message: one(wgChatMessages, {
		fields: [wgChatReactions.messageId],
		references: [wgChatMessages.id],
	}),
	member: one(wgMembers, {
		fields: [wgChatReactions.memberId],
		references: [wgMembers.id],
	}),
}));

export const wgChatReadsRelations = relations(wgChatReads, ({ one }) => ({
	wg: one(wgs, { fields: [wgChatReads.wgId], references: [wgs.id] }),
	member: one(wgMembers, { fields: [wgChatReads.memberId], references: [wgMembers.id] }),
	lastReadMessage: one(wgChatMessages, {
		fields: [wgChatReads.lastReadMessageId],
		references: [wgChatMessages.id],
	}),
}));

export const wgChatMentionsRelations = relations(wgChatMentions, ({ one }) => ({
	message: one(wgChatMessages, {
		fields: [wgChatMentions.messageId],
		references: [wgChatMessages.id],
	}),
	member: one(wgMembers, {
		fields: [wgChatMentions.mentionedMemberId],
		references: [wgMembers.id],
	}),
}));

export const wgMembersRelations = relations(wgMembers, ({ one, many }) => ({
	wg: one(wgs, { fields: [wgMembers.wgId], references: [wgs.id] }),
	paidExpenses: many(expenses),
	debts: many(expenseSplits),
	expensePaymentsFrom: many(expensePayments, { relationName: 'paymentFrom' }),
	expensePaymentsTo: many(expensePayments, { relationName: 'paymentTo' }),
	pushSubscriptions: many(pushSubscriptions),
	calendarSubscriptions: many(calendarSubscriptions),
}));

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
	member: one(wgMembers, {
		fields: [pushSubscriptions.memberId],
		references: [wgMembers.id],
	}),
}));

export const expensesRelations = relations(expenses, ({ one, many }) => ({
	wg: one(wgs, { fields: [expenses.wgId], references: [wgs.id] }),
	paidBy: one(wgMembers, {
		fields: [expenses.paidByMemberId],
		references: [wgMembers.id],
	}),
	import: one(expenseImports, {
		fields: [expenses.importId],
		references: [expenseImports.id],
	}),
	splits: many(expenseSplits),
}));

export const expenseImportsRelations = relations(expenseImports, ({ one, many }) => ({
	wg: one(wgs, { fields: [expenseImports.wgId], references: [wgs.id] }),
	importedBy: one(wgMembers, {
		fields: [expenseImports.importedByMemberId],
		references: [wgMembers.id],
	}),
	expenses: many(expenses),
}));

export const expenseSplitsRelations = relations(expenseSplits, ({ one }) => ({
	expense: one(expenses, {
		fields: [expenseSplits.expenseId],
		references: [expenses.id],
	}),
	debtor: one(wgMembers, {
		fields: [expenseSplits.debtorMemberId],
		references: [wgMembers.id],
	}),
}));

export const expensePaymentsRelations = relations(expensePayments, ({ one }) => ({
	wg: one(wgs, { fields: [expensePayments.wgId], references: [wgs.id] }),
	fromMember: one(wgMembers, {
		fields: [expensePayments.fromMemberId],
		references: [wgMembers.id],
		relationName: 'paymentFrom',
	}),
	toMember: one(wgMembers, {
		fields: [expensePayments.toMemberId],
		references: [wgMembers.id],
		relationName: 'paymentTo',
	}),
}));

export type Wg = typeof wgs.$inferSelect;
export type NewWg = typeof wgs.$inferInsert;
export type WgMember = typeof wgMembers.$inferSelect;
export type NewWgMember = typeof wgMembers.$inferInsert;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
export type ExpenseSplit = typeof expenseSplits.$inferSelect;
export type NewExpenseSplit = typeof expenseSplits.$inferInsert;
export type ExpensePayment = typeof expensePayments.$inferSelect;
export type NewExpensePayment = typeof expensePayments.$inferInsert;
export type ExpenseImport = typeof expenseImports.$inferSelect;
export type NewExpenseImport = typeof expenseImports.$inferInsert;
export type ShoppingItem = typeof shoppingItems.$inferSelect;
export type Announcement = typeof announcements.$inferSelect;
export type AnnouncementReaction = typeof announcementReactions.$inferSelect;
export type AnnouncementComment = typeof announcementComments.$inferSelect;
export type Chore = typeof chores.$inferSelect;
// Calendar-aware recurrence cadence for chores. 'days' = ms-based arithmetic
// (legacy default); 'months' = Date.setMonth() so 12-month chores land on the
// exact same calendar day each year instead of drifting ~5 days off.
export const idempotencyResponses = pgTable(
	'idempotency_responses',
	{
		scope: text('scope').notNull(),
		key: text('key').notNull(),
		responseBody: jsonb('response_body').notNull(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		pk: primaryKey({ columns: [t.scope, t.key] }),
		expiresIdx: index('idempotency_responses_expires_idx').on(t.expiresAt),
	}),
);
export type IdempotencyResponse = typeof idempotencyResponses.$inferSelect;
export type NewIdempotencyResponse = typeof idempotencyResponses.$inferInsert;

// Declared as a tuple (not readonly array) so `z.enum(CHORE_RECURRENCE_TYPES)`
// type-checks — zod requires `[string, ...string[]]`.
export const CHORE_RECURRENCE_TYPES = ['days', 'months'] as const;
export type ChoreRecurrenceType = (typeof CHORE_RECURRENCE_TYPES)[number];
export type MemberAbsence = typeof memberAbsences.$inferSelect;
export type RecurringExpense = typeof recurringExpenses.$inferSelect;
export type WgEvent = typeof wgEvents.$inferSelect;
export type NewWgEvent = typeof wgEvents.$inferInsert;
export type CalendarSubscription = typeof calendarSubscriptions.$inferSelect;
export type NewCalendarSubscription = typeof calendarSubscriptions.$inferInsert;
export type WgInventoryItem = typeof wgInventoryItems.$inferSelect;
export type NewWgInventoryItem = typeof wgInventoryItems.$inferInsert;
export type WgInventoryLogEntry = typeof wgInventoryLog.$inferSelect;
export type NewWgInventoryLogEntry = typeof wgInventoryLog.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type ExpenseReminder = typeof expenseReminders.$inferSelect;
export type NewExpenseReminder = typeof expenseReminders.$inferInsert;
export type WgChatMessage = typeof wgChatMessages.$inferSelect;
export type NewWgChatMessage = typeof wgChatMessages.$inferInsert;
export type WgChatReaction = typeof wgChatReactions.$inferSelect;
export type NewWgChatReaction = typeof wgChatReactions.$inferInsert;
export type WgChatRead = typeof wgChatReads.$inferSelect;
export type NewWgChatRead = typeof wgChatReads.$inferInsert;
export type WgChatMention = typeof wgChatMentions.$inferSelect;
export type NewWgChatMention = typeof wgChatMentions.$inferInsert;

export const LIMITS = {
	SHARE_CODE_LENGTH,
	NAME_MAX,
	TEXT_MAX,
	URL_MAX,
} as const;
