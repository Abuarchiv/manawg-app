'use client';

import {
	Card,
	CardAction,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@/components/ui/card';
import { MemberAvatar } from '@/components/wg/MemberAvatar';
import { formatRelativeTime, formatTimeFull } from '@/core/utils/time';
import {
	REACTION_OPTIONS,
	SOURCE_LABELS,
	pickReactionOptions,
} from '@/features/pinnwand/announcement-card-model';
import { buildPinnwandPrefill } from '@/features/pinnwand/pinnwand-prefill';
import { cn } from '@/shared/lib/cn';
import type { MemberInfo } from '@/shared/lib/member-types';
import { Pin } from 'lucide-react';
import { type ReactElement, memo, useState } from 'react';
import { AnnouncementActionsMenu } from './AnnouncementActionsMenu';
import { AnnouncementBody } from './AnnouncementBody';
import { AnnouncementDeleteDialog } from './AnnouncementDeleteDialog';
import { AnnouncementEditDrawer } from './AnnouncementEditDrawer';
import { AnnouncementFooter } from './AnnouncementFooter';
import { actionLabelSubject } from './CommentRow';
import type { Announcement, AnnouncementKind, ReactionKey } from './announcement-types';
import { KIND_LABELS } from './constants';

interface AnnouncementCardProps {
	announcement: Announcement;
	author: MemberInfo;
	deletePending: boolean;
	pinPending: boolean;
	statusPending: boolean;
	/** Comma-separated reactions with a request in flight (a string, not a function, so memo holds). */
	pendingReactions: string;
	onDelete: (announcement: Announcement) => Promise<string | null>;
	onTogglePinned: (announcement: Announcement) => void;
	onToggleStatus: (announcement: Announcement) => void;
	onEdit: (
		announcement: Announcement,
		next: { content: string; kind: AnnouncementKind },
	) => Promise<boolean>;
	onToggleReaction: (announcement: Announcement, reaction: ReactionKey) => void;
	onAddComment: (announcement: Announcement, content: string) => Promise<boolean>;
	onUpdateComment: (
		announcement: Announcement,
		commentId: string,
		content: string,
	) => Promise<boolean>;
	onDeleteComment: (announcement: Announcement, commentId: string) => Promise<boolean>;
	currentMemberId: string;
	isAdmin: boolean;
	shareCode: string;
	highlighted: boolean;
}

export const AnnouncementCard = memo(function AnnouncementCard({
	announcement,
	author,
	deletePending,
	pinPending,
	statusPending,
	pendingReactions,
	onDelete,
	onTogglePinned,
	onToggleStatus,
	onEdit,
	onToggleReaction,
	onAddComment,
	onUpdateComment,
	onDeleteComment,
	currentMemberId,
	isAdmin,
	shareCode,
	highlighted,
}: AnnouncementCardProps): ReactElement {
	const reactionPending = (key: ReactionKey): boolean => pendingReactions.includes(key);
	const bodyText = announcement.content.trim();
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [editOpen, setEditOpen] = useState(false);
	const [touchedReactions, setTouchedReactions] = useState<ReactionKey[]>([]);
	const draftKey = `manawg:draft:${shareCode}:${currentMemberId}:announcement:${announcement.id}`;

	const isResolved = announcement.status === 'resolved';
	const isPinned = Boolean(announcement.pinnedAt);
	const isAuthor = announcement.authorMemberId === currentMemberId;
	const canModerate = isAuthor || isAdmin;
	// Only the author rewrites a post, and only one they typed themselves (not system posts).
	const canEdit = isAuthor && announcement.source === 'manual';
	const canResolve = isAuthor || isAdmin || announcement.myReactions.includes('take');
	const sourceLabel = SOURCE_LABELS[announcement.source];
	const sourceHref = announcement.sourcePath
		? `/wg/${encodeURIComponent(shareCode)}${announcement.sourcePath}`
		: null;
	const actionSubject = actionLabelSubject(bodyText, 'leerer Beitrag');
	const reactions = pickReactionOptions(announcement, touchedReactions);
	const busy =
		deletePending ||
		pinPending ||
		statusPending ||
		REACTION_OPTIONS.some(({ key }) => reactionPending(key));

	function react(key: ReactionKey) {
		setTouchedReactions((current) => (current.includes(key) ? current : [...current, key]));
		onToggleReaction(announcement, key);
	}

	return (
		<li
			id={`announcement-${announcement.id}`}
			className={cn(
				'scroll-mt-24 [contain-intrinsic-size:auto_9rem] [content-visibility:auto]',
				highlighted && 'ring-2 ring-inset ring-ring',
			)}
		>
			{/* Borderless: the list draws borders and dividers so the board reads like a feed. */}
			<Card
				size="sm"
				aria-busy={busy}
				className="gap-1.5 rounded-none border-0 bg-transparent pt-2.5"
			>
				<CardHeader>
					<CardTitle className="flex min-w-0 items-center gap-2 font-sans font-normal">
						<MemberAvatar name={author.name} size={28} />
						<span className="min-w-0 break-words text-[12px] leading-snug text-muted-foreground">
							<span className="font-medium text-foreground">{author.name}</span> ·{' '}
							<time
								dateTime={announcement.createdAt}
								title={formatTimeFull(announcement.createdAt)}
							>
								{formatRelativeTime(announcement.createdAt)}
							</time>{' '}
							· {KIND_LABELS[announcement.kind]}
							{sourceLabel && ` · ${sourceLabel}`}
						</span>
						{isPinned && (
							<Pin aria-label="Fixiert" className="size-3.5 shrink-0 text-muted-foreground" />
						)}
					</CardTitle>
					<CardAction>
						<AnnouncementActionsMenu
							actionSubject={actionSubject}
							shareCode={shareCode}
							sourceHref={sourceHref}
							prefill={announcement.source === 'manual' ? buildPinnwandPrefill(bodyText) : null}
							hiddenReactions={reactions.hidden}
							reactionPending={reactionPending}
							isPinned={isPinned}
							isResolved={isResolved}
							canModerate={canModerate}
							canEdit={canEdit}
							canResolve={canResolve}
							deletePending={deletePending}
							pinPending={pinPending}
							statusPending={statusPending}
							onReact={react}
							onTogglePinned={() => onTogglePinned(announcement)}
							onToggleStatus={() => onToggleStatus(announcement)}
							onEdit={() => setEditOpen(true)}
							onDelete={() => setDeleteOpen(true)}
						/>
					</CardAction>
				</CardHeader>
				<CardContent className="flex flex-col gap-2">
					<AnnouncementBody
						announcement={announcement}
						bodyText={bodyText}
						actionSubject={actionSubject}
						busy={busy}
					/>
				</CardContent>
				<CardFooter className="flex-col items-stretch gap-2 border-t-0 bg-transparent px-1.5 pt-0 pb-1">
					<AnnouncementFooter
						announcement={announcement}
						actionSubject={actionSubject}
						currentMemberId={currentMemberId}
						isAdmin={isAdmin}
						draftKey={draftKey}
						visibleReactions={reactions.visible}
						reactionPending={reactionPending}
						canResolve={canResolve}
						statusPending={statusPending}
						onReact={react}
						onToggleStatus={() => onToggleStatus(announcement)}
						onAddComment={(content) => onAddComment(announcement, content)}
						onUpdateComment={(commentId, content) =>
							onUpdateComment(announcement, commentId, content)
						}
						onDeleteComment={(commentId) => onDeleteComment(announcement, commentId)}
					/>
				</CardFooter>
			</Card>
			{editOpen && (
				<AnnouncementEditDrawer
					open
					onOpenChange={setEditOpen}
					announcement={announcement}
					onSave={(next) => onEdit(announcement, next)}
				/>
			)}
			<AnnouncementDeleteDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				actionSubject={actionSubject}
				deletePending={deletePending}
				onDelete={() => onDelete(announcement)}
			/>
		</li>
	);
});
