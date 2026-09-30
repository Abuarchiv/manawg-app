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
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/components/ui/message';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { memberTint } from '@/components/wg/MemberAvatar';
import { readDraft, removeDraft, writeDraft } from '@/core/offline/drafts';
import { formatTimeFull } from '@/core/utils/time';
import { cn } from '@/shared/lib/cn';
import { haptic } from '@/shared/lib/haptics';
import { Copy, Pencil, Reply, Smile, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { canDeleteMessage, canEditMessage, resolveStoredEditDraft } from '../chat-pure';
import { ReactionPicker } from './ReactionPicker';

const BUBBLE_TEXT = 'rounded-2xl px-3 py-1.5 text-[14px] leading-snug';
const TIME_FORMAT = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

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
	const [reactOpen, setReactOpen] = useState(false);
	const pendingRef = useRef(false);
	const reactionRef = useRef(false);
	const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const actionsTriggerRef = useRef<HTMLButtonElement | null>(null);
	const wasEditingRef = useRef(false);
	const isDeleted = Boolean(message.deletedAt);
	const editable = canEditMessage(message, { id: currentMemberId });
	const deletable = canDeleteMessage(message, {
		id: currentMemberId,
		role: isAdmin ? 'admin' : null,
	});
	const senderName = sender?.name ?? 'Unbekannt';
	const align = isOwn ? 'end' : 'start';
	const messageBody = message.body ?? '';
	// Uhrzeit klein unten rechts in der Blase wie bei WhatsApp; das Datum steht im Tagestrenner.
	const timeStamp = (
		<span className="float-end ms-2 mt-1.5 text-[11px] leading-none tabular-nums opacity-70">
			{message.editedAt && 'bearbeitet · '}
			<time dateTime={message.createdAt} title={formatTimeFull(message.createdAt)}>
				{TIME_FORMAT.format(new Date(message.createdAt))}
			</time>
		</span>
	);

	useEffect(() => {
		// Keep the active textarea stable if a message update arrives mid-edit.
		if (editing) return;
		const stored = readDraft<{ body?: string; base?: string }>(draftKey);
		const resolved = resolveStoredEditDraft(stored, messageBody);
		if (resolved.discard) removeDraft(draftKey);
		if (resolved.text !== null) {
			if (typeof stored?.base !== 'string')
				writeDraft(draftKey, { body: resolved.text, base: messageBody });
			setDraft(resolved.text);
			setHasDraft(true);
			return;
		}
		setDraft(messageBody);
		setHasDraft(false);
	}, [draftKey, editing, messageBody]);
	useEffect(() => {
		if (editing) {
			wasEditingRef.current = true;
			editTextareaRef.current?.focus();
		} else if (wasEditingRef.current) {
			wasEditingRef.current = false;
			actionsTriggerRef.current?.focus();
		}
	}, [editing]);
	function changeDraft(value: string) {
		setDraft(value);
		setHasDraft(true);
		writeDraft(draftKey, { body: value, base: messageBody });
	}
	function cancelEdit() {
		if (pendingRef.current) return;
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
			{/* Wie WhatsApp: eigene Nachrichten ohne Avatar, fremde mit Avatar und Name nur am Anfang einer Folge. */}
			{!isOwn && (
				<MessageAvatar className={grouped ? 'invisible' : undefined} aria-hidden>
					<Avatar className="size-7 text-xs">
						<AvatarFallback style={memberTint(senderName)}>
							{senderName.slice(0, 2).toLocaleUpperCase('de-DE')}
						</AvatarFallback>
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
					<FieldGroup className="gap-2">
						<Field data-invalid={Boolean(error)}>
							<Textarea
								ref={editTextareaRef}
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
					<BubbleGroup className="min-w-0 max-w-[85%] group-data-[align=end]/message:self-end">
						<Bubble
							variant={isDeleted ? 'muted' : isOwn ? 'default' : 'secondary'}
							align={align}
							className="max-w-full"
						>
							{isDeleted ? (
								<BubbleContent className={BUBBLE_TEXT}>
									<p>
										Diese Nachricht wurde gelöscht.
										{timeStamp}
									</p>
								</BubbleContent>
							) : (
								// Tippen auf die Blase öffnet Antworten, Reagieren usw. (wie Telegram) statt eines ⋯ daneben.
								<DropdownMenu>
									<DropdownMenuTrigger
										ref={actionsTriggerRef}
										disabled={pending}
										render={
											<BubbleContent
												// Der Trigger setzt sonst data-slot="dropdown-menu-trigger"; die Blasenfarben hängen am Slot.
												data-slot="bubble-content"
												render={<button type="button" />}
												className={cn(BUBBLE_TEXT, 'cursor-pointer')}
											/>
										}
									>
										<span className="sr-only">Aktionen für Nachricht von {senderName}: </span>
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
										{/* Spans statt <p>: Absatz-Elemente sind in einem <button> nicht erlaubt. */}
										<span className="block whitespace-pre-wrap [overflow-wrap:anywhere]">
											{message.body}
											{timeStamp}
										</span>
									</DropdownMenuTrigger>
									<DropdownMenuContent align={isOwn ? 'end' : 'start'} className="w-48">
										<DropdownMenuGroup>
											<DropdownMenuItem
												className="min-h-11"
												disabled={Boolean(reactionPending)}
												onClick={() => setReactOpen(true)}
											>
												<Smile aria-hidden /> Reagieren
											</DropdownMenuItem>
											<DropdownMenuItem
												className="min-h-11"
												onClick={() => {
													haptic('selection');
													onReply();
												}}
											>
												<Reply aria-hidden /> Antworten
											</DropdownMenuItem>
											{message.body && (
												<DropdownMenuItem
													className="min-h-11"
													onClick={() => void navigator.clipboard?.writeText(message.body ?? '')}
												>
													<Copy aria-hidden /> Kopieren
												</DropdownMenuItem>
											)}
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
							{reactions.length > 0 && (
								<BubbleReactions
									align={align}
									className="static max-w-full flex-wrap translate-y-0 gap-1 bg-transparent p-0 ring-0 group-data-[align=end]/bubble:self-end has-[button]:p-0"
								>
									{reactions.map((reaction) => (
										<Button
											key={reaction.emoji}
											variant={reaction.mine ? 'secondary' : 'outline'}
											size="xs"
											className="rounded-full"
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
				<ReactionPicker
					open={reactOpen}
					onOpenChange={setReactOpen}
					onSelect={(emoji) => toggleReaction(emoji, false)}
					returnFocusRef={actionsTriggerRef}
				/>
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
