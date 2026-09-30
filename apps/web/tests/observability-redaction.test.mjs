import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { contentSecurityPolicy } from '../src/shared/lib/security-headers.ts';

test('Sentry CSP allows only the configured HTTPS DSN origin', () => {
	const originalDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
	process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://public-key@o123.ingest.de.sentry.io/1';
	try {
		const connectSource =
			contentSecurityPolicy('sentry-csp-test').match(/connect-src [^;]+/)?.[0] ?? '';
		assert.ok(connectSource.split(/\s+/).includes('https://o123.ingest.de.sentry.io'));
		assert.doesNotMatch(connectSource, /https:\/\/\*\.ingest\.de\.sentry\.io/);
		assert.doesNotMatch(connectSource, /public-key|\/1(?:\s|$)/);
	} finally {
		if (originalDsn === undefined) Reflect.deleteProperty(process.env, 'NEXT_PUBLIC_SENTRY_DSN');
		else process.env.NEXT_PUBLIC_SENTRY_DSN = originalDsn;
	}
});

test('Sentry strips personal data and WG codes from error events', async () => {
	const { sanitizeSentryEvent, sanitizeSentryBreadcrumb } = await import(
		'../src/core/infra/sentry-privacy.ts'
	);
	const event = sanitizeSentryEvent({
		user: { id: 'member-1', email: 'alice@example.com' },
		request: {
			method: 'GET',
			url: 'https://manawg.com/wg/private-code/ausgaben?invite=secret',
			headers: { cookie: 'secret' },
			data: { amount: 200 },
		},
		message: 'alice@example.com',
		exception: { values: [{ type: 'Private-group-code', value: 'expense for Alice' }] },
		extra: { name: 'Alice' },
		contexts: {
			trace: { trace_id: 'trace-id', span_id: 'span-id', data: 'member-email@example.com' },
			user: { id: 'member-1' },
		},
		tags: { boundary: 'root', memberId: 'private-code' },
		transaction: 'GET /wg/private-code/ausgaben?tab=all',
	});

	assert.equal(event.user, undefined);
	assert.deepEqual(event.request, {
		method: 'GET',
		url: 'https://manawg.com/wg/[redacted]/ausgaben',
	});
	assert.equal(event.message, undefined);
	assert.equal(event.exception?.values?.[0]?.value, '[redacted]');
	assert.equal(event.exception?.values?.[0]?.type, 'Error');
	assert.equal(event.extra, undefined);
	assert.deepEqual(event.contexts, {
		trace: { trace_id: 'trace-id', span_id: 'span-id' },
	});
	assert.deepEqual(event.tags, { boundary: 'root' });
	assert.equal(event.transaction, 'GET /wg/[redacted]/ausgaben');
	assert.equal(sanitizeSentryBreadcrumb({ category: 'ui', message: 'clicked Alice' }), null);
	const navigationBreadcrumb = sanitizeSentryBreadcrumb({
		category: 'navigation',
		message: 'Private household title',
		data: { from: '/wg/private-code/home?invite=secret', body: 'private' },
	});
	assert.equal(navigationBreadcrumb?.data?.from, '/wg/[redacted]/home');
	assert.equal(navigationBreadcrumb?.data?.body, undefined);
	assert.equal(navigationBreadcrumb?.message, undefined);

	const calendarUrl =
		'https://manawg.com/api/calendar/calendar-id/calendar-token?download=private#fragment';
	assert.equal(
		sanitizeSentryEvent({ request: { url: calendarUrl } }).request.url,
		'https://manawg.com/api/calendar/[redacted]/[redacted]',
	);
	assert.equal(
		sanitizeSentryEvent({ transaction: 'GET /api/calendar/calendar-id/calendar-token?secret' })
			.transaction,
		'GET /api/calendar/[redacted]/[redacted]',
	);

	const signedUpload = sanitizeSentryBreadcrumb({
		category: 'fetch',
		data: {
			url: 'https://bucket.s3.eu-central-1.amazonaws.com/manawg/wg-private-id/expense/private-file.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=private&X-Amz-Signature=private',
		},
	});
	assert.equal(
		signedUpload?.data?.url,
		'https://bucket.s3.eu-central-1.amazonaws.com/manawg/[redacted]/expense/[redacted]',
	);
	const signedSupabaseUpload = sanitizeSentryBreadcrumb({
		category: 'fetch',
		data: {
			url: 'https://project.supabase.co/storage/v1/object/upload/sign/private-bucket/manawg/private-wg-id/expense/private-file.jpg?token=private-upload-token',
		},
	});
	assert.equal(
		signedSupabaseUpload?.data?.url,
		'https://project.supabase.co/storage/v1/object/upload/sign/[redacted]',
	);
});

const require = createRequire(import.meta.url);
const ts = require('typescript');
const sentryRequire = createRequire(require.resolve('@sentry/nextjs/package.json'));
const browserSentry = sentryRequire('@sentry/browser');
const sourcePath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'../src/core/infra/observability.ts',
);
const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(
	(name) => {
		if (name === './sentry') return { captureSentryException() {}, logSentryApiError() {} };
		if (name === './sentry-privacy') return loadCoreModule('sentry-privacy.ts', {});
		return require(name);
	},
	loaded,
	loaded.exports,
);
const { captureException } = loaded.exports;

function loadCoreModule(relativePath, overrides) {
	const source = readFileSync(path.join(path.dirname(sourcePath), relativePath), 'utf8');
	const code = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', code)(
		(name) => (name in overrides ? overrides[name] : require(name)),
		module,
		module.exports,
	);
	return module.exports;
}

test('instrumentation loads the Sentry chunk only when a DSN is configured', async () => {
	const instrumentationPath = path.join(
		path.dirname(sourcePath),
		'../../instrumentation-client.ts',
	);
	const compiled = ts.transpileModule(readFileSync(instrumentationPath, 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;

	async function run(env) {
		const imports = [];
		const calls = [];
		const module = { exports: {} };
		new Function('require', 'module', 'exports', 'process', 'console', compiled)(
			(name) => {
				imports.push(name);
				if (name === '@/core/infra/sentry') {
					return { initializeSentry: () => calls.push('initializeSentry') };
				}
				throw new Error(`Unexpected instrumentation import: ${name}`);
			},
			module,
			module.exports,
			{ env },
			{ error() {}, warn() {} },
		);
		await new Promise((resolve) => setImmediate(resolve));
		return { imports, calls };
	}

	const unconfigured = await run({ NODE_ENV: 'production' });
	assert.deepEqual(unconfigured, { imports: [], calls: [] });

	const configured = await run({
		NODE_ENV: 'production',
		NEXT_PUBLIC_SENTRY_DSN: 'https://public@o123.ingest.sentry.io/1',
	});
	assert.deepEqual(configured, {
		imports: ['@/core/infra/sentry'],
		calls: ['initializeSentry'],
	});
});

test('pinned Sentry SDK envelopes omit inferred IPs and automatic sessions', async () => {
	const envKeys = [
		'NEXT_PUBLIC_SENTRY_DSN',
		'NEXT_PUBLIC_SENTRY_ENVIRONMENT',
		'NEXT_PUBLIC_SENTRY_RELEASE',
	];
	const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
	for (const [key, value] of [
		['NEXT_PUBLIC_SENTRY_DSN', 'https://public@o123.ingest.sentry.io/1'],
		['NEXT_PUBLIC_SENTRY_ENVIRONMENT', 'test'],
		['NEXT_PUBLIC_SENTRY_RELEASE', 'observability-envelope-test'],
	]) {
		process.env[key] = value;
	}

	const browserGlobals = [
		'window',
		'document',
		'location',
		'history',
		'navigator',
		'fetch',
		'addEventListener',
		'removeEventListener',
	];
	const oldGlobals = new Map(
		browserGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	const setGlobal = (key, value) =>
		Object.defineProperty(globalThis, key, {
			configurable: true,
			enumerable: true,
			writable: true,
			value,
		});
	const document = {
		visibilityState: 'hidden',
		hidden: true,
		referrer: '',
		getElementById: () => null,
		querySelector: () => null,
		addEventListener() {},
		removeEventListener() {},
	};
	Object.assign(globalThis, {
		addEventListener() {},
		removeEventListener() {},
		location: {
			href: 'https://manawg.com/',
			origin: 'https://manawg.com',
			hostname: 'manawg.com',
			pathname: '/',
		},
		history: { pushState() {}, replaceState() {} },
	});
	setGlobal('window', globalThis);
	setGlobal('document', document);
	setGlobal('navigator', { userAgent: 'Sentry test browser', language: 'de-DE' });
	let networkCalls = 0;
	setGlobal('fetch', () => {
		networkCalls += 1;
		throw new Error('network disabled in test');
	});

	const envelopes = [];
	const sentry = {
		...browserSentry,
		init(options) {
			return browserSentry.init({
				...options,
				transport: () => ({
					send(envelope) {
						envelopes.push(envelope);
						return Promise.resolve({ statusCode: 200 });
					},
					flush: () => Promise.resolve(true),
				}),
			});
		},
	};
	const sdkOptions = loadCoreModule('sentry.ts', {
		'@sentry/core': { captureException() {}, logger: { error() {} } },
		'@sentry/nextjs': sentry,
		'./sentry-privacy': loadCoreModule('sentry-privacy.ts', {}),
	});
	try {
		sdkOptions.initializeSentry();
		browserSentry.captureEvent({
			user: { id: 'private-member-id', email: 'alice@example.com' },
			message: 'private event message',
			exception: { values: [{ type: 'PrivateError', value: 'private exception body' }] },
			request: {
				method: 'GET',
				url: 'https://manawg.com/api/calendar/private-calendar-id/private-bearer-token?download=private-query',
				headers: { authorization: 'Bearer private-bearer-token', cookie: 'private-cookie' },
				data: { email: 'alice@example.com' },
			},
			contexts: {
				trace: { trace_id: 'trace-id', span_id: 'span-id', data: 'private span attributes' },
				user: { id: 'private-member-id' },
			},
			breadcrumbs: [
				{
					category: 'fetch',
					data: {
						url: 'https://bucket.s3.eu-central-1.amazonaws.com/manawg/private-wg-id/expense/private-object.jpg?X-Amz-Signature=private-signature',
					},
					message: 'private upload',
				},
				{
					category: 'fetch',
					data: {
						url: 'https://project.supabase.co/storage/v1/object/upload/sign/private-bucket/manawg/private-supabase-wg/expense/private-supabase-object.jpg?token=private-supabase-token',
					},
				},
			],
		});
		await browserSentry.flush(1000);

		assert.ok(envelopes.length > 0);
		const items = envelopes.flatMap(([, envelopeItems]) => envelopeItems);
		assert.equal(
			items.some(([header]) => header.type === 'session'),
			false,
		);
		const event = items.find(([header]) => header.type === 'event')?.[1];
		assert.ok(event);
		assert.equal(event.sdk?.settings?.infer_ip, 'never');
		assert.deepEqual(event.request, {
			method: 'GET',
			url: 'https://manawg.com/api/calendar/[redacted]/[redacted]',
		});
		assert.deepEqual(event.contexts, { trace: { trace_id: 'trace-id', span_id: 'span-id' } });
		assert.equal(event.exception?.values?.[0]?.value, '[redacted]');
		assert.equal(
			event.breadcrumbs?.[0]?.data?.url,
			'https://bucket.s3.eu-central-1.amazonaws.com/manawg/[redacted]/expense/[redacted]',
		);
		assert.equal(
			event.breadcrumbs?.[1]?.data?.url,
			'https://project.supabase.co/storage/v1/object/upload/sign/[redacted]',
		);
		const serialized = JSON.stringify(envelopes);
		for (const secret of [
			'private-member-id',
			'alice@example.com',
			'private event message',
			'private exception body',
			'private-calendar-id',
			'private-bearer-token',
			'private-query',
			'private-cookie',
			'private-wg-id',
			'private-object.jpg',
			'private-signature',
			'private-bucket',
			'private-supabase-wg',
			'private-supabase-object.jpg',
			'private-supabase-token',
			'private span attributes',
		]) {
			assert.equal(serialized.includes(secret), false, `envelope retained ${secret}`);
		}
		assert.equal(networkCalls, 0);
	} finally {
		if (browserSentry.isInitialized()) await browserSentry.close(1000);
		for (const [key, descriptor] of oldGlobals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		for (const [key, value] of oldEnv) {
			if (value === undefined) Reflect.deleteProperty(process.env, key);
			else process.env[key] = value;
		}
	}
});

test('custom Error.name values are reduced to a trusted error type', () => {
	const calls = [];
	const original = console.error;
	console.error = (...args) => calls.push(args);
	try {
		const custom = new Error('provider payload');
		custom.name = 'privateDbPassword123';
		captureException(custom);
		captureException(new TypeError('another provider payload'));

		assert.equal(calls[0][1], 'Error');
		assert.equal(calls[1][1], 'TypeError');
		assert.equal(JSON.stringify(calls).includes('privateDbPassword123'), false);
	} finally {
		console.error = original;
	}
});

test('idempotency cache failures never log a push endpoint or provider error', async () => {
	const secret = 'privatePushEndpointToken123';
	const calls = [];
	const originalError = console.error;
	const originalWarn = console.warn;
	console.error = (...args) => calls.push(format(...args));
	console.warn = (...args) => calls.push(format(...args));
	try {
		const { setCachedResponse } = loadCoreModule('../idempotency.ts', {
			'@/core/db': {
				db: {
					update: () => {
						throw new Error(secret);
					},
				},
				idempotencyResponses: {},
			},
			'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]+$/i },
			'@/core/infra/observability': loaded.exports,
			'@/core/offline/replay-retention': loadCoreModule('../offline/replay-retention.ts', {}),
			'@/core/rate-limit': { createConfiguredRedis: () => null },
		});
		await setCachedResponse(`push_subscribe:https://push.example/${secret}`, secret, {
			body: 'x'.repeat(33_000),
		});
		assert.ok(calls.length > 0);
		assert.equal(JSON.stringify(calls).includes(secret), false);
	} finally {
		console.error = originalError;
		console.warn = originalWarn;
	}
});

const clientEntryPath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'../src/instrumentation-client.ts',
);

function runInstrumentationClient(env, loadSentry) {
	const source = ts.transpileModule(readFileSync(clientEntryPath, 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', 'process', source)(
		(name) => {
			if (name === '@/core/infra/sentry') return loadSentry();
			throw new Error(`Unexpected optional import: ${name}`);
		},
		module,
		module.exports,
		{ env },
	);
}

const flushOptionalImport = () => new Promise((resolve) => setImmediate(resolve));

test('client entrypoint does not load Sentry without a configured DSN', async () => {
	const loads = [];
	runInstrumentationClient({}, () => loads.push('loaded'));
	await flushOptionalImport();
	assert.deepEqual(loads, []);
});

test('client entrypoint initializes Sentry once lazily and tolerates a failed optional import', async () => {
	const calls = [];
	runInstrumentationClient(
		{ NEXT_PUBLIC_SENTRY_DSN: 'https://public-key@o123.ingest.de.sentry.io/1' },
		() => {
			calls.push('loaded');
			return { initializeSentry: () => calls.push('initialized') };
		},
	);
	assert.deepEqual(calls, []);
	await flushOptionalImport();
	assert.deepEqual(calls, ['loaded', 'initialized']);

	const failedLoads = [];
	runInstrumentationClient({ NEXT_PUBLIC_SENTRY_DSN: 'configured' }, () => {
		failedLoads.push('loaded');
		throw new Error('optional Sentry unavailable');
	});
	assert.deepEqual(failedLoads, []);
	await flushOptionalImport();
	assert.deepEqual(failedLoads, ['loaded']);
});

test('Vercel config loads the public Sentry config wrapper', () => {
	const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../next.config.ts');
	const source = readFileSync(configPath, 'utf8');
	const compiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} };
	const env = {
		VERCEL: '1',
		VERCEL_ENV: 'preview',
		NODE_ENV: 'production',
		SENTRY_ORG: 'fixture-org',
		SENTRY_PROJECT: 'fixture-project',
		SENTRY_AUTH_TOKEN: 'fixture-only-not-a-credential',
	};
	new Function('require', 'module', 'exports', 'process', compiled)(
		require,
		module,
		module.exports,
		{ env },
	);
	assert.equal(typeof module.exports.default?.headers, 'function');
});
