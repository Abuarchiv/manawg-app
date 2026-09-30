import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));

function loadTs(file, overrides = {}) {
	const source = transpileModule(readFileSync(path.join(process.cwd(), file), 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return module.exports;
}

const ACTIVE = '11111111-1111-4111-8111-111111111111';
const MOVED_OUT = '22222222-2222-4222-8222-222222222222';
const FOREIGN_WG_MEMBER = '99999999-9999-4999-8999-999999999999';

function previewRoute() {
	const queried = [];
	const wgMembers = { wgId: 'wgMembers.wgId', deactivatedAt: 'wgMembers.deactivatedAt' };
	const db = {
		select: () => ({
			from: () => ({
				where: async (predicate) => {
					queried.push(predicate);
					// The route must only ever see active members.
					return predicate.includes('isNull:wgMembers.deactivatedAt')
						? [{ id: ACTIVE, name: 'Alex' }]
						: [
								{ id: ACTIVE, name: 'Alex' },
								{ id: MOVED_OUT, name: 'Sam' },
							];
				},
			}),
		}),
	};
	const parsers = loadTs('src/features/expenses/import-parsers.ts', {
		'@/core/utils/money': { CENTS_PER_EURO: 100 },
		'@/features/expenses/expense-constants': { AMOUNT_MAX_CENTS: 100_000_000 },
	});
	const { POST } = loadTs('src/app/api/wg/[code]/imports/preview/route.ts', {
		'@/core/db': { db, wgMembers },
		'@/core/errors': {
			badRequest: (error) => Response.json({ error }, { status: 400 }),
			tooMany: () => new Response(null, { status: 429 }),
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({ ok: true, wg: { id: 'wg' }, member: { memberId: ACTIVE } }),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_name, handler) => handler },
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), importLimiter: {} },
		'@/features/expenses/import-body': {
			MAX_CSV_BYTES: 1_000_000,
			MAX_OCR_BYTES: 1_000_000,
			readImportJsonBody: async (req) => ({ ok: true, value: await req.json() }),
		},
		'@/features/expenses/import-hash': { hashPayload: () => 'hash' },
		'@/features/expenses/import-parsers': {
			...parsers,
			parseSplitwiseCsv: () => [
				{ paidByName: 'Alex', splits: [{ memberName: 'Sam', amountCents: 100 }] },
			],
		},
		'@/features/expenses/ocr': { parseOcrText: () => ({ expenses: [] }) },
		'drizzle-orm': {
			and: (...parts) => parts.join('&'),
			eq: (column) => `eq:${column}`,
			isNull: (column) => `isNull:${column}`,
		},
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	});
	return (memberMapping) =>
		POST(
			new Request('https://example.invalid', {
				method: 'POST',
				body: JSON.stringify({ source: 'splitwise_csv', payload: 'csv', memberMapping }),
			}),
			{ code: 'MTE8PZAT' },
		);
}

test('preview rejects a mapping to a moved-out member as a conflict', async () => {
	const post = previewRoute();
	const body = await (await post({ Sam: MOVED_OUT })).json();
	assert.deepEqual(body.members, [{ id: ACTIVE, name: 'Alex' }]);
	assert.equal(body.memberMapping.Sam, null);
	assert.equal(body.memberMapping.Alex, ACTIVE);
	assert.deepEqual(body.conflicts, ['Sam']);
});

test('preview rejects unknown member ids and keeps valid ones', async () => {
	const post = previewRoute();
	const body = await (await post({ Sam: 'not-a-member', Alex: ACTIVE })).json();
	assert.deepEqual(body.conflicts, ['Sam']);
	const clean = await (await post({ Sam: ACTIVE, Alex: ACTIVE })).json();
	assert.deepEqual(clean.conflicts, []);
	assert.equal(clean.memberMapping.Sam, ACTIVE);
	assert.equal(clean.memberMapping.Alex, ACTIVE);
});

test('preview rejects a valid UUID mapping target outside the WG', async () => {
	const post = previewRoute();
	const body = await (await post({ Sam: FOREIGN_WG_MEMBER })).json();
	assert.equal(body.memberMapping.Sam, null);
	assert.deepEqual(body.conflicts, ['Sam']);
});
