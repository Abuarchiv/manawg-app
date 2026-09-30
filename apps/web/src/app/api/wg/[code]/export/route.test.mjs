import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));

function loadTs(file, overrides = {}) {
	const source = transpileModule(readFileSync(path.join(process.cwd(), file), 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => (name in overrides ? overrides[name] : requireFromWeb(name)),
		module,
		module.exports,
	);
	return module.exports;
}

function expenseRows(count) {
	return Array.from({ length: count }, (_unused, index) => ({
		id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
		description: `expense ${index}`,
		amountCents: 1000,
		currency: 'EUR',
		paidByMemberId: 'member',
		imageUrl: null,
		occurredAt: new Date('2026-09-01T10:00:00.000Z'),
	}));
}

function exportRoute(failedTable, { expenses: expenseFixture = [] } = {}) {
	const tables = Object.fromEntries(
		[
			'announcements',
			'auditEvents',
			'chores',
			'expenseSplits',
			'expenses',
			'memberAbsences',
			'recurringExpenses',
			'shoppingItems',
			'wgMembers',
		].map((name) => [name, {}]),
	);
	const limits = [];
	const inArraySizes = [];
	const db = {
		select: () => ({
			from: (table) => {
				const rows =
					table === tables[failedTable]
						? Promise.reject(new Error('section unavailable'))
						: Promise.resolve(table === tables.expenses ? expenseFixture : []);
				const query = Object.assign(rows, {
					where: () => query,
					orderBy: () => query,
					limit: (limit) => {
						limits.push(limit);
						return query;
					},
					offset: () => query,
				});
				return query;
			},
		}),
	};
	const { GET } = loadTs('src/app/api/wg/[code]/export/route.ts', {
		'@/core/db': { db, ...tables },
		'@/core/errors': {
			badRequest: (error) => Response.json({ error }, { status: 400 }),
			serverError: (_error, message) => Response.json({ error: message }, { status: 500 }),
			tooMany: () => new Response(null, { status: 429 }),
		},
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({
				ok: true,
				wg: { id: 'wg', name: 'WG', shareCode: 'MTE8PZAT' },
				member: { memberId: 'member' },
			}),
		},
		'@/core/guards/route-preamble': {
			readShareCode: async () => ({ ok: true, code: 'MTE8PZAT' }),
			resolveE2EFixture: async () => ({ mode: 'real' }),
		},
		'@/core/infra/observability': { logApiError: () => undefined },
		'@/core/rate-limit': { checkRateLimit: async () => ({ success: true }) },
		'@/core/reads/export': loadTs('src/core/reads/export.ts'),
		'drizzle-orm': {
			asc: () => null,
			desc: () => null,
			eq: () => null,
			inArray: (_column, ids) => {
				inArraySizes.push(ids.length);
				// Postgres refuses a statement with more than 65,535 bind
				// parameters — model that so an unchunked fetch fails the section.
				if (ids.length > 65_535) throw new Error('bind parameters exceed 65535');
				return null;
			},
		},
		'next/server': { NextResponse: Response },
	});
	return {
		limits,
		inArraySizes,
		get: (search = '') => GET({ nextUrl: new URL(`https://example.invalid/export${search}`) }, {}),
	};
}

test('authenticated default JSON and CSV exports work without a limit', async () => {
	for (const search of ['', '?format=csv&section=expenses', '?offset=20']) {
		const route = exportRoute();
		const response = await route.get(search);
		assert.equal(response.status, 200, await response.text());
		assert.ok(route.limits.every((limit) => limit === Number.MAX_SAFE_INTEGER));
	}
});

test('explicit export limits remain bounded', async () => {
	const route = exportRoute();
	assert.equal((await route.get('?limit=20')).status, 200);
	assert.ok(route.limits.every((limit) => limit === 20));
	assert.equal((await route.get('?limit=100001')).status, 400);
	assert.equal((await route.get('?limit=0')).status, 400);
});

test('one failed JSON section rejects the incomplete backup', async (t) => {
	t.mock.method(console, 'error', () => undefined);
	const response = await exportRoute('expenses').get('?limit=20');
	assert.equal(response.status, 500);
	assert.equal((await response.json()).error, 'export_incomplete');
});

test("expense split fetches stay under Postgres' 65,535 bind limit on every path", async () => {
	// 66,000 expenses exceed the parameter cap if their ids reach one inArray.
	const rows = expenseRows(66_000);
	for (const search of [
		'',
		'?sections=expenses',
		'?format=csv&section=expenses',
		'?format=csv&section=expenses&limit=100000',
	]) {
		const route = exportRoute(undefined, { expenses: rows });
		const response = await route.get(search);
		assert.equal(response.status, 200, `${search}: ${await response.text()}`);
		assert.ok(route.inArraySizes.length > 0, `${search}: splits must be fetched`);
		assert.ok(
			Math.max(...route.inArraySizes) <= 10_000,
			`${search}: chunk size ${Math.max(...route.inArraySizes)} must stay far below 65,535`,
		);
	}
});

test('an explicit limit at the declared maximum still returns 200', async () => {
	const route = exportRoute(undefined, { expenses: expenseRows(5) });
	const response = await route.get('?limit=100000&offset=0');
	assert.equal(response.status, 200, await response.text());
	assert.ok(route.limits.every((limit) => limit === 100_000));
});
