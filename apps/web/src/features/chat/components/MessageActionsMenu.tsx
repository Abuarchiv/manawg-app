'use client';

import { useToast } from '@/components/ui/Toast';
import { BubbleContent } from '@/components/ui/bubble';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { memberTint } from '@/components/wg/MemberAvatar';
import { useWg } from '@/components/wg/WgContextProvider';
import { copyText } from '@/core/utils/clipboard';
import { cn } from '@/shared/lib/cn';
import { haptic } from '@/shared/lib/haptics';
import { Copy, Pencil, Plus, Reply, Trash2 } from 'lucide-react';
import { type ReactNode, type RefObject, useMemo } from 'react';
import { splitMentions } from '../chat-pure';
import type { BubbleMessage, ReactionSummary } from '../chat-types';

export const BUBBLE_TEXT = 'rounded-lg px-2.5 py-1.5 text-[14px] leading-snug';
/** The reaction bar on top of the menu, as in WhatsApp. More emojis sit behind "+". */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

interface MessageActionsMenuProps {
	message: BubbleMessage;
	senderName: string;
	isOwn: boolean;
	/** First bubble of a run from someone else: their name sits inside the bubble. */
	showSenderName: boolean;
	open: boolean;
	onOpenChange: (open: boolean, reason?: string) => void;
	reactions: ReactionSummary[];
	onQuickReact: (emoji: string, mine: boolean) => void;
	replyTo: BubbleMessage | null;
	replyToSender: { name: string } | null;
	timeStamp: ReactNode;
	triggerRef: RefObject<HTMLButtonElement | null>;
	disabled: boolean;
	reactionPending: boolean;
	editable: boolean;
	deletable: boolean;
	hasDraft: boolean;
	onReactOpen: () => void;
	onReply: (messageId: string) => void;
	onEdit: () => void;
	onDelete: () => void;
}

/** The bubble itself as a menu trigger: tap, long press or right click opens react, reply, copy, edit and delete. */
export function MessageActionsMenu({
	message,
	senderName,
	isOwn,
	showSenderName,
	open,
	onOpenChange,
	reactions,
	onQuickReact,
	replyTo,
	replyToSender,
	timeStamp,
	triggerRef,
	disabled,
	reactionPending,
	editable,
	deletable,
	hasDraft,
	onReactOpen,
	onReply,
	onEdit,
	onDelete,
}: MessageActionsMenuProps) {
	const { members, identity } = useWg();
	const ownName = members.find((m) => m.id === identity.memberId)?.name;
	const bodySegments = useMemo(
		() =>
			splitMentions(
				message.body ?? '',
				members.map((m) => m.name),
			),
		[message.body, members],
	);
	const toast = useToast();
	return (
		<DropdownMenu open={open} onOpenChange={(next, details) => onOpenChange(next, details.reason)}>
			<DropdownMenuTrigger
				ref={triggerRef}
				disabled={disabled}
				onContextMenu={(event) => {
					event.preventDefault();
					if (!disabled) onOpenChange(true);
				}}
				render={
					<BubbleContent
						// The trigger would otherwise set data-slot="dropdown-menu-trigger"; the bubble colors key off the slot.
						data-slot="bubble-content"
						render={<button type="button" />}
						// No text selection or iOS callout: a long press opens the menu instead.
						className={cn(BUBBLE_TEXT, 'cursor-pointer select-none [-webkit-touch-callout:none]')}
					/>
				}
			>
				<span className="sr-only">Aktionen für Nachricht von {senderName}: </span>
				{showSenderName && (
					<span
						aria-hidden
						className="block text-[13px] font-medium [overflow-wrap:anywhere]"
						style={{ color: memberTint(senderName).color }}
					>
						{senderName}
					</span>
				)}
				{replyTo && (
					<span className="mb-1.5 block rounded-md border-s-2 border-current/40 bg-current/5 px-2 py-1">
						<span className="block text-xs font-medium [overflow-wrap:anywhere]">
							↪ {replyToSender?.name ?? 'Unbekannt'}
						</span>
						<span className="line-clamp-2 whitespace-pre-wrap text-xs opacity-80 [overflow-wrap:anywhere]">
							{replyTo.deletedAt
								? 'Diese Nachricht wurde gelöscht.'
								: (replyTo.body ?? (replyTo.imageUrl ? 'Bild' : '…'))}
						</span>
					</span>
				)}
				{/* Spans instead of <p>: paragraph elements are not allowed inside a <button>. */}
				<span className="block whitespace-pre-wrap [overflow-wrap:anywhere]">
					{bodySegments.map((segment, index) =>
						segment.mention ? (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: segments are static per body
								key={index}
								className={cn(
									'font-semibold',
									segment.mention === ownName && 'underline underline-offset-2',
								)}
							>
								{segment.text}
							</span>
						) : (
							segment.text
						),
					)}
					{timeStamp}
				</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent backdrop align={isOwn ? 'end' : 'start'} className="w-auto min-w-48">
				<DropdownMenuGroup
					aria-label="Reagieren"
					className="flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-0.5"
				>
					{QUICK_REACTIONS.map((emoji) => {
						const mine = reactions.some((reaction) => reaction.emoji === emoji && reaction.mine);
						return (
							<DropdownMenuItem
								key={emoji}
								aria-label={mine ? `Reaktion ${emoji} entfernen` : `Mit ${emoji} reagieren`}
								disabled={reactionPending}
								className={cn(
									'size-11 justify-center rounded-full p-0 text-[22px] leading-none',
									mine && 'bg-accent',
								)}
								onClick={() => onQuickReact(emoji, mine)}
							>
								{emoji}
							</DropdownMenuItem>
						);
					})}
					<DropdownMenuItem
						aria-label="Weitere Reaktionen"
						disabled={reactionPending}
						className="size-11 justify-center rounded-full bg-muted p-0"
						onClick={onReactOpen}
					>
						<Plus aria-hidden />
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						className="min-h-11"
						onClick={() => {
							haptic('selection');
							onReply(message.id);
						}}
					>
						<Reply aria-hidden /> Antworten
					</DropdownMenuItem>
					{message.body && (
						<DropdownMenuItem
							className="min-h-11"
							// copyText catches a rejected async clipboard call (otherwise a pageerror without feedback).
							onClick={() =>
								void copyText(message.body ?? '').then((copied) =>
									copied
										? toast.success('Nachricht kopiert.')
										: toast.error('Kopieren hat nicht geklappt. Versuche es erneut.'),
								)
							}
						>
							<Copy aria-hidden /> Kopieren
						</DropdownMenuItem>
					)}
					{editable && (
						<DropdownMenuItem className="min-h-11" onClick={onEdit}>
							<Pencil aria-hidden /> {hasDraft ? 'Entwurf weiterbearbeiten' : 'Bearbeiten'}
						</DropdownMenuItem>
					)}
					{deletable && (
						<DropdownMenuItem className="min-h-11" variant="destructive" onClick={onDelete}>
							<Trash2 aria-hidden /> Löschen
						</DropdownMenuItem>
					)}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
