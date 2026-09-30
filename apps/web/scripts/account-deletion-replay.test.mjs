import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const webDir = path.resolve(import.meta.dirname, '..');
const requireFromWeb = createRequire(path.join(webDir, 'package.json'));
const { ModuleKind, ScriptTarget, transpileModule } = requireFromWeb('typescript');

function load(cached, idempotencyOverrides = {}) {
	const mocks = {
		'@/core/guards/replay-slot': {
			claimReplaySlot: async () => (cached ? { won: false, cached } : { won: true }),
		},
		'@/core/idempotency': {
			claimResponseSlot: async () => true,
			getCachedResponse: async () => cached,
			readIdempotencyKey: (req) => req.headers.get('idempotency-key'),
			releaseResponseSlot: async () => undefined,
			setCachedResponse: async () => undefined,
			...idempotencyOverrides,
		},
		'next/server': { NextResponse: Response },
	};
	const source = readFileSync(path.join(webDir, 'src/core/guards/idempotency.ts'), 'utf8');
	const compiled = transpileModule(source, {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(
		(name) => (Object.hasOwn(mocks, name) ? mocks[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return module.exports;
}

test('a cached membership response is blocked when the account fence is present', async () => {
	const cached = { status: 200, body: { memberId: 'detached-member', token: 'old-token' } };
	const { withIdempotentJsonResponse } = load(cached);
	let handlerCalled = false;
	let gateCalled = false;
	const response = await withIdempotentJsonResponse(
		new Request('https://example.test/api/wg/members', {
			headers: { 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' },
		}),
		'wg-join:account',
		async () => {
			handlerCalled = true;
			return Response.json({ ok: true });
		},
		async () => {
			gateCalled = true;
			return Response.json({ error: 'account_deletion_pending' }, { status: 409 });
		},
	);
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: 'account_deletion_pending' });
	assert.equal(gateCalled, true);
	assert.equal(handlerCalled, false);
});

test('a cached response still replays when the fresh account gate allows it', async () => {
	const cached = { status: 200, body: { ok: true } };
	const { withIdempotentJsonResponse } = load(cached);
	const response = await withIdempotentJsonResponse(
		new Request('https://example.test/api/wg/members', {
			headers: { 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' },
		}),
		'wg-join:account',
		async () => Response.json({ ok: false }),
		async () => null,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
});

function loadWithStore() {
	const store = new Map();
	const released = [];
	const exports = load(null, {
		getCachedResponse: async (scope, key) => store.get(`${scope}:${key}`) ?? null,
		releaseResponseSlot: async (scope, key) => {
			released.push(`${scope}:${key}`);
		},
		setCachedResponse: async (scope, key, payload) => {
			store.set(`${scope}:${key}`, payload);
		},
	});
	return { ...exports, store, released };
}

const retryRequest = () =>
	new Request('https://example.test/api/wg/reminders', {
		method: 'POST',
		headers: { 'Idempotency-Key': '22222222-2222-4222-8222-222222222222' },
	});

test('a 5xx response is not cached and a retry with the same key re-runs the handler', async () => {
	// A failed attempt must not replay: the retry wins the slot again.
	const { withIdempotentJsonResponse, store, released } = loadWithStore();
	let calls = 0;
	const handler = async () => {
		calls += 1;
		return calls === 1
			? Response.json({ error: 'internal' }, { status: 500 })
			: Response.json({ ok: true }, { status: 201 });
	};
	const first = await withIdempotentJsonResponse(retryRequest(), 'reminder:test', handler);
	assert.equal(first.status, 500);
	assert.equal(store.size, 0);
	assert.deepEqual(released, ['reminder:test:22222222-2222-4222-8222-222222222222']);

	const second = await withIdempotentJsonResponse(retryRequest(), 'reminder:test', handler);
	assert.equal(second.status, 201);
	assert.deepEqual(await second.json(), { ok: true });
	assert.equal(calls, 2);
	assert.equal(store.size, 1);

	const replay = await withIdempotentJsonResponse(retryRequest(), 'reminder:test', handler);
	assert.equal(replay.status, 201);
	assert.deepEqual(await replay.json(), { ok: true });
	assert.equal(calls, 2);
});

test('a 429 response and a thrown handler release the claim instead of caching', async () => {
	const { withIdempotentJsonResponse, store, released } = loadWithStore();
	const limited = await withIdempotentJsonResponse(retryRequest(), 'reminder:test', async () =>
		Response.json({ error: 'rate_limited' }, { status: 429 }),
	);
	assert.equal(limited.status, 429);
	await assert.rejects(
		withIdempotentJsonResponse(retryRequest(), 'reminder:test', async () => {
			throw new Error('boom');
		}),
		/boom/,
	);
	assert.equal(store.size, 0);
	assert.equal(released.length, 2);
});
