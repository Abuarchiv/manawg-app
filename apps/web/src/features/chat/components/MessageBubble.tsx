'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
	Attachment,
	AttachmentContent,
	AttachmentDescription,
	AttachmentMedia,
	AttachmentTitle,
	AttachmentTrigger,
} from '@/components/ui/attachment';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bubble, BubbleContent, BubbleGroup, BubbleReactions } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldGroup } from '@/components/ui/field';
import {
	Message,
	MessageAvatar,
	MessageContent,
	MessageFooter,
	MessageHeader,
} from '@/components/ui/message';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { readDraft, removeDraft, writeDraft } from '@/core/offline/drafts';
import { formatRelativeTime, formatTimeFull } from '@/core/utils/time';
import { haptic } from '@/shared/lib/haptics';
import { MoreVertical, Pencil, Reply, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { canDeleteMessage, canEditMessage, resolveStoredEditDraft } from '../chat-pure';
import { ReactionPicker } from './ReactionPicker';

export interface BubbleMessage {
	id: string;
	senderMemberId: string | null;
	kind: string;
	body: string | null;
	imageUrl: string | null;
	createdAt: string;
	editedAt: string | null;
	deletedAt: string | null;
	replyToMessageId: string | null;
}
export interface ReactionSummary {
	emoji: string;
	count: number;
	mine: boolean;
}

interface MessageBubbleProps {
	message: BubbleMessage;
	sender: { name: string; color: string | null } | null;
	currentMemberId: string;
	isAdmin: boolean;
	isOwn: boolean;
	grouped?: boolean;
	draftKey: string;
	reactions: ReactionSummary[];
	replyTo: BubbleMessage | null;
	replyToSender: { name: string } | null;
	onReact: (emoji: string) => Promise<boolean>;
	onUnreact: (emoji: string) => Promise<boolean>;
	onEdit: (next: string) => Promise<boolean>;
	onDelete: () => Promise<boolean>;
	onReply: () => void;
}

export function MessageBubble({
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
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(message.body ?? '');
	const [hasDraft, setHasDraft] = useState(false);
	const [pending, setPending] = useState(false);
	const [reactionPending, setReactionPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const pendingRef = useRef(false);
	const reactionRef = useRef(false);
	const isDeleted = Boolean(message.deletedAt);
	const editable = canEditMessage(message, { id: currentMemberId });
	const deletable = canDeleteMessage(message, {
		id: currentMemberId,
		role: isAdmin ? 'admin' : null,
	});
	const senderName = sender?.name ?? 'Unbekannt';
	const align = isOwn ? 'end' : 'start';
	const messageBody = message.body ?? '';

	useEffect(() => {
		// Skip while editing: the textarea keeps what the user is typing, and a
		// message arriving mid-edit must not rewrite it.
		if (editing) return;
		const stored = readDraft<{ body?: string; base?: string }>(draftKey);
		const resolved = resolveStoredEditDraft(stored, messageBody);
		if (resolved.discard) removeDraft(draftKey);
		if (resolved.text !== null) {
			// Adopt drafts persisted before `base` existed so later message
			// changes are detected from now on.
			if (typeof stored?.base !== 'string')
				writeDraft(draftKey, { body: resolved.text, base: messageBody });
			setDraft(resolved.text);
			setHasDraft(true);
			return;
		}
		setDraft(messageBody);
		setHasDraft(false);
	}, [draftKey, editing, messageBody]);
	function changeDraft(value: string) {
		setDraft(value);
		setHasDraft(true);
		// `base` records the body this edit started from; a message that changes
		// underneath it invalidates the draft instead of silently overwriting.
		writeDraft(draftKey, { body: value, base: messageBody });
	}
	function cancelEdit() {
		if (pendingRef.current) return;
		// Abbrechen/Escape verwirft den Entwurf: sonst bietet das Menü „Entwurf
		// weiterbearbeiten" mit veraltetem Text an, auch nach einem Reload.
		removeDraft(draftKey);
		setHasDraft(false);
		setDraft(messageBody);
		setError(null);
		setEditing(false);
	}
	async function saveEdit() {
		const text = draft.trim();
		if (!text || pendingRef.current) return;
		pendingRef.current = true;
		setPending(true);
		setError(null);
		try {
			if (await onEdit(text)) {
				setEditing(false);
				setHasDraft(false);
				removeDraft(draftKey);
			} else setError('Änderung nicht gespeichert. Dein Text ist noch da.');
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	}
	async function remove() {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setPending(true);
		setError(null);
		try {
			if (await onDelete()) {
				setDeleteOpen(false);
				removeDraft(draftKey);
			} else setError('Nachricht konnte nicht gelöscht werden.');
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	}
	async function toggleReaction(emoji: string, mine: boolean) {
		if (reactionRef.current) return false;
		reactionRef.current = true;
		setReactionPending(emoji);
		setError(null);
		haptic('selection');
		try {
			const ok = await (mine ? onUnreact(emoji) : onReact(emoji));
			if (!ok) setError('Reaktion konnte nicht gespeichert werden.');
			return ok;
		} finally {
			reactionRef.current = false;
			setReactionPending(null);
		}
	}

	return (
		<Message
			align={align}
			id={`message-${message.id}`}
			aria-busy={pending || Boolean(reactionPending)}
		>
			<MessageAvatar
				className={grouped ? 'invisible' : undefined}
				aria-hidden={grouped || undefined}
			>
				<Avatar className="size-7 text-xs">
					<AvatarFallback>{senderName.slice(0, 2).toLocaleUpperCase('de-DE')}</AvatarFallback>
				</Avatar>
			</MessageAvatar>
			<MessageContent className="gap-1">
				<MessageHeader className={grouped ? 'sr-only' : 'flex-wrap gap-x-1.5 gap-y-0 px-2 text-xs'}>
					{!isOwn && <span className="min-w-0 [overflow-wrap:anywhere]">{senderName}</span>}
					<time dateTime={message.createdAt} title={formatTimeFull(message.createdAt)}>
						{formatRelativeTime(message.createdAt)}
					</time>
					{message.editedAt && <span>· bearbeitet</span>}
				</MessageHeader>
				{grouped && message.editedAt && (
					<span className="px-1 text-xs text-muted-foreground" aria-hidden>
						bearbeitet
					</span>
				)}
				{editing ? (
					<FieldGroup className="gap-2">
						<Field data-invalid={Boolean(error)}>
							<Textarea
								value={draft}
								onChange={(event) => changeDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing) return;
									if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
										event.preventDefault();
										void saveEdit();
									}
									if (event.key === 'Escape' && !pendingRef.current) cancelEdit();
								}}
								rows={3}
								disabled={pending}
								maxLength={4000}
								aria-label="Nachricht bearbeiten"
								aria-invalid={Boolean(error)}
								aria-describedby={error ? `message-edit-error-${message.id}` : undefined}
								className="min-h-24 text-base"
							/>
						</Field>
						<div className="flex flex-wrap justify-end gap-2">
							<Button variant="outline" disabled={pending} onClick={cancelEdit}>
								Abbrechen
							</Button>
							<Button disabled={pending || !draft.trim()} onClick={() => void saveEdit()}>
								{pending && <Spinner data-icon="inline-start" />}
								{pending ? 'Wird gespeichert…' : 'Speichern'}
							</Button>
						</div>
					</FieldGroup>
				) : (
					<BubbleGroup className="max-w-full">
						<Bubble
							variant={isDeleted ? 'muted' : isOwn ? 'default' : 'secondary'}
							align={align}
							className="max-w-full"
						>
							<BubbleContent className="px-2.5 py-1.5 leading-snug">
								{replyTo && (
									<blockquote className="mb-2 border-s-2 border-current/30 ps-2">
										<p className="text-xs font-medium [overflow-wrap:anywhere]">
											↪ {replyToSender?.name ?? 'Unbekannt'}
										</p>
										<p className="line-clamp-2 whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">
											{replyTo.deletedAt
												? 'Diese Nachricht wurde gelöscht.'
												: (replyTo.body ?? (replyTo.imageUrl ? 'Bild' : '…'))}
										</p>
									</blockquote>
								)}
								{isDeleted ? (
									<p>Diese Nachricht wurde gelöscht.</p>
								) : (
									message.body && (
										<p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.body}</p>
									)
								)}
							</BubbleContent>
							{reactions.length > 0 && (
								<BubbleReactions
									align={align}
									className="static max-w-full flex-wrap translate-y-0 self-start"
								>
									{reactions.map((reaction) => (
										<Button
											key={reaction.emoji}
											variant={reaction.mine ? 'secondary' : 'outline'}
											size="sm"
											onClick={() => void toggleReaction(reaction.emoji, reaction.mine)}
											disabled={isDeleted || Boolean(reactionPending)}
											aria-pressed={reaction.mine}
											aria-label={`Reaktion ${reaction.emoji} (${reaction.count}) ${reaction.mine ? 'entfernen' : 'hinzufügen'} — Nachricht von ${senderName}`}
										>
											{reactionPending === reaction.emoji ? (
												<Spinner />
											) : (
												<span>{reaction.emoji}</span>
											)}
											<span className="tabular-nums">{reaction.count}</span>
										</Button>
									))}
								</BubbleReactions>
							)}
						</Bubble>
						{!isDeleted && message.imageUrl && (
							<Attachment state="done" className="min-w-0 max-w-full">
								<AttachmentMedia variant="image" className="size-20">
									{/* eslint-disable-next-line @next/next/no-img-element */}
									<img src={message.imageUrl} alt={`Bild von ${senderName}`} loading="lazy" />
								</AttachmentMedia>
								<AttachmentContent>
									<AttachmentTitle>Bild</AttachmentTitle>
									<AttachmentDescription>In voller Größe öffnen</AttachmentDescription>
								</AttachmentContent>
								<AttachmentTrigger
									aria-label="Bild in voller Größe öffnen"
									render={
										<a href={message.imageUrl} target="_blank" rel="noopener noreferrer">
											<span className="sr-only">Bild in voller Größe öffnen</span>
										</a>
									}
								/>
							</Attachment>
						)}
					</BubbleGroup>
				)}
				{error && !deleteOpen && (
					<Alert id={`message-edit-error-${message.id}`} variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
				{!isDeleted && !editing && (
					<MessageFooter className="flex-wrap gap-2 px-0 py-1 [&_svg]:size-3.5">
						<ReactionPicker
							disabled={Boolean(reactionPending)}
							onSelect={(emoji) => toggleReaction(emoji, false)}
							triggerLabel={`Reaktion zu Nachricht von ${senderName} (${formatRelativeTime(message.createdAt)}) hinzufügen`}
						/>
						<Button
							variant="ghost"
							size="icon"
							onClick={() => {
								haptic('selection');
								onReply();
							}}
							aria-label={`Auf Nachricht von ${senderName} (${formatRelativeTime(message.createdAt)}) antworten`}
						>
							<Reply aria-hidden />
						</Button>
						{(editable || deletable) && (
							<DropdownMenu>
								<DropdownMenuTrigger
									render={<Button variant="ghost" size="icon" />}
									disabled={pending}
									aria-label={`Aktionen für Nachricht von ${senderName} (${formatRelativeTime(message.createdAt)})`}
								>
									<MoreVertical aria-hidden />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-48">
									<DropdownMenuGroup>
										{editable && (
											<DropdownMenuItem
												className="min-h-11"
												onClick={() => {
													if (!hasDraft) setDraft(message.body ?? '');
													setError(null);
													setEditing(true);
												}}
											>
												<Pencil aria-hidden />{' '}
												{hasDraft ? 'Entwurf weiterbearbeiten' : 'Bearbeiten'}
											</DropdownMenuItem>
										)}
										{deletable && (
											<DropdownMenuItem
												className="min-h-11"
												variant="destructive"
												onClick={() => {
													setError(null);
													setDeleteOpen(true);
												}}
											>
												<Trash2 aria-hidden /> Löschen
											</DropdownMenuItem>
										)}
									</DropdownMenuGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</MessageFooter>
				)}
				<AlertDialog
					open={deleteOpen}
					onOpenChange={(open) => {
						if (!pendingRef.current) setDeleteOpen(open);
					}}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Nachricht löschen?</AlertDialogTitle>
							<AlertDialogDescription>
								Der Inhalt wird für alle entfernt. Die Nachricht bleibt als gelöscht markiert.
							</AlertDialogDescription>
						</AlertDialogHeader>
						{error && (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						)}
						<AlertDialogFooter>
							<AlertDialogCancel disabled={pending} className="min-h-11">
								Abbrechen
							</AlertDialogCancel>
							<AlertDialogAction
								disabled={pending}
								variant="destructive"
								className="min-h-11"
								aria-label="Nachricht endgültig löschen"
								onClick={() => void remove()}
							>
								{pending && <Spinner data-icon="inline-start" />}
								{pending ? 'Wird gelöscht…' : 'Jetzt löschen'}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</MessageContent>
		</Message>
	);
}
