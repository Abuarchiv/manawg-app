import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routeFile = path.join(process.cwd(), 'src/app/api/wg/[code]/chores/[id]/complete/route.ts');
const choreId = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const memberA = '33333333-3333-4333-8333-333333333333';
const memberB = '44444444-4444-4444-8444-444444444444';
const idempotencyKey = '55555555-5555-4555-8555-555555555555';
const originalDueAt = new Date('2026-09-27T10:00:00.000Z');

function json(body, status = 200) {
	return Response.json(body, { status });
}

function makeRoute(state) {
	const tables = {
		announcements: {
			wgId: 'announcements.wg_id',
			status: 'announcements.status',
			source: 'announcements.source',
			sourcePath: 'announcements.source_path',
		},
		choreCompletions: {
			id: 'chore_completions.id',
			choreId: 'chore_completions.chore_id',
			completedByMemberId: 'chore_completions.completed_by_member_id',
		},
		chores: {
			id: 'chores.id',
			wgId: 'chores.wg_id',
			intervalDays: 'chores.interval_days',
			recurrenceType: 'chores.recurrence_type',
			title: 'chores.title',
			assignedMemberId: 'chores.assigned_member_id',
			nextDueAt: 'chores.next_due_at',
			anchorAt: 'chores.anchor_at',
		},
		idempotencyResponses: {
			scope: 'idempotency_responses.scope',
			key: 'idempotency_responses.key',
			responseBody: 'idempotency_responses.response_body',
			expiresAt: 'idempotency_responses.expires_at',
		},
		memberAbsences: {
			wgId: 'member_absences.wg_id',
			memberId: 'member_absences.member_id',
			startDate: 'member_absences.start_date',
			endDate: 'member_absences.end_date',
		},
		wgMembers: {
			id: 'wg_members.id',
			wgId: 'wg_members.wg_id',
			name: 'wg_members.name',
			createdAt: 'wg_members.created_at',
			deactivatedAt: 'wg_members.deactivated_at',
		},
	};
	const localReplay = new Map();
	const rowsFor = (table, projection, draft = state) => {
		if (table === tables.chores) {
			return projection?.intervalDays
				? [{ ...draft.chore }]
				: [{ assignedMemberId: draft.chore.assignedMemberId, nextDueAt: draft.chore.nextDueAt }];
		}
		if (table === tables.idempotencyResponses) {
			return draft.claim ? [{ body: draft.claim, expiresAt: draft.claimExpiresAt }] : [];
		}
		if (table === tables.wgMembers) {
			return [
				{ id: memberA, name: 'Alex' },
				{ id: memberB, name: 'Bela' },
			];
		}
		return [];
	};
	const query = (rows) => {
		const result = Promise.resolve(rows);
		result.limit = () => {
			const limited = rows.slice(0, 1);
			limited.for = async () => limited;
			return limited;
		};
		result.orderBy = async () => rows;
		return result;
	};
	const makeSelect =
		(draft = state) =>
		(projection) => ({
			from: (table) => ({
				where: () => query(rowsFor(table, projection, draft)),
			}),
		});
	const releaseClaim = () => {
		if (state.claim && state.claim._claimed === true) {
			state.claim = null;
			state.claimExpiresAt = null;
		}
	};
	const db = {
		select: makeSelect(),
		delete: (table) => ({
			where: async () => {
				if (table === tables.idempotencyResponses) releaseClaim();
			},
		}),
	};
	class TransactionAbort extends Error {
		constructor(code) {
			super(code);
			this.code = code;
		}
	}
	const withTransaction = async (operation) => {
		const draft = {
			...state,
			chore: { ...state.chore },
			completions: state.completions.slice(),
			claim: state.claim && { ...state.claim },
		};
		const tx = {
			select: makeSelect(draft),
			update: (table) => ({
				set: (values) => ({
					where: () => ({
						returning: async () => {
							if (table === tables.chores) {
								draft.chore = { ...draft.chore, ...values };
								return [{ ...draft.chore }];
							}
							if (table === tables.idempotencyResponses) {
								if (state.failReplayWrite) return [];
								draft.claim = values.responseBody;
								draft.claimExpiresAt = values.expiresAt;
								return [{ scope: 'claimed' }];
							}
							return [];
						},
					}),
				}),
			}),
			insert: (table) => ({
				values: (value) => ({
					returning: async () => {
						assert.equal(table, tables.choreCompletions);
						draft.completions.push(value);
						return [{ id: `completion-${draft.completions.length}` }];
					},
				}),
			}),
		};
		const result = await operation(tx);
		state.chore = draft.chore;
		state.completions = draft.completions;
		state.claim = draft.claim;
		state.claimExpiresAt = draft.claimExpiresAt;
		return result;
	};
	class ReplayCache {
		get(key) {
			return localReplay.get(key) ?? null;
		}
		remember(key, body) {
			localReplay.set(key, Promise.resolve(body));
		}
		reserve(key) {
			const existing = this.get(key);
			if (existing) return { owned: false, promise: existing };
			let resolvePromise;
			let rejectPromise;
			const promise = new Promise((resolve, reject) => {
				resolvePromise = resolve;
				rejectPromise = reject;
			});
			promise.catch(() => undefined);
			localReplay.set(key, promise);
			return {
				owned: true,
				resolve: (body) => {
					this.remember(key, body);
					resolvePromise(body);
				},
				reject: (error) => {
					localReplay.delete(key);
					rejectPromise(error);
				},
			};
		}
	}
	const overrides = {
		'@/core/audit': {
			recordAuditEvent: async () => {
				state.audits += 1;
			},
		},
		'@/core/db': { ...tables, db },
		'@/core/db/transaction': { TransactionAbort, withTransaction },
		'@/core/errors': {
			badRequest: (code) => json({ error: code }, 400),
			conflict: (code) => json({ error: code }, 409),
			notFound: (code) => json({ error: code }, 404),
			serverError: (code) => json({ error: code }, 500),
			tooMany: () => json({ error: 'too_many' }, 429),
		},
		'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
		'@/core/guards/idempotency': {
			ReplayCache,
			claimReplaySlotWithRetry: async () => {
				if (state.claim && state.claim._claimed !== true)
					return { won: false, cached: state.claim };
				state.claim = { _claimed: true };
				state.claimExpiresAt = new Date(Date.now() + 15 * 60_000);
				return { won: true };
			},
			replayKey: (scope, key) => `${scope}:${key}`,
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId },
				member: { memberId: memberA, name: 'Alex' },
			}),
		},
		'@/core/guards/with-wg-route': {
			withWgRoute: (_label, handler) => async (request, context) =>
				handler(request, await context.params),
		},
		'@/core/idempotency': {
			RESPONSE_REPLAY_TTL_SECONDS: 7 * 24 * 60 * 60,
			getCachedResponse: async () =>
				state.claim && state.claim._claimed !== true ? state.claim : null,
			readIdempotencyKey: (request) => request.headers.get('idempotency-key'),
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
		'@/core/utils/berlin-day': { startOfBerlinDay: (date) => new Date(date) },
		'@/features/chores/absence': {
			getAbsentMemberIds: (_absences, at) => {
				state.absenceCheckedAt = at;
				return [];
			},
		},
		'@/features/chores/chore-fairness': {
			computeOpenGapsByMember: () => new Map(),
			chooseNextAvailableMember: ({ members, currentMemberId }) =>
				members.find((member) => member.id !== currentMemberId)?.id ?? currentMemberId,
		},
		'@/features/chores/chore-recurrence': {
			computeNextDueAt: (previousDueAt, intervalDays) =>
				new Date(previousDueAt.getTime() + intervalDays * 86_400_000),
			isLateCompletion: (previousDueAt, completedAt) =>
				completedAt.getTime() > previousDueAt.getTime(),
		},
		'drizzle-orm': {
			and: (...values) => values,
			eq: (...values) => values,
			gt: (...values) => values,
			gte: (...values) => values,
			isNull: (value) => [value, null],
			sql: () => null,
		},
		'next/server': { NextResponse: { json } },
	};
	const compiled = transpileModule(readFileSync(routeFile, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(
		(name) => (Object.hasOwn(overrides, name) ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	const post = module.exports.POST;
	return {
		state,
		post,
		request: (
			body = { expectedNextDueAt: originalDueAt.toISOString(), expectedAssignedMemberId: memberA },
		) =>
			new Request(`https://example.invalid/api/wg/MTE8PZAT/chores/${choreId}/complete`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
				body: JSON.stringify(body),
			}),
		context: { params: Promise.resolve({ code: 'MTE8PZAT', id: choreId }) },
	};
}

function makeState(overrides = {}) {
	return {
		chore: {
			id: choreId,
			wgId,
			intervalDays: 7,
			recurrenceType: 'days',
			title: 'Bad putzen',
			assignedMemberId: memberA,
			nextDueAt: new Date(originalDueAt),
			anchorAt: new Date(originalDueAt),
		},
		completions: [],
		claim: null,
		claimExpiresAt: null,
		audits: 0,
		failReplayWrite: false,
		...overrides,
	};
}

test('chore replay-write failure rolls back completion and lets retry commit exactly once', async () => {
	const state = makeState({ failReplayWrite: true });
	let route = makeRoute(state);
	const failed = await route.post(route.request(), route.context);
	assert.equal(failed.status, 500);
	assert.equal(state.completions.length, 0);
	assert.equal(state.chore.nextDueAt.getTime(), originalDueAt.getTime());
	assert.equal(state.claim, null);

	state.failReplayWrite = false;
	route = makeRoute(state);
	const first = await route.post(route.request(), route.context);
	assert.equal(first.status, 200);
	assert.equal(state.completions.length, 1);
	assert.equal(state.chore.nextDueAt.getTime(), originalDueAt.getTime() + 7 * 86_400_000);

	route = makeRoute(state);
	const retry = await route.post(route.request(), route.context);
	assert.equal(retry.status, 200);
	assert.equal(state.completions.length, 1);
	assert.equal(state.chore.nextDueAt.getTime(), originalDueAt.getTime() + 7 * 86_400_000);
});

test('stale and legacy chore completion payloads conflict without advancing the next occurrence', async () => {
	const state = makeState({
		chore: {
			id: choreId,
			wgId,
			intervalDays: 7,
			recurrenceType: 'days',
			title: 'Bad putzen',
			assignedMemberId: memberB,
			nextDueAt: new Date(originalDueAt.getTime() + 7 * 86_400_000),
			anchorAt: new Date(originalDueAt),
		},
		completions: [{ choreId, completedByMemberId: memberB }],
	});
	const route = makeRoute(state);
	const stale = await route.post(route.request(), route.context);
	assert.equal(stale.status, 409);
	assert.deepEqual(await stale.json(), { error: 'chore_occurrence_changed' });
	const legacy = await route.post(route.request({}), route.context);
	assert.equal(legacy.status, 409);
	assert.deepEqual(await legacy.json(), { error: 'chore_occurrence_changed' });
	assert.equal(state.completions.length, 1);
	assert.equal(state.chore.nextDueAt.getTime(), originalDueAt.getTime() + 7 * 86_400_000);
});

test('rotation checks absences on the next due day, not at completion time', async () => {
	const state = makeState();
	const route = makeRoute(state);
	const response = await route.post(route.request(), route.context);
	assert.equal(response.status, 200);
	assert.equal(state.absenceCheckedAt, originalDueAt.getTime() + 7 * 86_400_000);
});
