import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../src/', import.meta.url);
const [instrumentation, onboarding, pwa] = await Promise.all([
	readFile(new URL('instrumentation-client.ts', root), 'utf8'),
	readFile(new URL('app/neu/NeuClient.tsx', root), 'utf8'),
	readFile(new URL('shared/components/pwa-register.tsx', root), 'utf8'),
]);

const compiled = ts.transpileModule(instrumentation, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function initialize(env, failImport = false, failInit = false) {
	const calls = [];
	let imports = 0;
	vm.runInNewContext(
		compiled,
		{
			Date,
			window: { location: { hostname: 'app.manawg.com' } },
			navigator: { userAgent: 'ManaWG-privacy-check' },
			exports: {},
			process: { env },
			console: { warn() {}, error() {} },
			require(name) {
				if (name === '@/core/infra/sentry') return { initializeSentry() {} };
				assert.equal(name, 'posthog-js');
				imports++;
				if (failImport) throw new Error('provider blocked');
				return {
					default: {
						init(key, config) {
							if (failInit) throw new Error('initialization failed');
							calls.push({ key, config });
						},
					},
				};
			},
		},
		{ timeout: 1000 },
	);
	await new Promise(setImmediate);
	return { calls, imports };
}

const env = {
	NODE_ENV: 'production',
	NEXT_PUBLIC_POSTHOG_KEY: 'phc_privacy_test',
	NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com',
};
const { calls, imports } = await initialize(env);
assert.equal(imports, 1);
assert.equal(calls.length, 1);
assert.equal(calls[0].key, env.NEXT_PUBLIC_POSTHOG_KEY);
const { config } = calls[0];
for (const [name, expected] of Object.entries({
	api_host: env.NEXT_PUBLIC_POSTHOG_HOST,
	cookieless_mode: 'always',
	persistence: 'memory',
	person_profiles: 'never',
	autocapture: false,
	disable_session_recording: true,
	disable_surveys: true,
	advanced_disable_flags: true,
	capture_exceptions: false,
	capture_pageleave: false,
	capture_pageview: 'history_change',
}))
	assert.equal(config[name], expected, `unsafe privacy setting: ${name}`);

assert.equal(typeof config.before_send, 'function');
assert.equal(config.before_send(null), null);
const uuid = '12345678-1234-4234-8234-123456789abc';
const timestamp = new Date('2026-09-03T00:00:00.000Z');
const secret = 'private-household-content';
for (const event of ['$pageview', 'wg_created', 'wg_joined']) {
	const cleaned = config.before_send({
		uuid,
		event,
		timestamp,
		$set: { email: secret },
		$set_once: { name: secret },
		$unset: [secret],
		extra: secret,
		properties: {
			$host: secret,
			$raw_user_agent: secret,
			$cookieless_mode: false,
			$process_person_profile: true,
			token: secret,
			distinct_id: secret,
			$session_id: secret,
			$device_id: secret,
			$current_url: `https://app.manawg.com/wg/${secret}?code=${secret}`,
			$pathname: `/wg/${secret}`,
			$referrer: secret,
			title: secret,
			$initial_current_url: secret,
			$prev_pageview_pathname: secret,
			$set: { email: secret },
			$set_once: { name: secret },
			nested: { content: secret },
		},
	});
	assert.ok(cleaned.timestamp instanceof Date);
	assert.deepEqual(JSON.parse(JSON.stringify(cleaned)), {
		uuid,
		event,
		timestamp: timestamp.toISOString(),
		properties: {
			token: env.NEXT_PUBLIC_POSTHOG_KEY,
			distinct_id: '$posthog_cookieless',
			$cookieless_mode: true,
			$process_person_profile: false,
			$host: 'app.manawg.com',
			$raw_user_agent: 'ManaWG-privacy-check',
		},
	});
}
for (const event of [
	'$identify',
	'$set',
	'$exception',
	'$pageleave',
	'$feature_flag_called',
	'chat_message_sent',
	'chore_created',
	'expense_saved',
	secret,
]) {
	assert.equal(config.before_send({ uuid, event, timestamp, properties: {} }), null);
}
assert.equal(
	config.before_send({ uuid: secret, event: 'wg_created', timestamp, properties: {} }),
	null,
);
assert.equal(
	config.before_send({ uuid, event: 'wg_created', timestamp: secret, properties: {} }),
	null,
);
assert.equal(
	config.before_send({ uuid, event: 'wg_created', timestamp: new Date('invalid'), properties: {} }),
	null,
);
for (const invalidEnv of [
	{},
	{ ...env, NEXT_PUBLIC_POSTHOG_KEY: '' },
	{ ...env, NEXT_PUBLIC_POSTHOG_HOST: '' },
	...[
		'https://us.i.posthog.com',
		'http://eu.i.posthog.com',
		'https://eu.i.posthog.com.evil.example',
		'https://eu.i.posthog.com/path',
	].map((host) => ({ ...env, NEXT_PUBLIC_POSTHOG_HOST: host })),
]) {
	assert.deepEqual(await initialize(invalidEnv), { calls: [], imports: 0 });
}
assert.equal((await initialize(env, true)).calls.length, 0);
assert.equal((await initialize(env, false, true)).calls.length, 0);
assert.doesNotMatch(pwa, /posthog|onAuthStateChange|createSupabaseBrowserClient/);

const captureCalls = [...onboarding.matchAll(/posthog\.capture\(([^)]*)\)/g)].map(
	(match) => match[1],
);
assert.deepEqual(captureCalls, ["'wg_created'", "'wg_joined'"]);

// Minimal analytics contract: only $pageview (autocaptured via
// capture_pageview, never an explicit capture call) plus the two permitted
// activation captures wg_created / wg_joined may exist in product source.
// Scan every product-source capture call so dead events fail closed here
// even though runtime before_send already drops them.
const ALLOWED_CAPTURE_EVENTS = new Set(['wg_created', 'wg_joined']);
const srcDir = fileURLToPath(root);
async function collectSourceFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await collectSourceFiles(full)));
		else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) files.push(full);
	}
	return files;
}
const sourceFiles = (await collectSourceFiles(srcDir)).filter(
	(file) => !/\.(test|spec)\./.test(path.basename(file)),
);
const allCaptures = [];
for (const file of sourceFiles) {
	const content = await readFile(file, 'utf8');
	for (const match of content.matchAll(/posthog\.capture\(\s*['"]([^'"]+)['"]/g)) {
		allCaptures.push(`${path.relative(srcDir, file)}: ${match[1]}`);
	}
}
const allEvents = allCaptures.map((item) => {
	const delimiter = item.lastIndexOf(': ');
	return item.slice(delimiter + 2);
});
const uniqueEvents = [...new Set(allEvents)].sort();
assert.deepEqual(
	uniqueEvents,
	[...ALLOWED_CAPTURE_EVENTS].sort(),
	`non-activation analytics calls contradict the minimal contract: ${allCaptures.join(', ') || 'none found'}`,
);
assert.equal(
	allEvents.length,
	uniqueEvents.length,
	`duplicate analytics captures are not allowed: ${allCaptures.join(', ')}`,
);

process.stdout.write('analytics privacy check passed\n');
