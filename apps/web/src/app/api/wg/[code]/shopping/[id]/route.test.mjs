import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DrizzleQueryError } from 'drizzle-orm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const directory = path.dirname(fileURLToPath(import.meta.url));
const routeFile = path.join(directory, 'route.ts');
const itemId = '11111111-1111-4111-8111-111111111111';
const wgId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';
const otherMemberId = '55555555-5555-4555-8555-555555555555';
const shareCode = 'MTE8PZAT';

function json(body, init = {}) {
	return Response.json(body, typeof init === 'number' ? { status: init } : init);
}

function harness(returning = async () => [{ id: itemId }]) {
	const state = {
		adminMemberId: null,
		audits: 0,
		deleted: 0,
		member: { memberId, name: 'Alex', verified: true },
		notices: 0,
		update: null,
		current: {
			id: itemId,
			wgId,
			updatedAt: '2026-09-27T10:00:00.123456Z',
			boughtAt: null,
			boughtByMemberId: null,
			addedByMemberId: memberId,
			name: 'Milch',
		},
		loggedErrors: [],
		patches: 0,
		transactionAborted: false,
	};
	const shoppingItems = {
		id: 'shopping_items.id',
		wgId: 'shopping_items.wg_id',
		updatedAt: 'shopping_items.updated_at',
		boughtAt: 'shopping_items.bought_at',
		addedByMemberId: 'shopping_items.added_by_member_id',
		name: 'shopping_items.name',
	};
	const wgMembers = {
		id: 'wg_members.id',
		wgId: 'wg_members.wg_id',
		role: 'wg_members.role',
		deactivatedAt: 'wg_members.deactivated_at',
	};
	const replayCache = new Map();
	const matches = (conditions) => {
		const pairs = [];
		const visit = (value) => {
			if (value?.truncateMilliseconds === true) {
				pairs.push(value);
				return;
			}
			if (!Array.isArray(value)) return;
			if (value.length === 2 && typeof value[0] === 'string') {
				pairs.push(value);
				return;
			}
			value.forEach(visit);
		};
		conditions.forEach(visit);
		return pairs.every((pair) => {
			const [column, value] = Array.isArray(pair) ? pair : [pair.column, pair.value];
			if (column === shoppingItems.updatedAt)
				return (
					pair.truncateMilliseconds === true &&
					new Date(value).getTime() === new Date(state.current.updatedAt).getTime()
				);
			if (column === shoppingItems.boughtAt) {
				const actual = state.current.boughtAt?.getTime() ?? null;
				const expected = value === null ? null : new Date(value).getTime();
				return actual === expected;
			}
			return true;
		});
	};
	const db = {
		update(table) {
			assert.equal(table, shoppingItems);
			return {
				set(values) {
					state.update = values;
					return {
						where(conditions) {
							state.patches += 1;
							return {
								returning: async () => {
									if (!matches(conditions)) return [];
									let rows;
									try {
										rows = await returning();
									} catch (error) {
										state.transactionAborted = true;
										throw error;
									}
									if (rows.length > 0) state.current = { ...state.current, ...values };
									return rows;
								},
							};
						},
					};
				},
			};
		},
		select() {
			return {
				from(table) {
					if (table === wgMembers) {
						return {
							where() {
								const rows = state.adminMemberId ? [{ id: state.adminMemberId }] : [];
								return { limit: async () => rows };
							},
						};
					}
					assert.equal(table, shoppingItems);
					return {
						where() {
							const rows = state.current
								? [
										{
											id: state.current.id,
											addedByMemberId: state.current.addedByMemberId,
											name: state.current.name,
										},
									]
								: [];
							return { limit: async () => rows };
						},
					};
				},
			};
		},
		delete(table) {
			assert.equal(table, shoppingItems);
			return {
				where() {
					return {
						returning: async () => {
							if (!state.current) return [];
							state.deleted += 1;
							const { id } = state.current;
							state.current = null;
							return [{ id }];
						},
					};
				},
			};
		},
	};
	const mocks = {
		'@/core/activity-feed': {
			postSystemNotice: async () => {
				state.notices += 1;
			},
		},
		'@/core/audit': {
			recordAuditEvent: async () => {
				state.audits += 1;
			},
		},
		'@/core/db': { db, shoppingItems, wgMembers },
		'@/core/errors': {
			badRequest: (error) => json({ error }, 400),
			conflict: (error) => json({ error }, 409),
			forbidden: (error) => json({ error }, 403),
			notFound: (error) => json({ error }, 404),
			serverError: () => json({ error: 'server_error' }, 500),
			tooMany: (error) => json({ error }, 429),
		},
		'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]{36}$/i },
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: wgId },
				member: state.member,
			}),
		},
		'@/core/guards/route-preamble': {
			readShareCode: async (ctx) => ({ ok: true, ...(await ctx.params) }),
			resolveE2EFixture: async () => ({ mode: 'none' }),
		},
		'@/core/infra/observability': {
			logApiError: (_label, error) => state.loggedErrors.push(error),
		},
		'@/core/rate-limit': {
			checkRateLimit: async () => ({ success: true }),
			wgWriteLimiter: {},
		},
		'drizzle-orm': {
			and: (...conditions) => conditions,
			eq: (...condition) => condition,
			isNull: (column) => [column, null],
			sql: (strings, column, value) =>
				strings[0]?.includes('greatest')
					? new Date('2026-09-27T10:00:00.124Z')
					: { column, value, truncateMilliseconds: true },
		},
		'@/core/idempotency': {
			readIdempotencyKey: (request) => request.headers.get('idempotency-key'),
		},
		'@/features/pinnwand/announcement-replay': {
			withAnnouncementReplay: async (request, scope, mutate) => {
				const key = request.headers.get('idempotency-key');
				const cacheKey = `${scope}:${key}`;
				if (replayCache.has(cacheKey)) {
					return { response: replayCache.get(cacheKey), effect: null, key };
				}
				let result;
				try {
					result = await mutate(db);
				} catch (error) {
					state.transactionAborted = false;
					throw error;
				}
				if (state.transactionAborted) {
					state.transactionAborted = false;
					throw new Error('transaction_aborted');
				}
				if (key) replayCache.set(cacheKey, result.response);
				return { ...result, key };
			},
		},
		'next/server': { NextResponse: { json } },
	};

	const cache = new Map();
	function loadTypeScript(file) {
		if (cache.has(file)) return cache.get(file).exports;
		const compiled = transpileModule(readFileSync(file, 'utf8'), {
			compilerOptions: {
				esModuleInterop: true,
				module: ModuleKind.CommonJS,
				target: ScriptTarget.ES2022,
			},
		}).outputText;
		const module = { exports: {} };
		cache.set(file, module);
		const mockRequire = (name) => {
			if (name === '@/core/guards/with-wg-route') {
				return {
					withWgRoute: (_label, handler) => async (request, context) => {
						try {
							return await handler(request, await context.params);
						} catch (error) {
							state.loggedErrors.push(error);
							return json({ error: 'server_error' }, 500);
						}
					},
				};
			}
			if (name === '@/features/shopping/shopping-duplicate') {
				return loadTypeScript(
					path.join(process.cwd(), 'src/features/shopping/shopping-duplicate.ts'),
				);
			}
			if (name === '@/core/guards/admin') {
				return loadTypeScript(path.join(process.cwd(), 'src/core/guards/admin.ts'));
			}
			if (Object.hasOwn(mocks, name)) return mocks[name];
			return requireFromWeb(name);
		};
		new Function('require', 'module', 'exports', compiled)(mockRequire, module, module.exports);
		return module.exports;
	}

	const route = loadTypeScript(routeFile);
	return {
		state,
		patch: ({
			body,
			bought = false,
			expectedUpdatedAt = new Date(state.current.updatedAt).toISOString(),
			expectedBoughtAt = null,
			key = '44444444-4444-4444-8444-444444444444',
		} = {}) =>
			route.PATCH(
				new Request(`https://example.invalid/api/wg/${shareCode}/shopping/${itemId}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json', 'idempotency-key': key },
					body: JSON.stringify(body ?? { bought, expectedUpdatedAt, expectedBoughtAt }),
				}),
				{ params: Promise.resolve({ code: shareCode, id: itemId }) },
			),
		remove: () =>
			route.DELETE(
				new Request(`https://example.invalid/api/wg/${shareCode}/shopping/${itemId}`, {
					method: 'DELETE',
				}),
				{ params: Promise.resolve({ code: shareCode, id: itemId }) },
			),
	};
}

test('reopening an item that conflicts with another open name returns 409', async () => {
	const postgresError = Object.assign(new Error('duplicate key value violates unique constraint'), {
		code: '23505',
		constraint: 'shopping_items_unique_open_name',
	});
	const duplicateError = new DrizzleQueryError(
		'update shopping_items set bought_at = null',
		[],
		postgresError,
	);
	const { patch, state } = harness(async () => {
		throw duplicateError;
	});

	const response = await patch();

	assert.deepEqual(await response.json(), { error: 'shopping_item_duplicate' });
	assert.equal(response.status, 409);
	assert.deepEqual(state.update, {
		boughtAt: null,
		boughtByMemberId: null,
		updatedAt: state.update.updatedAt,
	});
	assert.equal(state.audits, 0);
	assert.equal(state.notices, 0);
});

test('other database errors still use the shared 500 handler', async () => {
	const postgresError = Object.assign(new Error('different constraint'), {
		code: '23505',
		constraint: 'shopping_items_other_unique_key',
	});
	const queryError = new DrizzleQueryError('update shopping_items', [], postgresError);
	const { patch, state } = harness(async () => {
		throw queryError;
	});

	const response = await patch();

	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: 'server_error' });
	assert.equal(state.loggedErrors[0], queryError);
});

test('stale shopping state conflicts without mutation or notification', async () => {
	const { patch, state } = harness();
	state.current.updatedAt = new Date('2026-09-27T11:00:00.000Z');

	const response = await patch({ bought: true, expectedUpdatedAt: '2026-09-27T10:00:00.000Z' });

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: 'shopping_item_changed' });
	assert.equal(state.audits, 0);
	assert.equal(state.notices, 0);
	assert.equal(state.current.boughtAt, null);
});

test('legacy queued shopping update remains a visible conflict', async () => {
	const { patch, state } = harness();

	const response = await patch({ body: { bought: true } });

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: 'shopping_item_changed' });
	assert.equal(state.patches, 0);
	assert.equal(state.audits, 0);
	assert.equal(state.notices, 0);
});

test('retry of a bought PATCH replays after another member reopens the item', async () => {
	const { patch, state } = harness();
	const request = {
		bought: true,
		expectedUpdatedAt: '2026-09-27T10:00:00.123Z',
		expectedBoughtAt: null,
	};
	const first = await patch(request);
	assert.equal(first.status, 200);
	assert.equal(state.current.updatedAt.getTime(), Date.parse('2026-09-27T10:00:00.124Z'));
	state.current.updatedAt = new Date('2026-09-27T11:00:00.000Z');
	state.current.boughtAt = null;
	state.current.boughtByMemberId = null;

	const retry = await patch(request);

	assert.equal(retry.status, 200);
	assert.equal(state.patches, 1);
	assert.equal(state.audits, 1);
	assert.equal(state.notices, 1);
	assert.equal(state.current.boughtAt, null);
});

test('the member who added a shopping item may delete it', async () => {
	const { remove, state } = harness();

	const response = await remove();

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { deleted: true });
	assert.equal(state.deleted, 1);
	assert.equal(state.audits, 1);
});

test("a verified WG admin may delete another member's shopping item", async () => {
	const { remove, state } = harness();
	state.current.addedByMemberId = otherMemberId;
	state.adminMemberId = memberId;

	const response = await remove();

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { deleted: true });
	assert.equal(state.deleted, 1);
	assert.equal(state.audits, 1);
});

test("non-admins and unverified admins cannot delete another member's item", async () => {
	for (const setup of [
		(state) => {
			state.adminMemberId = otherMemberId;
		},
		(state) => {
			state.adminMemberId = memberId;
			state.member = { ...state.member, verified: false };
		},
	]) {
		const { remove, state } = harness();
		state.current.addedByMemberId = otherMemberId;
		setup(state);

		const response = await remove();

		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: 'not_owner' });
		assert.equal(state.deleted, 0);
		assert.equal(state.audits, 0);
	}
});
