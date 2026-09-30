import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function loadCachedFetch(apiFetch, generation = { value: 0 }) {
	const source = readFileSync(new URL('./useCachedFetch.ts', import.meta.url), 'utf8');
	const js = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	const mocks = {
		'@/core/infra/api-client': { apiFetch, mutationGeneration: () => generation.value },
		react: {
			useCallback: (callback) => callback,
			useEffect: () => {},
			useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
		},
	};
	vm.runInContext(
		js,
		vm.createContext({ require: (id) => mocks[id], module, exports: module.exports }),
	);
	return module.exports;
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

test('a refresh during a running GET fetches again instead of joining the stale GET', async () => {
	const responses = [deferred(), deferred()];
	let calls = 0;
	const { fetchAndCache } = loadCachedFetch(() => responses[calls++].promise);

	const initial = fetchAndCache('key', '/api/items', {});
	// e.g. a mutation finished here and the page asks for fresh data
	const afterMutation = fetchAndCache('key', '/api/items', {}, true);
	const concurrent = fetchAndCache('key', '/api/items', {}, true);
	assert.equal(calls, 1);
	assert.equal(concurrent, afterMutation);

	responses[0].resolve({ ok: true, data: ['before'] });
	await initial;
	await new Promise((done) => setImmediate(done));
	assert.equal(calls, 2);
	responses[1].resolve({ ok: true, data: ['after'] });
	await afterMutation;
	assert.equal(calls, 2);
});

test('sequential refreshes start one GET each', async () => {
	let calls = 0;
	const { fetchAndCache } = loadCachedFetch(async () => {
		calls += 1;
		return { ok: true, data: [] };
	});
	await fetchAndCache('key', '/api/items', {});
	await fetchAndCache('key', '/api/items', {});
	assert.equal(calls, 2);
});

test('overlapping plain refreshes (focus, polling) share the running GET', async () => {
	const response = deferred();
	let calls = 0;
	const { fetchAndCache } = loadCachedFetch(() => {
		calls += 1;
		return response.promise;
	});
	const first = fetchAndCache('key', '/api/items', {});
	const second = fetchAndCache('key', '/api/items', {});
	assert.equal(second, first);
	response.resolve({ ok: true, data: [] });
	await first;
	await new Promise((done) => setImmediate(done));
	assert.equal(calls, 1);
});

test('a plain refresh after any mutation settled does not join the older GET', async () => {
	const responses = [deferred(), deferred()];
	let calls = 0;
	const generation = { value: 0 };
	const { fetchAndCache } = loadCachedFetch(() => responses[calls++].promise, generation);
	const running = fetchAndCache('key', '/api/items', {});
	generation.value += 1; // e.g. a POST on the Pinnwand finished meanwhile
	const followUp = fetchAndCache('key', '/api/items', {});
	assert.notEqual(followUp, running);
	responses[0].resolve({ ok: true, data: ['before'] });
	await running;
	await new Promise((done) => setImmediate(done));
	assert.equal(calls, 2);
	responses[1].resolve({ ok: true, data: ['after'] });
	await followUp;
});

test('refresh errors survive a concurrent local cache update without replacing it', async () => {
	for (const failure of ['http', 'network']) {
		const response = deferred();
		let initial = true;
		const { useCachedFetch } = loadCachedFetch(() => {
			if (!initial) return response.promise;
			initial = false;
			return Promise.resolve({ ok: true, data: ['initial'] });
		});
		const read = useCachedFetch('/api/items');
		await read.refresh();
		const pending = read.refresh();
		read.setData(['newer local data']);
		if (failure === 'http') {
			response.resolve({ ok: false, status: 503, error: 'service_unavailable' });
		} else {
			response.reject(new Error('offline'));
		}
		assert.equal((await pending).ok, false, failure);
		const current = useCachedFetch('/api/items');
		assert.deepEqual(current.data, ['newer local data']);
		assert.equal(current.error.status, failure === 'http' ? 503 : 0);
		assert.equal(current.isFetching, false);
	}
});

test('a successful stale refresh preserves newer local data', async () => {
	const response = deferred();
	let initial = true;
	const { useCachedFetch } = loadCachedFetch(() => {
		if (!initial) return response.promise;
		initial = false;
		return Promise.resolve({ ok: true, data: ['initial'] });
	});
	const read = useCachedFetch('/api/items');
	await read.refresh();
	const pending = read.refresh();
	read.setData(['newer local data']);
	response.resolve({ ok: true, data: ['stale server data'] });
	await pending;
	const current = useCachedFetch('/api/items');
	assert.deepEqual(current.data, ['newer local data']);
	assert.equal(current.error, undefined);
	assert.equal(current.isFetching, false);
});
