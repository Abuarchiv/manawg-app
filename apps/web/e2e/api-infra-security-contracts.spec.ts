import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { inspect } from 'node:util';
import { expect, test } from '@playwright/test';
import { hasRemoteMatch } from 'next/dist/shared/lib/match-remote-pattern';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import nextConfig from '../next.config';
import { readJsonBody } from '../src/core/http/read-json';
import { captureException, logApiError } from '../src/core/infra/observability';

interface LoadedRoute {
	GET?: (req: Request) => Promise<Response>;
	POST?: (req: Request) => Promise<Response>;
}

function loadTs<T>(filePath: string, overrides: Record<string, unknown>): T {
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

test('image optimizer rejects arbitrary remote hosts before fetching redirects', () => {
	for (const url of [
		'https://attacker.execute-api.eu-central-1.amazonaws.com/proxy',
		'https://unrelated-bucket.s3.eu-central-1.amazonaws.com/image.png',
		'http://127.0.0.1/private',
	]) {
		expect(
			hasRemoteMatch(
				nextConfig.images?.domains ?? [],
				nextConfig.images?.remotePatterns ?? [],
				new URL(url),
			),
		).toBe(false);
	}
});

test('central error reporting redacts thrown messages and arbitrary context while keeping route labels', () => {
	const calls: unknown[][] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => calls.push(args);
	try {
		const providerPayload = 'PostgresError: password=private-db-payload';
		captureException(new Error(providerPayload), {
			boundary: 'wg-code',
			query: providerPayload,
			cronJob: 'privatepayload',
		});
		logApiError('[expenses GET]', new Error(providerPayload));

		const output = inspect(calls, { depth: 8 });
		expect(output).not.toContain(providerPayload);
		expect(output).not.toContain('privatepayload');
		expect(output).not.toContain('query:');
		expect(output).toContain('wg-code');
		expect(output).toContain('[expenses GET]');
	} finally {
		console.error = original;
	}
});

test('health reports an unavailable limiter as 503 instead of rate limiting', async () => {
	const routePath = path.join(process.cwd(), 'src/app/api/health/route.ts');
	const nextServer = createRequire(routePath)('next/server') as typeof import('next/server');
	let databaseImports = 0;
	const route = loadTs<LoadedRoute>(routePath, {
		'@/core/infra/env': {
			checkEnv: () => ({ ok: true, missingRequired: [], degraded: [] }),
		},
		'@/core/rate-limit': {
			checkRateLimit: async () => ({
				success: false,
				remaining: 0,
				reset: Date.now() + 60_000,
				limiterUnavailable: true,
			}),
			clientIpKey: () => '127.0.0.1',
			healthLimiter: null,
		},
		'@/core/db': {
			get db() {
				databaseImports += 1;
				return { execute: async () => undefined };
			},
		},
		'next/server': nextServer,
	});

	const response = await route.GET?.(new Request('https://example.invalid/api/health'));
	expect(response?.status).toBe(503);
	expect(await response?.json()).toMatchObject({ error: 'rate_limiter_unavailable' });
	expect(response?.headers.get('retry-after')).not.toBeNull();
	expect(databaseImports).toBe(0);
});

test('upload-sign rejects an oversized unauthenticated JSON body before auth or database work', async () => {
	const routePath = path.join(process.cwd(), 'src/app/api/upload/sign/route.ts');
	const nextServer = createRequire(routePath)('next/server') as typeof import('next/server');
	const json = (body: unknown, status = 200) =>
		nextServer.NextResponse.json(body as Record<string, unknown>, { status });
	let authCalls = 0;
	let databaseCalls = 0;
	const route = loadTs<LoadedRoute>(routePath, {
		'@/core/auth/server': {
			getAuthenticatedUser: async () => {
				authCalls += 1;
				return null;
			},
		},
		'@/core/db': {
			db: {
				query: {
					wgs: {
						findFirst: async () => {
							databaseCalls += 1;
							return null;
						},
					},
				},
			},
		},
		'@/core/errors': {
			apiError: (message: string, status: number, code?: string) =>
				json(code ? { error: message, code } : { error: message }, status),
			badRequest: (message: string) => json({ error: message }, 400),
			notFound: (message: string) => json({ error: message }, 404),
			payloadTooLarge: (message = 'payload_too_large', code = 'payload_too_large') =>
				json({ error: message, code }, 413),
			tooMany: (message: string, code?: string) =>
				json(code ? { error: message, code } : { error: message }, 429),
			serverError: (message: string) => json({ error: message }, 500),
		},
		'@/core/guards/api-auth': { requireMember: async () => ({ ok: false }) },
		'@/core/http/read-json': { readJsonBody },
		'@/core/infra/private-image-policy': { PRIVATE_IMAGE_MIME_TYPES: ['image/png'] },
		'@/core/infra/s3': {
			S3ConfigurationError: class extends Error {},
			S3_MAX_UPLOAD_BYTES: 8 * 1024 * 1024,
			createPresignedUpload: async () => ({}),
			isAllowedMimeType: () => true,
		},
		'@/core/infra/supabase-storage': {
			ImageStorageConfigurationError: class extends Error {},
			createSupabaseSignedUpload: async () => ({}),
			getImageStorageProvider: () => 'aws',
		},
		'@/core/rate-limit': {
			checkRateLimit: async () => ({ success: true }),
			uploadSignLimiter: null,
		},
		'@/core/validators/image-url': { getPrivateImageUrl: () => 'https://example.invalid/image' },
		'@/shared/lib/share-code': {
			isValidShareCode: () => true,
			normalizeShareCode: (value: string) => value,
		},
		'next/server': nextServer,
	});

	const body = 'x'.repeat(16 * 1024 + 1);
	const request = new Request('https://example.invalid/api/upload/sign', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body,
	});
	const response = await route.POST?.(request);
	expect(response?.status).toBe(413);
	expect(await response?.json()).toEqual({ error: 'payload_too_large', code: 'payload_too_large' });
	expect(response?.headers.get('cache-control')).toBe('no-store');
	expect(authCalls).toBe(0);
	expect(databaseCalls).toBe(0);
});
