'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bubble, BubbleContent, BubbleGroup, BubbleTail } from '@/components/ui/bubble';
import { Message, MessageAvatar, MessageContent } from '@/components/ui/message';
import { initials, memberTint } from '@/components/wg/MemberAvatar';
import { formatTimeFull } from '@/core/utils/time';
import { cn } from '@/shared/lib/cn';
import type { MemberInfo } from '@/shared/lib/member-types';
import { Check, CheckCheck, Reply } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { canDeleteMessage, canEditMessage } from '../chat-pure';
import type { BubbleMessage, ReactionSummary } from '../chat-types';
import { useBubbleGestures } from '../hooks/use-bubble-gestures';
import { useMessageBubbleActions } from '../hooks/use-message-bubble-actions';
import { BUBBLE_TEXT, MessageActionsMenu } from './MessageActionsMenu';
import {
	MessageDeleteDialog,
	MessageEditForm,
	MessageImage,
	MessageReactions,
} from './MessageBubbleParts';
import { ReactionPicker } from './ReactionPicker';

export type { BubbleMessage, ReactionSummary } from '../chat-types';

const TIME_FORMAT = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

interface MessageBubbleProps {
	message: BubbleMessage;
	sender: MemberInfo | null;
	currentMemberId: string;
	isAdmin: boolean;
	isOwn: boolean;
	grouped?: boolean;
	/** Own messages: how many of the other members have read this one, out of how many. */
	readCount?: number;
	readTotal?: number;
	draftKey: string;
	reactions: ReactionSummary[];
	replyTo: BubbleMessage | null;
	replyToSender: { name: string } | null;
	onReact: (messageId: string, emoji: string) => Promise<string | null>;
	onUnreact: (messageId: string, emoji: string) => Promise<string | null>;
	onEdit: (messageId: string, next: string) => Promise<string | null>;
	onDelete: (messageId: string) => Promise<string | null>;
	onReply: (messageId: string) => void;
}

export const MessageBubble = memo(function MessageBubble({
	message,
	sender,
	currentMemberId,
	isAdmin,
	isOwn,
	grouped = false,
	readCount = 0,
	readTotal = 0,
	draftKey,
	reactions,
	replyTo,
	replyToSender,
	onReact,
	onUnreact,
	onEdit,
	onDelete,
	onReply,
}: MessageBubbleProps) {
	const actions = useMessageBubbleActions({
		message,
		draftKey,
		onReact,
		onUnreact,
		onEdit,
		onDelete,
	});
	const { editing, pending, reactionPending, error, deleteOpen } = actions;
	const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const actionsTriggerRef = useRef<HTMLButtonElement | null>(null);
	const wasEditingRef = useRef(false);
	const deletedRef = useRef<HTMLParagraphElement | null>(null);
	const rowRef = useRef<HTMLDivElement | null>(null);
	const replyIconRef = useRef<HTMLSpanElement | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const isDeleted = Boolean(message.deletedAt);
	const gestures = useBubbleGestures({
		rowRef,
		iconRef: replyIconRef,
		enabled: !isDeleted && !editing && !pending,
		onReply: () => onReply(message.id),
		onLongPress: () => setMenuOpen(true),
	});
	const editable = canEditMessage(message, { id: currentMemberId });
	const deletable = canDeleteMessage(message, {
		id: currentMemberId,
		role: isAdmin ? 'admin' : null,
	});
	const senderName = sender?.name ?? 'Unbekannt';
	const align = isOwn ? 'end' : 'start';
	const readByAll = readTotal > 0 && readCount >= readTotal;
	// Time and read ticks sit small at the bottom right of the bubble; the date is in the day pill.
	const timeStamp = (
		<span className="float-end ms-2 mt-1.5 inline-flex items-center gap-0.5 text-[11px] leading-none tabular-nums">
			<span className="opacity-80">
				{message.editedAt && !isDeleted && 'bearbeitet · '}
				<time dateTime={message.createdAt} title={formatTimeFull(message.createdAt)}>
					{TIME_FORMAT.format(new Date(message.createdAt))}
				</time>
			</span>
			{isOwn && !isDeleted && (
				<span
					role="img"
					aria-label={
						readByAll
							? 'Von allen gelesen'
							: readCount > 0
								? `Von ${readCount} von ${readTotal} gelesen`
								: 'Gesendet'
					}
					className={cn(
						'inline-flex',
						readByAll ? 'text-[#027eb5] dark:text-[#53bdeb]' : 'opacity-80',
					)}
				>
					{readCount > 0 ? (
						<CheckCheck aria-hidden className="size-3.5" />
					) : (
						<Check aria-hidden className="size-3.5" />
					)}
				</span>
			)}
		</span>
	);

	useEffect(() => {
		if (!editing) {
			if (wasEditingRef.current) {
				wasEditingRef.current = false;
				actionsTriggerRef.current?.focus();
			}
			return;
		}
		wasEditingRef.current = true;
		const textarea = editTextareaRef.current;
		// WebKit scrolls the grown bubble not into view on its own; do it after layout so that Speichern/Abbrechen stay visible.
		textarea?.focus({ preventScroll: true });
		const frame = requestAnimationFrame(() =>
			textarea?.closest('[data-slot="message"]')?.scrollIntoView({ block: 'nearest' }),
		);
		return () => cancelAnimationFrame(frame);
	}, [editing]);

	return (
		// Swipe right to reply: the row slides, the reply arrow fades in behind it.
		<div className="relative touch-pan-y overflow-x-clip" {...gestures.handlers}>
			<span
				ref={replyIconRef}
				aria-hidden
				className="absolute start-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-foreground/10 opacity-0"
			>
				<Reply className="size-4" />
			</span>
			<Message
				ref={rowRef}
				align={align}
				id={`message-${message.id}`}
				aria-busy={pending || Boolean(reactionPending)}
				// Own bubbles keep room at the edge for their tail.
				className={cn('transition-transform duration-200 ease-out', isOwn && 'pe-2')}
			>
				{/* Own messages go without avatar; others show avatar and name only at the start of a run. */}
				{!isOwn && (
					<MessageAvatar className={cn('self-start', grouped && 'invisible')} aria-hidden>
						<Avatar className="size-7 text-xs">
							<AvatarFallback style={memberTint(senderName)}>{initials(senderName)}</AvatarFallback>
						</Avatar>
					</MessageAvatar>
				)}
				<MessageContent className="gap-0.5">
					{editing ? (
						<MessageEditForm
							messageId={message.id}
							draft={actions.draft}
							error={error}
							pending={pending}
							textareaRef={editTextareaRef}
							onChange={actions.changeDraft}
							onSave={() => void actions.saveEdit()}
							onCancel={actions.cancelEdit}
							canCancel={() => !actions.pendingRef.current}
						/>
					) : (
						<BubbleGroup className="min-w-0 max-w-[85%] group-data-[align=end]/message:self-end">
							<Bubble
								variant={isDeleted ? 'muted' : isOwn ? 'sent' : 'received'}
								align={align}
								className={cn(
									'max-w-full',
									!grouped &&
										!isDeleted &&
										(isOwn
											? '*:data-[slot=bubble-content]:rounded-se-none'
											: '*:data-[slot=bubble-content]:rounded-ss-none'),
								)}
							>
								{!grouped && !isDeleted && <BubbleTail />}
								{isDeleted ? (
									<BubbleContent className={BUBBLE_TEXT}>
										<p ref={deletedRef} tabIndex={-1} className="outline-none">
											Diese Nachricht wurde gelöscht.
											{timeStamp}
										</p>
									</BubbleContent>
								) : (
									<MessageActionsMenu
										message={message}
										senderName={senderName}
										isOwn={isOwn}
										showSenderName={!isOwn && !grouped}
										open={menuOpen}
										onOpenChange={(next, reason) => {
											// The click that ends a long press or swipe lands on the trigger or the new backdrop; it must not toggle the menu.
											if (
												(reason === 'trigger-press' || reason === 'outside-press') &&
												gestures.swallowsClick()
											)
												return;
											setMenuOpen(next);
										}}
										reactions={reactions}
										onQuickReact={(emoji, mine) => void actions.toggleReaction(emoji, mine)}
										replyTo={replyTo}
										replyToSender={replyToSender}
										timeStamp={timeStamp}
										triggerRef={actionsTriggerRef}
										disabled={pending}
										reactionPending={Boolean(reactionPending)}
										editable={editable}
										deletable={deletable}
										hasDraft={actions.hasDraft}
										onReactOpen={() => actions.setReactOpen(true)}
										onReply={onReply}
										onEdit={actions.startEdit}
										onDelete={actions.openDelete}
									/>
								)}
								{reactions.length > 0 && (
									<MessageReactions
										reactions={reactions}
										align={align}
										senderName={senderName}
										disabled={isDeleted || Boolean(reactionPending)}
										pendingEmoji={reactionPending}
										onToggle={(emoji, mine) => void actions.toggleReaction(emoji, mine)}
									/>
								)}
							</Bubble>
							{!isDeleted && message.imageUrl && (
								<MessageImage imageUrl={message.imageUrl} senderName={senderName} />
							)}
						</BubbleGroup>
					)}
					{error && !deleteOpen && (
						<Alert id={`message-edit-error-${message.id}`} variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}
					<ReactionPicker
						open={actions.reactOpen}
						onOpenChange={actions.setReactOpen}
						onSelect={(emoji) => actions.toggleReaction(emoji, false)}
						returnFocusRef={actionsTriggerRef}
					/>
					<MessageDeleteDialog
						open={deleteOpen}
						pending={pending}
						error={error}
						onOpenChange={(open) => {
							if (!actions.pendingRef.current) actions.setDeleteOpen(open);
						}}
						onConfirm={() => void actions.remove()}
						finalFocus={() => deletedRef.current ?? true}
					/>
				</MessageContent>
			</Message>
		</div>
	);
});
