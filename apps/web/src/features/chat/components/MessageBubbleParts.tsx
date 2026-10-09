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
import { BubbleReactions } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useWg } from '@/components/wg/WgContextProvider';
import type { RefObject } from 'react';
import { reactorNames } from '../chat-reactions';
import type { ReactionSummary } from '../chat-types';

interface MessageEditFormProps {
	messageId: string;
	draft: string;
	error: string | null;
	pending: boolean;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	onChange: (value: string) => void;
	onSave: () => void;
	onCancel: () => void;
	/** Escape cancels only while no save is running. */
	canCancel: () => boolean;
}

export function MessageEditForm({
	messageId,
	draft,
	error,
	pending,
	textareaRef,
	onChange,
	onSave,
	onCancel,
	canCancel,
}: MessageEditFormProps) {
	return (
		<FieldGroup className="gap-2">
			<Field data-invalid={Boolean(error)} className="data-[invalid=true]:text-foreground">
				<Textarea
					ref={textareaRef}
					value={draft}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							onSave();
						}
						if (event.key === 'Escape' && canCancel()) onCancel();
					}}
					rows={3}
					disabled={pending}
					maxLength={4000}
					aria-label="Nachricht bearbeiten"
					aria-invalid={Boolean(error)}
					aria-describedby={error ? `message-edit-error-${messageId}` : undefined}
					className="min-h-24 text-base"
				/>
			</Field>
			<div className="flex flex-wrap justify-end gap-2">
				<Button variant="outline" disabled={pending} onClick={onCancel}>
					Abbrechen
				</Button>
				<Button disabled={pending || !draft.trim()} onClick={onSave}>
					{pending && <Spinner data-icon="inline-start" />}
					{pending ? 'Wird gespeichert…' : 'Speichern'}
				</Button>
			</div>
		</FieldGroup>
	);
}

interface MessageReactionsProps {
	reactions: ReactionSummary[];
	align: 'start' | 'end';
	senderName: string;
	disabled: boolean;
	pendingEmoji: string | null;
	onToggle: (emoji: string, mine: boolean) => void;
}

export function MessageReactions({
	reactions,
	align,
	senderName,
	disabled,
	pendingEmoji,
	onToggle,
}: MessageReactionsProps) {
	const { members, identity } = useWg();
	return (
		<BubbleReactions
			align={align}
			className="static max-w-full flex-wrap translate-y-0 gap-1 bg-transparent p-0 ring-0 group-data-[align=end]/bubble:self-end has-[button]:p-0"
		>
			{reactions.map((reaction) => {
				const who = reactorNames(reaction.memberIds, members, identity.memberId);
				return (
					<Button
						key={reaction.emoji}
						variant={reaction.mine ? 'secondary' : 'outline'}
						size="xs"
						className="rounded-full"
						onClick={() => onToggle(reaction.emoji, reaction.mine)}
						disabled={disabled}
						aria-pressed={reaction.mine}
						title={who}
						aria-label={`Reaktion ${reaction.emoji} (${reaction.count}) von ${who}: ${reaction.mine ? 'entfernen' : 'hinzufügen'} — Nachricht von ${senderName}`}
					>
						{pendingEmoji === reaction.emoji ? <Spinner /> : <span>{reaction.emoji}</span>}
						<span className="tabular-nums">{reaction.count}</span>
					</Button>
				);
			})}
		</BubbleReactions>
	);
}

export function MessageImage({ imageUrl, senderName }: { imageUrl: string; senderName: string }) {
	return (
		<Attachment state="done" className="min-w-0 max-w-full">
			<AttachmentMedia variant="image" className="size-20">
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img src={imageUrl} alt={`Bild von ${senderName}`} loading="lazy" />
			</AttachmentMedia>
			<AttachmentContent>
				<AttachmentTitle>Bild</AttachmentTitle>
				<AttachmentDescription>Öffnen</AttachmentDescription>
			</AttachmentContent>
			<AttachmentTrigger
				aria-label="Bild in voller Größe öffnen"
				render={
					<a href={imageUrl} target="_blank" rel="noopener noreferrer">
						<span className="sr-only">Bild in voller Größe öffnen</span>
					</a>
				}
			/>
		</Attachment>
	);
}

interface MessageDeleteDialogProps {
	open: boolean;
	pending: boolean;
	error: string | null;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	/** Where focus goes after closing; true = default (the trigger). */
	finalFocus?: () => HTMLElement | true;
}

export function MessageDeleteDialog({
	open,
	pending,
	error,
	onOpenChange,
	onConfirm,
	finalFocus,
}: MessageDeleteDialogProps) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent finalFocus={finalFocus}>
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
						onClick={onConfirm}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{pending ? 'Wird gelöscht…' : 'Jetzt löschen'}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
