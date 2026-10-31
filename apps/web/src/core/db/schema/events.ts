import { relations, sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core';
import { wgMembers, wgs } from './wg';

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
		// An all-day event is a date: UTC midnight, the same day on every device (eventInstant).
		allDayMidnightCheck: check(
			'wg_events_all_day_midnight_check',
			sql`NOT ${t.allDay} OR ((${t.startsAt} AT TIME ZONE 'UTC')::time = '00:00:00' AND (${t.endsAt} IS NULL OR (${t.endsAt} AT TIME ZONE 'UTC')::time = '00:00:00'))`,
		),
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
		// Foreign-key lookups when a member row is deleted (WG deletion).
		memberIdx: index('audit_events_member_idx')
			.on(t.memberId)
			.where(sql`${t.memberId} IS NOT NULL`),
	}),
);

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

export type CalendarSubscription = typeof calendarSubscriptions.$inferSelect;
