import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {
	ModuleKind,
	ScriptKind,
	ScriptTarget,
	createSourceFile,
	forEachChild,
	isFunctionDeclaration,
	transpileModule,
} from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const apiClientPath = path.join(process.cwd(), 'src/core/infra/api-client.ts');
const chatViewPath = path.join(process.cwd(), 'src/features/chat/components/ChatView.tsx');

function loadTypeScript(file, overrides = {}) {
	const output = transpileModule(readFileSync(file, 'utf8'), {
		compilerOptions: {
			esModuleInterop: true,
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
		},
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', output)(
		(name) => (Object.hasOwn(overrides, name) ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

const { apiFetch } = loadTypeScript(apiClientPath, {
	'@/shared/lib/member-header': {
		EXPECTED_MEMBER_ID_HEADER: 'x-manawg-expected-member-id',
		MEMBER_ID_HEADER: 'x-manawg-member-id',
		MEMBER_TOKEN_HEADER: 'x-manawg-member-token',
	},
});

function replaceFetch(t, implementation) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = implementation;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
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

function loadSendMessage({ pendingMessageRequestRef, createOfflineIdempotencyKey }) {
	const source = readFileSync(chatViewPath, 'utf8');
	const sourceFile = createSourceFile(
		'ChatView.tsx',
		source,
		ScriptTarget.Latest,
		true,
		ScriptKind.TSX,
	);
	let functionSource;
	function visit(node) {
		if (isFunctionDeclaration(node) && node.name?.text === 'sendMessage') {
			functionSource = node.getText(sourceFile);
		}
		forEachChild(node, visit);
	}
	visit(sourceFile);
	assert.ok(functionSource, 'expected to find the actual ChatView.sendMessage function');

	const output = transpileModule(`${functionSource}\nmodule.exports = sendMessage;`, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: null };
	new Function(
		'module',
		'apiFetch',
		'setSendError',
		'pendingMessageRequestRef',
		'createOfflineIdempotencyKey',
		'encodedShareCode',
		'identity',
		'explainChatError',
		output,
	)(
		loaded,
		apiFetch,
		() => undefined,
		pendingMessageRequestRef,
		createOfflineIdempotencyKey,
		'MTE8PZAT',
		{ memberId: 'member-1', memberToken: 'token-1' },
		() => 'chat_error',
	);
	return loaded.exports;
}

test('unreadable successful JSON responses have unknown status 0', async (t) => {
	const responses = [
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

	let currentResponse;
	replaceFetch(t, async () => currentResponse);
	for (const [name, response] of responses) {
		currentResponse = response;
		const result = await apiFetch('/api/write', { method: 'POST', body: '{}' });
		assert.equal(result.ok, false, name);
		assert.equal(result.status, 0, name);
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
	const results = [
		[400, 'invalid_body'],
		[409, 'settlement_changed'],
		[429, 'rate_limited'],
	];

	let currentResponse;
	replaceFetch(t, async () => currentResponse);
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
	let requestHeaders;
	let requestSignal;
	replaceFetch(t, async (_input, init) => {
		requestHeaders = new Headers(init.headers);
		requestSignal = init.signal;
		controller.abort();
		return Response.json({ ok: true });
	});

	const result = await apiFetch('/api/write', {
		method: 'POST',
		memberId: 'member-1',
		memberToken: 'token-1',
		signal: controller.signal,
		body: '{}',
	});

	assert.equal(result.ok, true);
	assert.equal(requestHeaders.get('x-manawg-expected-member-id'), 'member-1');
	assert.notEqual(requestSignal, controller.signal);
	assert.equal(requestSignal.aborted, true);
});

test('204 remains a successful empty response', async (t) => {
	replaceFetch(t, async () => new Response(null, { status: 204 }));

	assert.deepEqual(await apiFetch('/api/delete', { method: 'DELETE' }), {
		ok: true,
		data: undefined,
	});
});

test('retrying an ambiguously committed chat message reuses its idempotency key', async (t) => {
	const keys = [];
	const bodies = [];
	let generatedKeys = 0;
	replaceFetch(t, async (_input, init) => {
		keys.push(new Headers(init.headers).get('Idempotency-Key'));
		bodies.push(init.body);
		return truncatedResponse(200);
	});
	const pendingMessageRequestRef = { current: null };
	const sendMessage = loadSendMessage({
		pendingMessageRequestRef,
		createOfflineIdempotencyKey: () => `chat-key-${++generatedKeys}`,
	});
	const message = {
		body: 'committed message',
		mentionMemberIds: [],
		replyToMessageId: null,
	};

	assert.equal(await sendMessage(message), false);
	assert.equal(await sendMessage(message), false);
	assert.deepEqual(keys, ['chat-key-1', 'chat-key-1']);
	assert.deepEqual(
		bodies.map((body) => JSON.parse(body)),
		[message, message],
	);
	assert.equal(generatedKeys, 1);
});
