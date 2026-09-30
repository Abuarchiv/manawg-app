import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const srcRoot = path.join(process.cwd(), 'src');
const routeFile = path.join(srcRoot, 'app/api/wg/[code]/imports/preview/route.ts');

const WG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTIVE_ANNA = '11111111-1111-4111-8111-111111111111';
const DEACTIVATED_BERT = '22222222-2222-4222-8222-222222222222';
const FOREIGN_CARA = '33333333-3333-4333-8333-333333333333';

const CSV = [
	'Datum;Titel;Betrag;Bezahlt von;Teilnehmer',
	'01.02.2026;Pizza;10,00;Anna;Anna, Bert',
].join('\n');

/**
 * Transpiles the real route and its real `@/` dependencies (import-parsers,
 * import-body, errors, …) to CommonJS and runs them against fakes for the
 * modules that need a database or a Next.js runtime. Each harness gets its own
 * module cache so tests cannot observe each other's state.
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

function harness() {
	const state = {
		members: [
			{ id: ACTIVE_ANNA, name: 'Anna', deactivatedAt: null },
			{ id: DEACTIVATED_BERT, name: 'Bert', deactivatedAt: new Date('2026-01-01T00:00:00Z') },
		],
	};
	const overrides = {
		'@/core/db': {
			db: { select: () => ({ from: () => ({ where: async () => state.members }) }) },
			wgMembers: { wgId: {}, id: {}, name: {}, deactivatedAt: {} },
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: WG_ID, name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId: MEMBER_ID, name: 'Member' },
			}),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
		'@/core/infra/observability': {
			captureException: () => undefined,
			logApiError: () => undefined,
		},
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), importLimiter: {} },
		'drizzle-orm': { eq: () => null, and: () => null, isNull: () => null, inArray: () => null },
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	};
	const route = createLoader(overrides)(routeFile);
	const post = (body) =>
		route.POST(
			new Request('https://example.invalid/api/wg/MTE8PZAT/imports/preview', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
			{ code: 'MTE8PZAT' },
		);
	return { state, post };
}

test('preview never maps a name onto a deactivated member', async () => {
	const { post } = harness();
	const res = await post({ source: 'splid_csv', payload: CSV });
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.memberMapping.Anna, ACTIVE_ANNA);
	assert.equal(body.memberMapping.Bert, null, 'deactivated member must not be a mapping target');
	assert.deepEqual(body.conflicts, ['Bert']);
	assert.deepEqual(
		body.members.map((m) => m.name),
		['Anna'],
	);
	assert.ok(
		body.members.every((m) => !('deactivatedAt' in m)),
		'preview only advertises valid mapping targets',
	);
});

test('an explicitly requested mapping to a deactivated member becomes a conflict', async () => {
	const { post } = harness();
	const res = await post({
		source: 'splid_csv',
		payload: CSV,
		memberMapping: { Anna: ACTIVE_ANNA, Bert: DEACTIVATED_BERT },
	});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.memberMapping.Bert, null);
	assert.deepEqual(body.conflicts, ['Bert']);
});

test('a mapping target outside the WG becomes a conflict', async () => {
	const { post } = harness();
	const res = await post({
		source: 'splid_csv',
		payload: CSV,
		memberMapping: { Anna: ACTIVE_ANNA, Bert: FOREIGN_CARA },
	});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.memberMapping.Bert, null);
	assert.deepEqual(body.conflicts, ['Bert']);
});

test('a non-UUID mapping value is rejected like the commit rejects it', async () => {
	const { post } = harness();
	const res = await post({
		source: 'splid_csv',
		payload: CSV,
		memberMapping: { Anna: ACTIVE_ANNA, Bert: 'Bert' },
	});
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: 'invalid_body' });
});

test('a fully active mapping previews without conflicts', async () => {
	const { post } = harness();
	const res = await post({
		source: 'splid_csv',
		payload: CSV,
		memberMapping: { Anna: ACTIVE_ANNA, Bert: ACTIVE_ANNA },
	});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.deepEqual(body.conflicts, []);
	assert.equal(body.memberMapping.Bert, ACTIVE_ANNA);
});
