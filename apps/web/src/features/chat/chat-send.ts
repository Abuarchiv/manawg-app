import { apiFetch } from '@/core/infra/api-client';
import type { NotificationWarning } from '@/core/notifications/notification-warning';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import type { ChatMessageDto } from './chat-types';

export interface ChatMessageInput {
	body: string;
	mentionMemberIds: string[];
	replyToMessageId: string | null;
	/** Set for photo messages; the text may then be empty. */
	imageUrl?: string;
}

/** The key of a send whose outcome is unknown; a retry of the same input reuses it. */
export interface PendingChatSend {
	current: { fingerprint: string; key: string } | null;
}

export type ChatSendResult =
	| { ok: true; message: ChatMessageDto; warning: NotificationWarning }
	| { ok: false; reason: 'key_unavailable' }
	| { ok: false; reason: 'rejected'; error: string };

interface ChatSendDeps {
	messagesUrl: string;
	memberId: string;
	pending: PendingChatSend;
	createKey?: () => string | null;
}

/**
 * Posts a chat message under an idempotency key. A response that never arrived (status 0) or a
 * server error keeps the key, so sending the same text again cannot create a second message.
 */
export async function postChatMessage(
	input: ChatMessageInput,
	{ messagesUrl, memberId, pending, createKey = createOfflineIdempotencyKey }: ChatSendDeps,
): Promise<ChatSendResult> {
	const fingerprint = JSON.stringify(input);
	const pendingRequest = pending.current;
	const idempotencyKey =
		pendingRequest?.fingerprint === fingerprint ? pendingRequest.key : createKey();
	if (!idempotencyKey) return { ok: false, reason: 'key_unavailable' };
	pending.current = { fingerprint, key: idempotencyKey };
	const res = await apiFetch<{ message: ChatMessageDto; warning: NotificationWarning }>(
		messagesUrl,
		{
			method: 'POST',
			memberId,
			headers: { 'Idempotency-Key': idempotencyKey },
			body: JSON.stringify(input),
		},
	);
	if (!res.ok) {
		if (res.status > 0 && res.status < 500) pending.current = null;
		return { ok: false, reason: 'rejected', error: res.error };
	}
	pending.current = null;
	return { ok: true, message: res.data.message, warning: res.data.warning };
}
