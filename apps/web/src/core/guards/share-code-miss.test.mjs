import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const { ModuleKind, ScriptTarget, transpileModule } = requireFromWeb('typescript');

function load(limitResult) {
	const source = readFileSync(
		path.join(process.cwd(), 'src/core/guards/share-code-miss.ts'),
		'utf8',
	);
	const compiled = transpileModule(source, {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const calls = [];
	const module = { exports: {} };
	const stubs = {
		'@/core/errors': {
			tooMany: (message, code) => Response.json({ error: message, code }, { status: 429 }),
		},
		'@/core/rate-limit': {
			wgShareCodeMissLimiter: 'miss-limiter',
			checkRateLimit: async (limiter, key, mode) => {
				calls.push({ limiter, key, mode });
				return limitResult;
			},
		},
	};
	new Function('require', 'module', 'exports', compiled)(
		(name) => stubs[name] ?? requireFromWeb(name),
		module,
		module.exports,
	);
	return { ...module.exports, calls };
}

test('keeps the original miss answer while the account has budget', async () => {
	const { shareCodeMissResponse, calls } = load({ success: true, remaining: 3, reset: 0 });
	const original = Response.json({ error: 'wg_not_found' }, { status: 404 });
	assert.equal(await shareCodeMissResponse('user-1', original), original);
	assert.deepEqual(calls, [{ limiter: 'miss-limiter', key: 'user-1', mode: 'open' }]);
});

test('answers 429 instead of the existence oracle once the budget is spent', async () => {
	const { shareCodeMissResponse } = load({ success: false, remaining: 0, reset: Date.now() });
	const response = await shareCodeMissResponse(
		'user-1',
		Response.json({ error: 'not_a_member' }, { status: 401 }),
	);
	assert.equal(response.status, 429);
});

test('an unavailable limiter never blocks the original answer', async () => {
	const { shareCodeMissResponse } = load({
		success: false,
		remaining: 0,
		reset: Date.now(),
		limiterUnavailable: true,
	});
	const original = Response.json({ error: 'wg_not_found' }, { status: 404 });
	assert.equal(await shareCodeMissResponse('user-1', original), original);
});
