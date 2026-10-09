'use client';

import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from '@/components/animate-ui/primitives/base/collapsible';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from '@/components/ui/input-group';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { CheckCircle2, MessageCircle, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { REACTION_ICONS, reactionLabel } from './AnnouncementActionsMenu';
import { CommentRow, useCommentDraft } from './CommentRow';
import type { Announcement, ReactionKey } from './announcement-types';

interface AnnouncementFooterProps {
	announcement: Announcement;
	actionSubject: string;
	currentMemberId: string;
	isAdmin: boolean;
	draftKey: string;
	visibleReactions: ReactionKey[];
	reactionPending: (key: ReactionKey) => boolean;
	canResolve: boolean;
	statusPending: boolean;
	onReact: (key: ReactionKey) => void;
	onToggleStatus: () => void;
	onAddComment: (content: string) => Promise<boolean>;
	onUpdateComment: (commentId: string, content: string) => Promise<boolean>;
	onDeleteComment: (commentId: string) => Promise<boolean>;
}

/** Reaction buttons, the "done" shortcut and the collapsible reply thread with its composer. */
export function AnnouncementFooter({
	announcement,
	actionSubject,
	currentMemberId,
	isAdmin,
	draftKey,
	visibleReactions,
	reactionPending,
	canResolve,
	statusPending,
	onReact,
	onToggleStatus,
	onAddComment,
	onUpdateComment,
	onDeleteComment,
}: AnnouncementFooterProps) {
	const [commentsOpen, setCommentsOpen] = useState(false);
	const [commentPending, setCommentPending] = useState(false);
	const [commentError, setCommentError] = useState(false);
	const commentPendingRef = useRef(false);
	const replyRef = useRef<HTMLTextAreaElement>(null);
	const commentDraft = useCommentDraft(`${draftKey}:reply`);
	const isResolved = announcement.status === 'resolved';
	const commentCount = announcement.comments.length;
	useEffect(() => {
		if (commentDraft.restored) setCommentsOpen(true);
	}, [commentDraft.restored]);

	async function submitComment() {
		const text = commentDraft.draft.trim();
		if (!text || commentPendingRef.current) return;
		commentPendingRef.current = true;
		setCommentPending(true);
		setCommentError(false);
		try {
			const ok = await onAddComment(text);
			if (ok) commentDraft.clear();
			else setCommentError(true);
		} finally {
			commentPendingRef.current = false;
			setCommentPending(false);
			// The disabled send button takes focus with it: return focus to the field so the next text can be typed right away.
			if (document.activeElement === document.body)
				replyRef.current?.focus({ preventScroll: true });
		}
	}

	return (
		<Collapsible
			open={commentsOpen}
			onOpenChange={setCommentsOpen}
			className="flex min-w-0 max-w-full flex-col gap-2"
		>
			<div className="flex flex-wrap items-center gap-1">
				{visibleReactions.map((key) => {
					const Icon = REACTION_ICONS[key];
					const label = reactionLabel(key);
					const active = announcement.myReactions.includes(key);
					const count = announcement.reactionCounts[key] ?? 0;
					return (
						<Button
							key={key}
							variant={active ? 'secondary' : 'ghost'}
							size="sm"
							className="gap-1 pr-2 text-[12px] aria-disabled:pointer-events-none aria-disabled:opacity-50"
							onClick={() => {
								if (!reactionPending(key)) onReact(key);
							}}
							aria-disabled={reactionPending(key) || undefined}
							aria-pressed={active}
							aria-label={`${label}-Reaktion: ${actionSubject}`}
						>
							{reactionPending(key) ? (
								<Spinner data-icon="inline-start" />
							) : (
								<Icon data-icon="inline-start" />
							)}
							{label}
							{count > 0 && <span className="tabular-nums">{count}</span>}
						</Button>
					);
				})}
				<CollapsibleTrigger
					render={
						<Button variant="ghost" size="sm" className="ml-auto min-w-9 gap-1 text-[12px]" />
					}
					aria-label={`Antworten anzeigen: ${actionSubject}${commentCount > 0 ? ` (${commentCount})` : ''}`}
					aria-controls={`announcement-comments-${announcement.id}`}
				>
					<MessageCircle aria-hidden />
					{commentCount > 0 && <span className="tabular-nums">{commentCount}</span>}
				</CollapsibleTrigger>
				{/* Infos and decisions fade out by themselves; everything else is closed here. */}
				{!isResolved &&
					canResolve &&
					announcement.kind !== 'info' &&
					announcement.kind !== 'decision' && (
						<Button
							variant="outline"
							size="sm"
							className="gap-1 pr-2 text-[12px]"
							disabled={statusPending}
							onClick={onToggleStatus}
							aria-label={`Als geklärt markieren: ${actionSubject}`}
						>
							{statusPending ? (
								<Spinner data-icon="inline-start" />
							) : (
								<CheckCircle2 data-icon="inline-start" />
							)}
							Geklärt
						</Button>
					)}
			</div>
			<CollapsiblePanel
				keepRendered
				inert={!commentsOpen}
				id={`announcement-comments-${announcement.id}`}
			>
				<div className="flex flex-col gap-3">
					<Separator />
					{commentCount > 0 && (
						<ul className="flex flex-col gap-4">
							{announcement.comments.map((comment) => (
								<CommentRow
									key={comment.id}
									comment={comment}
									canEdit={comment.memberId === currentMemberId && !comment.id.startsWith('temp-')}
									canDelete={
										(comment.memberId === currentMemberId || isAdmin) &&
										!comment.id.startsWith('temp-')
									}
									draftKey={`${draftKey}:edit:${comment.id}`}
									onUpdate={(text) => onUpdateComment(comment.id, text)}
									onDelete={() => onDeleteComment(comment.id)}
								/>
							))}
						</ul>
					)}
					{commentError && (
						<Alert id={`announcement-comment-error-${announcement.id}`} variant="destructive">
							<AlertDescription>
								Antwort nicht gespeichert. Dein Text bleibt zum erneuten Senden erhalten.
							</AlertDescription>
						</Alert>
					)}
					<Field data-invalid={commentError} className="data-[invalid=true]:text-foreground">
						<InputGroup>
							<InputGroupTextarea
								ref={replyRef}
								value={commentDraft.draft}
								onChange={(event) => commentDraft.change(event.target.value)}
								readOnly={commentPending}
								aria-busy={commentPending}
								aria-invalid={commentError}
								aria-describedby={
									commentError ? `announcement-comment-error-${announcement.id}` : undefined
								}
								maxLength={600}
								rows={1}
								aria-label={`Antwort verfassen: ${actionSubject}`}
								placeholder="Antwort schreiben"
								className="max-h-40 text-base read-only:opacity-60"
							/>
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									variant="default"
									size="icon-sm"
									disabled={commentPending || !commentDraft.draft.trim()}
									onClick={() => void submitComment()}
									aria-label={`Antworten: ${actionSubject}`}
								>
									{commentPending ? <Spinner /> : <Send />}
								</InputGroupButton>
							</InputGroupAddon>
						</InputGroup>
					</Field>
				</div>
			</CollapsiblePanel>
		</Collapsible>
	);
}
