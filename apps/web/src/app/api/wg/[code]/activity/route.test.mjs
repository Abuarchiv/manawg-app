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

test('due chores are the overdue ones, oldest first, so the 120-row cap keeps them', async () => {
	const tableNames = [
		'announcements',
		'auditEvents',
		'choreCompletions',
		'chores',
		'expenses',
		'memberAbsences',
		'recurringExpenses',
		'shoppingItems',
		'wgMembers',
	];
	const tables = Object.fromEntries(
		tableNames.map((name) => [
			name,
			{ name, wgId: `${name}.wgId`, nextDueAt: `${name}.nextDueAt` },
		]),
	);
	const choreQuery = {};
	const db = {
		select: () => ({
			from: (table) => {
				const query = Object.assign(Promise.resolve([]), {
					innerJoin: () => query,
					where: (predicate) => {
						if (table === tables.chores) choreQuery.where = predicate;
						return query;
					},
					orderBy: (order) => {
						if (table === tables.chores) choreQuery.orderBy = order;
						return query;
					},
					limit: (limit) => {
						if (table === tables.chores) choreQuery.limit = limit;
						return query;
					},
				});
				return query;
			},
		}),
	};
	const { GET } = loadTs('src/app/api/wg/[code]/activity/route.ts', {
		'@/core/db': { db, ...tables },
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({ ok: true, wg: { id: 'wg-1' } }),
		},
		'@/core/guards/with-wg-route': {
			withWgRoute: (_name, handler) => (req) => handler(req, { code: 'MTE8PZAT' }),
		},
		'@/core/reads/activity': {
			REMINDER_ANNOUNCEMENT_KINDS: ['question', 'request', 'task'],
			buildActivityTimeline: () => [],
			getActivityReminders: () => [],
		},
		'drizzle-orm': {
			and: (...parts) => ['and', ...parts],
			asc: (column) => ['asc', column],
			desc: (column) => ['desc', column],
			eq: (...parts) => ['eq', ...parts],
			inArray: (column, values) => ['inArray', column, values],
			isNull: (column) => ['isNull', column],
			lte: (column, value) => ['lte', column, value instanceof Date ? 'now' : value],
		},
		'next/server': { NextResponse: Response },
	});

	const response = await GET({});
	assert.equal(response.status, 200);
	assert.deepEqual(choreQuery.orderBy, ['asc', 'chores.nextDueAt']);
	assert.deepEqual(choreQuery.where, [
		'and',
		['eq', 'chores.wgId', 'wg-1'],
		['lte', 'chores.nextDueAt', 'now'],
	]);
	assert.equal(choreQuery.limit, 120);
});

test('reminders read open shopping items and open announcements from their own oldest-first queries', async () => {
	const columns = ['wgId', 'nextDueAt', 'createdAt', 'boughtAt', 'status', 'kind'];
	const tables = Object.fromEntries(
		[
			'announcements',
			'auditEvents',
			'choreCompletions',
			'chores',
			'expenses',
			'memberAbsences',
			'recurringExpenses',
			'shoppingItems',
			'wgMembers',
		].map((name) => [
			name,
			Object.fromEntries([
				['name', name],
				...columns.map((column) => [column, `${name}.${column}`]),
			]),
		]),
	);
	const at = new Date('2026-01-01T00:00:00.000Z');
	// The newest-first timeline rows are all bought items / system notices.
	const timelineShopping = Array.from({ length: 120 }, (_, index) => ({
		id: `bought-${index}`,
		name: 'Milch',
		createdAt: at,
		boughtAt: at,
	}));
	const timelineAnnouncements = Array.from({ length: 120 }, (_, index) => ({
		id: `notice-${index}`,
		content: 'Notice',
		kind: 'info',
		status: 'open',
		createdAt: at,
	}));
	const openShopping = [{ id: 'open-item', name: 'Brot', createdAt: at }];
	const openAnnouncements = [
		{ id: 'open-question', content: 'Wer?', kind: 'question', createdAt: at },
	];
	const queries = [];
	const db = {
		select: () => ({
			from: (table) => {
				const entry = { table: table.name };
				queries.push(entry);
				const rows = () => {
					const where = JSON.stringify(entry.where ?? null);
					if (table === tables.shoppingItems)
						return where.includes('isNull') ? openShopping : timelineShopping;
					if (table === tables.announcements)
						return where.includes('inArray') ? openAnnouncements : timelineAnnouncements;
					return [];
				};
				// Only the member list is awaited without `.limit()`.
				const query = Object.assign(Promise.resolve([]), {
					innerJoin: () => query,
					where: (predicate) => {
						entry.where = predicate;
						return query;
					},
					orderBy: (order) => {
						entry.orderBy = order;
						return query;
					},
					limit: async (limit) => {
						entry.limit = limit;
						return rows();
					},
				});
				return query;
			},
		}),
	};
	let reminderInput = null;
	const { GET } = loadTs('src/app/api/wg/[code]/activity/route.ts', {
		'@/core/db': { db, ...tables },
		'@/core/guards/require-wg-member': {
			requireWgMember: async () => ({ ok: true, wg: { id: 'wg-1' } }),
		},
		'@/core/guards/with-wg-route': {
			withWgRoute: (_name, handler) => (req) => handler(req, { code: 'MTE8PZAT' }),
		},
		'@/core/reads/activity': {
			REMINDER_ANNOUNCEMENT_KINDS: ['question', 'request', 'task'],
			buildActivityTimeline: () => [],
			getActivityReminders: (input) => {
				reminderInput = input;
				return [];
			},
		},
		'drizzle-orm': {
			and: (...parts) => ['and', ...parts],
			asc: (column) => ['asc', column],
			desc: (column) => ['desc', column],
			eq: (...parts) => ['eq', ...parts],
			inArray: (column, values) => ['inArray', column, values],
			isNull: (column) => ['isNull', column],
			lte: (column, value) => ['lte', column, value instanceof Date ? 'now' : value],
		},
		'next/server': { NextResponse: Response },
	});

	const response = await GET({});
	assert.equal(response.status, 200);
	assert.deepEqual(
		reminderInput.openShoppingItems.map((item) => item.id),
		['open-item'],
	);
	assert.deepEqual(
		reminderInput.openAnnouncements.map((item) => item.id),
		['open-question'],
	);

	const openShoppingQuery = queries.find(
		(query) => query.table === 'shoppingItems' && JSON.stringify(query.where).includes('isNull'),
	);
	assert.deepEqual(openShoppingQuery.where, [
		'and',
		['eq', 'shoppingItems.wgId', 'wg-1'],
		['isNull', 'shoppingItems.boughtAt'],
	]);
	assert.deepEqual(openShoppingQuery.orderBy, ['asc', 'shoppingItems.createdAt']);
	assert.equal(openShoppingQuery.limit, 120);

	const openAnnouncementQuery = queries.find(
		(query) => query.table === 'announcements' && JSON.stringify(query.where).includes('inArray'),
	);
	assert.deepEqual(openAnnouncementQuery.where, [
		'and',
		['eq', 'announcements.wgId', 'wg-1'],
		['eq', 'announcements.status', 'open'],
		['inArray', 'announcements.kind', ['question', 'request', 'task']],
	]);
	assert.deepEqual(openAnnouncementQuery.orderBy, ['asc', 'announcements.createdAt']);
	assert.equal(openAnnouncementQuery.limit, 120);
});
