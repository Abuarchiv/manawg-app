import {
	CHAT_REFRESH_BATCH_SIZE,
	type ChatReadMarker,
	advanceChatRefreshSequence,
	isLatestChatRefreshResponse,
	nextChatRefreshBatch,
	reactionKeysToPreserve,
	reconcileChatMessages,
	reconcileChatReactions,
} from './chat-pure';
import type { ChatMessageDto, ChatReactionRow } from './chat-types';

export const CHAT_PAGE_SIZE = 50;

type FetchResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };
type Update<T> = (current: T) => T;

interface ChatRefreshResponse {
	messages: ChatMessageDto[];
	refreshedMessages?: ChatMessageDto[];
	reactions: ChatReactionRow[];
	reads?: ChatReadMarker[];
}

/** Reaction mutations the refresh must not overwrite with an older server snapshot. */
export interface ReactionMutationTracker {
	versions: Map<string, { messageId: string; version: number }>;
	pending: Set<string>;
}

export interface ChatRefreshDeps {
	messagesUrl: string;
	memberId: string;
	fetchJson: (url: string, init: { memberId: string }) => Promise<FetchResult<ChatRefreshResponse>>;
	/** The messages loaded right now; decides which older ones are re-checked this round. */
	getMessages: () => readonly ChatMessageDto[];
	reactions: ReactionMutationTracker;
	setRefreshError: (update: Update<boolean>) => void;
	setMessages: (update: Update<ChatMessageDto[]>) => void;
	setReactionRows: (update: Update<ChatReactionRow[]>) => void;
	setHasMoreOlder: (update: Update<boolean>) => void;
	setReads?: (update: Update<ChatReadMarker[]>) => void;
}

export interface ChatRefresher {
	/** Fetches the latest page plus a rotating batch of older loaded messages. */
	refresh: () => Promise<boolean>;
	/** A local mutation landed: a response requested before it must not undo it. */
	invalidate: () => void;
	/** The refresh currently running, if any. */
	inFlight: () => Promise<boolean> | null;
}

/**
 * The chat's refresh loop without React: request sequencing, coalescing of overlapping polls and
 * reconciliation of the response with local state. Each response is applied only while it is
 * still the latest request, so a slow poll cannot bring back a message that was just edited or
 * deleted. The setters receive update functions, which check that again when they run.
 */
export function createChatRefresher(deps: ChatRefreshDeps): ChatRefresher {
	let sequence = 0;
	let olderOffset = 0;
	let running: Promise<boolean> | null = null;
	// Set when a mutation invalidates the refresh in flight: its result is then dropped, so the
	// next refresh() must fetch again instead of reusing it.
	let superseded = false;

	async function fetchMessages(): Promise<boolean> {
		const requestSequence = advanceChatRefreshSequence(sequence);
		sequence = requestSequence;
		const isLatest = () => isLatestChatRefreshResponse(requestSequence, sequence);
		const refreshBatch = nextChatRefreshBatch(
			deps.getMessages(),
			CHAT_PAGE_SIZE,
			CHAT_REFRESH_BATCH_SIZE,
			olderOffset,
		);
		olderOffset = refreshBatch.nextOffset;
		const params = new URLSearchParams({ limit: `${CHAT_PAGE_SIZE}` });
		for (const id of refreshBatch.ids) params.append('refreshId', id);
		const mutationVersionsAtRequest = new Map(
			[...deps.reactions.versions].map(([key, mutation]) => [key, mutation.version]),
		);
		const res = await deps.fetchJson(`${deps.messagesUrl}?${params.toString()}`, {
			memberId: deps.memberId,
		});
		if (!isLatest()) return true;
		if (!res.ok) {
			deps.setRefreshError((prev) => (isLatest() ? true : prev));
			return false;
		}
		deps.setRefreshError((prev) => (isLatest() ? false : prev));
		const refreshedLoadedMessages = res.data.refreshedMessages ?? [];
		const refreshedMessageIds = new Set(
			[...res.data.messages, ...refreshedLoadedMessages].map((message) => message.id),
		);
		deps.setMessages((prev) =>
			isLatest()
				? reconcileChatMessages(prev, res.data.messages, refreshedLoadedMessages, CHAT_PAGE_SIZE)
				: prev,
		);
		deps.setReactionRows((prev) => {
			if (!isLatest()) return prev;
			const preservedLocalKeys = reactionKeysToPreserve(
				deps.reactions.versions,
				deps.reactions.pending,
				mutationVersionsAtRequest,
				refreshedMessageIds,
			);
			return reconcileChatReactions(
				prev,
				res.data.reactions,
				refreshedMessageIds,
				preservedLocalKeys,
			);
		});
		const reads = res.data.reads;
		if (reads) deps.setReads?.((prev) => (isLatest() ? reads : prev));
		// Only ever grow: the latest page's length says nothing about whether older pages were
		// already loaded. Loading older pages clears the flag when the history is exhausted.
		deps.setHasMoreOlder((prev) =>
			isLatest() ? prev || res.data.messages.length >= CHAT_PAGE_SIZE : prev,
		);
		return true;
	}

	function refresh(): Promise<boolean> {
		// A poll must not supersede a request that is still loading. Mutations still invalidate
		// its sequence so a stale snapshot cannot undo them; in that case one follow-up fetch is
		// chained after it, otherwise the caller (e.g. the post-send refresh) would wait on a
		// result that gets dropped.
		const inFlight = running;
		if (inFlight && !superseded) return inFlight;
		superseded = false;
		const next: Promise<boolean> = (
			inFlight ? inFlight.then(fetchMessages, fetchMessages) : fetchMessages()
		).finally(() => {
			if (running === next) running = null;
		});
		running = next;
		return next;
	}

	function invalidate(): void {
		sequence = advanceChatRefreshSequence(sequence);
		if (running) superseded = true;
	}

	return { refresh, invalidate, inFlight: () => running };
}
