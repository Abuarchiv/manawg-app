import { useToast } from '@/components/ui/Toast';
import { useWg } from '@/components/wg/WgContextProvider';
import { apiFetch } from '@/core/infra/api-client';
import { notificationWarningMessage } from '@/core/notifications/notification-warning';
import { useVisibilityPausedInterval } from '@/core/utils/use-visibility-paused-interval';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { explainChatError } from '../chat-errors';
import { type ChatReadMarker, mergePagedMessagesById, mergePagedReactions } from '../chat-pure';
import { summarizeReactions } from '../chat-reactions';
import { CHAT_PAGE_SIZE, createChatRefresher } from '../chat-refresh';
import { type ChatMessageInput, type PendingChatSend, postChatMessage } from '../chat-send';
import type { ChatMessageDto, ChatReactionRow } from '../chat-types';
import { useChatReactions } from './use-chat-reactions';
import { useChatReadReceipt } from './use-chat-read-receipt';

export type { ChatMessageDto, ChatReactionRow } from '../chat-types';

const CHAT_POLL_INTERVAL_MS = 8000;

/**
 * Messages, reactions and read state of a WG chat: bootstrap, polling refresh, cursor
 * pagination and all mutations. Paged history does not fit a synced collection, so the refresh
 * loop lives in `createChatRefresher`, which guards every response against newer local changes.
 */
export function useChatRoom({
	wgId,
	shareCode,
	initialMessages,
	initialReactions,
}: {
	wgId: string;
	shareCode: string;
	initialMessages: ChatMessageDto[];
	initialReactions: ChatReactionRow[];
}) {
	const { identity } = useWg();
	const toast = useToast();
	const encodedShareCode = encodeURIComponent(shareCode);
	const messagesUrl = `/api/wg/${encodedShareCode}/chat/messages`;

	const [messages, setMessages] = useState<ChatMessageDto[]>(initialMessages);
	const [reactionRows, setReactionRows] = useState<ChatReactionRow[]>(initialReactions);
	const [reads, setReads] = useState<ChatReadMarker[]>([]);
	const [hasMoreOlder, setHasMoreOlder] = useState(initialMessages.length >= CHAT_PAGE_SIZE);
	const [bootstrapping, setBootstrapping] = useState(initialMessages.length === 0);
	const [bootstrapError, setBootstrapError] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [olderError, setOlderError] = useState(false);
	const [refreshError, setRefreshError] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const loadingOlderRef = useRef(false);
	const pendingSendRef = useRef<PendingChatSend['current']>(null);
	const messagesRef = useRef(messages);
	messagesRef.current = messages;

	const receipt = useChatReadReceipt({ shareCode, memberId: identity.memberId, messages });
	const reactions = useChatReactions({
		encodedShareCode,
		memberId: identity.memberId,
		setReactionRows,
	});
	const reactionTracker = reactions.tracker;

	const reactionsByMessage = useMemo(
		() => summarizeReactions(reactionRows, identity.memberId),
		[reactionRows, identity.memberId],
	);

	const refresher = useMemo(
		() =>
			createChatRefresher({
				messagesUrl,
				memberId: identity.memberId,
				fetchJson: (url, init) => apiFetch(url, init),
				getMessages: () => messagesRef.current,
				reactions: reactionTracker,
				setRefreshError,
				setMessages,
				setReactionRows,
				setHasMoreOlder,
				setReads,
			}),
		[identity.memberId, messagesUrl, reactionTracker],
	);
	const refresh = refresher.refresh;

	useVisibilityPausedInterval(() => void refresh(), wgId ? CHAT_POLL_INTERVAL_MS : null);

	// Bootstrap through the gated API when the RSC passed no messages (the server render
	// intentionally loads none, see chat/page.tsx).
	const bootstrappedRef = useRef(initialMessages.length > 0);
	const loadInitialMessages = useCallback(async () => {
		setBootstrapError(false);
		setBootstrapping(true);
		const loaded = await refresh();
		setBootstrapError(!loaded);
		setBootstrapping(false);
	}, [refresh]);
	useEffect(() => {
		if (bootstrappedRef.current) return;
		bootstrappedRef.current = true;
		void loadInitialMessages();
	}, [loadInitialMessages]);

	async function loadOlder(): Promise<void> {
		if (loadingOlderRef.current || !hasMoreOlder) return;
		const oldest = messages[0];
		if (!oldest) return;
		loadingOlderRef.current = true;
		setOlderError(false);
		setLoadingOlder(true);
		try {
			const res = await apiFetch<{ messages: ChatMessageDto[]; reactions: ChatReactionRow[] }>(
				`${messagesUrl}?limit=${CHAT_PAGE_SIZE}&before=${encodeURIComponent(oldest.createdAt)}&beforeId=${encodeURIComponent(oldest.id)}`,
				{ memberId: identity.memberId },
			);
			if (!res.ok) {
				setOlderError(true);
				return;
			}
			if (res.data.messages.length === 0) {
				setHasMoreOlder(false);
				return;
			}
			setMessages((prev) => mergePagedMessagesById(res.data.messages, prev));
			setReactionRows((prev) => mergePagedReactions(res.data.reactions, prev));
			setHasMoreOlder(res.data.messages.length >= CHAT_PAGE_SIZE);
		} finally {
			loadingOlderRef.current = false;
			setLoadingOlder(false);
		}
	}

	async function sendMessage(input: ChatMessageInput): Promise<boolean> {
		setSendError(null);
		const result = await postChatMessage(input, {
			messagesUrl,
			memberId: identity.memberId,
			pending: pendingSendRef,
		});
		if (!result.ok) {
			setSendError(
				result.reason === 'key_unavailable'
					? 'Nachricht konnte nicht sicher gesendet werden. Versuche es erneut.'
					: explainChatError('send', result.error),
			);
			return false;
		}
		const sent = result.message;
		refresher.invalidate();
		setMessages((prev) =>
			prev.some((message) => message.id === sent.id)
				? prev.map((message) => (message.id === sent.id ? sent : message))
				: [...prev, sent],
		);
		void refresh();
		const warningMessage = notificationWarningMessage(result.warning, 'Gesendet');
		if (warningMessage) toast.info(warningMessage);
		return true;
	}

	async function editMessage(messageId: string, next: string): Promise<string | null> {
		const res = await apiFetch<{ message: ChatMessageDto }>(`${messagesUrl}/${messageId}`, {
			method: 'PATCH',
			memberId: identity.memberId,
			body: JSON.stringify({ body: next }),
		});
		if (!res.ok) {
			return explainChatError('edit', res.error);
		}
		refresher.invalidate();
		const editedAt =
			typeof res.data.message.editedAt === 'string'
				? res.data.message.editedAt
				: new Date().toISOString();
		setMessages((prev) =>
			prev.map((m) => (m.id === messageId ? { ...m, body: res.data.message.body, editedAt } : m)),
		);
		return null;
	}

	async function deleteMessage(messageId: string): Promise<string | null> {
		const res = await apiFetch(`${messagesUrl}/${messageId}`, {
			method: 'DELETE',
			memberId: identity.memberId,
		});
		if (!res.ok) {
			return explainChatError('delete', res.error);
		}
		refresher.invalidate();
		setMessages((prev) =>
			prev.map((m) =>
				m.id === messageId
					? { ...m, body: null, imageUrl: null, deletedAt: new Date().toISOString() }
					: m,
			),
		);
		return null;
	}

	return {
		messages,
		reads,
		reactionsByMessage,
		hasMoreOlder,
		bootstrapping,
		bootstrapError,
		loadingOlder,
		olderError,
		refreshError,
		readError: receipt.readError,
		sendError,
		scrollRef: receipt.scrollRef,
		readSentinelRef: receipt.readSentinelRef,
		markLatestRead: receipt.markLatestRead,
		refresh,
		loadInitialMessages,
		loadOlder,
		sendMessage,
		react: reactions.react,
		unreact: reactions.unreact,
		editMessage,
		deleteMessage,
	};
}
