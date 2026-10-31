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
} from 'drizzle-orm/pg-core';
import { wgMembers, wgs } from './schema';

/**
 * Ledger of transactional mails (welcome, invitation, reminder, account
 * deleted). `dedupe_key` is unique per mail that may be sent once
 * (`welcome:<authUserId>`); a row is claimed as `sending` before the provider
 * call and finished as `sent` or `failed`. Addresses are never stored, only
 * the member or account reference.
 */
export const mailLog = pgTable(
	'mail_log',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		kind: text('kind').notNull(),
		dedupeKey: text('dedupe_key').notNull(),
		wgId: uuid('wg_id').references(() => wgs.id, { onDelete: 'set null' }),
		memberId: uuid('member_id').references(() => wgMembers.id, { onDelete: 'set null' }),
		status: text('status').notNull().default('sending'),
		providerId: text('provider_id'),
		error: text('error'),
		attempts: integer('attempts').notNull().default(1),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		sentAt: timestamp('sent_at', { withTimezone: true }),
	},
	(t) => ({
		dedupeUnique: uniqueIndex('mail_log_dedupe_key_idx').on(t.dedupeKey),
		kindCreatedIdx: index('mail_log_kind_created_idx').on(t.kind, t.createdAt),
		statusCheck: check('mail_log_status_check', sql`${t.status} in ('sending', 'sent', 'failed')`),
	}),
);
