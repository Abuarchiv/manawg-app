// craftsman-ignore: TS002
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { parse } from 'dotenv';

const DEFAULT_E2E_PORT = process.env.E2E_PORT ?? '3101';
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${DEFAULT_E2E_PORT}`;
const previewE2E = process.env.PREVIEW_E2E === 'true';
const automationBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
const isTrustedPreviewDeployment =
	/^https:\/\/manawg-[a-z0-9-]+-abditubes-projects\.vercel\.app$/i.test(BASE_URL);

if (previewE2E && (!automationBypassSecret || !isTrustedPreviewDeployment)) {
	throw new Error(
		"PREVIEW_E2E requires VERCEL_AUTOMATION_BYPASS_SECRET and this project's trusted Vercel Preview URL.",
	);
}

let previewStorageState: string | undefined;
if (previewE2E) {
	previewStorageState = process.env.MANAWG_PREVIEW_AUTH_STATE;
	if (!previewStorageState) {
		previewStorageState = path.join(
			mkdtempSync(path.join(tmpdir(), 'manawg-preview-auth-')),
			'state.json',
		);
		process.env.MANAWG_PREVIEW_AUTH_STATE = previewStorageState;
	}
}
const parsedBaseUrl = new URL(BASE_URL);
const isLocalBase = ['localhost', '127.0.0.1', '::1'].includes(parsedBaseUrl.hostname);
const isRemoteBase = /^https?:\/\//i.test(BASE_URL) && !isLocalBase;
const authUiE2E = process.env.AUTH_UI_E2E === 'true';
if (authUiE2E && (!isLocalBase || parsedBaseUrl.protocol !== 'http:')) {
	throw new Error('AUTH_UI_E2E requires a local HTTP BASE_URL.');
}
const serverPort = parsedBaseUrl.port || (parsedBaseUrl.protocol === 'https:' ? '443' : '80');
const APP_DIR = __dirname;
const useBuiltServer = process.env.PLAYWRIGHT_USE_BUILD === 'true';
const authSupabaseEnv = authUiE2E
	? `NEXT_PUBLIC_SUPABASE_URL=${parsedBaseUrl.origin} NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=auth-ui-fixture-key`
	: 'NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=';
if (!isRemoteBase && (useBuiltServer || authUiE2E || process.env.NEXT_PUBLIC_DB_DOWN === 'true')) {
	const storageKeys = new Set([
		'AWS_ACCESS_KEY_ID',
		'AWS_SECRET_ACCESS_KEY',
		'AWS_SESSION_TOKEN',
		'AWS_REGION',
		'S3_BUCKET',
		'S3_PUBLIC_URL',
	]);
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('S3_')) storageKeys.add(key);
	}
	for (const file of readdirSync(APP_DIR)) {
		if (!/^\.env(?:\..+)?$/.test(file)) continue;
		for (const key of Object.keys(parse(readFileSync(path.join(APP_DIR, file))))) {
			if (key.startsWith('S3_')) storageKeys.add(key);
		}
	}
	for (const key of storageKeys) process.env[key] = '';
}
const e2eDistDir = `.next-e2e-${serverPort}`;
const e2eTsconfigPath = `.next-e2e-tsconfig-${serverPort}.json`;
const isolatedNextEnv = `NEXT_DIST_DIR=${e2eDistDir} NEXT_TSCONFIG_PATH=${e2eTsconfigPath}`;
const prepareIsolatedNext = `cp "${path.join(APP_DIR, 'tsconfig.json')}" "${e2eTsconfigPath}"`;
const webServerCommand =
	useBuiltServer || authUiE2E
		? `${prepareIsolatedNext} && CI=true E2E_FIXTURE_MODE=true NEXT_PUBLIC_E2E_FIXTURE_MODE=true NEXT_PUBLIC_DB_DOWN=true POSTGRES_URL= DATABASE_URL= ${authSupabaseEnv} UPSTASH_REDIS_REST_URL= UPSTASH_REDIS_REST_TOKEN= VERCEL_ENV=preview ${isolatedNextEnv} pnpm exec next build && CI=true E2E_FIXTURE_MODE=true NEXT_PUBLIC_E2E_FIXTURE_MODE=true NEXT_PUBLIC_DB_DOWN=true POSTGRES_URL= DATABASE_URL= ${authSupabaseEnv} UPSTASH_REDIS_REST_URL= UPSTASH_REDIS_REST_TOKEN= VERCEL_ENV=preview ${isolatedNextEnv} pnpm exec next start --port ${serverPort}`
		: process.env.NEXT_PUBLIC_DB_DOWN === 'true'
			? `${prepareIsolatedNext} && CI=true E2E_FIXTURE_MODE=true NEXT_PUBLIC_E2E_FIXTURE_MODE=true NEXT_PUBLIC_DB_DOWN=true POSTGRES_URL= DATABASE_URL= ${authSupabaseEnv} UPSTASH_REDIS_REST_URL= UPSTASH_REDIS_REST_TOKEN= VERCEL_ENV=preview ${isolatedNextEnv} pnpm exec next dev --port ${serverPort}`
			: `${prepareIsolatedNext} && if [ "\${CI:-}" != "true" ] && [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi; VERCEL_ENV=development ${isolatedNextEnv} pnpm exec next dev --port ${serverPort}`;

export default defineConfig({
	globalSetup: previewE2E ? path.join(APP_DIR, 'e2e/preview-global-setup.ts') : undefined,
	testDir: './e2e',
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: [['html', { open: 'never' }], ['list']],
	workers: 1,
	timeout: previewE2E ? 60_000 : 30_000,
	use: {
		baseURL: BASE_URL,
		storageState: previewStorageState,
		// Pace live UI actions to respect the real shared per-IP rate limits.
		launchOptions: previewE2E ? { slowMo: 500 } : undefined,
		trace: previewE2E ? 'off' : 'on-first-retry',
		screenshot: previewE2E ? 'off' : 'only-on-failure',
		// Pin timezone and locale so assertions on rendered dates and amounts
		// pass in CET and do not fail in CI's UTC. These
		// are the settings the app is actually built for.
		timezoneId: 'Europe/Berlin',
		locale: 'de-DE',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	// Skip local dev server when running against a remote BASE_URL (e.g. preview/prod).
	webServer: isRemoteBase
		? undefined
		: {
				command: webServerCommand,
				cwd: APP_DIR,
				url: BASE_URL,
				reuseExistingServer: false,
				timeout: 180_000,
			},
});
