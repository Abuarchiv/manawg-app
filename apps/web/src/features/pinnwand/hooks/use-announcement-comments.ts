import { apiFetch } from '@/core/infra/api-client';
import { notificationWarningMessage } from '@/core/notifications/notification-warning';
import { createOfflineIdempotencyKey } from '@/core/offline/offline-queue';
import type { CommentOverrides } from '@/features/pinnwand/comment-overrides';
import type {
	Announcement,
	AnnouncementComment,
} from '@/features/pinnwand/components/announcement-types';
import { type MutableRefObject, useRef } from 'react';
import { announcementListEdits } from './announcement-list-edits';
import type {
	AnnouncementCommentResponse,
	AnnouncementPageContext,
} from './announcement-page-context';

/**
 * Adding, editing and deleting replies on a card. Each change is shown at once and remembered as
 * a comment override, so a background refresh cannot undo it before the server reflects it.
 */
export function useAnnouncementComments(
	ctx: AnnouncementPageContext,
	commentOverridesRef: MutableRefObject<CommentOverrides>,
) {
	const {
		identity,
		members,
		toast,
		encodedShareCode,
		isPending,
		start,
		end,
		setActionError,
		load,
	} = ctx;
	const commentIdempotencyKeysRef = useRef(new Map<string, string>());
	const edits = announcementListEdits(ctx, commentOverridesRef);
	const commentUrl = (announcementId: string, commentId?: string) =>
		`/api/wg/${encodedShareCode}/announcements/${encodeURIComponent(announcementId)}/comments${
			commentId === undefined ? '' : `/${encodeURIComponent(commentId)}`
		}`;

	async function addComment(announcement: Announcement, content: string): Promise<boolean> {
		const pendingKey = `${announcement.id}:comment`;
		if (isPending(pendingKey)) return false;
		const optimisticComment: AnnouncementComment = {
			id: `temp-${Date.now()}`,
			announcementId: announcement.id,
			memberId: identity.memberId,
			content,
			createdAt: new Date().toISOString(),
			authorName: identity.name,
			authorColor: members.find((member) => member.id === identity.memberId)?.color ?? null,
		};
		edits.rememberCommentOverride(announcement.id, optimisticComment.id, optimisticComment);
		edits.updateItem(announcement.id, (item) => ({
			...item,
			comments: [...item.comments, optimisticComment],
		}));
		start(pendingKey);
		const commentRequestKey = `${announcement.id}:${content}`;
		const idempotencyKey =
			commentIdempotencyKeysRef.current.get(commentRequestKey) ?? createOfflineIdempotencyKey();
		if (!idempotencyKey) {
			end(pendingKey);
			return false;
		}
		commentIdempotencyKeysRef.current.set(commentRequestKey, idempotencyKey);
		const res = await apiFetch<AnnouncementCommentResponse>(commentUrl(announcement.id), {
			method: 'POST',
			memberId: identity.memberId,
			headers: { 'Idempotency-Key': idempotencyKey },
			body: JSON.stringify({ content }),
		});
		end(pendingKey);
		if (!res.ok) {
			if (res.status > 0 && res.status < 500 && res.status !== 429) {
				commentIdempotencyKeysRef.current.delete(commentRequestKey);
			}
			if (res.status === 404 && res.error === 'announcement_not_found') {
				commentOverridesRef.current.delete(announcement.id);
				edits.dropVanishedAnnouncement(announcement.id);
			} else {
				edits.forgetCommentOverride(announcement.id, optimisticComment.id);
				edits.replaceComment(announcement.id, optimisticComment.id, null);
			}
			return false;
		}
		commentIdempotencyKeysRef.current.delete(commentRequestKey);
		edits.forgetCommentOverride(announcement.id, optimisticComment.id);
		const confirmedComment = { ...optimisticComment, ...res.data.comment };
		edits.rememberCommentOverride(announcement.id, confirmedComment.id, confirmedComment);
		edits.updateItem(announcement.id, (item) => ({
			...item,
			comments: item.comments.map((comment) =>
				comment.id === optimisticComment.id ? confirmedComment : comment,
			),
		}));
		const warningMessage = notificationWarningMessage(res.data.warning);
		if (warningMessage) toast.info(warningMessage);
		void load('background');
		return true;
	}

	async function updateComment(
		announcement: Announcement,
		commentId: string,
		content: string,
	): Promise<boolean> {
		const pendingKey = `${commentId}:comment-edit`;
		if (isPending(pendingKey)) return false;
		const previousComment = announcement.comments.find((comment) => comment.id === commentId);
		if (previousComment) {
			edits.rememberCommentOverride(announcement.id, commentId, { ...previousComment, content });
		}
		edits.updateItem(announcement.id, (item) => ({
			...item,
			comments: item.comments.map((comment) =>
				comment.id === commentId ? { ...comment, content } : comment,
			),
		}));
		start(pendingKey);
		const res = await apiFetch<{ comment: AnnouncementComment }>(
			commentUrl(announcement.id, commentId),
			{
				method: 'PATCH',
				memberId: identity.memberId,
				body: JSON.stringify({ content }),
			},
		);
		end(pendingKey);
		if (!res.ok) {
			edits.forgetCommentOverride(announcement.id, commentId);
			if (res.status === 404 && res.error === 'comment_not_found') {
				edits.updateItem(announcement.id, (item) => ({
					...item,
					comments: item.comments.filter((comment) => comment.id !== commentId),
				}));
				setActionError('Diese Antwort existiert nicht mehr und wurde entfernt.');
				return true;
			}
			if (previousComment) edits.replaceComment(announcement.id, commentId, previousComment);
			return false;
		}
		const confirmedComment = { ...previousComment, ...res.data.comment };
		edits.rememberCommentOverride(announcement.id, confirmedComment.id, confirmedComment);
		edits.updateItem(announcement.id, (item) => ({
			...item,
			comments: item.comments.map((comment) =>
				comment.id === commentId ? confirmedComment : comment,
			),
		}));
		void load('background');
		return true;
	}

	async function deleteComment(announcement: Announcement, commentId: string): Promise<boolean> {
		const pendingKey = `${commentId}:comment-delete`;
		if (isPending(pendingKey)) return false;
		start(pendingKey);
		const res = await apiFetch<Record<string, never>>(commentUrl(announcement.id, commentId), {
			method: 'DELETE',
			memberId: identity.memberId,
		});
		end(pendingKey);
		const gone = res.ok || (res.status === 404 && res.error === 'comment_not_found');
		if (!gone) {
			// The comment stays until the server confirms; the open dialog shows the error.
			return false;
		}
		// Remove only now: removing earlier would unmount the row and its dialog mid-request.
		edits.rememberCommentOverride(announcement.id, commentId, null);
		edits.updateItem(announcement.id, (item) => ({
			...item,
			comments: item.comments.filter((comment) => comment.id !== commentId),
		}));
		if (!res.ok) setActionError('Diese Antwort existiert nicht mehr und wurde entfernt.');
		void load('background');
		return true;
	}

	return { addComment, updateComment, deleteComment };
}
