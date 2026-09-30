import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

// Routes that call getAuthenticatedUser outside their own try/catch must turn
// a transient Supabase Auth outage into the same structured, retryable 503
// that requireWgMember returns — never an unhandled 500 or a 401.

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));

class NextResponse extends Response {
	static json(body, init) {
		return new NextResponse(JSON.stringify(body), {
			...init,
			headers: { 'content-type': 'application/json', ...init?.headers },
		});
	}
}

function loadRoute(file, overrides) {
	const source = transpileModule(readFileSync(path.join(process.cwd(), file), 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (Object.hasOwn(overrides, name) ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

function sharedMocks(state) {
	const unreachable = (name) => () => {
		throw new Error(`${name} must not run after an Auth outage`);
	};
	return {
		'@/core/auth/server': {
			getAuthenticatedUser: async () => {
				state.authCalls += 1;
				throw Object.assign(new Error('Auth service unavailable'), { status: 503 });
			},
		},
		'@/core/errors': {
			apiError: (error, status, code) =>
				NextResponse.json(code === undefined ? { error } : { error, code }, { status }),
			authUnavailable: () =>
				NextResponse.json({ error: 'db_error' }, { status: 503, headers: { 'Retry-After': '1' } }),
			badRequest: (error) => NextResponse.json({ error }, { status: 400 }),
			conflict: (error) => NextResponse.json({ error }, { status: 409 }),
			notFound: (error) => NextResponse.json({ error }, { status: 404 }),
			payloadTooLarge: () => NextResponse.json({ error: 'payload_too_large' }, { status: 413 }),
			serverError: (error) => NextResponse.json({ error }, { status: 500 }),
			tooMany: () => NextResponse.json({ error: 'rate_limited' }, { status: 429 }),
		},
		'@/core/guards/api-auth': { requireMember: unreachable('requireMember') },
		'@/core/infra/observability': {
			logApiError: (label) => state.logged.push(label),
		},
		'next/server': { NextResponse },
		unreachable,
	};
}

async function assertAuthOutage(response, state) {
	assert.equal(state.authCalls, 1);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: 'db_error' });
	assert.equal(state.logged.length, 1);
}

test('upload sign returns a retryable 503 when Supabase Auth is unavailable', async () => {
	const state = { authCalls: 0, logged: [] };
	const { unreachable, ...mocks } = sharedMocks(state);
	const { POST } = loadRoute('src/app/api/upload/sign/route.ts', {
		...mocks,
		'@/core/db': { db: { query: { wgs: { findFirst: unreachable('wg lookup') } } } },
		'@/core/http/read-json': {
			readJsonBody: async (req) => ({ ok: true, body: await req.json() }),
		},
		'@/core/infra/private-image-policy': { PRIVATE_IMAGE_MIME_TYPES: ['image/jpeg'] },
		'@/core/infra/s3': {
			S3ConfigurationError: class extends Error {},
			S3_MAX_UPLOAD_BYTES: 10_000_000,
			createPresignedUpload: unreachable('createPresignedUpload'),
			isAllowedMimeType: () => true,
		},
		'@/core/infra/supabase-storage': {
			ImageStorageConfigurationError: class extends Error {},
			createSupabaseSignedUpload: unreachable('createSupabaseSignedUpload'),
			getImageStorageProvider: unreachable('getImageStorageProvider'),
		},
		'@/core/rate-limit': { checkRateLimit: unreachable('checkRateLimit'), uploadSignLimiter: {} },
		'@/core/validators/image-url': { getPrivateImageUrl: unreachable('getPrivateImageUrl') },
		'@/shared/lib/share-code': {
			isValidShareCode: () => true,
			normalizeShareCode: (value) => value,
		},
	});

	const response = await POST(
		new Request('https://app.test/api/upload/sign', {
			method: 'POST',
			body: JSON.stringify({
				shareCode: 'MTE8PZAT',
				purpose: 'expense',
				mimeType: 'image/jpeg',
				fileSize: 1024,
			}),
		}),
	);

	await assertAuthOutage(response, state);
	assert.equal(response.headers.get('Retry-After'), '1');
	assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('upload read returns a retryable 503 when Supabase Auth is unavailable', async () => {
	const state = { authCalls: 0, logged: [] };
	const { unreachable, ...mocks } = sharedMocks(state);
	const { GET } = loadRoute('src/app/api/upload/read/route.ts', {
		...mocks,
		'@/core/db/private-image-deletions': {
			isPrivateImageKeyRevoked: unreachable('isPrivateImageKeyRevoked'),
		},
		'@/core/infra/supabase-storage': {
			ImageStorageConfigurationError: class extends Error {},
			ImageStorageObjectNotFoundError: class extends Error {},
			downloadSupabaseImage: unreachable('downloadSupabaseImage'),
		},
		'@/core/validators/image-url': {
			parsePrivateImageKey: () => ({ wgId: '11111111-1111-4111-8111-111111111111' }),
		},
	});

	const response = await GET({
		nextUrl: new URL('https://app.test/api/upload/read?key=manawg/wg/expense/image.jpg'),
	});

	await assertAuthOutage(response, state);
	assert.equal(response.headers.get('Retry-After'), '1');
	assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('account DELETE returns a retryable 503 when Supabase Auth is unavailable', async (t) => {
	const previousServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
	process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
	t.after(() => {
		if (previousServiceRoleKey === undefined) {
			Reflect.deleteProperty(process.env, 'SUPABASE_SERVICE_ROLE_KEY');
		} else process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceRoleKey;
	});
	const state = { authCalls: 0, logged: [] };
	const { unreachable, ...mocks } = sharedMocks(state);
	const { DELETE } = loadRoute('src/app/api/account/route.ts', {
		...mocks,
		'@/core/auth/delete-user': { deleteAuthUser: unreachable('deleteAuthUser') },
		'@/core/auth/env': {
			getSupabaseEnv: unreachable('getSupabaseEnv'),
			hasSupabaseEnv: () => true,
		},
		'@/core/db': { accountDeletions: {}, auditEvents: {} },
		'@/core/db/account-deletion': {
			readAccountDeletionStatusWithFreshConnection: unreachable('readAccountDeletionStatus'),
			tryCompleteAccountDeletion: unreachable('tryCompleteAccountDeletion'),
		},
		'@/core/db/delete-account': { removeAccountFromWgs: unreachable('removeAccountFromWgs') },
		'@/core/db/transaction': {
			TransactionAbort: class extends Error {},
			withTransaction: unreachable('withTransaction'),
		},
		'drizzle-orm': { eq: () => null },
	});

	const response = await DELETE(new Request('https://app.test/api/account', { method: 'DELETE' }));

	await assertAuthOutage(response, state);
	assert.equal(response.headers.get('Retry-After'), '1');
});

// Share-code routes load their preamble helpers through the `@/` alias, which
// this harness cannot resolve, so stand in minimal equivalents.
function wgRouteMocks(state) {
	const { unreachable, ...mocks } = sharedMocks(state);
	const readShareCode = async (ctx) => ({ ok: true, ...(await ctx.params) });
	return {
		...mocks,
		'@/core/errors': {
			...mocks['@/core/errors'],
			HTTP: {},
			forbidden: (error) => NextResponse.json({ error }, { status: 403 }),
		},
		'@/core/db': {
			db: { query: { wgs: { findFirst: unreachable('wg lookup') } } },
			idempotencyResponses: {},
			wgMembers: {},
			wgs: {},
		},
		'@/core/db/account-deletion': {
			assertAccountCanAcquireMembership: unreachable('assertAccountCanAcquireMembership'),
			lockActiveAccountMember: unreachable('lockActiveAccountMember'),
		},
		'@/core/db/schema': { LIMITS: { NAME_MAX: 50 } },
		'@/core/db/transaction': {
			TransactionAbort: class extends Error {},
			withTransaction: unreachable('withTransaction'),
		},
		'@/core/activity-feed': { postSystemNotice: unreachable('postSystemNotice') },
		'@/core/audit': { recordAuditEvent: unreachable('recordAuditEvent') },
		'@/core/db/delete-wg': { deleteWgCascade: unreachable('deleteWgCascade') },
		'@/core/guards/admin': { isVerifiedWgAdmin: unreachable('isVerifiedWgAdmin') },
		'@/core/guards/api-auth': {
			UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
			requireMember: unreachable('requireMember'),
		},
		'@/core/guards/idempotency': {
			claimReplaySlotWithRetry: unreachable('claimReplaySlotWithRetry'),
			withIdempotentJsonResponse: unreachable('withIdempotentJsonResponse'),
		},
		'@/core/guards/member-token': {
			deriveMemberToken: unreachable('deriveMemberToken'),
			verifyMemberToken: unreachable('verifyMemberToken'),
		},
		'@/core/guards/require-wg-admin': { requireWgAdmin: unreachable('requireWgAdmin') },
		'@/core/guards/require-wg-member': { requireWgMember: unreachable('requireWgMember') },
		'@/core/guards/route-preamble': { readShareCode },
		'@/core/idempotency': {
			RESPONSE_REPLAY_TTL_SECONDS: 60,
			getCachedResponse: unreachable('getCachedResponse'),
			readIdempotencyKey: unreachable('readIdempotencyKey'),
		},
		'@/features/expenses/expense-payments': {
			withExpensePaymentLock: unreachable('withExpensePaymentLock'),
		},
		'@/shared/lib/member-header': {
			MEMBER_ID_HEADER: 'x-member-id',
			MEMBER_TOKEN_HEADER: 'x-member-token',
		},
		'@/shared/lib/share-code': {
			generateShareCode: unreachable('generateShareCode'),
			isValidShareCode: () => true,
		},
		'@/core/guards/share-code-miss': {
			shareCodeMissResponse: unreachable('shareCodeMissResponse'),
		},
		'@/core/guards/with-wg-route': {
			withWgRoute: (label, handler) => async (req, ctx) => {
				const { ok: _ok, ...params } = await readShareCode(ctx);
				try {
					return await handler(req, params);
				} catch (err) {
					state.logged.push(`[${label}]`);
					return NextResponse.json({ error: String(err) }, { status: 500 });
				}
			},
		},
		'@/core/infra/e2e-db-down': {
			E2E_CREATED_WG: {},
			getE2EWgFixture: unreachable('getE2EWgFixture'),
			isE2EDbDownMode: () => false,
		},
		'@/core/rate-limit': {
			checkRateLimit: async () => ({ success: true }),
			clientIpKey: () => '127.0.0.1',
			rateLimitFailMode: () => 'open',
			registerLimiter: {},
			wgWriteLimiter: {},
		},
	};
}

const WG_CODE = 'MTE8PZAT';
const wgCtx = (params = {}) => ({ params: Promise.resolve({ code: WG_CODE, ...params }) });

test('WG GET returns a retryable 503 when Supabase Auth is unavailable', async () => {
	const state = { authCalls: 0, logged: [] };
	const { GET } = loadRoute('src/app/api/wg/[code]/route.ts', wgRouteMocks(state));

	const response = await GET(new Request(`https://app.test/api/wg/${WG_CODE}`), wgCtx());

	await assertAuthOutage(response, state);
});

test('WG mine returns a retryable 503 when Supabase Auth is unavailable', async () => {
	const state = { authCalls: 0, logged: [] };
	const { GET } = loadRoute('src/app/api/wg/mine/route.ts', wgRouteMocks(state));

	const response = await GET(new Request('https://app.test/api/wg/mine'));

	await assertAuthOutage(response, state);
});

test('WG join returns a retryable 503 when Supabase Auth is unavailable', async () => {
	const state = { authCalls: 0, logged: [] };
	const { POST } = loadRoute('src/app/api/wg/[code]/members/route.ts', wgRouteMocks(state));

	const response = await POST(
		new Request(`https://app.test/api/wg/${WG_CODE}/members`, {
			method: 'POST',
			body: JSON.stringify({ name: 'Mia' }),
		}),
		wgCtx(),
	);

	await assertAuthOutage(response, state);
});

test('member claim returns a retryable 503 when Supabase Auth is unavailable', async () => {
	const state = { authCalls: 0, logged: [] };
	const { POST } = loadRoute(
		'src/app/api/wg/[code]/members/[id]/claim/route.ts',
		wgRouteMocks(state),
	);

	const response = await POST(
		new Request(`https://app.test/api/wg/${WG_CODE}/members/claim`, { method: 'POST' }),
		wgCtx({ id: '11111111-1111-4111-8111-111111111111' }),
	);

	await assertAuthOutage(response, state);
});

test('WG create returns a retryable 503 when Supabase Auth is unavailable', async () => {
	const state = { authCalls: 0, logged: [] };
	const { POST } = loadRoute('src/app/api/wg/route.ts', wgRouteMocks(state));

	const response = await POST(
		new Request('https://app.test/api/wg', {
			method: 'POST',
			body: JSON.stringify({ name: 'Sonnenallee', creatorName: 'Mia' }),
		}),
	);

	await assertAuthOutage(response, state);
});
