import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
