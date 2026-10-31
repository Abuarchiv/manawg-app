import { relations, sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core';

export const wgs = pgTable(
	'wgs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		shareCode: text('share_code').notNull(),
		name: text('name').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		shareCodeIdx: uniqueIndex('wgs_share_code_idx').on(t.shareCode),
	}),
);

// FK policy toward wgMembers: 'restrict' on the financial and audit tables (expenses, splits,
// shopping items, announcements, chore completions, recurring expenses) keeps history intact, so
// members leave through deactivated_at ("Auszug") and are never deleted; 'cascade' on tables
// (absences, debts, chat) whose rows mean nothing without the member.
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
		pushOptIn: boolean('push_opt_in').notNull().default(false),
		notifyAnnouncements: boolean('notify_announcements').notNull().default(true),
		notifyChores: boolean('notify_chores').notNull().default(true),
		notifyExpenses: boolean('notify_expenses').notNull().default(true),
		notifyShopping: boolean('notify_shopping').notNull().default(true),
		notifyInventory: boolean('notify_inventory').notNull().default(true),
		notifyReminders: boolean('notify_reminders').notNull().default(true),
		notifyChat: boolean('notify_chat').notNull().default(true),
		notifyEvents: boolean('notify_events').notNull().default(true),
		notifyStatementEmail: boolean('notify_statement_email').notNull().default(true),
		quietStartHour: integer('quiet_start_hour'),
		quietEndHour: integer('quiet_end_hour'),
		locale: text('locale').notNull().default('de'),
		// Soft-delete for "Auszug" (move-out). A member who ever paid an expense, owes a
		// split, added a shopping item, wrote an announcement, completed a chore, or
		// created a recurring expense cannot be hard-deleted — six RESTRICT foreign keys
		// reference wg_members. Instead this timestamp is set: the member drops out of every
		// *active* roster (chore rotation, split candidates, identity picker, dropdowns)
		// while all history and balances stay intact. NULL = active. Reversible.
		deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => ({
		wgIdx: index('wg_members_wg_idx').on(t.wgId),
		uniqueNamePerWg: uniqueIndex('wg_members_unique_name_per_wg').on(t.wgId, t.name),
		uniqueWgAuthUser: uniqueIndex('wg_members_wg_auth_user_unique_idx')
			.on(t.wgId, t.authUserId)
			.where(sql`${t.authUserId} IS NOT NULL`),
		// "Which WGs is this account in?" (`/api/wg/mine`, account deletion)
		// filters on the auth user alone, without a WG.
		authUserIdx: index('wg_members_auth_user_idx')
			.on(t.authUserId)
			.where(sql`${t.authUserId} IS NOT NULL`),
		oneAdminPerWg: uniqueIndex('wg_members_one_admin_per_wg_idx')
			.on(t.wgId)
			.where(sql`${t.role} = 'admin'`),
		roleCheck: check('wg_members_role_check', sql`${t.role} in ('admin', 'member')`),
		localeCheck: check('wg_members_locale_check', sql`${t.locale} in ('de', 'en')`),
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
		// One browser endpoint may serve the same account in several WGs, so the
		// subscription is unique per member, not per endpoint. Foreign accounts are
		// kept off a shared endpoint by the subscribe route.
		memberEndpointUnique: uniqueIndex('push_subscriptions_member_endpoint_idx').on(
			t.memberId,
			t.endpoint,
		),
		endpointIdx: index('push_subscriptions_endpoint_lookup_idx').on(t.endpoint),
	}),
);

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
	member: one(wgMembers, {
		fields: [pushSubscriptions.memberId],
		references: [wgMembers.id],
	}),
}));

export type WgMember = typeof wgMembers.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
