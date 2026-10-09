'use client';

import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { useWg } from '@/components/wg/WgContextProvider';
import { useStableCallback } from '@/core/hooks/useStableCallback';
import { haptic } from '@/shared/lib/haptics';
import { ChevronDown } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { previewBody } from '../chat-pure';
import { type ChatMessageDto, type ChatReactionRow, useChatRoom } from '../hooks/use-chat-room';
import { useChatViewportFit } from '../hooks/use-chat-viewport-fit';
import { ChatBanner } from './ChatBanner';
import { ChatComposer } from './ChatComposer';
import {
	ChatEmptyPlaceholder,
	ChatLoadErrorPlaceholder,
	ChatLoadingPlaceholder,
} from './ChatPlaceholder';
import { MessageList } from './MessageList';

interface ChatViewProps {
	wgId: string;
	shareCode: string;
	initialMessages: ChatMessageDto[];
	initialReactions: ChatReactionRow[];
}

export function ChatView({ wgId, shareCode, initialMessages, initialReactions }: ChatViewProps) {
	const { members, identity, isAdmin } = useWg();
	const chat = useChatRoom({ wgId, shareCode, initialMessages, initialReactions });
	const { messages } = chat;
	const chatRootRef = useRef<HTMLDivElement | null>(null);
	const [replyToId, setReplyToId] = useState<string | null>(null);
	const [replyFocusRequest, setReplyFocusRequest] = useState(0);
	useChatViewportFit(chatRootRef);

	const readerIds = useMemo(
		() => members.filter((m) => m.active && m.id !== identity.memberId).map((m) => m.id),
		[members, identity.memberId],
	);
	const listMembers = useMemo(
		() => members.map((m) => ({ id: m.id, name: m.name, color: m.color ?? null })),
		[members],
	);

	const replyTo = replyToId ? (messages.find((m) => m.id === replyToId) ?? null) : null;
	const replyToSender = replyTo?.senderMemberId
		? (members.find((m) => m.id === replyTo.senderMemberId) ?? null)
		: null;

	const stableLoadOlder = useStableCallback(() => void chat.loadOlder());
	const stableReact = useStableCallback(chat.react);
	const stableUnreact = useStableCallback(chat.unreact);
	const stableEdit = useStableCallback(chat.editMessage);
	const stableDelete = useStableCallback(chat.deleteMessage);
	// Always bring the own message to the end of the list, even when scrolled up.
	const send = useStableCallback(async (input: Parameters<typeof chat.sendMessage>[0]) => {
		const ok = await chat.sendMessage(input);
		if (ok) {
			setTimeout(() => {
				const el = chat.scrollRef.current;
				if (el) el.scrollTop = el.scrollHeight;
			}, 100);
		}
		return ok;
	});
	const onReply = useCallback((id: string) => {
		setReplyToId(id);
		setReplyFocusRequest((request) => request + 1);
	}, []);

	return (
		<div ref={chatRootRef} className="relative flex min-h-0 flex-1 flex-col bg-background">
			{chat.readError && (
				<ChatBanner
					message="Lesestatus konnte nicht gespeichert werden."
					actionLabel="Lesestatus erneut speichern"
					onAction={chat.markLatestRead}
				/>
			)}
			{chat.refreshError && !chat.bootstrapError && !chat.bootstrapping && (
				<ChatBanner
					message="Chat gerade nicht aktuell."
					actionLabel="Erneut versuchen"
					onAction={() => void chat.refresh()}
				/>
			)}
			<MessageScrollerProvider
				autoScroll
				defaultScrollPosition="end"
				scrollEdgeThreshold={120}
				scrollPreviousItemPeek={0}
			>
				<MessageScroller className="flex-1">
					<MessageScrollerViewport
						ref={chat.scrollRef}
						preserveScrollOnPrepend
						data-scroll-y
						role="log"
						aria-label="Chat-Nachrichten"
						// Chat wallpaper as in WhatsApp: warm beige with a faint dot pattern.
						className="bg-[#efeae2] [background-image:radial-gradient(rgb(0_0_0/0.05)_1px,transparent_1px)] [background-size:18px_18px] dark:bg-[#0b141a] dark:[background-image:radial-gradient(rgb(255_255_255/0.04)_1px,transparent_1px)] [scroll-behavior:auto]!"
					>
						<MessageScrollerContent className="mx-auto w-full max-w-3xl gap-2 px-3 py-2">
							{chat.bootstrapping ? (
								<ChatLoadingPlaceholder />
							) : chat.bootstrapError ? (
								<ChatLoadErrorPlaceholder onRetry={() => void chat.loadInitialMessages()} />
							) : messages.length === 0 && !chat.hasMoreOlder ? (
								<ChatEmptyPlaceholder />
							) : (
								<MessageList
									messages={messages}
									members={listMembers}
									currentMemberId={identity.memberId}
									shareCode={shareCode}
									isAdmin={isAdmin}
									reactionsByMessage={chat.reactionsByMessage}
									reads={chat.reads}
									readerIds={readerIds}
									hasMoreOlder={chat.hasMoreOlder}
									loadingOlder={chat.loadingOlder}
									olderError={chat.olderError}
									scrollRef={chat.scrollRef}
									onLoadOlder={stableLoadOlder}
									onReact={stableReact}
									onUnreact={stableUnreact}
									onEdit={stableEdit}
									onDelete={stableDelete}
									onReply={onReply}
								/>
							)}
							{/* No MessageScrollerItem: an item before the real messages would consume the one-time start position "end" on an empty list. */}
							<div ref={chat.readSentinelRef} className="h-px shrink-0" aria-hidden />
						</MessageScrollerContent>
					</MessageScrollerViewport>
					<MessageScrollerButton
						direction="end"
						aria-label="Zum Ende scrollen"
						behavior="smooth"
						className="inset-s-auto end-3 translate-x-0 rounded-full shadow-md rtl:translate-x-0"
						onClick={() => haptic('selection')}
					>
						<ChevronDown aria-hidden />
						<span className="sr-only">Zum Ende scrollen</span>
					</MessageScrollerButton>
				</MessageScroller>
			</MessageScrollerProvider>
			<ChatComposer
				key={`${shareCode}:${identity.memberId}`}
				draftKey={`manawg:draft:${shareCode}:${identity.memberId}:chat`}
				error={chat.sendError}
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
				onSend={send}
			/>
		</div>
	);
}
