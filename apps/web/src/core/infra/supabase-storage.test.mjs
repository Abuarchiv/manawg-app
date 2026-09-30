import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));

function loadTypeScript(file, overrides = {}) {
	const source = transpileModule(readFileSync(file, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		loaded,
		loaded.exports,
	);
	return loaded.exports;
}

function harness() {
	const state = { bucket: null, keys: null, fetchSignal: null, fetchOptions: null };
	const policy = loadTypeScript(path.join(process.cwd(), 'src/core/infra/private-image-policy.ts'));
	const module = loadTypeScript(path.join(process.cwd(), 'src/core/infra/supabase-storage.ts'), {
		'server-only': {},
		'./private-image-policy': policy,
		'@supabase/supabase-js': {
			createClient: (_url, _serviceRoleKey, options) => ({
				storage: {
					getBucket: async (_bucket) => ({ data: state.bucket, error: null }),
					from: (_bucket) => ({
						remove: async (keys) => {
							state.keys = keys;
							const response = await options.global.fetch('https://storage.example/remove', {
								method: 'DELETE',
							});
							return { data: [], error: response.ok ? null : new Error('remove failed') };
						},
					}),
				},
			}),
		},
	});
	return { state, ...module };
}

test('cleanup removes through Supabase with a bounded request even when uploads use AWS', async () => {
	const previous = {
		fetch: globalThis.fetch,
		url: process.env.NEXT_PUBLIC_SUPABASE_URL,
		serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY,
		bucketName: process.env.SUPABASE_STORAGE_BUCKET,
		provider: process.env.IMAGE_STORAGE_PROVIDER,
	};
	const { state, removeSupabaseImages } = harness();
	state.bucket = {
		public: false,
		file_size_limit: 8 * 1024 * 1024,
		allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
	};
	globalThis.fetch = async (_input, options) => {
		state.fetchSignal = options.signal;
		state.fetchOptions = options;
		return new Response(null, { status: 204 });
	};
	process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example';
	process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
	process.env.SUPABASE_STORAGE_BUCKET = 'private-images';
	process.env.IMAGE_STORAGE_PROVIDER = 'aws';
	try {
		const keys = [
			'manawg/11111111-1111-4111-8111-111111111111/expense/22222222-2222-4222-8222-222222222222.jpg',
			'manawg/11111111-1111-4111-8111-111111111111/announcement/33333333-3333-4333-8333-333333333333.png',
		];
		await removeSupabaseImages(keys);
		assert.deepEqual(state.keys, keys);
		assert.ok(state.fetchSignal instanceof AbortSignal);
		assert.equal(state.fetchSignal.aborted, false);
		assert.equal(state.fetchOptions.method, 'DELETE');
	} finally {
		globalThis.fetch = previous.fetch;
		for (const [name, value] of [
			['NEXT_PUBLIC_SUPABASE_URL', previous.url],
			['SUPABASE_SERVICE_ROLE_KEY', previous.serviceRole],
			['SUPABASE_STORAGE_BUCKET', previous.bucketName],
			['IMAGE_STORAGE_PROVIDER', previous.provider],
		]) {
			if (value === undefined) Reflect.deleteProperty(process.env, name);
			else process.env[name] = value;
		}
	}
});

test('cleanup fails closed when bucket policy no longer matches the private image contract', async () => {
	const previous = {
		url: process.env.NEXT_PUBLIC_SUPABASE_URL,
		serviceRole: process.env.SUPABASE_SERVICE_ROLE_KEY,
		bucketName: process.env.SUPABASE_STORAGE_BUCKET,
	};
	const { state, ImageStorageConfigurationError, removeSupabaseImages } = harness();
	state.bucket = { public: true, file_size_limit: 8 * 1024 * 1024, allowed_mime_types: [] };
	process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example';
	process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
	process.env.SUPABASE_STORAGE_BUCKET = 'private-images';
	try {
		await assert.rejects(
			removeSupabaseImages([
				'manawg/11111111-1111-4111-8111-111111111111/expense/22222222-2222-4222-8222-222222222222.jpg',
			]),
			ImageStorageConfigurationError,
		);
		assert.equal(state.keys, null);
	} finally {
		for (const [name, value] of [
			['NEXT_PUBLIC_SUPABASE_URL', previous.url],
			['SUPABASE_SERVICE_ROLE_KEY', previous.serviceRole],
			['SUPABASE_STORAGE_BUCKET', previous.bucketName],
		]) {
			if (value === undefined) Reflect.deleteProperty(process.env, name);
			else process.env[name] = value;
		}
	}
});
