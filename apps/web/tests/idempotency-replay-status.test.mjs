import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const srcRoot = path.join(process.cwd(), 'src');
const file = path.join(srcRoot, 'core/guards/idempotency.ts');
const scope = 'inventory:create:wg-1:member-1';
const key = '11111111-1111-4111-8111-111111111111';

// Resolve "@/..." aliases and transpile ".ts" on require, so the guard's
// pure sibling modules load exactly as they do in the app.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWebModule(request, parent, isMain, options) {
	const resolved = request.startsWith('@/') ? path.join(srcRoot, request.slice(2)) : request;
	return resolveFilename.call(this, resolved, parent, isMain, options);
};
Module._extensions['.ts'] = (loadedModule, filename) => {
	const source = fs.readFileSync(filename, 'utf8');
	const compiled = transpileModule(source, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
		fileName: filename,
	}).outputText;
	loadedModule._compile(compiled, filename);
};

function harness() {
	const state = {
		calls: new Map(),
		claimed: new Map(),
		released: [],
		runs: 0,
	};
	const overrides = {
		'@/core/idempotency': {
			readIdempotencyKey: (req) => req.headers.get('idempotency-key'),
			getCachedResponse: async (scopeName, idemKey) =>
				state.calls.get(`${scopeName}:${idemKey}`) ?? null,
			claimResponseSlot: async (scopeName, idemKey) => {
				const cacheKey = `${scopeName}:${idemKey}`;
				if (state.claimed.has(cacheKey)) return false;
				state.claimed.set(cacheKey, true);
				return true;
			},
			releaseResponseSlot: async (scopeName, idemKey) => {
				state.released.push(`${scopeName}:${idemKey}`);
				state.claimed.delete(`${scopeName}:${idemKey}`);
			},
			setCachedResponse: async (scopeName, idemKey, payload) => {
				state.calls.set(`${scopeName}:${idemKey}`, payload);
				state.claimed.delete(`${scopeName}:${idemKey}`);
			},
		},
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	};
	const source = transpileModule(fs.readFileSync(file, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);

	const request = () =>
		new Request('https://example.invalid', { method: 'POST', headers: { 'Idempotency-Key': key } });

	return {
		state,
		call: (handler) => module.exports.withIdempotentJsonResponse(request(), scope, handler),
	};
}

test('a 500 is never cached and the retry re-executes the handler', async () => {
	const { state, call } = harness();
	const first = await call(async () => {
		state.runs += 1;
		return Response.json({ error: 'insert_failed' }, { status: 500 });
	});
	assert.equal(first.status, 500);
	assert.equal(state.runs, 1);
	assert.deepEqual(state.released, [`${scope}:${key}`], 'claim must be released on 5xx');
	assert.equal(state.calls.has(`${scope}:${key}`), false, '5xx must not be stored');

	const second = await call(async () => {
		state.runs += 1;
		return Response.json({ item: { id: 'item-1' } }, { status: 201 });
	});
	assert.equal(second.status, 201);
	assert.equal(state.runs, 2, 'retry re-runs the handler instead of replaying the 500');
	assert.deepEqual(await second.json(), { item: { id: 'item-1' } });
	assert.equal(state.calls.get(`${scope}:${key}`).status, 201);
});

test('a successful response is replayed without re-running the handler', async () => {
	const { state, call } = harness();
	const first = await call(async () => {
		state.runs += 1;
		return Response.json({ item: { id: 'item-1' } }, { status: 201 });
	});
	assert.equal(first.status, 201);
	assert.deepEqual(state.released, []);

	const replay = await call(async () => {
		state.runs += 1;
		return Response.json({ item: { id: 'item-2' } }, { status: 201 });
	});
	assert.equal(replay.status, 201);
	assert.deepEqual(await replay.json(), { item: { id: 'item-1' } });
	assert.equal(state.runs, 1, 'replay must not execute the handler again');
});

test('a 429 throttle is not replayed for the seven-day window', async () => {
	const { state, call } = harness();
	const first = await call(async () => {
		state.runs += 1;
		return Response.json({ error: 'reminder_cooldown' }, { status: 429 });
	});
	assert.equal(first.status, 429);
	assert.deepEqual(state.released, [`${scope}:${key}`]);
	assert.equal(state.calls.has(`${scope}:${key}`), false, '429 must not be stored');
});

test('a deterministic 4xx releases the claim and is not replayed', async () => {
	const { state, call } = harness();
	const first = await call(async () => {
		state.runs += 1;
		return Response.json({ error: 'member_not_in_wg' }, { status: 400 });
	});
	assert.equal(first.status, 400);
	assert.deepEqual(state.released, [`${scope}:${key}`]);
	assert.equal(state.calls.has(`${scope}:${key}`), false, '4xx must not be stored');

	const replay = await call(async () => {
		state.runs += 1;
		return Response.json({ error: 'member_not_in_wg' }, { status: 400 });
	});
	assert.equal(state.runs, 2, 'retry re-runs a deterministic 4xx');
	assert.deepEqual(state.released, [`${scope}:${key}`, `${scope}:${key}`]);
	assert.deepEqual(await replay.json(), { error: 'member_not_in_wg' });
	assert.equal(state.calls.has(`${scope}:${key}`), false);
});

test('a handler that throws releases the claim', async () => {
	const { state, call } = harness();
	await assert.rejects(
		() =>
			call(async () => {
				state.runs += 1;
				throw new Error('db_down');
			}),
		/db_down/,
	);
	assert.deepEqual(state.released, [`${scope}:${key}`]);
	assert.equal(state.calls.has(`${scope}:${key}`), false);

	await call(async () => {
		state.runs += 1;
		return Response.json({ ok: true }, { status: 200 });
	});
	assert.equal(state.runs, 2, 'the next retry re-runs the handler');
});
