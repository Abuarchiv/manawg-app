import 'server-only';

import { announcements, db, wgChatMessages } from '@/core/db';
import { logApiError } from '@/core/infra/observability';
import { SYSTEM_MESSAGE_KIND } from '@/features/chat/chat-pure';
import type { ChatSystemKind } from '@/features/chat/chat-pure';

export interface SystemNoticeInput {
	wgId: string;
	authorMemberId: string;
	kind: 'info' | 'request';
	source: 'expense' | 'shopping' | 'system';
	content: string;
	sourcePath?: string;
}

/**
 * Cross-feature system notices land on the pinnwand feed, but posting one is
 * an infrastructural side effect (like an audit event), not pinnwand business
 * logic — so it lives here in core rather than in features/pinnwand, which
 * would force every other feature to import across the feature boundary.
 *
 * Best-effort: a failure here must never undo the action that triggered it,
 * so callers don't need their own try/catch — this swallows and logs.
 */
export async function postSystemNotice(input: SystemNoticeInput): Promise<void> {
	try {
		await db.insert(announcements).values({
			wgId: input.wgId,
			authorMemberId: input.authorMemberId,
			kind: input.kind,
			source: input.source,
			sourcePath: input.sourcePath,
			content: input.content,
		});
	} catch (err) {
		logApiError('[activity-feed] system notice failed', err);
	}
}

export interface ChatSystemMessageInput {
	wgId: string;
	kind: ChatSystemKind;
	payload: Record<string, unknown>;
}

/**
 * The chat-feed counterpart of postSystemNotice, and here for the same reason:
 * nothing inside features/chat writes these — they are always another feature
 * announcing an event ("expense created") into the chat timeline. Keeping the
 * write here is what lets expenses post one without importing features/chat.
 *
 * Best-effort, like postSystemNotice: a failed system message must never undo
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
