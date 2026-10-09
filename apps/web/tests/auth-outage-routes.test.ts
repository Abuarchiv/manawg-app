import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Routes that call getAuthenticatedUser outside their own try/catch must turn
// a transient Supabase Auth outage into the same structured, retryable 503
// that requireWgMember returns — never an unhandled 500 or a 401.

const state = { authCalls: 0, logged: [] as string[], rateLimitAllowed: true };

function freshState(): void {
	state.authCalls = 0;
	state.logged = [];
	state.rateLimitAllowed = true;
}

const unreachable =
	(name: string) =>
	(..._args: unknown[]): never => {
		throw new Error(`${name} must not run after an Auth outage`);
	};

class UnusedError extends Error {}

mock.module('@/core/auth/server', {
	namedExports: {
		getAuthenticatedUser: async () => {
			state.authCalls += 1;
			throw Object.assign(new Error('Auth service unavailable'), { status: 503 });
		},
	},
});
mock.module('@/core/infra/observability', {
	namedExports: {
		logApiError: (label: string) => state.logged.push(label),
		captureException: () => {},
	},
});
mock.module('@/core/db/claimed-response', {
	namedExports: {
		lockClaimedResponse: unreachable('claim lock'),
		completeClaimedResponse: unreachable('claim completion'),
		releaseClaimedResponse: async () => false,
		releaseLockedClaim: async () => false,
	},
});
mock.module('@/core/db', {
	namedExports: {
		db: { query: { wgs: { findFirst: unreachable('wg lookup') } } },
		idempotencyResponses: {},
		wgMembers: {},
		wgs: {},
		accountDeletions: {},
		auditEvents: {},
	},
});
mock.module('@/core/guards/api-auth', {
	namedExports: {
		UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		requireMember: unreachable('requireMember'),
	},
});
mock.module('@/core/db/transaction', {
	namedExports: { TransactionAbort: UnusedError, withTransaction: unreachable('withTransaction') },
});
mock.module('@/core/db/account-deletion', {
	namedExports: {
		assertAccountCanAcquireMembership: unreachable('assertAccountCanAcquireMembership'),
		lockActiveAccountMember: unreachable('lockActiveAccountMember'),
		readAccountDeletionStatusWithFreshConnection: unreachable('readAccountDeletionStatus'),
		tryCompleteAccountDeletion: unreachable('tryCompleteAccountDeletion'),
	},
});
mock.module('@/core/rate-limit', {
	namedExports: {
		checkRateLimit: async () => {
			if (!state.rateLimitAllowed) throw new Error('checkRateLimit must not run');
			return { success: true };
		},
		clientIpKey: () => '127.0.0.1',
		rateLimitFailMode: () => 'open',
		registerLimiter: {},
		wgWriteLimiter: {},
		uploadSignLimiter: {},
	},
});
mock.module('@/core/utils/share-code', {
	namedExports: {
		generateShareCode: unreachable('generateShareCode'),
		isValidShareCode: () => true,
		normalizeShareCode: (value: string) => value,
	},
});
mock.module('@/core/infra/supabase-storage', {
	namedExports: {
		ImageStorageConfigurationError: UnusedError,
		ImageStorageObjectNotFoundError: UnusedError,
		createSupabaseSignedUpload: unreachable('createSupabaseSignedUpload'),
		downloadSupabaseImage: unreachable('downloadSupabaseImage'),
		getImageStorageProvider: unreachable('getImageStorageProvider'),
	},
});
mock.module('@/core/infra/s3', {
	namedExports: {
		S3ConfigurationError: UnusedError,
		S3_MAX_UPLOAD_BYTES: 10_000_000,
		createPresignedUpload: unreachable('createPresignedUpload'),
		isAllowedMimeType: () => true,
	},
});
mock.module('@/core/validators/image-url', {
	namedExports: {
		getPrivateImageUrl: unreachable('getPrivateImageUrl'),
		parsePrivateImageKey: () => ({ wgId: '11111111-1111-4111-8111-111111111111' }),
	},
});
mock.module('@/core/db/private-image-deletions', {
	namedExports: { isPrivateImageKeyRevoked: unreachable('isPrivateImageKeyRevoked') },
});
mock.module('@/core/auth/delete-user', {
	namedExports: { deleteAuthUser: unreachable('deleteAuthUser') },
});
mock.module('@/core/auth/supabase-env', {
	namedExports: { getSupabaseEnv: unreachable('getSupabaseEnv'), hasSupabaseEnv: () => true },
});
mock.module('@/core/db/delete-account', {
	namedExports: { removeAccountFromWgs: unreachable('removeAccountFromWgs') },
});
mock.module('@/core/audit', {
	namedExports: { recordAuditEvent: unreachable('recordAuditEvent') },
});
mock.module('@/core/db/delete-wg', {
	namedExports: { deleteWgCascade: unreachable('deleteWgCascade') },
});
mock.module('@/core/guards/admin', { namedExports: { isWgAdmin: unreachable('isWgAdmin') } });
mock.module('@/core/guards/legacy-claim-proof', {
	namedExports: { verifyLegacyClaimProof: unreachable('verifyLegacyClaimProof') },
});
mock.module('@/core/guards/require-wg-admin', {
	namedExports: { requireWgAdmin: unreachable('requireWgAdmin') },
});
mock.module('@/core/guards/resolve', { namedExports: { resolveWg: unreachable('resolveWg') } });
mock.module('@/core/guards/share-code-miss', {
	namedExports: { shareCodeMissResponse: unreachable('shareCodeMissResponse') },
});
mock.module('@/core/guards/route-preamble', {
	namedExports: {
		readShareCode: async (ctx: { params: Promise<Record<string, string>> }) => ({
			ok: true,
			...(await ctx.params),
		}),
	},
});
mock.module('@/core/idempotency-store', {
	namedExports: {
		RESPONSE_REPLAY_TTL_SECONDS: 60,
		claimResponseSlot: unreachable('claimResponseSlot'),
		getCachedResponse: unreachable('getCachedResponse'),
		readIdempotencyKey: unreachable('readIdempotencyKey'),
	},
});
mock.module('@/features/expenses/server/expense-payments', {
	namedExports: { withExpensePaymentLock: unreachable('withExpensePaymentLock') },
});
mock.module('@/core/guards/with-wg-route', {
	namedExports: {
		withWgRoute:
			(
				label: string,
				handler: (req: Request, params: Record<string, string>) => Promise<Response>,
			) =>
			async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
				try {
					return await handler(req, await ctx.params);
				} catch (err) {
					state.logged.push(`[${label}]`);
					return Response.json({ error: String(err) }, { status: 500 });
				}
			},
	},
});

const uploadSign = await import('../src/app/api/upload/sign/route.ts');
const uploadRead = await import('../src/app/api/upload/read/route.ts');
const account = await import('../src/app/api/account/route.ts');
const wgByCode = await import('../src/app/api/wg/[code]/route.ts');
const wgMine = await import('../src/app/api/wg/mine/route.ts');
const wgMembers = await import('../src/app/api/wg/[code]/members/route.ts');
const memberClaim = await import('../src/app/api/wg/[code]/members/[id]/claim/route.ts');
const wgCreate = await import('../src/app/api/wg/route.ts');

async function assertAuthOutage(response: Response): Promise<void> {
	assert.equal(state.authCalls, 1);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: 'db_error' });
	assert.equal(state.logged.length, 1);
}

test('upload sign returns a retryable 503 when Supabase Auth is unavailable', async () => {
	freshState();
	state.rateLimitAllowed = false;

	const response = await uploadSign.POST(
		new Request('https://app.test/api/upload/sign', {
			method: 'POST',
			body: JSON.stringify({
				shareCode: 'MTE8PZAT',
				purpose: 'expense',
				mimeType: 'image/jpeg',
				fileSize: 1024,
			}),
		}) as never,
	);

	await assertAuthOutage(response);
	assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('upload read returns a retryable 503 when Supabase Auth is unavailable', async () => {
	freshState();

	const response = await uploadRead.GET({
		nextUrl: new URL('https://app.test/api/upload/read?key=manawg/wg/expense/image.jpg'),
	} as never);

	await assertAuthOutage(response);
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
	freshState();

	const response = await account.DELETE(
		new Request('https://app.test/api/account', { method: 'DELETE' }) as never,
	);

	await assertAuthOutage(response);
});

const WG_CODE = 'MTE8PZAT';
const wgCtx = (params: Record<string, string> = {}) =>
	({ params: Promise.resolve({ code: WG_CODE, ...params }) }) as never;

test('WG GET returns a retryable 503 when Supabase Auth is unavailable', async () => {
	freshState();

	const response = await wgByCode.GET(
		new Request(`https://app.test/api/wg/${WG_CODE}`) as never,
		wgCtx(),
	);

	await assertAuthOutage(response);
});

test('WG mine returns a retryable 503 when Supabase Auth is unavailable', async () => {
	freshState();

	const response = await wgMine.GET(new Request('https://app.test/api/wg/mine') as never);

	await assertAuthOutage(response);
});

test('WG join returns a retryable 503 when Supabase Auth is unavailable', async () => {
	freshState();

	const response = await wgMembers.POST(
		new Request(`https://app.test/api/wg/${WG_CODE}/members`, {
			method: 'POST',
			body: JSON.stringify({ name: 'Mia' }),
		}) as never,
		wgCtx(),
	);

	await assertAuthOutage(response);
});

test('member claim returns a retryable 503 when Supabase Auth is unavailable', async () => {
	freshState();

	const response = await memberClaim.POST(
		new Request(`https://app.test/api/wg/${WG_CODE}/members/claim`, { method: 'POST' }) as never,
		wgCtx({ id: '11111111-1111-4111-8111-111111111111' }),
	);

	await assertAuthOutage(response);
});

test('WG create returns a retryable 503 when Supabase Auth is unavailable', async () => {
	freshState();

	const response = await wgCreate.POST(
		new Request('https://app.test/api/wg', {
			method: 'POST',
			body: JSON.stringify({ name: 'Sonnenallee', creatorName: 'Mia' }),
		}) as never,
	);

	await assertAuthOutage(response);
});
