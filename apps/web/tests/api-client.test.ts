import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

const {
	anySignal,
	apiFetch,
	MEMBERSHIP_LOST_EVENT,
	noteSessionExpiry,
	readApiErrorCode,
	SESSION_EXPIRED_EVENT,
} = await import('../src/core/infra/api-client.ts');
const { getLocalAccount } = await import('../src/core/auth/local-account.ts');
const { postChatMessage } = await import('../src/features/chat/chat-send.ts');
const CHAT_SEND_KEY = '00000000-0000-4000-8000-000000000001';

function replaceFetch(t: TestContext, implementation: typeof fetch) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = implementation;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
}

function replaceAccountWindow(t: TestContext, initialAccount: string | null) {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	let account = initialAccount;
	const events: Event[] = [];
	const fakeWindow = Object.assign(new EventTarget(), {
		localStorage: {
			getItem(key: string) {
				return key === 'manawg_account' ? account : null;
			},
		},
	});
	for (const eventName of [SESSION_EXPIRED_EVENT, MEMBERSHIP_LOST_EVENT]) {
		fakeWindow.addEventListener(eventName, (event) => events.push(event));
	}
	Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
	t.after(() => {
		if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
		else Reflect.deleteProperty(globalThis, 'window');
	});
	return {
		events,
		setAccount(value: string | null) {
			account = value;
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function truncatedResponse(status = 200) {
	return new Response('{"accepted":', {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function failedBodyResponse(status = 201) {
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"accepted":'));
			controller.error(new Error('response stream interrupted'));
		},
	});
	return new Response(body, {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

test('unreadable successful JSON responses have unknown status 0', async (t) => {
	const responses: Array<[string, Response]> = [
		['truncated HTTP 200 JSON', truncatedResponse(200)],
		['body read failure after HTTP 201 headers', failedBodyResponse(201)],
		[
			'non-JSON proxy response after HTTP 200',
			new Response('<html>upstream timeout</html>', {
				status: 200,
				headers: { 'content-type': 'text/html' },
			}),
		],
		[
			'empty unexpected HTTP 200 body',
			new Response(null, { status: 200, headers: { 'content-type': 'text/plain' } }),
		],
	];

	let currentResponse: Response | undefined;
	replaceFetch(t, async () => currentResponse as Response);
	for (const [name, response] of responses) {
		currentResponse = response;
		const result = await apiFetch('/api/write', { method: 'POST', body: '{}' });
		assert.equal(result.ok, false, name);
		assert.equal(!result.ok && result.status, 0, name);
	}
});

test('well-formed successful JSON keeps its HTTP success result', async (t) => {
	replaceFetch(t, async () => Response.json({ saved: true }, { status: 201 }));

	assert.deepEqual(await apiFetch('/api/write', { method: 'POST', body: '{}' }), {
		ok: true,
		data: { saved: true },
	});
});

test('real HTTP 400 and 429 responses retain their status and error code', async (t) => {
	const results: Array<[number, string]> = [
		[400, 'invalid_body'],
		[409, 'settlement_changed'],
		[429, 'rate_limited'],
	];

	let currentResponse: Response | undefined;
	replaceFetch(t, async () => currentResponse as Response);
	for (const [status, error] of results) {
		currentResponse = Response.json({ error }, { status });
		assert.deepEqual(await apiFetch('/api/write', { method: 'POST', body: '{}' }), {
			ok: false,
			status,
			error,
		});
	}
});

test('keeps the expected-member header and combines the caller abort signal', async (t) => {
	const controller = new AbortController();
	let requestHeaders: Headers | undefined;
	let requestSignal: AbortSignal | null | undefined;
	replaceFetch(t, async (_input, init) => {
		requestHeaders = new Headers(init?.headers);
		requestSignal = init?.signal;
		controller.abort();
		return Response.json({ ok: true });
	});

	const result = await apiFetch('/api/write', {
		method: 'POST',
		memberId: 'member-1',
		signal: controller.signal,
		body: '{}',
	});

	assert.equal(result.ok, true);
	assert.equal(requestHeaders?.get('x-manawg-expected-member-id'), 'member-1');
	assert.equal(requestHeaders?.get('x-manawg-member-id'), null);
	assert.equal(requestHeaders?.get('x-manawg-member-token'), null);
	assert.notEqual(requestSignal, controller.signal);
	assert.equal(requestSignal?.aborted, true);
});

test('204 remains a successful empty response', async (t) => {
	replaceFetch(t, async () => new Response(null, { status: 204 }));

	assert.deepEqual(await apiFetch('/api/delete', { method: 'DELETE' }), {
		ok: true,
		data: undefined,
	});
});

test('retrying an ambiguously committed chat message reuses its idempotency key', async (t) => {
	const keys: Array<string | null> = [];
	const bodies: unknown[] = [];
	let generatedKeys = 0;
	replaceFetch(t, async (_input, init) => {
		keys.push(new Headers(init?.headers).get('Idempotency-Key'));
		bodies.push(init?.body);
		return truncatedResponse(200);
	});
	const pending = {
		current: null as { fingerprint: string; key: string; createdAtMs: number | null } | null,
	};
	const deps = {
		messagesUrl: '/api/wg/MTE8PZAT/chat/messages',
		memberId: 'member-1',
		pending,
		createKey: () => {
			generatedKeys += 1;
			return CHAT_SEND_KEY;
		},
		persistPending: () => true,
	};
	const message = {
		body: 'committed message',
		mentionMemberIds: [],
		replyToMessageId: null,
	};

	assert.equal((await postChatMessage(message, deps)).ok, false);
	assert.equal((await postChatMessage(message, deps)).ok, false);
	assert.deepEqual(keys, [CHAT_SEND_KEY, CHAT_SEND_KEY]);
	assert.deepEqual(
		bodies.map((body) => JSON.parse(String(body))),
		[message, message],
	);
	assert.equal(generatedKeys, 1);
});

test('a rejected chat message frees its key, a missing key sends nothing', async (t) => {
	let requests = 0;
	replaceFetch(t, async () => {
		requests += 1;
		return Response.json({ error: 'reply_to_not_found' }, { status: 404 });
	});
	const pending = {
		current: null as { fingerprint: string; key: string; createdAtMs: number | null } | null,
	};
	const message = { body: 'hi', mentionMemberIds: [], replyToMessageId: 'gone' };
	const deps = {
		messagesUrl: '/api/x',
		memberId: 'member-1',
		pending,
		createKey: () => CHAT_SEND_KEY,
		persistPending: () => true,
	};

	assert.deepEqual(await postChatMessage(message, deps), {
		ok: false,
		reason: 'rejected',
		error: 'reply_to_not_found',
	});
	assert.equal(pending.current, null);
	assert.deepEqual(await postChatMessage(message, { ...deps, createKey: () => null }), {
		ok: false,
		reason: 'key_unavailable',
	});
	assert.equal(requests, 1);
});

test('anySignal aborts with the first source, also without AbortSignal.any', async () => {
	const nativeAny = AbortSignal.any;
	const signalStatics = AbortSignal as unknown as { any: typeof AbortSignal.any | undefined };
	try {
		for (const any of [nativeAny, undefined]) {
			signalStatics.any = any;
			const first = new AbortController();
			const second = new AbortController();
			const combined = anySignal([first.signal, second.signal]);
			assert.equal(combined.aborted, false);
			second.abort('stop');
			assert.equal(combined.aborted, true);
			assert.equal(combined.reason, 'stop');

			const already = new AbortController();
			already.abort('early');
			assert.equal(anySignal([already.signal, first.signal]).reason, 'early');
		}
	} finally {
		signalStatics.any = nativeAny;
	}
});

test('readApiErrorCode prefers error over code, falls back to code and never throws', async () => {
	assert.equal(await readApiErrorCode(Response.json({ error: 'a', code: 'b' })), 'a');
	assert.equal(await readApiErrorCode(Response.json({ error: '', code: 'b' })), 'b');
	assert.equal(await readApiErrorCode(Response.json({ code: 'b' })), 'b');
	assert.equal(await readApiErrorCode(Response.json({ error: 4 })), '');
	assert.equal(await readApiErrorCode(new Response('not json')), '');
	const response = Response.json({ error: 'kept' });
	assert.equal(await readApiErrorCode(response), 'kept');
	assert.equal((await response.json()).error, 'kept');
});

test('a rate-limited or still-pending chat message keeps its key', async (t) => {
	const answers = [
		Response.json({ error: 'rate_limited' }, { status: 429 }),
		Response.json({ error: 'idempotency_response_pending' }, { status: 409 }),
	];
	replaceFetch(t, async () => answers.shift() as Response);
	const pending = {
		current: null as { fingerprint: string; key: string; createdAtMs: number | null } | null,
	};
	const message = { body: 'hi', mentionMemberIds: [], replyToMessageId: null };
	const deps = {
		messagesUrl: '/api/x',
		memberId: 'member-1',
		pending,
		createKey: () => CHAT_SEND_KEY,
		persistPending: () => true,
	};

	await postChatMessage(message, deps);
	assert.equal(pending.current?.key, CHAT_SEND_KEY);
	await postChatMessage(message, deps);
	assert.equal(pending.current?.key, CHAT_SEND_KEY);
});

test('apiFetch does not dispatch stale account failures after a pending fetch resolves', async (t) => {
	const account = replaceAccountWindow(t, 'account-a');
	let pendingFetch = deferred<Response>();
	replaceFetch(t, () => pendingFetch.promise);
	const failures = [
		{ path: '/api/account', status: 401, error: 'auth_required' },
		{ path: '/api/wg/TEST1234/expenses', status: 401, error: 'not_a_member' },
		{ path: '/api/wg/TEST1234/expenses', status: 404, error: 'wg_not_found' },
	];

	for (const failure of failures) {
		account.setAccount('account-a');
		pendingFetch = deferred<Response>();
		const resultPromise = apiFetch(failure.path);
		account.setAccount('account-b');
		pendingFetch.resolve(Response.json({ error: failure.error }, { status: failure.status }));

		assert.deepEqual(await resultPromise, {
			ok: false,
			status: failure.status,
			error: failure.error,
		});
		assert.deepEqual(account.events, []);
	}
});

test('apiFetch rechecks the account after parsing a delayed error body', async (t) => {
	const account = replaceAccountWindow(t, 'account-a');
	const body = deferred<{ error: string }>();
	const bodyStarted = deferred<void>();
	const response = Response.json({ error: 'auth_required' }, { status: 401 });
	const clone = response.clone.bind(response);
	response.clone = () => {
		const copy = clone();
		copy.json = () => {
			bodyStarted.resolve();
			return body.promise;
		};
		return copy;
	};
	replaceFetch(t, async () => response);

	const resultPromise = apiFetch('/api/account');
	await bodyStarted.promise;
	account.setAccount('account-b');
	body.resolve({ error: 'auth_required' });

	assert.deepEqual(await resultPromise, {
		ok: false,
		status: 401,
		error: 'auth_required',
	});
	assert.deepEqual(account.events, []);
});

test('noteSessionExpiry ignores a delayed old-account 401 body', async (t) => {
	const account = replaceAccountWindow(t, 'account-a');
	const expectedAccount = getLocalAccount();
	const body = deferred<{ error: string }>();
	const bodyStarted = deferred<void>();
	const response = Response.json({ error: 'auth_required' }, { status: 401 });
	const clone = response.clone.bind(response);
	response.clone = () => {
		const copy = clone();
		copy.json = () => {
			bodyStarted.resolve();
			return body.promise;
		};
		return copy;
	};

	noteSessionExpiry(response, expectedAccount);
	await bodyStarted.promise;
	account.setAccount('account-b');
	body.resolve({ error: 'auth_required' });
	await body.promise;
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(account.events, []);
});

test('same-account auth failures still notify and item_not_found stays ordinary', async (t) => {
	const account = replaceAccountWindow(t, 'account-a');
	const responses = [
		Response.json({ error: 'auth_required' }, { status: 401 }),
		Response.json({ error: 'item_not_found' }, { status: 404 }),
	];
	replaceFetch(t, async () => responses.shift() as Response);

	assert.deepEqual(await apiFetch('/api/account'), {
		ok: false,
		status: 401,
		error: 'auth_required',
	});
	assert.deepEqual(
		account.events.map((event) => event.type),
		[SESSION_EXPIRED_EVENT],
	);
	account.events.length = 0;
	assert.deepEqual(await apiFetch('/api/wg/TEST1234/expenses'), {
		ok: false,
		status: 404,
		error: 'item_not_found',
	});
	assert.deepEqual(account.events, []);
});
