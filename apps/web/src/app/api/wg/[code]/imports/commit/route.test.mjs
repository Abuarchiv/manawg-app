import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const srcRoot = path.join(process.cwd(), 'src');
const routeFile = path.join(srcRoot, 'app/api/wg/[code]/imports/commit/route.ts');

const WG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ANNA = '11111111-1111-4111-8111-111111111111';
const KEY = '99999999-9999-4999-8999-999999999999';

const CSV = ['Datum;Titel;Betrag;Bezahlt von;Teilnehmer', '01.02.2026;Pizza;10,00;Anna;Anna'].join(
	'\n',
);

/**
 * Transpiles the real route plus its real `@/` dependencies (errors,
 * guards/idempotency, import-parsers, …) and swaps only the parts that need a
 * database or a Next.js runtime. Each harness gets its own module cache.
 */
function createLoader(overrides) {
	const cache = new Map();
	const resolveTs = (base) => {
		const asFile = `${base}.ts`;
		if (existsSync(asFile) && statSync(asFile).isFile()) return asFile;
		if (existsSync(base) && statSync(base).isFile()) return base;
		const asIndex = path.join(base, 'index.ts');
		if (existsSync(asIndex) && statSync(asIndex).isFile()) return asIndex;
		throw new Error(`cannot resolve module: ${base}`);
	};
	const load = (file) => {
		const abs = resolveTs(path.resolve(file));
		const cached = cache.get(abs);
		if (cached) return cached.exports;
		const module = { exports: {} };
		cache.set(abs, module);
		const source = transpileModule(readFileSync(abs, 'utf8'), {
			compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
		}).outputText;
		const localRequire = (spec) => {
			if (Object.hasOwn(overrides, spec)) return overrides[spec];
			if (spec.startsWith('@/')) return load(path.join(srcRoot, spec.slice(2)));
			if (spec.startsWith('.')) return load(path.resolve(path.dirname(abs), spec));
			return requireFromWeb(spec);
		};
		new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
		return module.exports;
	};
	return load;
}

/** Mirrors the Postgres `idempotency_responses` semantics used by the route. */
function createReplayStore(state) {
	const CLAIM = { _claimed: true };
	const store = new Map();
	const keyOf = (scope, key) => `${scope}:${key}`;
	return {
		store,
		module: {
			RESPONSE_REPLAY_TTL_SECONDS: 7 * 24 * 60 * 60,
			readIdempotencyKey: (req) => {
				const raw = req.headers.get('idempotency-key');
				if (!raw) return null;
				const trimmed = raw.trim();
				if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
					return null;
				}
				return trimmed.toLowerCase();
			},
			claimResponseSlot: async (scope, key) => {
				const slot = keyOf(scope, key);
				if (store.has(slot)) return false;
				store.set(slot, CLAIM);
				state.claims.push(slot);
				return true;
			},
			getCachedResponse: async (scope, key) => {
				const body = store.get(keyOf(scope, key));
				if (body === undefined || body === CLAIM) return null;
				if (body._replayUnavailable === true) throw new Error('idempotency_response_unavailable');
				return body;
			},
			setCachedResponse: async (scope, key, payload) => {
				store.set(keyOf(scope, key), payload);
			},
			releaseResponseSlot: async (scope, key) => {
				state.releases.push(keyOf(scope, key));
				if (store.get(keyOf(scope, key)) === CLAIM) store.delete(keyOf(scope, key));
			},
			persistImportReplayWarning: async () => true,
		},
	};
}

function harness() {
	const state = { claims: [], releases: [], commitCalls: 0, failure: 'member_not_in_wg' };
	const { store, module: idempotencyModule } = createReplayStore(state);
	const overrides = {
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: WG_ID, name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId: MEMBER_ID, name: 'Member' },
			}),
		},
		'@/core/guards/route-preamble': {
			readShareCode: async (ctx) => ({ ok: true, code: (await ctx.params).code }),
		},
		'@/core/idempotency': idempotencyModule,
		'@/core/infra/observability': {
			captureException: () => undefined,
			logApiError: () => undefined,
		},
		'@/core/rate-limit': {
			checkRateLimit: async () => ({ success: true }),
			importCommitLimiter: {},
		},
		'@/features/expenses/import-commit': {
			isCommitResult: (value) =>
				value !== null &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				Object.keys(value).length === 5 &&
				typeof value.importId === 'string' &&
				value.importId.length > 0 &&
				Number.isInteger(value.inserted) &&
				value.inserted >= 0 &&
				Number.isInteger(value.skipped) &&
				value.skipped >= 0 &&
				Array.isArray(value.errors) &&
				value.errors.every(
					(e) =>
						e !== null &&
						typeof e === 'object' &&
						Number.isInteger(e.index) &&
						typeof e.reason === 'string',
				) &&
				(value.warning === null ||
					value.warning === 'notification_delivery_failed' ||
					value.warning === 'notification_delivery_unknown'),
			// Mirrors `writeImport`: a successful commit replaces its claim
			// placeholder with the real response inside the same transaction.
			commitImport: async (input) => {
				state.commitCalls += 1;
				if (state.failure) throw new Error(state.failure);
				const result = { importId: 'import-1', inserted: 1, skipped: 0, errors: [], warning: null };
				if (input.replay) store.set(`${input.replay.scope}:${input.replay.key}`, result);
				return result;
			},
		},
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	};
	const route = createLoader(overrides)(routeFile);
	const post = (body, { key = KEY } = {}) =>
		route.POST(
			new Request('https://example.invalid/api/wg/MTE8PZAT/imports/commit', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(key ? { 'Idempotency-Key': key } : {}),
				},
				body: JSON.stringify({
					source: 'splid_csv',
					payload: CSV,
					memberMapping: { Anna: ANNA },
					...body,
				}),
			}),
			{ params: Promise.resolve({ code: 'MTE8PZAT' }) },
		);
	return { state, store, post };
}

test('a failed commit releases its claim so the retry returns the original 400', async () => {
	const { state, store, post } = harness();

	const first = await post();
	assert.equal(first.status, 400);
	assert.deepEqual(await first.json(), { error: 'member_not_in_wg' });
	assert.equal(state.claims.length, 1, 'the failure happens while holding the claim');
	assert.equal(state.releases.length, 1, 'the claim is released on the failure path');
	assert.equal(store.size, 0, 'no claim may survive the failed commit');

	const retry = await post();
	assert.equal(retry.status, 400, 'a retry must not turn into idempotency_response_pending');
	assert.deepEqual(await retry.json(), { error: 'member_not_in_wg' });
	assert.equal(state.commitCalls, 2, 'the retry re-runs the commit instead of replaying a claim');
});

test('a failed commit without an Idempotency-Key returns its original status', async () => {
	const { state, post } = harness();
	const first = await post({}, { key: null });
	const second = await post({}, { key: null });
	assert.equal(first.status, 400);
	assert.equal(second.status, 400);
	assert.equal(state.claims.length, 0, 'no idempotency key means no claim');
	assert.equal(state.releases.length, 0);
	assert.equal(state.commitCalls, 2);
});

test('a successful commit keeps its response for replay', async () => {
	const { state, store, post } = harness();
	state.failure = null;

	const first = await post();
	assert.equal(first.status, 200);
	assert.deepEqual(await first.json(), {
		importId: 'import-1',
		inserted: 1,
		skipped: 0,
		errors: [],
		warning: null,
	});
	assert.equal(state.releases.length, 0, 'a successful commit must not release its claim');

	const replay = await post();
	assert.equal(replay.status, 200);
	assert.deepEqual(await replay.json(), {
		importId: 'import-1',
		inserted: 1,
		skipped: 0,
		errors: [],
		warning: null,
	});
	assert.equal(state.commitCalls, 1, 'the replay must not commit a second time');
	assert.equal(store.size, 1, 'the completed response stays cached');
});
