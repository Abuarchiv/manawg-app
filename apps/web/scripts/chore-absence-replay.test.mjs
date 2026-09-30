import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const requireFromWeb = createRequire(new URL('../package.json', import.meta.url));
const ts = requireFromWeb('typescript');
const wgId = '989ac820-58b7-431f-9c65-28721264f333';
const memberId = '7d898f9e-5ad7-4f5d-abed-8c3e99a76973';
const key = 'a597a363-9e4c-4df3-9946-a76375583cd4';

function loadPost(route, overrides) {
	const source = readFileSync(
		new URL(`../src/app/api/wg/[code]/${route}/route.ts`, import.meta.url),
		'utf8',
	);
	const compiled = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', compiled)(
		(name) => (Object.hasOwn(overrides, name) ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports.POST;
}

function harness(kind) {
	const tables = {
		chores: { name: 'chores' },
		memberAbsences: { name: 'memberAbsences' },
		idempotencyResponses: {
			name: 'idempotencyResponses',
			scope: 'scope',
			key: 'key',
			responseBody: 'responseBody',
			expiresAt: 'expiresAt',
		},
		wgMembers: {
			id: 'wgMembers.id',
			wgId: 'wgMembers.wgId',
			deactivatedAt: 'wgMembers.deactivatedAt',
		},
	};
	const state = {
		claim: null,
		claimExpiresAt: null,
		rows: [],
		audits: 0,
		notifications: 0,
		missReplayWrite: false,
		forceWon: false,
		rolloverOnRollback: false,
	};
	const nextId = '910a55a3-1a79-450d-9922-38a0de395daa';
	const withTransaction = async (operation) => {
		let draftRow;
		let draftClaim = state.claim;
		const tx = {
			select: () => ({
				from: (table) => ({
					where: () => ({
						limit: () => {
							const rows =
								table === tables.idempotencyResponses
									? [{ body: draftClaim, expiresAt: state.claimExpiresAt }]
									: [];
							rows.for = async () => rows;
							return rows;
						},
					}),
				}),
			}),
			insert: () => ({
				values: (value) => ({
					returning: async () => {
						draftRow = { id: nextId, ...value, createdAt: new Date(), updatedAt: new Date() };
						return [draftRow];
					},
				}),
			}),
			update: (table) => ({
				set: (value) => ({
					where: () => ({
						returning: async () => {
							assert.equal(table, tables.idempotencyResponses);
							if (state.missReplayWrite) return [];
							draftClaim = value.responseBody;
							return [{ scope: 'claimed' }];
						},
					}),
				}),
			}),
			execute: async () => undefined,
		};
		let result;
		try {
			result = await operation(tx);
		} catch (err) {
			if (state.rolloverOnRollback) {
				state.claimExpiresAt = new Date(state.claimExpiresAt.getTime() + 60_000);
			}
			throw err;
		}
		if (draftRow) state.rows.push(draftRow);
		state.claim = draftClaim;
		return result;
	};
	class TransactionAbort extends Error {
		constructor(code) {
			super(code);
			this.code = code;
		}
	}
	class ReplayCache {
		get() {
			return null;
		}
		reserve() {
			return { owned: true, resolve() {}, reject() {} };
		}
		remember() {}
	}
	const jsonError = (code, status) => Response.json({ error: code }, { status });
	const overrides = {
		'@/core/audit': {
			recordAuditEvent: async () => {
				state.audits += 1;
			},
		},
		'@/core/db': {
			...tables,
			db: {
				select: () => ({
					from: () => ({ where: () => ({ limit: async () => [{ id: memberId }] }) }),
				}),
				delete: (table) => ({
					where: async (conditions) => {
						assert.equal(table, tables.idempotencyResponses);
						assert.deepEqual(state.claim, { _claimed: true });
						const expiry = conditions.find(
							(part) => Array.isArray(part) && part[0] === tables.idempotencyResponses.expiresAt,
						)?.[1];
						assert.ok(expiry instanceof Date);
						if (expiry.getTime() === state.claimExpiresAt.getTime()) state.claim = null;
					},
				}),
			},
		},
		'@/core/db/transaction': { TransactionAbort, withTransaction },
		'@/core/errors': {
			badRequest: (code) => jsonError(code, 400),
			conflict: (code) => jsonError(code, 409),
			forbidden: (code) => jsonError(code, 403),
			serverError: (code) => jsonError(code, 500),
			tooMany: () => jsonError('too_many', 429),
		},
		'@/core/guards/admin': { isVerifiedWgAdmin: async () => false },
		'@/core/guards/idempotency': {
			ReplayCache,
			claimReplaySlotWithRetry: async () => {
				if (state.forceWon) return { won: true };
				if (state.claim === null) {
					state.claim = { _claimed: true };
					state.claimExpiresAt = new Date(Date.now() + 60_000);
					return { won: true };
				}
				if ('_claimed' in state.claim) throw new Error('claim_still_held');
				return { won: false, cached: state.claim };
			},
			replayKey: (scope, idemKey) => `${scope}:${idemKey}`,
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId, shareCode: 'MTE8PZAT' },
				member: { memberId, name: 'Mina', verified: true },
			}),
		},
		'@/core/guards/with-wg-route': {
			withWgRoute: (_label, handler) => async (req, params) => {
				try {
					return await handler(req, params);
				} catch {
					return jsonError('server_error', 500);
				}
			},
		},
		'@/core/idempotency': {
			RESPONSE_REPLAY_TTL_SECONDS: 604800,
			getCachedResponse: async () => null,
			readIdempotencyKey: () => key,
			releaseResponseSlot: async () => undefined,
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/notifications/notification-dispatch': {
			dispatchNotificationSafely: async () => {
				state.notifications += 1;
				return { warning: null };
			},
		},
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }), wgWriteLimiter: {} },
		'@/core/utils/berlin-day': {
			berlinDayKey: (date) => date.toISOString().slice(0, 10),
			startOfBerlinDay: (date) => date,
			endOfBerlinDay: (date) => date,
		},
		'@/core/utils/time': { MS_PER_DAY: 86_400_000 },
		'@/features/chores/chore-fairness': { computeOpenGapsByMember: () => new Map() },
		// The harness always posts an explicit `nextDueAt`, so only the
		// requested-due branch runs here; the computed branch (clamped first
		// due + intended anchor) is covered by scripts/chore-recurrence.test.mjs.
		'@/features/chores/chore-recurrence': {
			computeNextDueAt: () => new Date(),
			computeInitialDue: (_createdAt, _interval, _recurrenceType, requestedDueAt) => ({
				nextDueAt: requestedDueAt ?? new Date(),
				anchorAt: requestedDueAt ?? new Date(),
			}),
		},
		'drizzle-orm': {
			and: (...parts) => parts,
			asc: (value) => value,
			desc: (value) => value,
			eq: (...parts) => parts,
			gt: (...parts) => parts,
			gte: (...parts) => parts,
			inArray: (...parts) => parts,
			isNull: (value) => value,
			lte: (...parts) => parts,
			sql: () => null,
		},
		'next/server': { NextResponse: { json: (body) => Response.json(body) } },
	};
	overrides['@/core/db'].CHORE_RECURRENCE_TYPES = ['days', 'months'];
	const route = kind === 'chore' ? 'chores' : 'absences';
	const post = loadPost(route, overrides);
	const body =
		kind === 'chore'
			? {
					title: 'Bad putzen',
					intervalDays: 7,
					recurrenceType: 'days',
					assignedMemberId: memberId,
					nextDueAt: new Date(Date.now() + 1_000).toISOString(),
				}
			: { memberId, startDate: '2026-09-24T00:00:00+02:00', endDate: '2026-09-24T23:59:59+02:00' };
	const request = () => ({
		json: async () => body,
		headers: new Headers({ 'idempotency-key': key }),
	});
	return { post, request, state };
}

for (const kind of ['chore', 'absence']) {
	test(`${kind} create rolls back on replay write miss, then replays one committed response`, async () => {
		const { post, request, state } = harness(kind);
		state.missReplayWrite = true;
		const failed = await post(request(), { code: 'MTE8PZAT' });
		assert.equal(failed.status, 500);
		assert.equal(state.rows.length, 0);
		assert.equal(state.audits, 0);
		assert.equal(state.notifications, 0);
		assert.equal(state.claim, null);

		state.missReplayWrite = false;
		const first = await post(request(), { code: 'MTE8PZAT' });
		const replay = await post(request(), { code: 'MTE8PZAT' });
		assert.equal(first.status, 200);
		assert.equal(replay.status, 200);
		const firstBody = await first.json();
		assert.deepEqual(await replay.json(), firstBody);
		state.forceWon = true;
		const lockedReplay = await post(request(), { code: 'MTE8PZAT' });
		assert.equal(lockedReplay.status, 200);
		assert.deepEqual(await lockedReplay.json(), firstBody);
		assert.equal(state.rows.length, 1);
		assert.equal(state.audits, 1);
		assert.equal(state.notifications, kind === 'chore' ? 1 : 0);
	});

	test(`${kind} create rejects a claim with extra fields before inserting`, async () => {
		const { post, request, state } = harness(kind);
		state.claim = { _claimed: true, extra: true };
		state.claimExpiresAt = new Date(Date.now() + 60_000);
		state.forceWon = true;
		const response = await post(request(), { code: 'MTE8PZAT' });
		assert.equal(response.status, 500);
		assert.equal(state.rows.length, 0);
		assert.equal(state.audits, 0);
	});

	test(`${kind} rollback release preserves a replacement claim with a new lease`, async () => {
		const { post, request, state } = harness(kind);
		state.missReplayWrite = true;
		state.rolloverOnRollback = true;
		const response = await post(request(), { code: 'MTE8PZAT' });
		assert.equal(response.status, 500);
		assert.deepEqual(state.claim, { _claimed: true });
		assert.equal(state.rows.length, 0);
		assert.equal(state.audits, 0);
	});
}
