import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import {
	PRIVATE_IMAGE_MAX_BYTES,
	isAllowedPrivateImageMimeType,
	isValidPrivateImageSize,
} from '../src/core/infra/private-image-policy';
import { parsePrivateImageKey } from '../src/core/validators/image-url';

const PRIVATE_KEY =
	'manawg/989ac820-58b7-431f-9c65-28721264f333/expense/550e8400-e29b-41d4-a716-446655440000.png';

async function readSource(relativePath: string): Promise<string> {
	return readFile(path.join(process.cwd(), 'src', relativePath), 'utf8');
}

function loadTs<T>(filePath: string, overrides: Record<string, unknown> = {}): T {
	const compiled = transpileModule(readFileSync(filePath, 'utf8'), {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} as Record<string, unknown> };
	const realRequire = createRequire(filePath);
	const localRequire = (id: string): unknown =>
		Object.hasOwn(overrides, id) ? overrides[id] : realRequire(id);
	new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
	return module.exports as T;
}

test('private image policy accepts only the exact size and MIME allowlist', () => {
	expect(PRIVATE_IMAGE_MAX_BYTES).toBe(8 * 1024 * 1024);
	for (const mimeType of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
		expect(isAllowedPrivateImageMimeType(mimeType)).toBe(true);
	}
	expect(isAllowedPrivateImageMimeType('image/gif')).toBe(false);
	expect(isValidPrivateImageSize(PRIVATE_IMAGE_MAX_BYTES)).toBe(true);
	expect(isValidPrivateImageSize(PRIVATE_IMAGE_MAX_BYTES + 1)).toBe(false);
	expect(isValidPrivateImageSize(0)).toBe(false);
});

test('private keys reject traversal and preserve WG scoping', () => {
	expect(parsePrivateImageKey('../outside.png')).toBeNull();
	expect(parsePrivateImageKey('manawg/not-a-uuid/expense/image.png')).toBeNull();
});

test('private reads use Supabase after an AWS rollback and re-check membership', async () => {
	const routePath = path.join(process.cwd(), 'src/app/api/upload/read/route.ts');
	const imageUrl = loadTs<{ parsePrivateImageKey: typeof parsePrivateImageKey }>(
		path.join(process.cwd(), 'src/core/validators/image-url.ts'),
	);
	const nextServer = createRequire(routePath)('next/server') as typeof import('next/server');
	let authenticatedUser: { id: string } | null = { id: 'user-1' };
	let authOutage = false;
	let membership: 'active' | 'foreign' | 'revoked' = 'active';
	let membershipCalls = 0;
	let downloadCalls = 0;
	const downloadedKeys: string[] = [];

	const storageErrors = {
		ImageStorageConfigurationError: class extends Error {},
		ImageStorageObjectNotFoundError: class extends Error {},
	};
	const route = loadTs<{ GET: (request: { nextUrl: URL }) => Promise<Response> }>(routePath, {
		'@/core/auth/server': {
			getAuthenticatedUser: async () => {
				if (authOutage) throw new Error('AuthRetryableFetchError');
				return authenticatedUser;
			},
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/db/private-image-deletions': {
			isPrivateImageKeyRevoked: async () => false,
		},
		'@/core/errors': {
			apiError: (message: string, status: number, code?: string) =>
				nextServer.NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status }),
			badRequest: (message: string) =>
				nextServer.NextResponse.json({ error: message }, { status: 400 }),
			notFound: (message: string) =>
				nextServer.NextResponse.json({ error: message }, { status: 404 }),
			serverError: (message: string) =>
				nextServer.NextResponse.json({ error: message }, { status: 500 }),
		},
		'@/core/guards/api-auth': {
			requireMember: async () => {
				membershipCalls += 1;
				return membership === 'active'
					? { ok: true, member: { memberId: 'member-1', name: 'Member', verified: true } }
					: {
							ok: false,
							response: nextServer.NextResponse.json(
								{ error: membership === 'revoked' ? 'member_deactivated' : 'not_a_member' },
								{ status: 401 },
							),
						};
			},
		},
		'@/core/infra/supabase-storage': {
			...storageErrors,
			downloadSupabaseImage: async (key: string) => {
				downloadCalls += 1;
				downloadedKeys.push(key);
				return {
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array([1, 2, 3]));
							controller.close();
						},
					}),
					contentType: 'image/png',
					contentLength: 3,
				};
			},
		},
		'@/core/validators/image-url': imageUrl,
	});

	const originalProvider = process.env.IMAGE_STORAGE_PROVIDER;
	const originalFetch = globalThis.fetch;
	let awsFetches = 0;
	globalThis.fetch = (async () => {
		awsFetches += 1;
		throw new Error('AWS private read must not fetch');
	}) as typeof fetch;
	process.env.IMAGE_STORAGE_PROVIDER = 'aws';
	const request = {
		nextUrl: new URL(`https://app.example/api/upload/read?key=${encodeURIComponent(PRIVATE_KEY)}`),
	};

	try {
		// A transient Auth outage is retryable: 503, no-store, and no membership
		// lookup or storage read before the caller is known.
		authOutage = true;
		const outage = await route.GET(request);
		expect(outage.status).toBe(503);
		expect(await outage.json()).toEqual({ error: 'db_error' });
		expect(outage.headers.get('cache-control')).toBe('no-store');
		expect(membershipCalls).toBe(0);
		expect(downloadCalls).toBe(0);
		authOutage = false;

		authenticatedUser = null;
		const guest = await route.GET(request);
		expect(guest.status).toBe(401);
		expect(downloadCalls).toBe(0);

		authenticatedUser = { id: 'user-1' };
		membership = 'foreign';
		const foreign = await route.GET(request);
		expect(foreign.status).toBe(401);
		expect(downloadCalls).toBe(0);

		membership = 'active';
		const response = await route.GET(request);
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('location')).toBeNull();
		expect(downloadedKeys).toEqual([PRIVATE_KEY]);

		membership = 'revoked';
		const revoked = await route.GET(request);
		expect(revoked.status).toBe(401);
		expect(downloadCalls).toBe(1);
		expect(awsFetches).toBe(0);
	} finally {
		globalThis.fetch = originalFetch;
		if (originalProvider === undefined)
			Reflect.deleteProperty(process.env, 'IMAGE_STORAGE_PROVIDER');
		else process.env.IMAGE_STORAGE_PROVIDER = originalProvider;
	}
});

test('private read authenticates malformed and foreign keys before streaming bytes', async () => {
	const source = await readSource('app/api/upload/read/route.ts');

	expect(source).toContain('parsePrivateImageKey');
	expect(source).toContain('getAuthenticatedUser');
	expect(source).toContain('requireMember');
	expect(source).toContain("apiError('auth_required'");
	expect(source).toContain('if (!auth.ok) return noStore(auth.response)');
	expect(source).toContain('downloadSupabaseImage');
	expect(source).not.toContain('getImageStorageProvider');
	expect(source).not.toContain('downloadAwsImage');
	const authLookup = source.indexOf('authenticatedUser = await getAuthenticatedUser(req)');
	expect(authLookup).toBeGreaterThan(-1);
	expect(source.indexOf('const privateImage =')).toBeLessThan(authLookup);
	expect(authLookup).toBeLessThan(source.indexOf('const auth = await requireMember'));
	expect(source.indexOf('const auth = await requireMember')).toBeLessThan(
		source.indexOf('await downloadSupabaseImage'),
	);
	expect(source).not.toContain('createSignedUrl');
	expect(source).not.toContain('redirect(');
});

test('private signing keeps the upload response contract and immutable Supabase upload', async () => {
	const routeSource = await readSource('app/api/upload/sign/route.ts');
	const storageSource = await readSource('core/infra/supabase-storage.ts');

	expect(routeSource).toContain('getPrivateImageUrl');
	expect(storageSource).toContain('uploadHeaders');
	expect(storageSource).toContain('getBucket');
	expect(storageSource).toContain('upsert: false');
	expect(storageSource).toContain('hasExactPrivateImageBucketConfig');
});
