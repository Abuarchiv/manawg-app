import 'server-only';

import { db, wgChatMessages } from '@/core/db';
import { type ChatSystemKind, SYSTEM_MESSAGE_KIND } from '@/core/feed-kinds';
import { logApiError } from '@/core/infra/observability';

export interface ChatSystemMessageInput {
	wgId: string;
	kind: ChatSystemKind;
	payload: Record<string, unknown>;
}

/**
 * Lives in core because nothing inside features/chat writes these — they are always another feature
 * announcing an event ("expense created") into the chat timeline. Keeping the
 * write here is what lets expenses post one without importing features/chat.
 *
 * Best-effort: a failed system message must never undo
 * the action that triggered it, so callers need no try/catch of their own.
 */
export async function postChatSystemMessage(input: ChatSystemMessageInput): Promise<void> {
	try {
		await db.insert(wgChatMessages).values({
			wgId: input.wgId,
			senderMemberId: null,
			kind: SYSTEM_MESSAGE_KIND,
			systemKind: input.kind,
			systemPayload: input.payload,
		});
	} catch (err) {
		logApiError('[activity-feed] chat system message failed', err);
	}
}
