import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Guard for the read-marker upsert: only move the marker forward, comparing
 * by message timestamp with the id as tiebreaker.
 *
 * A `null` marker must never reach this filter — `${candidate} is not null`
 * made `onConflictDoUpdate` match zero rows while the route answered
 * `{ ok: true }`. The caller (chat/read route) branches on `null` and resets
 * with an unconditional statement instead, so the candidate id is typed as
 * required here.
 */
export function buildChatReadMarkerSetWhere(
	candidateMessageId: string,
	currentMessageId: AnyPgColumn,
) {
	const candidateCreatedAt = sql`(
		select candidate.created_at
		from wg_chat_messages candidate
		where candidate.id = ${candidateMessageId}::uuid
	)`;
	const currentCreatedAt = sql`coalesce(
		(select current_read.created_at
		 from wg_chat_messages current_read
		 where current_read.id = ${currentMessageId}),
		'-infinity'::timestamptz
	)`;

	return sql`
		(
			${currentMessageId} is null
			or ${candidateCreatedAt} > ${currentCreatedAt}
			or (
				${candidateCreatedAt} = ${currentCreatedAt}
				and ${candidateMessageId}::uuid > ${currentMessageId}
			)
		)
	`;
}
