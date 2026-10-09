import type {
	Announcement,
	AnnouncementComment,
	ReactionKey,
} from '@/features/pinnwand/components/announcement-types';

/** Optimistic card edits; pure so the board can apply and roll them back field by field. */

interface Reactor {
	memberId: string;
	name: string;
	color: string | null;
}

/** The card after the viewer toggled `reaction`; "take" also adds or removes them as taker. */
export function withToggledReaction(
	item: Announcement,
	reaction: ReactionKey,
	active: boolean,
	reactor: Reactor,
): Announcement {
	return {
		...item,
		myReactions: active
			? item.myReactions.filter((current) => current !== reaction)
			: [...item.myReactions, reaction],
		reactionCounts: {
			...item.reactionCounts,
			[reaction]: Math.max(0, (item.reactionCounts[reaction] ?? 0) + (active ? -1 : 1)),
		},
		takers:
			reaction !== 'take'
				? item.takers
				: active
					? item.takers.filter((taker) => taker.memberId !== reactor.memberId)
					: [...item.takers, reactor],
	};
}

/** The card with one comment replaced (or removed), comments kept in creation order. */
export function withReplacedComment(
	item: Announcement,
	commentId: string,
	replacement: AnnouncementComment | null,
): Announcement {
	const others = item.comments.filter((comment) => comment.id !== commentId);
	const comments = replacement ? [...others, replacement] : others;
	return {
		...item,
		comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
	};
}

/** `item` with the given fields taken from `before`; other fields keep their newer values. */
export function withRestoredFields<K extends keyof Announcement>(
	item: Announcement,
	before: Announcement,
	keys: readonly K[],
): Announcement {
	const restored = { ...item };
	for (const key of keys) restored[key] = before[key];
	return restored;
}

/** A saved draft is only worth restoring when it holds text that differs from the starting text. */
export function isRestorableDraft(saved: unknown, initial: string): saved is { content: string } {
	const content = (saved as { content?: unknown } | null | undefined)?.content;
	return typeof content === 'string' && content.length > 0 && content !== initial;
}
