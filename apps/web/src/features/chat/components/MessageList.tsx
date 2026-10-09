'use client';

import { Button } from '@/components/ui/button';
import { MessageGroup } from '@/components/ui/message';
import { MessageScrollerItem } from '@/components/ui/message-scroller';
import { Spinner } from '@/components/ui/spinner';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import {
	type ChatReadMarker,
	chatDayLabel,
	countChatReaders,
	groupMessagesByDay,
} from '../chat-pure';
import { type BubbleMessage, MessageBubble, type ReactionSummary } from './MessageBubble';
import { SystemMessage } from './SystemMessage';

interface MessageListProps {
	messages: BubbleMessage[];
	members: { id: string; name: string; color: string | null }[];
	currentMemberId: string;
	shareCode: string;
	isAdmin: boolean;
	reactionsByMessage: Map<string, ReactionSummary[]>;
	reads: readonly ChatReadMarker[];
	/** Members whose read markers count for the read ticks: everyone active except the viewer. */
	readerIds: readonly string[];
	hasMoreOlder: boolean;
	loadingOlder: boolean;
	olderError: boolean;
	scrollRef: RefObject<HTMLDivElement | null>;
	onLoadOlder: () => void;
	onReact: (messageId: string, emoji: string) => Promise<string | null>;
	onUnreact: (messageId: string, emoji: string) => Promise<string | null>;
	onEdit: (messageId: string, next: string) => Promise<string | null>;
	onDelete: (messageId: string) => Promise<string | null>;
	onReply: (messageId: string) => void;
}
const NO_REACTIONS: ReactionSummary[] = [];
const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

function groupsWithPreviousMessage(
	previous: BubbleMessage | undefined,
	current: BubbleMessage,
): boolean {
	const previousTime = previous ? Date.parse(previous.createdAt) : Number.NaN;
	const currentTime = Date.parse(current.createdAt);
	return Boolean(
		previous &&
			previous.kind !== 'system' &&
			current.kind !== 'system' &&
			previous.senderMemberId &&
			previous.senderMemberId === current.senderMemberId &&
			Number.isFinite(previousTime) &&
			Number.isFinite(currentTime) &&
			currentTime >= previousTime &&
			currentTime - previousTime <= MESSAGE_GROUP_WINDOW_MS,
	);
}

export function MessageList({
	messages,
	members,
	currentMemberId,
	shareCode,
	isAdmin,
	reactionsByMessage,
	reads,
	readerIds,
	hasMoreOlder,
	loadingOlder,
	olderError,
	scrollRef,
	onLoadOlder,
	onReact,
	onUnreact,
	onEdit,
	onDelete,
	onReply,
}: MessageListProps) {
	const topSentinelRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const sentinel = topSentinelRef.current;
		const root = scrollRef.current;
		if (
			!sentinel ||
			!root ||
			!hasMoreOlder ||
			loadingOlder ||
			olderError ||
			typeof IntersectionObserver === 'undefined'
		)
			return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) onLoadOlder();
			},
			{ root, threshold: 0.1 },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMoreOlder, loadingOlder, olderError, onLoadOlder, scrollRef]);

	const messagesById = useMemo(
		() => new Map(messages.map((message) => [message.id, message])),
		[messages],
	);
	const memberLookup = useMemo(
		() => new Map(members.map((member) => [member.id, member])),
		[members],
	);
	const groups = useMemo(() => groupMessagesByDay(messages), [messages]);
	const oldestId = messages[0]?.id;
	const now = new Date();

	// Each message is a direct, stable child of MessageScrollerContent. Inserting
	// older messages moves the previous first item, which enables prepend restore.
	// scrollAnchor stays false: this is a live group chat, not an anchored AI turn.
	return groups.flatMap((group) =>
		group.messages.map((message, index) => {
			const grouped = groupsWithPreviousMessage(group.messages[index - 1], message);
			const sender = message.senderMemberId
				? (memberLookup.get(message.senderMemberId) ?? null)
				: null;
			const replyTo = message.replyToMessageId
				? (messagesById.get(message.replyToMessageId) ?? null)
				: null;
			const replyToSender = replyTo?.senderMemberId
				? (memberLookup.get(replyTo.senderMemberId) ?? null)
				: null;
			return (
				<MessageScrollerItem
					key={message.id}
					messageId={message.id}
					className={grouped ? '-mt-1.5' : undefined}
				>
					{message.id === oldestId && hasMoreOlder && (
						<div className="flex flex-col items-center gap-2 pb-3">
							<div ref={topSentinelRef} className="h-1" aria-hidden />
							{olderError && (
								<p role="alert" className="text-sm text-destructive">
									Ältere Nachrichten konnten nicht geladen werden.
								</p>
							)}
							<Button variant="ghost" disabled={loadingOlder} onClick={onLoadOlder}>
								{loadingOlder && <Spinner data-icon="inline-start" />}
								{loadingOlder
									? 'Ältere Nachrichten werden geladen…'
									: olderError
										? 'Erneut versuchen'
										: 'Ältere Nachrichten laden'}
							</Button>
						</div>
					)}
					{index === 0 && (
						<div className="flex justify-center py-2">
							<span
								data-slot="chat-day"
								className="max-w-full rounded-lg bg-white text-center [overflow-wrap:anywhere] px-3 py-1 text-xs font-medium text-[#54656f] shadow-xs dark:bg-[#182229] dark:text-[#8696a0]"
							>
								{chatDayLabel(group.day, now)}
							</span>
						</div>
					)}
					{message.kind === 'system' && !message.deletedAt ? (
						<SystemMessage
							systemKind={(message as BubbleMessage & { systemKind?: string }).systemKind ?? null}
							payload={
								(message as BubbleMessage & { systemPayload?: Record<string, unknown> })
									.systemPayload ?? null
							}
						/>
					) : (
						<MessageGroup>
							<MessageBubble
								key={`${currentMemberId}:${message.id}`}
								message={message}
								sender={sender}
								currentMemberId={currentMemberId}
								grouped={grouped}
								isAdmin={isAdmin}
								isOwn={message.senderMemberId === currentMemberId}
								readCount={
									message.senderMemberId === currentMemberId
										? countChatReaders(message.createdAt, reads, readerIds)
										: 0
								}
								readTotal={readerIds.length}
								draftKey={`manawg:draft:${shareCode}:${currentMemberId}:chat:edit:${message.id}`}
								reactions={reactionsByMessage.get(message.id) ?? NO_REACTIONS}
								replyTo={replyTo}
								replyToSender={replyToSender}
								onReact={onReact}
								onUnreact={onUnreact}
								onEdit={onEdit}
								onDelete={onDelete}
								onReply={onReply}
							/>
						</MessageGroup>
					)}
				</MessageScrollerItem>
			);
		}),
	);
}
