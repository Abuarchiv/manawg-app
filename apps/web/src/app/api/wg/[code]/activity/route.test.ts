import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

type Entry = { table: string; where?: unknown; orderBy?: unknown; limit?: number };
type Table = { name: string } & Record<string, string>;

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
const columns = [
	'wgId',
	'nextDueAt',
	'createdAt',
	'boughtAt',
	'status',
	'kind',
	'source',
	'eventType',
];
const tables = Object.fromEntries(
	tableNames.map((name) => [
		name,
		Object.fromEntries([['name', name], ...columns.map((column) => [column, `${name}.${column}`])]),
	]),
) as Record<string, Table>;

const state = {
	queries: [] as Entry[],
	// Rows returned by `.limit()` for a given table and where-clause.
	rows: (_table: string, _where: string): unknown[] => [],
	timelineLimit: 0,
	reminderInput: null as {
		openShoppingItems: { id: string }[];
		openAnnouncements: { id: string }[];
	} | null,
};

const db = {
	select: () => ({
		from: (table: Table) => {
			const entry: Entry = { table: table.name };
			state.queries.push(entry);
			// Only the member list is awaited without `.limit()`.
			const query: Promise<unknown[]> & object = Object.assign(Promise.resolve([]), {
				innerJoin: () => query,
				where: (predicate: unknown) => {
					entry.where = predicate;
					return query;
				},
				orderBy: (order: unknown) => {
					entry.orderBy = order;
					return query;
				},
				limit: async (limit: number) => {
					entry.limit = limit;
					return state.rows(table.name, JSON.stringify(entry.where ?? null));
				},
			});
			return query;
		},
	}),
};

mock.module('@/core/db', { namedExports: { db, ...tables } });
mock.module('@/core/guards/require-wg-member', {
	namedExports: { requireWgMember: async () => ({ ok: true, wg: { id: 'wg-1' } }) },
});
mock.module('@/composition/activity', {
	namedExports: {
		ACTIVITY_HIDDEN_AUDIT_EVENT_TYPES: ['chat.message.created', 'shopping.created'],
		MEMBER_ANNOUNCEMENT_SOURCES: ['manual', 'chore_swap'],
		REMINDER_ANNOUNCEMENT_KINDS: ['question', 'problem', 'request'],
		buildActivityTimeline: (input: { limit: number }) => {
			state.timelineLimit = input.limit;
			return [];
		},
		getActivityReminders: (input: NonNullable<typeof state.reminderInput>) => {
			state.reminderInput = input;
			return [];
		},
	},
});
mock.module('drizzle-orm', {
	namedExports: {
		and: (...parts: unknown[]) => ['and', ...parts],
		asc: (column: unknown) => ['asc', column],
		desc: (column: unknown) => ['desc', column],
		eq: (...parts: unknown[]) => ['eq', ...parts],
		inArray: (column: unknown, values: unknown) => ['inArray', column, values],
		isNull: (column: unknown) => ['isNull', column],
		notInArray: (column: unknown, values: unknown) => ['notInArray', column, values],
		sql: (strings: TemplateStringsArray) => ['sql', strings.join('?')],
		lte: (column: unknown, value: unknown) => [
			'lte',
			column,
			value instanceof Date ? 'now' : value,
		],
	},
});

const { GET } = await import('./route');

function get(search = '') {
	return GET(
		new Request(`https://example.test/api/wg/MTE8PZAT/activity${search}`) as never,
		{ params: Promise.resolve({ code: 'MTE8PZAT' }) } as never,
	);
}

function reset(rows: typeof state.rows = () => []) {
	state.queries = [];
	state.rows = rows;
	state.reminderInput = null;
	state.timelineLimit = 0;
}

test('due chores are the overdue ones, oldest first, so the 120-row cap keeps them', async () => {
	reset();

	const response = await get();
	assert.equal(response.status, 200);
	const choreQuery = state.queries.find((query) => query.table === 'chores');
	assert.deepEqual(choreQuery?.orderBy, ['asc', 'chores.nextDueAt']);
	assert.deepEqual(choreQuery?.where, [
		'and',
		['eq', 'chores.wgId', 'wg-1'],
		['lte', 'chores.nextDueAt', 'now'],
	]);
	assert.equal(choreQuery?.limit, 120);
});

test('reminders read open shopping items and open announcements from their own oldest-first queries', async () => {
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
	reset((table, where) => {
		if (table === 'shoppingItems')
			return where.includes('isNull') ? openShopping : timelineShopping;
		if (table === 'announcements') {
			return where.includes('"open"') ? openAnnouncements : timelineAnnouncements;
		}
		return [];
	});

	const response = await get();
	assert.equal(response.status, 200);
	assert.deepEqual(
		state.reminderInput?.openShoppingItems.map((item) => item.id),
		['open-item'],
	);
	assert.deepEqual(
		state.reminderInput?.openAnnouncements.map((item) => item.id),
		['open-question'],
	);

	const openShoppingQuery = state.queries.find(
		(query) =>
			query.table === 'shoppingItems' && JSON.stringify(query.where ?? null).includes('isNull'),
	);
	assert.deepEqual(openShoppingQuery?.where, [
		'and',
		['eq', 'shoppingItems.wgId', 'wg-1'],
		['isNull', 'shoppingItems.boughtAt'],
	]);
	assert.deepEqual(openShoppingQuery?.orderBy, ['asc', 'shoppingItems.createdAt']);
	assert.equal(openShoppingQuery?.limit, 120);

	const openAnnouncementQuery = state.queries.find(
		(query) =>
			query.table === 'announcements' && JSON.stringify(query.where ?? null).includes('"open"'),
	);
	assert.deepEqual(openAnnouncementQuery?.where, [
		'and',
		['eq', 'announcements.wgId', 'wg-1'],
		['eq', 'announcements.status', 'open'],
		['inArray', 'announcements.kind', ['question', 'problem', 'request']],
		// Shopping notices would duplicate the shopping reminder.
		['inArray', 'announcements.source', ['manual', 'chore_swap']],
	]);
	assert.deepEqual(openAnnouncementQuery?.orderBy, ['asc', 'announcements.createdAt']);
	assert.equal(openAnnouncementQuery?.limit, 120);
});

test('timeline queries drop system notices and noisy audits in SQL and sort shopping by its timeline instant', async () => {
	reset();

	await get();
	const find = (table: string) =>
		state.queries.find(
			(query) => query.table === table && !JSON.stringify(query.where ?? null).includes('"open"'),
		);
	assert.deepEqual(find('announcements')?.where, [
		'and',
		['eq', 'announcements.wgId', 'wg-1'],
		['inArray', 'announcements.source', ['manual', 'chore_swap']],
	]);
	assert.deepEqual(find('auditEvents')?.where, [
		'and',
		['eq', 'auditEvents.wgId', 'wg-1'],
		['notInArray', 'auditEvents.eventType', ['chat.message.created', 'shopping.created']],
	]);
	const shoppingQuery = state.queries.find(
		(query) => query.table === 'shoppingItems' && query.limit === 80,
	);
	assert.deepEqual(shoppingQuery?.orderBy, ['desc', ['sql', 'coalesce(?, ?)']]);
});

test('limit query param raises every timeline cap, clamped to 80..320', async () => {
	for (const [search, expected] of [
		['', 80],
		['?limit=160', 160],
		['?limit=10', 80],
		['?limit=9999', 320],
		['?limit=abc', 80],
	] as const) {
		reset();
		await get(search);
		assert.equal(state.timelineLimit, expected, search);
		const expenseQuery = state.queries.find((query) => query.table === 'expenses');
		assert.equal(expenseQuery?.limit, expected, search);
		const completions = state.queries.filter((query) => query.table === 'choreCompletions');
		assert.equal(completions[0]?.limit, expected, search);
	}
});
