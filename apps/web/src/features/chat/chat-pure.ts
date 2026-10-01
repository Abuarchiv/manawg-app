const MENTION_PATTERN = /(^|[\s(])@([A-Za-zÄÖÜäöüß0-9_-]{1,40})/g;
const EDIT_WINDOW_MS_DEFAULT = 15 * 60 * 1000;
const SYSTEM_MESSAGE_KIND = 'system';
const TEXT_MESSAGE_KIND = 'text';

export const CHAT_REFRESH_BATCH_SIZE = 100;

export type ChatSystemKind =
	| 'member.joined'
	| 'member.left'
	| 'expense.created'
	| 'chore.completed';

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

interface ParsedMentions {
	mentions: string[];
	cleanedBody: string;
}

export interface MentionTrigger {
	query: string;
	startIndex: number;
}

export function detectMention(value: string, cursor: number): MentionTrigger | null {
	const upTo = value.slice(0, cursor);
	const match = /(?:^|\s)@([A-Za-zÄÖÜäöüß0-9_-]{1,40})$/.exec(upTo);
	if (!match) return null;
	const start = upTo.length - (match[1]?.length ?? 0) - 1;
	return { query: match[1] ?? '', startIndex: start };
}

export function parseMentions(body: string): ParsedMentions {
	const matches = new Set<string>();
	if (typeof body !== 'string' || body.length === 0) {
		return { mentions: [], cleanedBody: '' };
	}
	for (const match of body.matchAll(MENTION_PATTERN)) {
		const name = match[2];
		if (typeof name === 'string' && name.length > 0) matches.add(name);
	}
	// The `@name` markers are parsing input, not message text: strip them so
	// the cleaned body only carries what the author actually wrote, and normalize
	// the whitespace the removal leaves behind.
	const cleanedBody = body.replace(MENTION_PATTERN, '$1').replace(/\s+/g, ' ').trim();
	return { mentions: [...matches], cleanedBody };
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

export interface AppendSystemMessageInput {
	wgId: string;
	kind: ChatSystemKind;
	payload: Record<string, unknown>;
}

export { SYSTEM_MESSAGE_KIND };

export function isSingleEmoji(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 16) return false;
	try {
		const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
		const segments = [...segmenter.segment(trimmed)];
		return segments.length === 1;
	} catch {
		return /^\p{Extended_Pictographic}$/u.test(trimmed);
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
	return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
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

export function reconcileChatMessages<T extends { id: string }>(
	existing: readonly T[],
	latestPage: readonly T[],
	refreshedLoaded: readonly T[],
): T[] {
	const latestIds = new Set(latestPage.map((message) => message.id));
	const refreshedById = new Map(refreshedLoaded.map((message) => [message.id, message]));
	const rebasing =
		existing.length > 0 &&
		latestPage.length > 0 &&
		!existing.some((message) => latestIds.has(message.id));
	// With no shared row, the old cursor cannot reach the missing interval.
	const retainedMessages = rebasing
		? []
		: existing
				.filter((message) => !latestIds.has(message.id))
				.map((message) => refreshedById.get(message.id) ?? message);
	// Both history and the latest page already have the database's exact order.
	// JS timestamps lose microseconds, so they cannot safely reconstruct it.
	return [...retainedMessages, ...latestPage];
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
