import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcRoot = fileURLToPath(new URL('../..', import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('@/')) {
			const path = resolve(srcRoot, `${specifier.slice(2)}.ts`);
			return nextResolve(pathToFileURL(path).href, context);
		}
		return nextResolve(specifier, context);
	},
});

const { isE2EDbDownMode } = await import('./e2e-db-down.ts');

const FIXTURE_ENV = {
	E2E_FIXTURE_MODE: 'true',
	NEXT_PUBLIC_DB_DOWN: 'true',
	CI: 'true',
	VERCEL_ENV: 'preview',
	POSTGRES_URL: '',
	DATABASE_URL: '',
	VERCEL: '',
};

function withEnv(overrides, fn) {
	const previous = {};
	for (const [key, value] of Object.entries(overrides)) {
		previous[key] = process.env[key];
		if (value === '') delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test('fixture mode activates for the local/CI fixture run', () => {
	assert.equal(
		withEnv(FIXTURE_ENV, () => isE2EDbDownMode()),
		true,
	);
});

test('fixture mode never activates on a hosted Vercel deployment', () => {
	assert.equal(
		withEnv({ ...FIXTURE_ENV, VERCEL: '1' }, () => isE2EDbDownMode()),
		false,
	);
});
