import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routePath = 'src/app/api/wg/[code]/chores/[id]/swap-request/route.ts';
const CHORE_ID = '44444444-4444-4444-8444-444444444444';

function loadRoute(state) {
	const source = transpileModule(readFileSync(path.join(process.cwd(), routePath), 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	const overrides = {
		'@/core/audit': { recordAuditEvent: async () => state.auditCalls++ },
		'@/core/db': { announcements: {}, chores: {} },
		'@/core/errors': {
			badRequest: (error) => Response.json({ error }, { status: 400 }),
		},
		'@/core/guards/api-auth': {
			UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => {
				state.membershipCalls++;
				return {
					ok: true,
					wg: { id: '11111111-1111-4111-8111-111111111111' },
					member: { memberId: '22222222-2222-4222-8222-222222222222', name: 'Anna' },
				};
			},
		},
		'@/core/guards/with-wg-route': { withWgRoute: (_label, handler) => handler },
		'@/core/idempotency': {
			readIdempotencyKey: (request) => request.headers.get('Idempotency-Key'),
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/notifications/notification-dispatch': {
			dispatchNotificationSafely: async () => {
				state.notificationCalls++;
				return { warning: null };
			},
		},
		'@/core/rate-limit': {
			checkRateLimit: async () => {
				state.rateLimitCalls++;
				return { success: true };
			},
			wgWriteLimiter: {},
		},
		'@/features/chores/chore-status': { getChoreStatus: () => ({ label: 'fällig' }) },
		'@/features/pinnwand/announcement-replay': {
			persistAnnouncementReplayWarning: async () => true,
			withAnnouncementReplay: async () => {
				state.replayCalls++;
				throw new Error('mutation must not run without idempotency key');
			},
		},
		drizzle: {},
		'drizzle-orm': { and: () => ({}), eq: () => ({}) },
		'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
	};
	new Function('require', 'module', 'exports', source)(
		(name) => (Object.hasOwn(overrides, name) ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

test('swap request rejects a missing idempotency key before rate limits or mutation', async () => {
	const state = {
		auditCalls: 0,
		membershipCalls: 0,
		notificationCalls: 0,
		rateLimitCalls: 0,
		replayCalls: 0,
	};
	const { POST } = loadRoute(state);
	const response = await POST(
		new Request('https://app.test/api/wg/MTE8PZAT/chores/swap-request', { method: 'POST' }),
		{ code: 'MTE8PZAT', id: CHORE_ID },
	);

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { error: 'idempotency_key_required' });
	assert.equal(state.membershipCalls, 1);
	assert.equal(state.rateLimitCalls, 0);
	assert.equal(state.replayCalls, 0);
	assert.equal(state.auditCalls, 0);
	assert.equal(state.notificationCalls, 0);
});
