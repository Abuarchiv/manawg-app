import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const routePath = path.join(process.cwd(), 'src/app/api/upload/read/route.ts');
const key =
	'manawg/11111111-1111-4111-8111-111111111111/expense/22222222-2222-4222-8222-222222222222.jpg';

function harness() {
	const state = { revoked: true, revocationError: null, memberResponse: null, events: [] };
	class ImageStorageConfigurationError extends Error {}
	class ImageStorageObjectNotFoundError extends Error {}
	class NextResponse extends Response {
		static json(body, init) {
			return Response.json(body, init);
		}
	}
	const source = transpileModule(readFileSync(routePath, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	const overrides = {
		'@/core/auth/server': {
			getAuthenticatedUser: async () => {
				state.events.push('user');
				return { id: 'user-id' };
			},
		},
		'@/core/errors': {
			apiError: (_message, status, error) => Response.json({ error }, { status }),
			badRequest: (error) => Response.json({ error }, { status: 400 }),
			notFound: (error) => Response.json({ error }, { status: 404 }),
			serverError: (error) => Response.json({ error }, { status: 500 }),
		},
		'@/core/guards/api-auth': {
			requireMember: async () => {
				state.events.push('member');
				return state.memberResponse ?? { ok: true, member: { memberId: 'member-id' } };
			},
		},
		'@/core/db/private-image-deletions': {
			isPrivateImageKeyRevoked: async () => {
				state.events.push('revocation');
				if (state.revocationError) throw state.revocationError;
				return state.revoked;
			},
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/infra/supabase-storage': {
			ImageStorageConfigurationError,
			ImageStorageObjectNotFoundError,
			downloadSupabaseImage: async () => {
				state.events.push('download');
				return {
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('image-bytes'));
							controller.close();
						},
					}),
					contentType: 'image/jpeg',
					contentLength: 11,
				};
			},
		},
		'@/core/validators/image-url': {
			parsePrivateImageKey: (value) =>
				value === key ? { wgId: '11111111-1111-4111-8111-111111111111' } : null,
		},
		'next/server': { NextResponse },
	};
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return {
		state,
		get: () => {
			const req = new Request(`https://app.example/api/upload/read?key=${encodeURIComponent(key)}`);
			req.nextUrl = new URL(req.url);
			return loaded.exports.GET(req);
		},
	};
}

test('revoked image reads stop after membership authorization and return no-store 404', async () => {
	const { state, get } = harness();
	const response = await get();
	assert.equal(response.status, 404);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(state.events, ['user', 'member', 'revocation']);
});

test('a revocation lookup failure fails closed before provider download', async () => {
	const { state, get } = harness();
	state.revocationError = new Error('database unavailable');
	const response = await get();
	assert.equal(response.status, 500);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(state.events, ['user', 'member', 'revocation']);
});
