import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';
import { wgMembers, wgs } from './wg';

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
		addedByIdx: index('shopping_items_added_by_idx').on(t.addedByMemberId),
		uniqueOpenName: uniqueIndex('shopping_items_unique_open_name')
			.on(t.wgId, t.normalizedName)
			.where(sql`${t.boughtAt} IS NULL`),
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
		// 'days' = fixed day count; 'months' = calendar months (no drift over a year).
		recurrenceType: varchar('recurrence_type', { length: 10 })
			.$type<'days' | 'months'>()
			.notNull()
			.default('days'),
		nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull().defaultNow(),
		// Monthly-cadence anchor, see recurring_expenses.anchor_at.
		anchorAt: timestamp('anchor_at', { withTimezone: true }).notNull(),
		assignedMemberId: uuid('assigned_member_id').references(() => wgMembers.id, {
			onDelete: 'set null',
		}),
		lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('chores_wg_idx').on(t.wgId, t.nextDueAt),
		// The reminder cron scans every WG's chores due in a window.
		nextDueIdx: index('chores_next_due_idx').on(t.nextDueAt),
		// Mirrors CHORE_RECURRENCE_TYPES; every write goes through a zod enum of the same two values.
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
		completedByIdx: index('chore_completions_completed_by_idx').on(t.completedByMemberId),
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

export type ShoppingItem = typeof shoppingItems.$inferSelect;
export type Chore = typeof chores.$inferSelect;
// Declared as a tuple (not readonly array) so `z.enum(CHORE_RECURRENCE_TYPES)`
// type-checks — zod requires `[string, ...string[]]`.
export const CHORE_RECURRENCE_TYPES = ['days', 'months'] as const;
export type ChoreRecurrenceType = (typeof CHORE_RECURRENCE_TYPES)[number];
