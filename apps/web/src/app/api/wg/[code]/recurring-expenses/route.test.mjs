import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const srcRoot = path.join(process.cwd(), 'src');
const routePath = path.join(srcRoot, 'app/api/wg/[code]/recurring-expenses/route.ts');
const templateId = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const creatorId = '33333333-3333-4333-8333-333333333333';
const otherMemberId = '44444444-4444-4444-8444-444444444444';
const currentDueAt = new Date('2026-10-01T00:00:00.000Z');

function loadTs(filePath, mocks) {
	const source = transpileModule(readFileSync(filePath, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	const require = (name) => {
		if (Object.hasOwn(mocks, name)) return mocks[name];
		// Pure helpers run for real so the route is exercised with its actual validation.
		if (name.startsWith('@/')) return loadTs(path.join(srcRoot, `${name.slice(2)}.ts`), mocks);
		return requireFromWeb(name);
	};
	new Function('require', 'module', 'exports', source)(require, module, module.exports);
	return module.exports;
}

function harness({ callerId = otherMemberId, isAdmin = false } = {}) {
	const recurringExpenses = {
		id: 'recurringExpenses.id',
		wgId: 'recurringExpenses.wgId',
		nextDueAt: 'recurringExpenses.nextDueAt',
		pausedAt: 'recurringExpenses.pausedAt',
	};
	const wgMembers = { id: 'wgMembers.id' };
	const state = {
		template: {
			id: templateId,
			wgId,
			createdByMemberId: creatorId,
			paidByMemberId: creatorId,
			description: 'Miete',
			amountCents: 500,
			currency: 'EUR',
			intervalMonths: 1,
			nextDueAt: currentDueAt,
			anchorAt: currentDueAt,
			lastCreatedAt: null,
			pausedAt: null,
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			splitsJson: JSON.stringify([{ debtorMemberId: creatorId, amountCents: 500 }]),
		},
		updates: [],
		ownerChecks: 0,
	};
	const db = {
		select() {
			let table;
			const query = {
				from(selected) {
					table = selected;
					return query;
				},
				where() {
					const rows = table === wgMembers ? [{ id: creatorId }] : [{ ...state.template }];
					return Object.assign(Promise.resolve(rows), { limit: async () => rows });
				},
			};
			return query;
		},
		update() {
			let values;
			return {
				set(next) {
					values = next;
					return this;
				},
				where() {
					return {
						returning: async () => {
							state.updates.push(values);
							state.template = { ...state.template, ...values };
							return [{ ...state.template }];
						},
					};
				},
			};
		},
	};
	const errorResponse = (code, status) => Response.json({ error: code }, { status });
	const mocks = {
		'@/core/audit': { recordAuditEvent: async () => {} },
		'@/core/db': { db, idempotencyResponses: {}, recurringExpenses, wgMembers },
		'@/core/db/transaction': { TransactionAbort: class TransactionAbort extends Error {} },
		'@/core/errors': {
			apiError: (code, status) => errorResponse(code, status),
			badRequest: (code) => errorResponse(code, 400),
			conflict: (code) => errorResponse(code, 409),
			notFound: (code) => errorResponse(code, 404),
			serverError: () => errorResponse('server_error', 500),
			tooMany: () => errorResponse('rate_limited', 429),
		},
		'@/core/guards/admin': {
			requireOwnerOrAdmin: async (_wgId, member, ownerId) => {
				state.ownerChecks++;
				return member.memberId === ownerId || isAdmin ? null : errorResponse('forbidden', 403);
			},
		},
		'@/core/guards/idempotency': {
			ReplayCache: class ReplayCache {},
			claimReplaySlotWithRetry: async () => null,
			replayKey: () => '',
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId },
				member: { memberId: callerId, name: 'Kim' },
			}),
		},
		'@/core/guards/route-preamble': { readShareCode: async () => ({ ok: true, code: 'MTE8PZAT' }) },
		'@/core/guards/with-wg-route': {
			withWgRoute: (_label, handler) => (req) => handler(req, { code: 'MTE8PZAT' }),
		},
		'@/core/idempotency': {
			RESPONSE_REPLAY_TTL_SECONDS: 60,
			getCachedResponse: async () => null,
			readIdempotencyKey: () => null,
		},
		'@/core/infra/observability': { logApiError: () => {} },
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
		'@/features/expenses/expense-payments': { withExpensePaymentLock: async () => {} },
		'@/features/expenses/expenses': { checkPaidByGuard: () => ({ ok: true }) },
		'drizzle-orm': new Proxy({}, { get: () => () => ({}) }),
		'next/server': {
			NextResponse: Object.assign(class extends Response {}, {
				json: (body, init) => Response.json(body, init),
			}),
		},
	};
	const route = loadTs(routePath, mocks);
	return {
		state,
		patch: (body) =>
			route.PATCH(
				new Request('https://example.test/api/wg/MTE8PZAT/recurring-expenses', {
					method: 'PATCH',
					body: JSON.stringify({ id: templateId, ...body }),
				}),
			),
	};
}

test('PATCH rejects moving nextDueAt out of the catch-up range', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, patch } = harness({ callerId: creatorId });
	for (const nextDueAt of ['2000-01-01T00:00:00.000Z', '2040-01-01T00:00:00.000Z']) {
		const response = await patch({ description: 'Miete', nextDueAt });
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: 'due_date_invalid' });
	}
	assert.deepEqual(state.updates, []);

	const moved = await patch({ nextDueAt: '2026-11-01T00:00:00.000Z' });
	assert.equal(moved.status, 200);
	assert.equal(state.template.nextDueAt.toISOString(), '2026-11-01T00:00:00.000Z');
});

test('any member may advance a template after booking it, but only the owner may edit it', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-25T12:00:00.000Z') });
	const { state, patch } = harness({ callerId: otherMemberId });

	const edit = await patch({ description: 'Strom' });
	assert.equal(edit.status, 403);
	assert.equal(state.template.description, 'Miete');

	const advanced = await patch({ expectedNextDueAt: currentDueAt.toISOString() });
	assert.equal(advanced.status, 200);
	assert.equal(state.template.nextDueAt.toISOString(), '2026-11-01T00:00:00.000Z');

	// The expectedNextDueAt check still rejects a stale or replayed advance.
	const replay = await patch({ expectedNextDueAt: currentDueAt.toISOString() });
	assert.equal(replay.status, 409);
	assert.equal(state.template.nextDueAt.toISOString(), '2026-11-01T00:00:00.000Z');
});
