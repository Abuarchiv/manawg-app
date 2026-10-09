'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bubble, BubbleContent, BubbleGroup } from '@/components/ui/bubble';
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/components/ui/message';
import { initials, memberTint } from '@/components/wg/MemberAvatar';
import { formatTimeFull } from '@/core/utils/time';
import type { MemberInfo } from '@/shared/lib/member-types';
import { memo, useEffect, useRef } from 'react';
import { canDeleteMessage, canEditMessage } from '../chat-pure';
import type { BubbleMessage, ReactionSummary } from '../chat-types';
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
	const isDeleted = Boolean(message.deletedAt);
	const editable = canEditMessage(message, { id: currentMemberId });
	const deletable = canDeleteMessage(message, {
		id: currentMemberId,
		role: isAdmin ? 'admin' : null,
	});
	const senderName = sender?.name ?? 'Unbekannt';
	const align = isOwn ? 'end' : 'start';
	// The time sits small at the bottom right of the bubble; the date is in the day divider.
	const timeStamp = (
		<span className="float-end ms-2 mt-1.5 text-[12px] leading-none tabular-nums opacity-70">
			{message.editedAt && !isDeleted && 'bearbeitet · '}
			<time dateTime={message.createdAt} title={formatTimeFull(message.createdAt)}>
				{TIME_FORMAT.format(new Date(message.createdAt))}
			</time>
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
		<Message
			align={align}
			id={`message-${message.id}`}
			aria-busy={pending || Boolean(reactionPending)}
		>
			{/* Own messages go without avatar; others show avatar and name only at the start of a run. */}
			{!isOwn && (
				<MessageAvatar className={grouped ? 'invisible' : undefined} aria-hidden>
					<Avatar className="size-7 text-xs">
						<AvatarFallback style={memberTint(senderName)}>{initials(senderName)}</AvatarFallback>
					</Avatar>
				</MessageAvatar>
			)}
			<MessageContent className="gap-0.5">
				{!isOwn && !grouped && (
					<MessageHeader className="px-2.5 text-xs">
						<span className="min-w-0 [overflow-wrap:anywhere]">{senderName}</span>
					</MessageHeader>
				)}
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
							variant={isDeleted ? 'muted' : isOwn ? 'default' : 'secondary'}
							align={align}
							className="max-w-full"
						>
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
									reactions={reactions}
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
	);
});
