import { relations, sql } from 'drizzle-orm';
import {
	type AnyPgColumn,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core';
import { wgMembers, wgs } from './wg';

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
		category: text('category').notNull().default('other'),
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
		// cron) already rejects amountCents <= 0 in JS.
		amountCheck: check('expenses_amount_cents_check', sql`${t.amountCents} > 0`),
		// Keep in sync with EXPENSE_CATEGORIES in features/expenses/expense-categories.ts.
		categoryCheck: check(
			'expenses_category_check',
			sql`${t.category} IN ('groceries', 'household', 'housing', 'leisure', 'transport', 'other')`,
		),
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
		// debtor's share at 0 cents (e.g. 1c over 3 debtors -> [1, 0, 0]).
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
		status: text('status').notNull().default('completed'),
		completedAt: timestamp('completed_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('expense_payments_wg_idx').on(t.wgId, t.createdAt),
		amountCheck: check('expense_payments_amount_cents_check', sql`${t.amountCents} > 0`),
		membersCheck: check(
			'expense_payments_members_check',
			sql`${t.fromMemberId} <> ${t.toMemberId}`,
		),
		statusCheck: check(
			'expense_payments_status_check',
			sql`${t.status} in ('completed', 'voided')`,
		),
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
		// the clamped result (31.01 → 28.02 → 28.03 …).
		anchorAt: timestamp('anchor_at', { withTimezone: true }).notNull(),
		lastCreatedAt: timestamp('last_created_at', { withTimezone: true }),
		pausedAt: timestamp('paused_at', { withTimezone: true }),
		splitsJson: text('splits_json').notNull(),
		category: text('category').notNull().default('other'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('recurring_expenses_wg_idx').on(t.wgId, t.nextDueAt),
		// The recurring-expense cron scans all active entries that are due.
		nextDueIdx: index('recurring_expenses_next_due_idx')
			.on(t.nextDueAt)
			.where(sql`${t.pausedAt} IS NULL`),
		amountCheck: check('recurring_expenses_amount_cents_check', sql`${t.amountCents} > 0`),
		// Keep in sync with EXPENSE_CATEGORIES in features/expenses/expense-categories.ts.
		categoryCheck: check(
			'recurring_expenses_category_check',
			sql`${t.category} IN ('groceries', 'household', 'housing', 'leisure', 'transport', 'other')`,
		),
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
		// Channels are push and in-app only.
		channelCheck: check('expense_reminders_channel_check', sql`${t.channel} in ('push', 'inapp')`),
	}),
);

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

export type Expense = typeof expenses.$inferSelect;
export type ExpenseSplit = typeof expenseSplits.$inferSelect;
export type RecurringExpense = typeof recurringExpenses.$inferSelect;
