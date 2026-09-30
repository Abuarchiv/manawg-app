import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const directory = path.dirname(fileURLToPath(import.meta.url));
const routeFile = path.join(directory, 'route.ts');
const wgId = '22222222-2222-4222-8222-222222222222';

function stubModule() {
	return new Proxy(
		{},
		{
			get: () =>
				function Stub() {
					return undefined;
				},
		},
	);
}

function loadRoute(rows) {
	const shoppingItems = {
		wgId: 'wgId',
		boughtAt: 'boughtAt',
		createdAt: 'createdAt',
	};
	const matches = (row, predicate) => {
		const [op, ...args] = predicate;
		if (op === 'and') return args.every((part) => matches(row, part));
		if (op === 'eq') return row[args[0]] === args[1];
		if (op === 'isNull') return row[args[0]] === null;
		if (op === 'isNotNull') return row[args[0]] !== null;
		throw new Error(`unsupported predicate ${op}`);
	};
	// Postgres default: NULL sorts as the largest value (last in ASC, first in DESC).
	const compare = (orders) => (a, b) => {
		for (const [direction, column] of orders) {
			const left = a[column]?.getTime() ?? Number.POSITIVE_INFINITY;
			const right = b[column]?.getTime() ?? Number.POSITIVE_INFINITY;
			if (left === right) continue;
			if (left !== right) return direction === 'asc' ? left - right : right - left;
		}
		return 0;
	};
	const db = {
		select: () => ({
			from: (table) => {
				assert.equal(table, shoppingItems);
				return {
					where: (predicate) => ({
						orderBy: (...orders) => ({
							limit: async (limit) =>
								rows
									.filter((row) => matches(row, predicate))
									.sort(compare(orders))
									.slice(0, limit),
						}),
					}),
				};
			},
		}),
	};
	const overrides = {
		'@/core/db': { db, shoppingItems },
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({ ok: true, wg: { id: wgId }, member: { memberId: 'm' } }),
		},
		'@/core/guards/with-wg-route': {
			withWgRoute: (_name, handler) => (req) => handler(req, { code: 'MTE8PZAT' }),
		},
		'@/core/infra/env': {
			readListLimit: (_env, _name, fallback) => fallback,
		},
		'drizzle-orm': {
			and: (...parts) => ['and', ...parts],
			asc: (column) => ['asc', column],
			desc: (column) => ['desc', column],
			eq: (...parts) => ['eq', ...parts],
			isNotNull: (column) => ['isNotNull', column],
			isNull: (column) => ['isNull', column],
		},
		'next/server': { NextResponse: Response },
	};
	const source = transpileModule(readFileSync(routeFile, 'utf8'), {
		compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', source)(
		(name) => {
			if (name in overrides) return overrides[name];
			if (name.startsWith('@/')) return stubModule();
			return requireFromWeb(name);
		},
		module,
		module.exports,
	);
	return module.exports;
}

test('GET keeps every open item even when the bought history exceeds the list limit', async () => {
	const base = Date.parse('2026-01-01T00:00:00.000Z');
	const rows = [];
	for (let index = 0; index < 1500; index++) {
		rows.push({
			id: `bought-${index}`,
			wgId,
			createdAt: new Date(base + index * 1000),
			boughtAt: new Date(base + index * 1000 + 500),
		});
	}
	for (let index = 0; index < 3; index++) {
		rows.push({
			id: `open-${index}`,
			wgId,
			createdAt: new Date(base + index * 1000),
			boughtAt: null,
		});
	}
	rows.push({ id: 'other-wg', wgId: 'other', createdAt: new Date(base), boughtAt: null });

	const { GET } = loadRoute(rows);
	const response = await GET({});
	assert.equal(response.status, 200);
	const { items } = await response.json();
	const ids = items.map((item) => item.id);

	assert.deepEqual(ids.slice(0, 3), ['open-0', 'open-1', 'open-2']);
	assert.equal(ids.includes('other-wg'), false);
	const bought = ids.slice(3);
	assert.equal(bought.length, 1000);
	// Bought history is capped from the newest purchase backwards.
	assert.equal(bought[0], 'bought-1499');
	assert.equal(bought.at(-1), 'bought-500');
});
