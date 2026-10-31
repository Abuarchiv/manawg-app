import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { wgMembers, wgs } from './wg';

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
		// in features/announcements/announcement-workflow.ts, which every insert/update
		// site validates through.
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
		memberIdx: index('announcement_reactions_member_idx').on(t.memberId),
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
		memberIdx: index('announcement_comments_member_idx').on(t.memberId),
	}),
);

export type Announcement = typeof announcements.$inferSelect;
export type AnnouncementComment = typeof announcementComments.$inferSelect;
