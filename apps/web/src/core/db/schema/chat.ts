import { relations, sql } from 'drizzle-orm';
import {
	type AnyPgColumn,
	check,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core';
import { wgMembers, wgs } from './wg';

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
		// Deleting a WG cascades over its messages and runs one ON DELETE SET NULL
		// lookup per message on this self-reference; the (wg_id, …) index above
		// cannot serve it, so every lookup would scan the whole chat table.
		replyToIdx: index('wg_chat_messages_reply_to_idx')
			.on(t.replyToMessageId)
			.where(sql`${t.replyToMessageId} IS NOT NULL`),
		senderIdx: index('wg_chat_messages_sender_idx').on(t.senderMemberId),
		// The only values ever written: 'text'/'image' in POST /chat/messages
		// and 'system' via postChatSystemMessage (see chat-pure.ts and feed-kinds.ts for
		// TEXT_MESSAGE_KIND/SYSTEM_MESSAGE_KIND).
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
		memberIdx: index('wg_chat_reactions_member_idx').on(t.memberId),
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
		// ON DELETE SET NULL lookup for every deleted chat message.
		lastReadIdx: index('wg_chat_reads_last_read_idx')
			.on(t.lastReadMessageId)
			.where(sql`${t.lastReadMessageId} IS NOT NULL`),
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
