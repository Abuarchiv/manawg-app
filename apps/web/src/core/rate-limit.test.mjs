import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const typescript = require('typescript');
const SdkRatelimit = require('@upstash/ratelimit').Ratelimit;
const sourcePath = fileURLToPath(new URL('./rate-limit.ts', import.meta.url));

function loadRateLimit({ env = {}, decisions = [] } = {}) {
	const source = readFileSync(sourcePath, 'utf8');
	const code = typescript.transpileModule(source, {
		compilerOptions: {
			module: typescript.ModuleKind.CommonJS,
			target: typescript.ScriptTarget.ES2022,
		},
	}).outputText;
	const redisCalls = [];
	const redis = new Proxy(
		{},
		{
			get:
				(_target, command) =>
				async (...args) => {
					redisCalls.push({ command: String(command), args });
					return 1;
				},
		},
	);
	const optionsSeen = [];
	const sdkKeys = [];
	const pending = [];
	const logs = [];
	const exceptions = [];

	class TestRatelimit extends SdkRatelimit {
		constructor(options) {
			optionsSeen.push({ analytics: options.analytics, prefix: options.prefix });
			super({
				...options,
				redis,
				limiter: () => ({
					limit: async () =>
						decisions.shift() ?? {
							success: true,
							limit: 120,
							remaining: 119,
							reset: Date.now() + 60_000,
						},
				}),
			});
			const limit = this.limit.bind(this);
			this.limit = async (...args) => {
				sdkKeys.push(args[0]);
				const result = await limit(...args);
				if (result.pending) pending.push(result.pending);
				return result;
			};
		}
	}

	class TestRedis {
		constructor() {
			Object.setPrototypeOf(this, redis);
		}
	}

	const loaded = { exports: {} };
	new Function('require', 'module', 'exports', 'process', 'console', code)(
		(name) => {
			if (name === '@upstash/ratelimit') return { Ratelimit: TestRatelimit };
			if (name === '@upstash/redis/cloudflare') return { Redis: TestRedis };
			if (name === '@/core/infra/observability') {
				return { captureException: (...args) => exceptions.push(args) };
			}
			throw new Error(`Unexpected rate-limit import: ${name}`);
		},
		loaded,
		loaded.exports,
		{ env },
		{ error: (...args) => logs.push(args) },
	);

	return {
		rateLimit: loaded.exports,
		redis,
		redisCalls,
		optionsSeen,
		sdkKeys,
		pending,
		logs,
		exceptions,
	};
}

test('built limiters preserve SDK allow/deny results without writing analytics', async () => {
	const now = Date.now();
	const decision = (success, remaining, reset) => ({ success, limit: 120, remaining, reset });
	const harness = loadRateLimit({
		env: {
			NODE_ENV: 'test',
			UPSTASH_REDIS_REST_URL: 'https://rate-limit.test',
			UPSTASH_REDIS_REST_TOKEN: 'fake-token',
		},
		decisions: [decision(true, 119, now + 60_000), decision(false, 0, now + 45_000)],
	});
	const ip = '198.51.100.41';
	const allowed = await harness.rateLimit.checkRateLimit(
		harness.rateLimit.wgReadLimiter,
		ip,
		'closed',
	);
	const denied = await harness.rateLimit.checkRateLimit(
		harness.rateLimit.wgReadLimiter,
		ip,
		'closed',
	);
	await Promise.all(harness.pending);

	assert.deepEqual(allowed, { success: true, remaining: 119, reset: now + 60_000 });
	assert.deepEqual(denied, { success: false, remaining: 0, reset: now + 45_000 });
	assert.deepEqual(harness.sdkKeys, [ip, ip]);
	assert.ok(harness.optionsSeen.some(({ prefix }) => prefix === 'manawg:wg-read'));
	assert.deepEqual(harness.redisCalls, []);
	assert.ok(harness.optionsSeen.every(({ analytics }) => analytics === false));
});

test('SDK timeout results use the existing open and closed failure policies', async () => {
	const harness = loadRateLimit({
		env: { NODE_ENV: 'production', VERCEL_ENV: 'production' },
	});
	const sdkLimiter = new SdkRatelimit({
		redis: harness.redis,
		analytics: false,
		prefix: 'rate-limit-timeout-test',
		timeout: 1,
		limiter: () => ({ limit: () => new Promise(() => {}) }),
	});
	const timeoutResult = await sdkLimiter.limit('198.51.100.41');
	assert.equal(timeoutResult.success, true);
	assert.equal(timeoutResult.reason, 'timeout');

	harness.rateLimit.resetOpenStateReporting();
	const limiter = { limit: async () => timeoutResult };
	const closed = await harness.rateLimit.checkRateLimit(limiter, '198.51.100.41', 'closed');
	const open = await harness.rateLimit.checkRateLimit(limiter, '198.51.100.41', 'open');

	assert.deepEqual(closed, {
		success: false,
		remaining: 0,
		reset: closed.reset,
		limiterUnavailable: true,
	});
	assert.ok(closed.reset > Date.now());
	assert.deepEqual(open, { success: true, remaining: -1, reset: 0 });
	assert.deepEqual(harness.rateLimit.getFailOpenStats(), {
		total: 1,
		byCause: { 'limiter-call-failed': 1 },
	});
	assert.equal(harness.logs.length, 2);
	assert.equal(harness.exceptions.length, 2);
});
