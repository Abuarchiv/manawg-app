import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PgDialect, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import ts from 'typescript';
import * as chat from '../src/features/chat/chat-pure.ts';
import * as chatReadQuery from '../src/features/chat/chat-read-query.ts';
import * as unreadCount from '../src/features/chat/chat-unread-count.ts';

let unreadQuery;
try {
	unreadQuery = await import('../src/features/chat/chat-unread-query.ts');
} catch {
	unreadQuery = {};
}

test('sanitizes deleted chat messages while retaining reply identity', () => {
	const deleted = {
		id: 'deleted-message',
		senderMemberId: 'member-a',
		body: 'private text',
		imageUrl: 'https://example.test/private.jpg',
		systemPayload: { description: 'private system detail' },
		replyToMessageId: 'parent-message',
		deletedAt: '2026-09-23T18:00:00.000Z',
	};

	assert.deepEqual(chat.sanitizeChatMessageForRead?.(deleted), {
		...deleted,
		body: null,
		imageUrl: null,
		systemPayload: null,
	});
});

test('refresh replaces loaded reactions from the server and preserves a pending local mutation', () => {
	const existing = [
		{ messageId: 'loaded-a', memberId: 'member-a', emoji: '💙' },
		{ messageId: 'loaded-a', memberId: 'member-b', emoji: '😕' },
		{ messageId: 'loaded-b', memberId: 'member-a', emoji: '🔥' },
	];
	const server = [
		{ messageId: 'loaded-a', memberId: 'member-b', emoji: '👏' },
		{ messageId: 'loaded-a', memberId: 'member-c', emoji: '❤️' },
	];

	assert.deepEqual(
		chat.reconcileChatReactions?.(
			existing,
			server,
			new Set(['loaded-a']),
			new Set(['loaded-a|member-a|💙']),
		),
		[
			{ messageId: 'loaded-b', memberId: 'member-a', emoji: '🔥' },
			{ messageId: 'loaded-a', memberId: 'member-b', emoji: '👏' },
			{ messageId: 'loaded-a', memberId: 'member-c', emoji: '❤️' },
			{ messageId: 'loaded-a', memberId: 'member-a', emoji: '💙' },
		],
	);
});

test('refresh protects reaction mutations that are pending or completed after it started', () => {
	const versions = new Map([
		['loaded-a|member-a|💙', { messageId: 'loaded-a', version: 2 }],
		['loaded-a|member-b|👏', { messageId: 'loaded-a', version: 3 }],
		['loaded-a|member-c|❤️', { messageId: 'loaded-a', version: 7 }],
		['loaded-b|member-a|🔥', { messageId: 'loaded-b', version: 4 }],
	]);

	assert.deepEqual(
		chat.reactionKeysToPreserve?.(
			versions,
			new Set(['loaded-a|member-a|💙']),
			new Map([
				['loaded-a|member-a|💙', 2],
				['loaded-a|member-b|👏', 2],
				['loaded-a|member-c|❤️', 7],
				['loaded-b|member-a|🔥', 3],
			]),
			new Set(['loaded-a']),
		),
		new Set(['loaded-a|member-a|💙', 'loaded-a|member-b|👏']),
	);
});

test('refresh replaces stale content for loaded older messages with tombstones', () => {
	const oldMessage = {
		id: 'older-message',
		createdAt: '2026-09-23T10:00:00.000Z',
		body: 'deleted text must not remain visible',
		imageUrl: null,
		deletedAt: null,
	};
	const latestMessage = {
		id: 'latest-message',
		createdAt: '2026-09-23T12:00:00.000Z',
		body: 'still visible',
		imageUrl: null,
		deletedAt: null,
	};
	const tombstone = {
		...oldMessage,
		body: null,
		deletedAt: '2026-09-23T13:00:00.000Z',
	};

	assert.deepEqual(
		chat.reconcileChatMessages?.([oldMessage, latestMessage], [latestMessage], [tombstone]),
		[tombstone, latestMessage],
	);
});

test('older message refresh batches are bounded and rotate through loaded IDs', () => {
	const loaded = Array.from({ length: 7 }, (_, index) => ({ id: `message-${index}` }));

	assert.deepEqual(chat.nextChatRefreshBatch?.(loaded, 2, 3, 0), {
		ids: ['message-0', 'message-1', 'message-2'],
		nextOffset: 3,
	});
	assert.deepEqual(chat.nextChatRefreshBatch?.(loaded, 2, 3, 3), {
		ids: ['message-3', 'message-4'],
		nextOffset: 0,
	});
});

test('unread chat query excludes soft-deleted messages', () => {
	const messages = pgTable('wg_chat_messages', {
		id: uuid('id'),
		wgId: uuid('wg_id'),
		senderMemberId: uuid('sender_member_id'),
		systemPayload: jsonb('system_payload'),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }),
	});
	const where = unreadQuery.buildUnreadChatMessagesWhere?.(
		messages,
		'00000000-0000-4000-8000-000000000001',
		'00000000-0000-4000-8000-000000000002',
		new Date('2026-09-24T00:00:00.000Z'),
		'00000000-0000-4000-8000-000000000003',
	);
	assert.ok(where, 'unread query builder must provide a filter');
	const query = new PgDialect().sqlToQuery(where);
	assert.match(query.sql, /deleted_at" is null/i);
	assert.match(
		query.sql,
		/coalesce\("wg_chat_messages"\."system_payload"->>'actorMemberId', ''\) <> \$/i,
	);
	assert.match(query.sql, /\("wg_chat_messages"\."created_at", "wg_chat_messages"\."id"\) > \(/i);
	assert.match(query.sql, /select cursor\.created_at, cursor\.id/i);
	assert.ok(!query.params.includes('2026-09-24T00:00:00.000Z'));
	assert.deepEqual(query.params.slice(-2), [
		'00000000-0000-4000-8000-000000000003',
		'00000000-0000-4000-8000-000000000001',
	]);
	const older = unreadQuery.buildChatCursorWhere?.(
		messages,
		'00000000-0000-4000-8000-000000000001',
		'00000000-0000-4000-8000-000000000003',
		'before',
	);
	assert.ok(older, 'pagination must compare the same database cursor in reverse');
	assert.match(
		new PgDialect().sqlToQuery(older).sql,
		/\) < \(\s*select cursor\.created_at, cursor\.id/i,
	);
});

test('unread count response preserves the exact total and caps only the visible count', () => {
	assert.deepEqual(unreadCount.toChatUnreadCountResponse(147), {
		count: 99,
		exactCount: 147,
		overflow: true,
	});
	assert.deepEqual(unreadCount.toChatUnreadCountResponse(99), {
		count: 99,
		exactCount: 99,
		overflow: false,
	});
});

test('chat read marker advances by timestamp and message id', () => {
	const reads = pgTable('wg_chat_reads', {
		lastReadMessageId: uuid('last_read_message_id'),
	});
	const where = chatReadQuery.buildChatReadMarkerSetWhere?.(
		'00000000-0000-4000-8000-000000000003',
		reads.lastReadMessageId,
	);
	assert.ok(where, 'read marker query builder must provide a filter');
	const query = new PgDialect().sqlToQuery(where);
	assert.match(query.sql, /last_read_message_id" is null/i);
	assert.match(query.sql, /candidate\.created_at[\s\S]*?\) > coalesce/i);
	assert.match(query.sql, /candidate\.created_at[\s\S]*?\) = coalesce/i);
	assert.match(query.sql, /::uuid > "wg_chat_reads"\."last_read_message_id"/i);
});

test('read payload keeps the latest page and older refresh updates in separate fields', () => {
	const pageTombstone = {
		id: 'page-deleted',
		body: 'hidden page content',
		imageUrl: null,
		deletedAt: '2026-09-23T14:00:00.000Z',
	};
	const olderTombstone = {
		id: 'older-deleted',
		body: 'hidden older content',
		imageUrl: null,
		deletedAt: '2026-09-23T13:00:00.000Z',
	};

	assert.deepEqual(chat.chatMessagesReadPayload?.([pageTombstone], [olderTombstone]), {
		messages: [{ ...pageTombstone, body: null }],
		refreshedMessages: [{ ...olderTombstone, body: null }],
	});
	assert.deepEqual(chat.chatMessagesReadPayload?.([], [olderTombstone]), {
		messages: [],
		refreshedMessages: [{ ...olderTombstone, body: null }],
	});
});

test('late older refresh response cannot overwrite a newer tombstone', () => {
	let latestRequestId = 0;
	const staleRequestId = ++latestRequestId;
	const tombstoneRequestId = ++latestRequestId;
	let visibleMessage = 'live body';

	if (chat.isLatestChatRefreshResponse?.(tombstoneRequestId, latestRequestId)) {
		visibleMessage = 'tombstone';
	}
	if (chat.isLatestChatRefreshResponse?.(staleRequestId, latestRequestId)) {
		visibleMessage = 'stale live body';
	}
	assert.equal(visibleMessage, 'tombstone');
});

test('GET started before successful delete cannot restore the deleted body', () => {
	let latestRequestId = 1;
	const oldGetRequestId = latestRequestId;
	let visibleBody = 'body to delete';

	latestRequestId = chat.advanceChatRefreshSequence?.(latestRequestId) ?? latestRequestId;
	visibleBody = null;
	if (chat.isLatestChatRefreshResponse?.(oldGetRequestId, latestRequestId)) {
		visibleBody = 'body to delete';
	}

	assert.equal(visibleBody, null);
});

test('reconciliation preserves database order when timestamps lose microseconds', () => {
	const older = {
		id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
		createdAt: new Date('2026-09-24T10:00:00.123100Z').toISOString(),
		body: 'older',
	};
	const newer = {
		id: '00000000-0000-4000-8000-000000000000',
		createdAt: new Date('2026-09-24T10:00:00.123900Z').toISOString(),
		body: 'newer',
	};
	const latest = { id: 'latest', createdAt: '2026-09-24T10:00:01.000Z', body: 'latest' };
	assert.deepEqual(chat.reconcileChatMessages([], [older, newer], []), [older, newer]);
	// Refreshed rows are unordered by the API; they must only replace in place.
	const edited = { ...older, body: 'edited' };
	assert.deepEqual(chat.reconcileChatMessages([older, newer, latest], [latest], [newer, edited]), [
		edited,
		newer,
		latest,
	]);
	assert.deepEqual(chat.reconcileChatMessages([older, newer], [newer, latest], []), [
		older,
		newer,
		latest,
	]);
});

test('a disjoint latest page rebases the displayed history to the current window', () => {
	const oldWindow = Array.from({ length: 50 }, (_, index) => ({ id: `message-${index + 1}` }));
	const latestPage = Array.from({ length: 50 }, (_, index) => ({ id: `message-${index + 101}` }));

	assert.deepEqual(chat.reconcileChatMessages(oldWindow, latestPage, []), latestPage);
});

test('polling rebases the cursor window without changing the read marker', async () => {
	const oldWindow = Array.from({ length: 50 }, (_, index) => ({ id: `message-${index + 1}` }));
	const latestPage = Array.from({ length: 50 }, (_, index) => ({
		id: `message-${index + 101}`,
		createdAt: `2026-09-26T10:${String(index).padStart(2, '0')}:00.000Z`,
	}));
	const { scope, refresh } = refreshHarness(
		async () => ({
			ok: true,
			data: { messages: latestPage, reactions: [] },
		}),
		oldWindow,
	);
	scope.lastReadSentIdRef.current = 'last-read-message';

	assert.equal(await refresh(), true);
	assert.deepEqual(scope.messages, latestPage);
	assert.equal(scope.messages[0].id, 'message-101');
	assert.equal(scope.lastReadSentIdRef.current, 'last-read-message');
});

test('a delayed older-page response cannot restore the pre-rebase history', async () => {
	const oldWindow = Array.from({ length: 50 }, (_, index) => ({
		id: `message-${index + 1}`,
		createdAt: `2026-09-25T10:${String(index).padStart(2, '0')}:00.000Z`,
	}));
	const latestPage = Array.from({ length: 50 }, (_, index) => ({
		id: `message-${index + 101}`,
		createdAt: `2026-09-26T10:${String(index).padStart(2, '0')}:00.000Z`,
	}));
	let completeOlderPage;
	const requests = [];
	const { scope, refresh, loadOlder } = refreshHarness((url) => {
		requests.push(url);
		if (url.includes('&before=')) {
			return new Promise((resolve) => {
				completeOlderPage = resolve;
			});
		}
		return Promise.resolve({ ok: true, data: { messages: latestPage, reactions: [] } });
	}, oldWindow);
	scope.hasMoreOlder = true;

	const olderPending = loadOlder();
	assert.match(requests[0], /beforeId=message-1/);
	assert.equal(await refresh(), true);
	completeOlderPage({
		ok: true,
		data: {
			messages: Array.from({ length: 50 }, (_, index) => ({ id: `older-${index}` })),
			reactions: [],
		},
	});
	await olderPending;

	assert.deepEqual(scope.messages, latestPage);
});

// Execute the component's real request callbacks with controlled transport and
// state, so polling latency is tested without a browser or duplicating the loop.
function refreshHarness(apiFetch, initialMessages = []) {
	const path = new URL('../src/features/chat/components/ChatView.tsx', import.meta.url);
	const source = ts.createSourceFile(
		'ChatView.tsx',
		readFileSync(path, 'utf8'),
		ts.ScriptTarget.ES2022,
		true,
	);
	const declarations = [];
	function visit(node) {
		if (
			ts.isVariableDeclaration(node) &&
			['fetchMessages', 'refresh'].includes(node.name.getText(source))
		) {
			declarations.push(`const ${node.getText(source)};`);
		} else if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === 'loadOlder') {
			declarations.push(node.getText(source));
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	assert.equal(declarations.length, 3);
	const scope = {
		...chat,
		PAGE_SIZE: 50,
		messages: initialMessages,
		encodedShareCode: 'test',
		identity: { memberId: 'member' },
		apiFetch,
		lastReadSentIdRef: { current: null },
		historyStartIdRef: { current: initialMessages[0]?.id ?? null },
		loadingOlderRef: { current: false },
		hasMoreOlder: initialMessages.length >= 50,
		useCallback: (callback) => callback,
		refreshPromiseRef: { current: null },
		refreshRequestSequenceRef: { current: 0 },
		refreshOlderOffsetRef: { current: 0 },
		reactionMutationVersionsRef: { current: new Map() },
		pendingReactionMutationsRef: { current: new Set() },
		setRefreshError: (update) => {
			scope.error = update(scope.error ?? false);
		},
		setMessages: (update) => {
			scope.messages = update(scope.messages);
		},
		setReactionRows: (update) => {
			scope.reactions = update(scope.reactions ?? []);
		},
		setHasMoreOlder: (update) => {
			scope.hasMoreOlder =
				typeof update === 'function' ? update(scope.hasMoreOlder ?? false) : update;
		},
		setOlderError: (value) => {
			scope.olderError = typeof value === 'function' ? value(scope.olderError ?? false) : value;
		},
		setLoadingOlder: (value) => {
			scope.loadingOlder = typeof value === 'function' ? value(scope.loadingOlder ?? false) : value;
		},
		mergePagedMessagesById: chat.mergePagedMessagesById,
		mergePagedReactions: chat.mergePagedReactions,
	};
	const code = ts.transpileModule(declarations.join('\n'), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	}).outputText;
	return {
		scope,
		...new Function('scope', `with (scope) { ${code}; return { refresh, loadOlder }; }`)(scope),
	};
}

test('8-second polling accepts a 10-second response and reports a slow failure', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let requests = 0;
	const message = { id: 'server-message', createdAt: '2026-09-24T10:00:00.000Z' };
	const { scope, refresh } = refreshHarness(() => {
		const request = ++requests;
		return new Promise((resolve) =>
			setTimeout(
				() =>
					resolve(
						request === 1
							? { ok: true, data: { messages: [message], reactions: [] } }
							: { ok: false, error: 'Netzwerkfehler', status: 0 },
					),
				10_000,
			),
		);
	});
	const first = refresh();
	t.mock.timers.tick(8_000);
	assert.equal(refresh(), first);
	assert.equal(requests, 1);
	t.mock.timers.tick(2_000);
	assert.equal(await first, true);
	assert.deepEqual(scope.messages, [message]);
	const second = refresh();
	t.mock.timers.tick(8_000);
	assert.equal(refresh(), second);
	t.mock.timers.tick(2_000);
	assert.equal(await second, false);
	assert.equal(scope.error, true);
});

test('a coalesced request still respects successful mutation invalidation', async () => {
	let complete;
	const deleted = { id: 'message', body: null, deletedAt: '2026-09-24T10:00:00.000Z' };
	const { scope, refresh } = refreshHarness(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
		[deleted],
	);
	const pending = refresh();
	scope.refreshRequestSequenceRef.current = chat.advanceChatRefreshSequence(
		scope.refreshRequestSequenceRef.current,
	);
	assert.equal(refresh(), pending);
	complete({
		ok: true,
		data: { messages: [{ ...deleted, body: 'old secret', deletedAt: null }], reactions: [] },
	});
	await pending;
	assert.deepEqual(scope.messages, [deleted]);
	assert.equal(scope.refreshPromiseRef.current, null);
});
