import assert from 'node:assert/strict';
import test from 'node:test';

const { createChatRefresher } = await import('../src/features/chat/chat-refresh.ts');

type Message = { id: string; createdAt?: string; body?: string | null; deletedAt?: string | null };
type FetchResult =
	| { ok: true; data: { messages: Message[]; reactions: unknown[] } }
	| { ok: false; status: number; error: string };

/**
 * Drives the real refresh loop with a controlled transport and plain state holders, so polling
 * latency and mutation races are tested without React or a browser.
 */
function refreshHarness(fetchJson: () => Promise<FetchResult>, initialMessages: Message[] = []) {
	const state = {
		messages: initialMessages,
		reactions: [] as unknown[],
		error: false,
		hasMore: false,
	};
	const refresher = createChatRefresher({
		messagesUrl: '/api/wg/test/chat/messages',
		memberId: 'member',
		fetchJson: fetchJson as never,
		getMessages: () => state.messages as never,
		reactions: { versions: new Map(), pending: new Set() },
		setRefreshError: (update) => {
			state.error = update(state.error);
		},
		setMessages: (update) => {
			state.messages = update(state.messages as never) as Message[];
		},
		setReactionRows: (update) => {
			state.reactions = update(state.reactions as never);
		},
		setHasMoreOlder: (update) => {
			state.hasMore = update(state.hasMore);
		},
	});
	return { state, refresher };
}

test('8-second polling accepts a 10-second response and reports a slow failure', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let requests = 0;
	const message = { id: 'server-message', createdAt: '2026-09-24T10:00:00.000Z' };
	const { state, refresher } = refreshHarness(() => {
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
	const first = refresher.refresh();
	t.mock.timers.tick(8_000);
	assert.equal(refresher.refresh(), first);
	assert.equal(requests, 1);
	t.mock.timers.tick(2_000);
	assert.equal(await first, true);
	assert.deepEqual(state.messages, [message]);
	const second = refresher.refresh();
	t.mock.timers.tick(8_000);
	assert.equal(refresher.refresh(), second);
	t.mock.timers.tick(2_000);
	assert.equal(await second, false);
	assert.equal(state.error, true);
});

test('a coalesced request still respects successful mutation invalidation', async () => {
	let complete!: (result: FetchResult) => void;
	const deleted = { id: 'message', body: null, deletedAt: '2026-09-24T10:00:00.000Z' };
	const { state, refresher } = refreshHarness(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
		[deleted],
	);
	const pending = refresher.refresh();
	// A poll joins the running request instead of starting another one.
	assert.equal(refresher.refresh(), pending);
	// The delete succeeded while that request was still loading.
	refresher.invalidate();
	complete({
		ok: true,
		data: { messages: [{ ...deleted, body: 'old secret', deletedAt: null }], reactions: [] },
	});
	await pending;
	assert.deepEqual(state.messages, [deleted]);
	assert.equal(refresher.inFlight(), null);
});

test('a refresh superseded by a mutation is followed by one fresh fetch, not reused', async () => {
	const resolvers: Array<(result: FetchResult) => void> = [];
	const sent = { id: 'sent', createdAt: '2026-09-24T10:01:00.000Z' };
	const { state, refresher } = refreshHarness(
		() =>
			new Promise((resolve) => {
				resolvers.push(resolve);
			}),
	);
	const bootstrap = refresher.refresh();
	// A message was sent while the bootstrap request was loading.
	refresher.invalidate();
	const afterSend = refresher.refresh();
	assert.notEqual(afterSend, bootstrap);
	assert.equal(refresher.refresh(), afterSend);

	resolvers[0]?.({ ok: true, data: { messages: [], reactions: [] } });
	await bootstrap;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(resolvers.length, 2);
	resolvers[1]?.({ ok: true, data: { messages: [sent], reactions: [] } });
	assert.equal(await afterSend, true);
	assert.deepEqual(state.messages, [sent]);
	assert.equal(refresher.inFlight(), null);
});

test('a full latest page signals older history, a short one never clears it', async () => {
	const page = Array.from({ length: 50 }, (_, index) => ({
		id: `m-${index}`,
		createdAt: new Date(Date.UTC(2026, 8, 24, 10, index)).toISOString(),
	}));
	let response: FetchResult = { ok: true, data: { messages: page, reactions: [] } };
	const { state, refresher } = refreshHarness(async () => response);
	await refresher.refresh();
	assert.equal(state.hasMore, true);
	response = { ok: true, data: { messages: page.slice(-3), reactions: [] } };
	await refresher.refresh();
	assert.equal(state.hasMore, true);
});

test('a failed first load is followed by a successful poll that reports true', async () => {
	let requests = 0;
	const message = { id: 'm1', createdAt: '2026-09-24T10:00:00.000Z' };
	const { state, refresher } = refreshHarness(async () =>
		++requests === 1
			? { ok: false, status: 0, error: 'Netzwerkfehler' }
			: { ok: true, data: { messages: [message], reactions: [] } },
	);
	// useChatRoom clears its bootstrap error screen on the first `true`.
	assert.equal(await refresher.refresh(), false);
	assert.equal(state.error, true);
	assert.equal(await refresher.refresh(), true);
	assert.equal(state.error, false);
	assert.deepEqual(state.messages, [message]);
});

test('the read marker is requested until the first successful refresh reports it', async () => {
	const urls: string[] = [];
	const seen: unknown[] = [];
	const marker = { messageId: 'm1', createdAt: '2026-09-24T10:00:00.000Z' };
	let requests = 0;
	const refresher = createChatRefresher({
		messagesUrl: '/api/wg/test/chat/messages',
		memberId: 'member',
		fetchJson: (async (url: string) => {
			urls.push(url);
			return ++requests === 1
				? { ok: false, status: 0, error: 'Netzwerkfehler' }
				: { ok: true, data: { messages: [{ id: 'm1' }], reactions: [], readMarker: marker } };
		}) as never,
		getMessages: () => [],
		reactions: { versions: new Map(), pending: new Set() },
		setRefreshError: () => undefined,
		setMessages: () => undefined,
		setReactionRows: () => undefined,
		setHasMoreOlder: () => undefined,
		onReadMarker: (...args) => seen.push(args),
	});
	await refresher.refresh();
	await refresher.refresh();
	await refresher.refresh();
	assert.deepEqual(
		urls.map((url) => url.includes('includeReadMarker=1')),
		[true, true, false],
	);
	assert.deepEqual(seen, [[marker, [{ id: 'm1' }]]]);
});
