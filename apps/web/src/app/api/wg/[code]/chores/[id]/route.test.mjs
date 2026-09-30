import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routeFile = path.join(process.cwd(), 'src/app/api/wg/[code]/chores/[id]/route.ts');
const choreId = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const otherWgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function json(body, status = 200) {
	return Response.json(body, { status });
}

function makeRoute(state) {
	const chores = { id: 'chores.id', wgId: 'chores.wg_id' };
	const db = {
		select: () => ({
			from: (table) => ({
				where: (conditions) => ({
					limit: async (limit) => {
						state.queries.push({ table, conditions, limit });
						const filters = new Map(conditions.map(({ column, value }) => [column, value]));
						return state.rows
							.filter(
								(row) => row.id === filters.get(chores.id) && row.wgId === filters.get(chores.wgId),
							)
							.slice(0, limit);
					},
				}),
			}),
		}),
	};
	const overrides = {
		'@/core/audit': { recordAuditEvent: async () => undefined },
		'@/core/db': { CHORE_RECURRENCE_TYPES: ['days', 'months'], chores, db, wgMembers: {} },
		'@/core/errors': {
			badRequest: (code) => json({ error: code }, 400),
			conflict: (code) => json({ error: code }, 409),
			forbidden: (code) => json({ error: code }, 403),
			notFound: (code) => json({ error: code }, 404),
			tooMany: (code) => json({ error: code }, 429),
		},
		'@/core/guards/admin': { isVerifiedWgAdmin: () => true },
		'@/core/guards/api-auth': {
			UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async (_request, code) => {
				state.authCalls.push(code);
				return state.auth;
			},
		},
		'@/core/guards/with-wg-route': {
			withWgRoute: (_label, handler) => async (request, context) =>
				handler(request, await context.params),
		},
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
		'@/features/chores/chore-patch': { buildChorePatchUpdate: () => ({}) },
		'drizzle-orm': {
			and: (...conditions) => conditions,
			eq: (column, value) => ({ column, value }),
			isNull: (column) => ({ column, value: null }),
		},
		'next/server': { NextResponse: { json } },
	};
	const compiled = transpileModule(readFileSync(routeFile, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const routeModule = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(
		(name) => (Object.hasOwn(overrides, name) ? overrides[name] : requireFromWeb(name)),
		routeModule,
		routeModule.exports,
	);
	return { get: routeModule.exports.GET };
}

function makeState(overrides = {}) {
	return {
		rows: [
			{
				id: choreId,
				wgId,
				title: 'Küche reinigen',
				assignedMemberId: null,
				nextDueAt: new Date('2026-09-27T10:00:00.000Z'),
				intervalDays: 7,
				recurrenceType: 'days',
			},
		],
		auth: { ok: true, wg: { id: wgId }, member: { memberId: choreId, name: 'Alex' } },
		authCalls: [],
		queries: [],
		...overrides,
	};
}

function request() {
	return new Request(`https://example.invalid/api/wg/WG123456/chores/${choreId}`);
}

function context(id = choreId) {
	return { params: Promise.resolve({ code: 'WG123456', id }) };
}

test('GET returns the chore needed by the MCP detail reader and scopes by id and WG', async () => {
	const state = makeState();
	const route = makeRoute(state);

	const response = await route.get(request(), context());

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { chore: JSON.parse(JSON.stringify(state.rows[0])) });
	assert.equal(state.authCalls.length, 1);
	assert.deepEqual(
		state.queries[0]?.conditions.map(({ column, value }) => [column, value]),
		[
			['chores.id', choreId],
			['chores.wg_id', wgId],
		],
	);
	assert.equal(state.queries[0]?.limit, 1);
});

test('GET returns not found for a chore id that belongs to another WG', async () => {
	const state = makeState({ rows: [{ ...makeState().rows[0], wgId: otherWgId }] });
	const route = makeRoute(state);

	const response = await route.get(request(), context());

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: 'chore_not_found' });
	assert.equal(state.queries.length, 1);
});

test('GET requires WG membership before querying chores', async () => {
	const denied = json({ error: 'not_a_member' }, 403);
	const state = makeState({ auth: { ok: false, response: denied } });
	const route = makeRoute(state);

	const response = await route.get(request(), context());

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: 'not_a_member' });
	assert.equal(state.queries.length, 0);
});

test('GET rejects a malformed UUID before auth or database access', async () => {
	const state = makeState();
	const route = makeRoute(state);

	const response = await route.get(request(), context('not-a-uuid'));

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { error: 'id_invalid' });
	assert.equal(state.authCalls.length, 0);
	assert.equal(state.queries.length, 0);
});
