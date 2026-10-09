import { SYSTEM_MESSAGE_KIND } from '@/core/feed-kinds';
const EDIT_WINDOW_MS_DEFAULT = 15 * 60 * 1000;
const TEXT_MESSAGE_KIND = 'text';

export const CHAT_REFRESH_BATCH_SIZE = 100;

interface ChatMessageLike {
	id: string;
	senderMemberId: string | null;
	kind: string;
	deletedAt?: Date | string | null;
	createdAt: Date | string;
}

interface ChatMemberLike {
	id: string;
	role?: string | null;
}

// Text helpers (mentions, links, day labels) live in ./chat-text; re-exported for existing callers.
export { detectMention, type MentionTrigger } from './chat-text';

/** The viewer's last read message as the server reports it when the chat opens. */
export interface ChatReadMarker {
	messageId: string;
	createdAt: string;
}

/**
 * The first message after the read marker that the viewer did not write themselves, i.e. where
 * the "Neue Nachrichten" divider goes. `null` when there is no marker (never opened) or nothing
 * foreign is unread. A marker older than the loaded page counts as "before the first message".
 */
export function findFirstUnreadId(
	messages: ReadonlyArray<{
		id: string;
		senderMemberId: string | null;
		createdAt: string;
		deletedAt?: string | null;
		systemPayload?: Record<string, unknown> | null;
	}>,
	marker: ChatReadMarker | null,
	currentMemberId: string,
): string | null {
	if (!marker) return null;
	const markerIndex = messages.findIndex((message) => message.id === marker.messageId);
	const markerTime = Date.parse(marker.createdAt);
	const start =
		markerIndex >= 0
			? markerIndex + 1
			: messages.findIndex((message) => Date.parse(message.createdAt) > markerTime);
	if (start < 0) return null;
	// Same rule as the unread counter: deleted messages and the viewer's own actions are not news.
	const next = messages.slice(start).find((message) => {
		if (message.deletedAt) return false;
		return message.senderMemberId
			? message.senderMemberId !== currentMemberId
			: message.systemPayload?.actorMemberId !== currentMemberId;
	});
	return next?.id ?? null;
}

function toDate(value: Date | string): Date {
	return value instanceof Date ? value : new Date(value);
}

function isoDayKey(date: Date, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(date);
}

interface MessageDayGroup<T extends { createdAt: Date | string }> {
	day: Date;
	key: string;
	messages: T[];
}

export function groupMessagesByDay<T extends { createdAt: Date | string }>(
	messages: ReadonlyArray<T>,
	locale = 'de-DE',
): MessageDayGroup<T>[] {
	const groups: MessageDayGroup<T>[] = [];
	const lookup = new Map<string, MessageDayGroup<T>>();
	for (const message of messages) {
		const date = toDate(message.createdAt);
		if (Number.isNaN(date.getTime())) continue;
		const key = isoDayKey(date, locale);
		const existing = lookup.get(key);
		if (existing) {
			existing.messages.push(message);
			continue;
		}
		const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
		const group: MessageDayGroup<T> = { day, key, messages: [message] };
		lookup.set(key, group);
		groups.push(group);
	}
	return groups;
}

export function canEditMessage(
	message: ChatMessageLike,
	member: ChatMemberLike,
	now: Date | number = Date.now(),
	maxEditWindowMs = EDIT_WINDOW_MS_DEFAULT,
): boolean {
	if (message.kind !== TEXT_MESSAGE_KIND) return false;
	if (message.deletedAt) return false;
	if (message.senderMemberId !== member.id) return false;
	const createdMs = toDate(message.createdAt).getTime();
	const nowMs = typeof now === 'number' ? now : now.getTime();
	return nowMs - createdMs <= maxEditWindowMs;
}

export function canDeleteMessage(message: ChatMessageLike, member: ChatMemberLike): boolean {
	if (message.deletedAt) return false;
	if (message.kind === SYSTEM_MESSAGE_KIND) return member.role === 'admin';
	if (message.senderMemberId === member.id) return true;
	return member.role === 'admin';
}

// Pictographs, flags and keycaps; plain letters, digits and punctuation are not emoji.
const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;

export function isSingleEmoji(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 16) return false;
	try {
		const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
		const segments = [...segmenter.segment(trimmed)];
		return segments.length === 1 && EMOJI_PATTERN.test(trimmed);
	} catch {
		// Without Intl.Segmenter graphemes cannot be counted; the length cap above is the bound.
		return EMOJI_PATTERN.test(trimmed);
	}
}

export function sanitizeMessageBody(body: unknown, maxLength = 4000): string | null {
	if (typeof body !== 'string') return null;
	const trimmed = body.trim();
	if (trimmed.length === 0) return null;
	return trimmed.length > maxLength ? null : trimmed;
}

export function previewBody(body: string | null | undefined, max = 120): string {
	if (typeof body !== 'string') return '';
	const normalized = body.replace(/\s+/g, ' ').trim();
	// Code points, not UTF-16 units: slicing mid-surrogate leaves a broken "�" at the cut.
	const chars = Array.from(normalized);
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : normalized;
}

export function filterPersistedMentionIds(
	requestedIds: readonly string[],
	insertedRows: readonly { mentionedMemberId: string }[],
): string[] {
	const persistedIds = new Set(insertedRows.map((row) => row.mentionedMemberId));
	return requestedIds.filter((id) => persistedIds.has(id));
}

export function sanitizeChatMessageForRead<
	T extends {
		deletedAt: Date | string | null;
		body: string | null;
		imageUrl: string | null;
		systemPayload?: unknown;
	},
>(message: T): T {
	if (!message.deletedAt) return message;
	return {
		...message,
		body: null,
		imageUrl: null,
		...('systemPayload' in message ? { systemPayload: null } : {}),
	} as T;
}

export function chatMessagesReadPayload<
	T extends {
		deletedAt: Date | string | null;
		body: string | null;
		imageUrl: string | null;
		systemPayload?: unknown;
	},
>(
	pageRows: readonly T[],
	refreshedRows: readonly T[],
): {
	messages: T[];
	refreshedMessages: T[];
} {
	return {
		messages: pageRows.map(sanitizeChatMessageForRead).reverse(),
		refreshedMessages: refreshedRows.map(sanitizeChatMessageForRead),
	};
}

export function reconcileChatReactions<
	T extends { messageId: string; memberId: string; emoji: string },
>(
	existing: readonly T[],
	server: readonly T[],
	refreshedMessageIds: ReadonlySet<string>,
	preservedLocalKeys: ReadonlySet<string>,
): T[] {
	const key = (reaction: T): string =>
		`${reaction.messageId}|${reaction.memberId}|${reaction.emoji}`;
	return [
		...existing.filter((reaction) => !refreshedMessageIds.has(reaction.messageId)),
		...server.filter(
			(reaction) =>
				refreshedMessageIds.has(reaction.messageId) && !preservedLocalKeys.has(key(reaction)),
		),
		...existing.filter(
			(reaction) =>
				refreshedMessageIds.has(reaction.messageId) && preservedLocalKeys.has(key(reaction)),
		),
	];
}

export function reactionKeysToPreserve(
	mutationVersions: ReadonlyMap<string, { messageId: string; version: number }>,
	pendingKeys: ReadonlySet<string>,
	versionsAtRequest: ReadonlyMap<string, number>,
	refreshedMessageIds: ReadonlySet<string>,
): Set<string> {
	const keys = new Set<string>();
	for (const [key, mutation] of mutationVersions) {
		if (
			refreshedMessageIds.has(mutation.messageId) &&
			(pendingKeys.has(key) || mutation.version !== versionsAtRequest.get(key))
		) {
			keys.add(key);
		}
	}
	return keys;
}

export function nextChatRefreshBatch<T extends { id: string }>(
	messages: readonly T[],
	latestPageSize: number,
	batchLimit: number,
	offset: number,
): { ids: string[]; nextOffset: number } {
	const older = messages.slice(0, Math.max(0, messages.length - latestPageSize));
	if (older.length === 0 || batchLimit <= 0) return { ids: [], nextOffset: 0 };
	const start = ((Math.floor(offset) % older.length) + older.length) % older.length;
	const size = Math.min(Math.floor(batchLimit), older.length - start);
	const ids = older.slice(start, start + size).map((message) => message.id);
	return { ids, nextOffset: (start + size) % older.length };
}

export function isLatestChatRefreshResponse(requestId: number, latestRequestId: number): boolean {
	return requestId === latestRequestId;
}

export function advanceChatRefreshSequence(currentRequestId: number): number {
	return currentRequestId + 1;
}

/**
 * Merges the latest page into the loaded history. When a full latest page no
 * longer contains the newest loaded message (e.g. the tab was backgrounded
 * while more than a page arrived), merging would leave a silent gap between
 * the old history and the new page, so the latest page replaces the history;
 * a full page keeps `hasMoreOlder` set, so the skipped messages load again
 * through the normal "load older" path.
 */
export function reconcileChatMessages<T extends { id: string }>(
	existing: readonly T[],
	latestPage: readonly T[],
	refreshedLoaded: readonly T[],
	pageSize?: number,
): T[] {
	const latestIds = new Set(latestPage.map((message) => message.id));
	const newestLoaded = existing[existing.length - 1];
	if (
		pageSize !== undefined &&
		latestPage.length >= pageSize &&
		newestLoaded &&
		!latestIds.has(newestLoaded.id)
	) {
		return [...latestPage];
	}
	const refreshedById = new Map(refreshedLoaded.map((message) => [message.id, message]));
	// Both history and the latest page already have the database's exact order.
	// JS timestamps lose microseconds, so they cannot safely reconstruct it.
	return [
		...existing
			.filter((message) => !latestIds.has(message.id))
			.map((message) => refreshedById.get(message.id) ?? message),
		...latestPage,
	];
}

export function mergePagedMessagesById<T extends { id: string }>(
	older: readonly T[],
	existing: readonly T[],
): T[] {
	const seenIds = new Set(existing.map((m) => m.id));
	const fresh = older.filter((m) => !seenIds.has(m.id));
	return [...fresh, ...existing];
}

export function mergePagedReactions<
	T extends { messageId: string; memberId: string; emoji: string },
>(older: readonly T[], existing: readonly T[]): T[] {
	const key = (r: T): string => `${r.messageId}|${r.memberId}|${r.emoji}`;
	const seen = new Set(existing.map(key));
	const fresh = older.filter((r) => !seen.has(key(r)));
	return [...fresh, ...existing];
}
