import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { idempotencyResponses } from '../src/core/db/schema';
import { RESPONSE_REPLAY_TTL_SECONDS } from '../src/core/offline/replay-retention';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));

function loadTs<T>(file: string, overrides: Record<string, unknown>): T {
	const source = transpileModule(readFileSync(file, 'utf8'), {
		compilerOptions: {
			module: ModuleKind.CommonJS,
			target: ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText;
	const module = { exports: {} as T };
	new Function('require', 'module', 'exports', source)(
		(name: string) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return module.exports;
}

type Warning = 'notification_delivery_failed' | 'notification_delivery_unknown';
type ReplayRow = {
	scope: string;
	key: string;
	expiresAt: Date;
	body: Record<string, unknown>;
};

function warningStore(row: ReplayRow | null) {
	const dialect = new PgDialect();
	let setSql = '';
	let whereSql = '';
	let whereParams: unknown[] = [];
	const db = {
		update: () => ({
			set: (values: { responseBody: SQL }) => ({
				where: (condition: SQL) => ({
					returning: async () => {
						const assignment = dialect.sqlToQuery(values.responseBody);
						const predicate = dialect.sqlToQuery(condition);
						setSql = assignment.sql;
						whereSql = predicate.sql;
						whereParams = predicate.params;
						const [scope, key, now, importId, warning] = predicate.params;
						if (
							!row ||
							row.scope !== scope ||
							row.key !== key ||
							row.expiresAt.getTime() <= new Date(String(now)).getTime() ||
							row.body.importId !== importId ||
							!('warning' in row.body) ||
							(row.body.warning !== null && row.body.warning !== warning)
						) {
							return [];
						}
						row.body = { ...row.body, warning };
						return [{ scope: row.scope }];
					},
				}),
			}),
		}),
	};
	const { persistImportReplayWarning } = loadTs<{
		persistImportReplayWarning: (
			scope: string,
			key: string,
			importId: string,
			warning: Warning,
		) => Promise<boolean>;
	}>(path.join(process.cwd(), 'src/core/idempotency.ts'), {
		'@/core/db': { db, idempotencyResponses },
		'@/core/guards/api-auth': { UUID_PATTERN: /^[0-9a-f-]+$/i },
		'@/core/offline/replay-retention': { RESPONSE_REPLAY_TTL_SECONDS },
		'@/core/rate-limit': { createConfiguredRedis: () => null },
	});
	return {
		persistImportReplayWarning,
		query: () => ({ setSql, whereSql, whereParams }),
	};
}

const warning: Warning = 'notification_delivery_failed';

test('warning update uses a scoped JSONB update', async () => {
	const row: ReplayRow = {
		scope: 'import-commit:wg:member',
		key: 'key',
		expiresAt: new Date(Date.now() + 60_000),
		body: { importId: 'import-1', inserted: 0, skipped: 0, errors: [], warning: null },
	};
	const { persistImportReplayWarning, query } = warningStore(row);
	expect(await persistImportReplayWarning(row.scope, row.key, 'import-1', warning)).toBe(true);
	expect(query().setSql).toContain('jsonb_set');
	expect(query().whereSql).toContain('expires_at');
	expect(query().whereSql).toContain('importId');
	expect(query().whereParams).toContain('import-1');
});

test('missing, expired, or different import rows reject warning updates', async () => {
	const base = {
		scope: 'import-commit:wg:member',
		key: 'key',
		expiresAt: new Date(Date.now() + 60_000),
		body: { importId: 'import-1', inserted: 1, skipped: 0, errors: [], warning: null },
	};
	for (const row of [
		null,
		{ ...base, expiresAt: new Date(Date.now() - 1) },
		{ ...base, body: { ...base.body, importId: 'other-import' } },
	]) {
		const { persistImportReplayWarning } = warningStore(row);
		expect(await persistImportReplayWarning(base.scope, base.key, 'import-1', warning)).toBe(false);
	}
});

function importRoute(persist: () => Promise<boolean>, commit?: () => Promise<unknown>) {
	let logs = 0;
	const released: string[] = [];
	const result = {
		importId: 'import-1',
		inserted: 1,
		skipped: 0,
		errors: [],
		warning,
	};
	const route = loadTs<{ POST: (req: Request, ctx: unknown) => Promise<Response> }>(
		path.join(process.cwd(), 'src/app/api/wg/[code]/imports/commit/route.ts'),
		{
			'@/core/errors': {
				badRequest: () => new Response(null, { status: 400 }),
				serverError: () => new Response(null, { status: 500 }),
				tooMany: () => new Response(null, { status: 429 }),
			},
			'@/core/guards/idempotency': {
				ReplayCache: class {
					get() {
						return null;
					}
					reserve() {
						return { owned: true, resolve: () => undefined, reject: () => undefined };
					}
				},
				claimReplaySlotWithRetry: async () => ({ won: true }),
				replayKey: () => 'replay-key',
			},
			'@/core/guards/require-wg-member': {
				requireWgMember: async () => ({
					ok: true,
					wg: { id: 'wg', name: 'WG', shareCode: 'MTE8PZAT' },
					member: { memberId: 'member', name: 'Member' },
				}),
			},
			'@/core/guards/route-preamble': {
				readShareCode: async () => ({ ok: true, code: 'MTE8PZAT' }),
			},
			'@/core/idempotency': {
				getCachedResponse: async () => null,
				persistImportReplayWarning: persist,
				readIdempotencyKey: () => 'key',
				releaseResponseSlot: async (scope: string, key: string) => {
					released.push(`${scope}:${key}`);
				},
			},
			'@/core/infra/observability': { logApiError: () => logs++ },
			'@/core/rate-limit': {
				checkRateLimit: async () => ({ success: true }),
				importCommitLimiter: {},
			},
			'@/features/expenses/import-body': {
				MAX_CSV_BYTES: 5 * 1024 * 1024,
				MAX_OCR_BYTES: 1024 * 1024,
				readImportJsonBody: async (req: Request) => ({ ok: true, value: await req.json() }),
			},
			'@/features/expenses/import-commit': {
				commitImport: commit ?? (async () => result),
				isCommitResult: () => true,
			},
			'@/features/expenses/import-hash': { hashPayload: () => 'hash' },
			'@/features/expenses/import-parsers': {
				UnsupportedCurrencyError: class extends Error {},
				findMappingConflicts: () => [],
				parseSplidCsv: () => [{ paidByName: 'Member', splits: [] }],
				parseSplitwiseCsv: () => [{ paidByName: 'Member', splits: [] }],
			},
			'@/features/expenses/ocr': { parseOcrText: () => ({ expenses: [] }) },
			'next/server': { NextResponse: { json: (body: unknown) => Response.json(body) } },
		},
	);
	return {
		logs: () => logs,
		released: () => released,
		post: () =>
			route.POST(
				new Request('https://example.invalid', {
					method: 'POST',
					body: JSON.stringify({ source: 'splitwise_csv', payload: 'data', memberMapping: {} }),
				}),
				{ params: Promise.resolve({ code: 'MTE8PZAT' }) },
			),
	};
}

test('immediate response preserves a known warning when persistence fails', async () => {
	const saved = importRoute(async () => true);
	await expect((await saved.post()).json()).resolves.toMatchObject({ warning });
	expect(saved.logs()).toBe(0);

	const missing = importRoute(async () => false);
	await expect((await missing.post()).json()).resolves.toMatchObject({ warning });
	expect(missing.logs()).toBe(1);

	const failed = importRoute(async () => {
		throw new Error('db_unavailable');
	});
	await expect((await failed.post()).json()).resolves.toMatchObject({ warning });
	expect(failed.logs()).toBe(1);
});

test('a failed commit releases its idempotency claim so the retry gets the real error', async () => {
	const failing = importRoute(
		async () => true,
		async () => {
			throw new Error('member_not_in_wg');
		},
	);
	expect((await failing.post()).status).toBe(400);
	expect(failing.released()).toHaveLength(1);
	expect((await failing.post()).status).toBe(400);
	expect(failing.released()).toHaveLength(2);

	const succeeding = importRoute(async () => true);
	expect((await succeeding.post()).status).toBe(200);
	expect(succeeding.released()).toHaveLength(0);
});
