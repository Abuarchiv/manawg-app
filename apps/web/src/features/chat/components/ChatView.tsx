'use client';

import { useToast } from '@/components/ui/Toast';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty';
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Spinner } from '@/components/ui/spinner';
import { useWg } from '@/components/wg/WgContextProvider';
import { notifyChatReadConfirmed } from '@/components/wg/useWgCounts';
import { apiFetch } from '@/core/infra/api-client';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import { haptic } from '@/shared/lib/haptics';
import { ChevronDown, MessageCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatChannel } from '../chat-channel';
import {
	CHAT_REFRESH_BATCH_SIZE,
	advanceChatRefreshSequence,
	isLatestChatRefreshResponse,
	mergePagedMessagesById,
	mergePagedReactions,
	nextChatRefreshBatch,
	previewBody,
	reactionKeysToPreserve,
	reconcileChatMessages,
	reconcileChatReactions,
} from '../chat-pure';
import { ChatComposer } from './ChatComposer';
import type { BubbleMessage, ReactionSummary } from './MessageBubble';
import { MessageList } from './MessageList';

interface ChatMessageDto extends BubbleMessage {
	wgId: string;
	systemKind?: string | null;
	systemPayload?: Record<string, unknown> | null;
}

interface InitialReactionRow {
	messageId: string;
	memberId: string;
	emoji: string;
}

interface ChatViewProps {
	wgId: string;
	shareCode: string;
	initialMessages: ChatMessageDto[];
	initialReactions: InitialReactionRow[];
}

const PAGE_SIZE = 50;

function summarizeReactions(
	rows: InitialReactionRow[],
	currentMemberId: string,
): Map<string, ReactionSummary[]> {
	const byMessage = new Map<string, Map<string, { count: number; mine: boolean }>>();
	for (const row of rows) {
		const messageMap = byMessage.get(row.messageId) ?? new Map();
		const entry = messageMap.get(row.emoji) ?? { count: 0, mine: false };
		entry.count += 1;
		if (row.memberId === currentMemberId) entry.mine = true;
		messageMap.set(row.emoji, entry);
		byMessage.set(row.messageId, messageMap);
	}
	const result = new Map<string, ReactionSummary[]>();
	for (const [messageId, emojiMap] of byMessage) {
		const list: ReactionSummary[] = [];
		for (const [emoji, { count, mine }] of emojiMap) {
			list.push({ emoji, count, mine });
		}
		list.sort((a, b) => b.count - a.count);
		result.set(messageId, list);
	}
	return result;
}

export function ChatView({ wgId, shareCode, initialMessages, initialReactions }: ChatViewProps) {
	const { members, identity, isAdmin } = useWg();
	const toast = useToast();
	const [messages, setMessages] = useState<ChatMessageDto[]>(initialMessages);
	const [reactionRows, setReactionRows] = useState<InitialReactionRow[]>(initialReactions);
	const [hasMoreOlder, setHasMoreOlder] = useState(initialMessages.length >= PAGE_SIZE);
	const [bootstrapping, setBootstrapping] = useState(initialMessages.length === 0);
	const [bootstrapError, setBootstrapError] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const loadingOlderRef = useRef(false);
	const refreshOlderOffsetRef = useRef(0);
	const refreshRequestSequenceRef = useRef(0);
	const refreshPromiseRef = useRef<Promise<boolean> | null>(null);
	const [olderError, setOlderError] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	const pendingMessageRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
	const reactionRequestKeysRef = useRef(new Map<string, string>());
	const reactionMutationVersionsRef = useRef(
		new Map<string, { messageId: string; version: number }>(),
	);
	const pendingReactionMutationsRef = useRef(new Set<string>());
	const [refreshError, setRefreshError] = useState(false);
	const [readError, setReadError] = useState(false);
	const [replyToId, setReplyToId] = useState<string | null>(null);
	const [replyFocusRequest, setReplyFocusRequest] = useState(0);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const chatRootRef = useRef<HTMLDivElement | null>(null);
	const readSentinelRef = useRef<HTMLDivElement | null>(null);
	const lastReadSentIdRef = useRef<string | null>(null);
	const encodedShareCode = encodeURIComponent(shareCode);

	const reactionsByMessage = useMemo(
		() => summarizeReactions(reactionRows, identity.memberId),
		[reactionRows, identity.memberId],
	);

	function explainChatError(
		action: 'send' | 'react' | 'unreact' | 'edit' | 'delete',
		error: string,
	) {
		if (error === 'image_removed') {
			return 'Dieses Bild wurde entfernt. Lade es erneut hoch, bevor du die Nachricht sendest.';
		}
		if (error === 'Netzwerkfehler' || error === 'Failed to fetch') {
			switch (action) {
				case 'send':
					return 'Nachricht konnte nicht gesendet werden: Prüfe deine Verbindung und versuche es erneut.';
				case 'react':
				case 'unreact':
					return 'Reaktion konnte nicht gespeichert werden: Prüfe deine Verbindung und versuche es erneut.';
				case 'edit':
					return 'Nachricht konnte nicht gespeichert werden: Prüfe deine Verbindung und versuche es erneut.';
				case 'delete':
					return 'Nachricht konnte nicht gelöscht werden: Prüfe deine Verbindung und versuche es erneut.';
			}
		}
		switch (action) {
			case 'send':
				return 'Nachricht konnte nicht gesendet werden.';
			case 'react':
			case 'unreact':
				return 'Reaktion konnte nicht gespeichert werden.';
			case 'edit':
				return 'Nachricht konnte nicht gespeichert werden.';
			case 'delete':
				return 'Nachricht konnte nicht gelöscht werden.';
		}
	}

	const sendRead = useCallback(
		async (messageId: string | null) => {
			const res = await apiFetch(`/api/wg/${encodedShareCode}/chat/read`, {
				method: 'POST',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				body: JSON.stringify({ lastReadMessageId: messageId }),
			});
			// An older response must not overwrite a newer receipt's state.
			if (lastReadSentIdRef.current !== messageId) return;
			setReadError(!res.ok);
			if (!res.ok) lastReadSentIdRef.current = null;
			else notifyChatReadConfirmed(shareCode);
		},
		[encodedShareCode, identity.memberId, identity.memberToken, shareCode],
	);

	const markLatestRead = useCallback(() => {
		const latest = messages[messages.length - 1];
		if (!latest) return;
		if (lastReadSentIdRef.current === latest.id) return;
		lastReadSentIdRef.current = latest.id;
		void sendRead(latest.id);
	}, [messages, sendRead]);

	useEffect(() => {
		const root = scrollRef.current;
		const sentinel = readSentinelRef.current;
		if (!root || !sentinel || typeof IntersectionObserver === 'undefined') return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) markLatestRead();
			},
			{ root, threshold: 1 },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [markLatestRead]);

	const fetchMessages = useCallback(async (): Promise<boolean> => {
		const requestSequence = advanceChatRefreshSequence(refreshRequestSequenceRef.current);
		refreshRequestSequenceRef.current = requestSequence;
		const refreshBatch = nextChatRefreshBatch(
			messages,
			PAGE_SIZE,
			CHAT_REFRESH_BATCH_SIZE,
			refreshOlderOffsetRef.current,
		);
		refreshOlderOffsetRef.current = refreshBatch.nextOffset;
		const params = new URLSearchParams({ limit: `${PAGE_SIZE}` });
		for (const id of refreshBatch.ids) params.append('refreshId', id);
		const mutationVersionsAtRequest = new Map(
			[...reactionMutationVersionsRef.current].map(([key, mutation]) => [key, mutation.version]),
		);
		const res = await apiFetch<{
			messages: ChatMessageDto[];
			refreshedMessages?: ChatMessageDto[];
			reactions: InitialReactionRow[];
		}>(`/api/wg/${encodedShareCode}/chat/messages?${params.toString()}`, {
			memberId: identity.memberId,
		});
		if (!isLatestChatRefreshResponse(requestSequence, refreshRequestSequenceRef.current))
			return true;
		if (!res.ok) {
			setRefreshError((prev) =>
				isLatestChatRefreshResponse(requestSequence, refreshRequestSequenceRef.current)
					? true
					: prev,
			);
			return false;
		}
		setRefreshError((prev) =>
			isLatestChatRefreshResponse(requestSequence, refreshRequestSequenceRef.current)
				? false
				: prev,
		);
		const refreshedLoadedMessages = res.data.refreshedMessages ?? [];
		const refreshedMessageIds = new Set(
			[...res.data.messages, ...refreshedLoadedMessages].map((message) => message.id),
		);
		setMessages((prev) =>
			isLatestChatRefreshResponse(requestSequence, refreshRequestSequenceRef.current)
				? reconcileChatMessages(prev, res.data.messages, refreshedLoadedMessages, PAGE_SIZE)
				: prev,
		);
		setReactionRows((prev) => {
			if (!isLatestChatRefreshResponse(requestSequence, refreshRequestSequenceRef.current))
				return prev;
			const preservedLocalKeys = reactionKeysToPreserve(
				reactionMutationVersionsRef.current,
				pendingReactionMutationsRef.current,
				mutationVersionsAtRequest,
				refreshedMessageIds,
			);
			return reconcileChatReactions(
				prev,
				res.data.reactions,
				refreshedMessageIds,
				preservedLocalKeys,
			);
		});
		// Only ever grow: the latest page's length says nothing about whether
		// older pages were already loaded. loadOlder() clears the flag when the
		// history is exhausted.
		setHasMoreOlder((prev) =>
			isLatestChatRefreshResponse(requestSequence, refreshRequestSequenceRef.current)
				? prev || res.data.messages.length >= PAGE_SIZE
				: prev,
		);
		return true;
	}, [encodedShareCode, identity.memberId, messages]);

	const refresh = useCallback((): Promise<boolean> => {
		// A poll must not supersede a request that is still loading. Mutations
		// still invalidate its sequence so a stale snapshot cannot undo them.
		refreshPromiseRef.current ??= fetchMessages().finally(() => {
			refreshPromiseRef.current = null;
		});
		return refreshPromiseRef.current;
	}, [fetchMessages]);

	function beginReactionMutation(messageId: string, emoji: string): string {
		const key = `${messageId}|${identity.memberId}|${emoji}`;
		const current = reactionMutationVersionsRef.current.get(key);
		reactionMutationVersionsRef.current.set(key, {
			messageId,
			version: (current?.version ?? 0) + 1,
		});
		pendingReactionMutationsRef.current.add(key);
		return key;
	}

	function finishReactionMutation(key: string, committed: boolean): void {
		const current = reactionMutationVersionsRef.current.get(key);
		if (committed && current) {
			reactionMutationVersionsRef.current.set(key, {
				...current,
				version: current.version + 1,
			});
		}
		pendingReactionMutationsRef.current.delete(key);
	}

	useChatChannel(wgId, {
		onMessageCreated: () => void refresh(),
		onMessageUpdated: () => void refresh(),
		onMessageDeleted: () => void refresh(),
		onReactionChanged: () => void refresh(),
	});

	// Bootstrap through the gated API when the RSC passed no messages (the
	// server render intentionally loads none — see chat/page.tsx).
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
			const res = await apiFetch<{ messages: ChatMessageDto[]; reactions: InitialReactionRow[] }>(
				`/api/wg/${encodedShareCode}/chat/messages?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest.createdAt)}&beforeId=${encodeURIComponent(oldest.id)}`,
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
			setHasMoreOlder(res.data.messages.length >= PAGE_SIZE);
		} finally {
			loadingOlderRef.current = false;
			setLoadingOlder(false);
		}
	}

	async function sendMessage(input: {
		body: string;
		mentionMemberIds: string[];
		replyToMessageId: string | null;
	}): Promise<boolean> {
		setSendError(null);
		const fingerprint = JSON.stringify(input);
		const pendingRequest = pendingMessageRequestRef.current;
		const idempotencyKey =
			pendingRequest?.fingerprint === fingerprint
				? pendingRequest.key
				: createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			setSendError('Nachricht konnte nicht sicher gesendet werden. Versuche es erneut.');
			return false;
		}
		pendingMessageRequestRef.current = { fingerprint, key: idempotencyKey };
		const res = await apiFetch<{
			message: ChatMessageDto;
			warning: null | 'notification_delivery_failed' | 'notification_delivery_unknown';
		}>(`/api/wg/${encodedShareCode}/chat/messages`, {
			method: 'POST',
			memberId: identity.memberId,
			memberToken: identity.memberToken,
			headers: { 'Idempotency-Key': idempotencyKey },
			body: JSON.stringify(input),
		});
		if (!res.ok) {
			if (res.status > 0 && res.status < 500) pendingMessageRequestRef.current = null;
			setSendError(explainChatError('send', res.error));
			return false;
		}
		pendingMessageRequestRef.current = null;
		refreshRequestSequenceRef.current = advanceChatRefreshSequence(
			refreshRequestSequenceRef.current,
		);
		setMessages((prev) =>
			prev.some((message) => message.id === res.data.message.id)
				? prev.map((message) => (message.id === res.data.message.id ? res.data.message : message))
				: [...prev, res.data.message],
		);
		void refresh();
		if (res.data.warning === 'notification_delivery_failed') {
			toast.info('Gesendet. Nicht alle Push-Benachrichtigungen konnten versendet werden.');
		} else if (res.data.warning === 'notification_delivery_unknown') {
			toast.info('Gesendet. Push-Versand konnte nicht bestätigt werden.');
		}
		return true;
	}

	async function react(messageId: string, emoji: string): Promise<boolean> {
		const requestKeyId = `add:${messageId}:${emoji}`;
		const idempotencyKey =
			reactionRequestKeysRef.current.get(requestKeyId) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			toast.error(explainChatError('react', 'Netzwerkfehler'));
			return false;
		}
		reactionRequestKeysRef.current.set(requestKeyId, idempotencyKey);
		const mutationKey = beginReactionMutation(messageId, emoji);
		let committed = false;
		try {
			const res = await apiFetch(
				`/api/wg/${encodedShareCode}/chat/messages/${messageId}/reactions`,
				{
					method: 'POST',
					memberId: identity.memberId,
					memberToken: identity.memberToken,
					headers: { 'Idempotency-Key': idempotencyKey },
					body: JSON.stringify({ emoji }),
				},
			);
			if (!res.ok) {
				if (res.status > 0 && res.status < 500) reactionRequestKeysRef.current.delete(requestKeyId);
				toast.error(explainChatError('react', res.error));
				return false;
			}
			committed = true;
			reactionRequestKeysRef.current.delete(requestKeyId);
			setReactionRows((prev) =>
				prev.some(
					(row) =>
						row.messageId === messageId &&
						row.memberId === identity.memberId &&
						row.emoji === emoji,
				)
					? prev
					: [...prev, { messageId, memberId: identity.memberId, emoji }],
			);
			return true;
		} finally {
			finishReactionMutation(mutationKey, committed);
		}
	}

	async function unreact(messageId: string, emoji: string): Promise<boolean> {
		const requestKeyId = `remove:${messageId}:${emoji}`;
		const idempotencyKey =
			reactionRequestKeysRef.current.get(requestKeyId) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			toast.error(explainChatError('unreact', 'Netzwerkfehler'));
			return false;
		}
		reactionRequestKeysRef.current.set(requestKeyId, idempotencyKey);
		const mutationKey = beginReactionMutation(messageId, emoji);
		let committed = false;
		try {
			const res = await apiFetch(
				`/api/wg/${encodedShareCode}/chat/messages/${messageId}/reactions?emoji=${encodeURIComponent(emoji)}`,
				{
					method: 'DELETE',
					memberId: identity.memberId,
					memberToken: identity.memberToken,
					headers: { 'Idempotency-Key': idempotencyKey },
				},
			);
			if (!res.ok) {
				if (res.status > 0 && res.status < 500) reactionRequestKeysRef.current.delete(requestKeyId);
				toast.error(explainChatError('unreact', res.error));
				return false;
			}
			committed = true;
			reactionRequestKeysRef.current.delete(requestKeyId);
			setReactionRows((prev) =>
				prev.filter(
					(row) =>
						!(
							row.messageId === messageId &&
							row.memberId === identity.memberId &&
							row.emoji === emoji
						),
				),
			);
			return true;
		} finally {
			finishReactionMutation(mutationKey, committed);
		}
	}

	async function editMessage(messageId: string, next: string): Promise<boolean> {
		const res = await apiFetch<{ message: ChatMessageDto }>(
			`/api/wg/${encodedShareCode}/chat/messages/${messageId}`,
			{
				method: 'PATCH',
				memberId: identity.memberId,
				memberToken: identity.memberToken,
				body: JSON.stringify({ body: next }),
			},
		);
		if (!res.ok) {
			toast.error(explainChatError('edit', res.error));
			return false;
		}
		refreshRequestSequenceRef.current = advanceChatRefreshSequence(
			refreshRequestSequenceRef.current,
		);
		setMessages((prev) =>
			prev.map((m) =>
				m.id === messageId
					? {
							...m,
							body: res.data.message.body,
							editedAt:
								typeof res.data.message.editedAt === 'string'
									? res.data.message.editedAt
									: new Date().toISOString(),
						}
					: m,
			),
		);
		return true;
	}

	async function deleteMessage(messageId: string): Promise<boolean> {
		const res = await apiFetch(`/api/wg/${encodedShareCode}/chat/messages/${messageId}`, {
			method: 'DELETE',
			memberId: identity.memberId,
			memberToken: identity.memberToken,
		});
		if (!res.ok) {
			toast.error(explainChatError('delete', res.error));
			return false;
		}
		refreshRequestSequenceRef.current = advanceChatRefreshSequence(
			refreshRequestSequenceRef.current,
		);
		setMessages((prev) =>
			prev.map((m) =>
				m.id === messageId
					? { ...m, body: null, imageUrl: null, deletedAt: new Date().toISOString() }
					: m,
			),
		);
		return true;
	}

	const replyTo = replyToId ? (messages.find((m) => m.id === replyToId) ?? null) : null;
	const replyToSender = replyTo?.senderMemberId
		? (members.find((m) => m.id === replyTo.senderMemberId) ?? null)
		: null;

	// Size this route to the visible phone viewport when the keyboard opens.
	// MessageScroller still owns all message/history scroll positioning.
	useEffect(() => {
		const viewport = window.visualViewport;
		const resolveFrame = (): HTMLElement | null =>
			chatRootRef.current?.closest<HTMLElement>('[data-chat-frame]') ?? null;
		let frame = resolveFrame();
		if (!frame) return;
		let chrome: HTMLElement | null = null;
		let chromeObserver: ResizeObserver | null = null;

		// Re-resolved on every pass: React re-renders and app-chrome swaps must
		// not leave listeners or observers pointing at detached nodes.
		function syncChrome(): void {
			const next = document.querySelector<HTMLElement>('nav[data-app-chrome]');
			if (next === chrome) return;
			chromeObserver?.disconnect();
			chrome = next;
			if (chrome) {
				chromeObserver = new ResizeObserver(resize);
				chromeObserver.observe(chrome);
			}
		}

		function resize() {
			if (!frame?.isConnected) frame = resolveFrame();
			if (!frame) return;
			syncChrome();
			const top = viewport?.offsetTop ?? 0;
			const bottom = top + (viewport?.height ?? window.innerHeight);
			// iOS keeps the fixed nav at the layout bottom, behind the keyboard, and
			// pans the visual viewport: only reserve the nav part that is visible.
			const nav = chrome?.getBoundingClientRect();
			const reserved = nav ? Math.max(0, bottom - Math.max(top, nav.top)) : 68;
			// End the frame at the visible bottom, wherever the pan left its top.
			frame.style.height = `${Math.max(0, bottom - reserved - frame.getBoundingClientRect().top)}px`;
		}

		syncChrome();
		resize();
		window.addEventListener('resize', resize);
		viewport?.addEventListener('resize', resize);
		viewport?.addEventListener('scroll', resize);
		return () => {
			chromeObserver?.disconnect();
			window.removeEventListener('resize', resize);
			viewport?.removeEventListener('resize', resize);
			viewport?.removeEventListener('scroll', resize);
		};
	}, []);

	function scrollToBottom(): void {
		haptic('selection');
	}

	return (
		<div ref={chatRootRef} className="relative flex min-h-0 flex-1 flex-col bg-background">
			{readError && (
				<Alert variant="destructive" className="rounded-none border-x-0 border-t-0 px-4 py-1.5">
					<AlertDescription className="flex flex-row flex-wrap items-center justify-between gap-x-2 gap-y-0 text-xs">
						Lesestatus konnte nicht gespeichert werden.
						<Button variant="ghost" size="sm" className="text-xs" onClick={markLatestRead}>
							Lesestatus erneut speichern
						</Button>
					</AlertDescription>
				</Alert>
			)}
			{refreshError && !bootstrapError && !bootstrapping && (
				<Alert variant="destructive" className="rounded-none border-x-0 border-t-0 px-4 py-1.5">
					<AlertDescription className="flex flex-row flex-wrap items-center justify-between gap-x-2 gap-y-0 text-xs">
						Chat gerade nicht aktuell.
						<Button variant="ghost" size="sm" className="text-xs" onClick={() => void refresh()}>
							Erneut versuchen
						</Button>
					</AlertDescription>
				</Alert>
			)}
			<MessageScrollerProvider
				autoScroll
				defaultScrollPosition="end"
				scrollEdgeThreshold={120}
				scrollPreviousItemPeek={0}
			>
				<MessageScroller className="flex-1">
					<MessageScrollerViewport
						ref={scrollRef}
						preserveScrollOnPrepend
						data-scroll-y
						role="log"
						aria-label="Chat-Nachrichten"
						className="bg-background"
					>
						<MessageScrollerContent className="mx-auto w-full max-w-3xl gap-3 px-4 py-2">
							{bootstrapping ? (
								<MessageScrollerItem>
									<output className="flex min-h-40 items-center justify-center">
										<Spinner className="size-5" aria-hidden />
										<span className="sr-only">Nachrichten werden geladen</span>
									</output>
								</MessageScrollerItem>
							) : bootstrapError ? (
								<MessageScrollerItem className="flex min-h-40 w-full items-center justify-center">
									<Alert variant="destructive" className="max-w-sm text-center">
										<AlertTitle>Chat konnte nicht geladen werden.</AlertTitle>
										<AlertDescription>
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => void loadInitialMessages()}
												className="mt-3"
											>
												Erneut laden
											</Button>
										</AlertDescription>
									</Alert>
								</MessageScrollerItem>
							) : messages.length === 0 && !hasMoreOlder ? (
								<MessageScrollerItem className="py-6">
									<Empty className="border border-dashed">
										<EmptyHeader>
											<EmptyMedia>
												<MessageCircle aria-hidden />
											</EmptyMedia>
											<EmptyDescription>
												{'Noch keine Nachrichten. Schreib die erste.'}
											</EmptyDescription>
										</EmptyHeader>
									</Empty>
								</MessageScrollerItem>
							) : (
								<MessageList
									messages={messages}
									members={members.map((m) => ({ id: m.id, name: m.name, color: m.color ?? null }))}
									currentMemberId={identity.memberId}
									shareCode={shareCode}
									isAdmin={isAdmin}
									reactionsByMessage={reactionsByMessage}
									hasMoreOlder={hasMoreOlder}
									loadingOlder={loadingOlder}
									olderError={olderError}
									scrollRef={scrollRef}
									onLoadOlder={() => void loadOlder()}
									onReact={react}
									onUnreact={unreact}
									onEdit={editMessage}
									onDelete={deleteMessage}
									onReply={(id) => {
										setReplyToId(id);
										setReplyFocusRequest((request) => request + 1);
									}}
								/>
							)}
							<MessageScrollerItem>
								<div ref={readSentinelRef} className="h-px" aria-hidden />
							</MessageScrollerItem>
						</MessageScrollerContent>
					</MessageScrollerViewport>
					<MessageScrollerButton
						direction="end"
						aria-label="Zum Ende scrollen"
						behavior="auto"
						className="min-h-11 min-w-11"
						onClick={scrollToBottom}
					>
						<ChevronDown aria-hidden />
						<span className="sr-only">Zum Ende scrollen</span>
					</MessageScrollerButton>
				</MessageScroller>
			</MessageScrollerProvider>
			<ChatComposer
				key={`${shareCode}:${identity.memberId}`}
				draftKey={`manawg:draft:${shareCode}:${identity.memberId}:chat`}
				error={sendError}
				members={members.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name }))}
				currentMemberId={identity.memberId}
				replyToMessageId={replyToId}
				replyFocusRequest={replyFocusRequest}
				replyToPreview={
					replyTo ? previewBody(replyTo.body ?? (replyTo.imageUrl ? 'Bild' : ''), 80) : null
				}
				replyToSenderName={replyToSender?.name ?? null}
				onClearReply={() => setReplyToId(null)}
				onRestoreReply={setReplyToId}
				onSend={sendMessage}
			/>
		</div>
	);
}
