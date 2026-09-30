import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routePath = 'src/app/api/wg/[code]/absences/route.ts';

const memberId = '22222222-2222-4222-8222-222222222222';

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

function harness() {
	const state = { inserts: [], audit: 0 };

	const memberAbsences = {};
	const wgMembers = {};
	const idempotencyResponses = {};

	const tx = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => [],
				}),
			}),
		}),
		insert: (table) => ({
			values: (value) => ({
				returning: async () => {
					assert.equal(table, memberAbsences);
					state.inserts.push(value);
					return [
						{
							id: 'absence-1',
							wgId: value.wgId,
							memberId: value.memberId,
							startDate: value.startDate,
							endDate: value.endDate,
							reason: value.reason,
						},
					];
				},
			}),
		}),
		execute: async () => [],
	};

	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => [{ id: memberId }],
				}),
			}),
		}),
		delete: () => ({ where: async () => [] }),
	};

	const { POST } = loadTs(routePath, {
		'@/core/audit': {
			recordAuditEvent: async () => {
				state.audit += 1;
			},
		},
		'@/core/db': { db, idempotencyResponses, memberAbsences, wgMembers },
		'@/core/db/transaction': {
			TransactionAbort: class TransactionAbort extends Error {
				constructor(code) {
					super(String(code));
					this.code = String(code);
				}
			},
			withTransaction: async (operation) => operation(tx),
		},
		'@/core/errors': {
			badRequest: (error) => Response.json({ error }, { status: 400 }),
			conflict: (error) => Response.json({ error }, { status: 409 }),
			forbidden: (error) => Response.json({ error }, { status: 403 }),
			serverError: (error) => Response.json({ error: String(error) }, { status: 500 }),
			tooMany: () => Response.json({ error: 'rate_limited' }, { status: 429 }),
		},
		'@/core/guards/admin': { isVerifiedWgAdmin: async () => false },
		'@/core/guards/idempotency': {
			ReplayCache: class ReplayCache {
				get() {
					return null;
				}
				reserve() {
					return null;
				}
				remember() {}
			},
			claimReplaySlotWithRetry: async () => ({ won: true }),
			replayKey: () => 'replay',
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: 'wg', name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId, name: 'Member', verified: true },
			}),
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
		'@/core/idempotency': {
			RESPONSE_REPLAY_TTL_SECONDS: 600,
			getCachedResponse: async () => null,
			readIdempotencyKey: () => null,
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
		'@/core/utils/berlin-day': loadTs('src/core/utils/berlin-day.ts'),
		'drizzle-orm': {
			and: () => null,
			asc: () => null,
			eq: () => null,
			gt: () => null,
			gte: () => null,
			isNull: () => null,
			lte: () => null,
			sql: (strings, ...values) => ({ strings, values }),
		},
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	});

	return {
		state,
		post: (startDate, endDate) =>
			POST(
				new Request('https://example.invalid', {
					method: 'POST',
					body: JSON.stringify({ memberId, startDate, endDate, reason: null }),
				}),
				{ code: 'MTE8PZAT' },
			),
	};
}

test('a same-day reversed time range is rejected', async () => {
	const route = harness();
	const response = await route.post('2026-10-05T15:00:00+02:00', '2026-10-05T09:00:00+02:00');
	const body = await response.json();
	assert.equal(response.status, 400, JSON.stringify(body));
	assert.equal(body.error, 'date_range_invalid');
	assert.equal(route.state.inserts.length, 0, 'a negative-duration absence must never be stored');
});

test('a reversed range across days is rejected', async () => {
	const route = harness();
	const response = await route.post('2026-10-06T09:00:00+02:00', '2026-10-05T15:00:00+02:00');
	assert.equal(response.status, 400);
	assert.equal((await response.json()).error, 'date_range_invalid');
});

test('a same-day forward range is still accepted', async () => {
	const route = harness();
	const response = await route.post('2026-10-05T09:00:00+02:00', '2026-10-05T15:00:00+02:00');
	const body = await response.json();
	assert.equal(response.status, 200, JSON.stringify(body));
	assert.equal(route.state.inserts.length, 1);
	assert.equal(route.state.audit, 1);
	assert.equal(body.absence.startDate, new Date('2026-10-05T09:00:00+02:00').toISOString());
	assert.ok(body.absence.endDate > body.absence.startDate);
});
