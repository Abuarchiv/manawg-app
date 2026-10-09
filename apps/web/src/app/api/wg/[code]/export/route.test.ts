import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

type Row = Record<string, unknown>;
type Sections = Record<string, Row[]>;

const tables: Record<string, object> = Object.fromEntries(
	[
		'announcementComments',
		'announcements',
		'auditEvents',
		'choreCompletions',
		'chores',
		'expensePayments',
		'expenseSplits',
		'expenses',
		'memberAbsences',
		'recurringExpenses',
		'shoppingItems',
		'wgChatMessages',
		'wgEvents',
		'wgInventoryItems',
		'wgMembers',
	].map((name) => [
		name,
		name === 'expensePayments'
			? {
					id: {},
					fromMemberId: {},
					toMemberId: {},
					amountCents: {},
					currency: {},
					completedAt: {},
					wgId: {},
					status: {},
				}
			: {},
	]),
);

const state = {
	failedTable: undefined as string | null | undefined,
	expenseRows: [] as Row[],
	rowsByTable: {} as Record<string, Row[]>,
	limits: [] as number[],
	inArrayCalls: [] as number[],
};

const db = {
	select: () => ({
		from: (table: object) => {
			const name = Object.keys(tables).find((key) => tables[key] === table) ?? '';
			const rows =
				state.failedTable && table === tables[state.failedTable]
					? Promise.reject(new Error('privateDbPassword123'))
					: Promise.resolve(
							table === tables.expenses ? state.expenseRows : (state.rowsByTable[name] ?? []),
						);
			const query: Promise<Row[]> & object = Object.assign(rows, {
				innerJoin: () => query,
				where: () => query,
				orderBy: () => query,
				limit: (limit: number) => {
					state.limits.push(limit);
					return query;
				},
				offset: () => query,
			});
			return query;
		},
	}),
};

mock.module('@/core/db', { namedExports: { db, ...tables } });
mock.module('drizzle-orm', {
	namedExports: {
		and: () => null,
		asc: () => null,
		count: () => null,
		desc: () => null,
		eq: () => null,
		inArray: (_column: unknown, values: unknown[]) => {
			state.inArrayCalls.push(values.length);
			return null;
		},
	},
});
mock.module('@/core/guards/require-wg-member', {
	namedExports: {
		requireWgMember: async () => ({
			ok: true,
			wg: { id: 'wg', name: 'WG', shareCode: 'MTE8PZAT' },
			member: { memberId: 'member' },
		}),
	},
});
// The real observability module runs against a stubbed Sentry so tests can inspect console output.
mock.module('@/core/infra/sentry', {
	namedExports: { captureSentryException() {}, logSentryApiError() {} },
});
mock.module('@/core/rate-limit', {
	namedExports: { wgExportLimiter: {}, checkRateLimit: async () => ({ success: true }) },
});

const { GET } = await import('./route');

function exportRoute(
	failedTable?: string | null,
	{
		expenseCount = 0,
		rowsByTable = {},
	}: { expenseCount?: number; rowsByTable?: Record<string, Row[]> } = {},
) {
	state.failedTable = failedTable;
	state.rowsByTable = rowsByTable;
	state.limits = [];
	state.inArrayCalls = [];
	state.expenseRows = Array.from({ length: expenseCount }, (_, index) => ({
		id: `expense-${index}`,
		description: 'x',
		amountCents: 1,
		currency: 'EUR',
		paidByMemberId: 'member',
		imageUrl: null,
		occurredAt: new Date(0),
	}));
	return {
		limits: state.limits,
		inArrayCalls: state.inArrayCalls,
		get: (search = '') =>
			GET(
				{ nextUrl: new URL(`https://example.invalid/export${search}`) } as never,
				{ params: Promise.resolve({ code: 'MTE8PZAT' }) } as never,
			),
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

test('large expense id sets load splits in bind-param-safe chunks', async () => {
	for (const search of ['?format=csv&section=expenses', '?sections=expenses']) {
		const route = exportRoute(undefined, { expenseCount: 25_001 });
		const response = await route.get(search);
		assert.equal(response.status, 200, await response.text());
		assert.deepEqual(route.inArrayCalls, [10_000, 10_000, 5_001]);
	}
});

test('one failed JSON section rejects the incomplete backup', async (t) => {
	const logged: unknown[][] = [];
	t.mock.method(console, 'error', (...args: unknown[]) => logged.push(args));
	for (const section of ['expenses', 'wgMembers']) {
		const response = await exportRoute(section).get('?limit=20');
		assert.equal(response.status, 500);
		assert.equal(((await response.json()) as { error: string }).error, 'export_incomplete');
	}
	assert.equal(JSON.stringify(logged).includes('privateDbPassword123'), false);
});

test('deleted chat messages export without their text or image', async () => {
	const route = exportRoute(undefined, {
		rowsByTable: {
			wgMembers: [{ id: 'member', name: 'Alice', createdAt: new Date(0) }],
			wgChatMessages: [
				{
					id: 'message-live',
					senderMemberId: 'member',
					kind: 'image',
					body: 'Hallo',
					imageUrl: 'https://img.example/live.jpg',
					replyToMessageId: null,
					editedAt: null,
					deletedAt: null,
					createdAt: new Date('2026-03-01T10:00:00Z'),
				},
				{
					id: 'message-deleted',
					senderMemberId: 'member',
					kind: 'image',
					body: 'privateDeletedText',
					imageUrl: 'https://img.example/deleted.jpg',
					replyToMessageId: 'message-live',
					editedAt: new Date('2026-03-01T10:05:00Z'),
					deletedAt: new Date('2026-03-01T10:06:00Z'),
					createdAt: new Date('2026-03-01T10:01:00Z'),
				},
				{
					id: 'message-system',
					senderMemberId: null,
					kind: 'system',
					body: null,
					imageUrl: null,
					replyToMessageId: null,
					editedAt: null,
					deletedAt: null,
					createdAt: new Date('2026-03-01T10:02:00Z'),
				},
			],
		},
	});
	const response = await route.get('?sections=chatMessages');
	assert.equal(response.status, 200);
	const { sections } = (await response.json()) as { sections: Sections };
	assert.deepEqual(sections.chatMessages, [
		{
			id: 'message-live',
			createdAt: '2026-03-01T10:00:00.000Z',
			senderName: 'Alice',
			kind: 'image',
			body: 'Hallo',
			imageUrl: 'https://img.example/live.jpg',
			editedAt: null,
			deletedAt: null,
			replyToMessageId: null,
		},
		{
			id: 'message-deleted',
			createdAt: '2026-03-01T10:01:00.000Z',
			senderName: 'Alice',
			kind: 'image',
			body: null,
			imageUrl: '',
			editedAt: '2026-03-01T10:05:00.000Z',
			deletedAt: '2026-03-01T10:06:00.000Z',
			replyToMessageId: 'message-live',
		},
		{
			id: 'message-system',
			createdAt: '2026-03-01T10:02:00.000Z',
			senderName: 'System',
			kind: 'system',
			body: null,
			imageUrl: '',
			editedAt: null,
			deletedAt: null,
			replyToMessageId: null,
		},
	]);

	const csv = await route.get('?format=csv&section=chatMessages');
	assert.equal(csv.status, 200);
	const csvText = await csv.text();
	assert.equal(csvText.includes('privateDeletedText'), false);
	assert.equal(csvText.includes('deleted.jpg'), false);
});

test('new sections are part of the full dump and export CSV headers', async () => {
	const route = exportRoute(undefined, {
		rowsByTable: {
			wgMembers: [{ id: 'member', name: 'Alice', createdAt: new Date(0) }],
			announcementComments: [
				{
					id: 'comment',
					announcementId: 'post',
					memberId: 'member',
					content: '=HYPERLINK("x")',
					createdAt: new Date('2026-03-02T08:00:00Z'),
				},
			],
			wgInventoryItems: [
				{
					id: 'rice',
					name: 'Reis',
					quantity: 2,
					unit: 'Packung',
					threshold: 1,
					category: 'lebensmittel',
					lastDecrementedAt: null,
					createdAt: new Date('2026-03-01T08:00:00Z'),
				},
			],
			choreCompletions: [
				{
					id: 'done',
					choreTitle: 'Bad',
					completedByMemberId: 'member',
					completedAt: new Date('2026-03-03T08:00:00Z'),
				},
			],
			wgEvents: [
				{
					id: 'event',
					title: 'Putzparty',
					description: null,
					startsAt: new Date('2026-03-05T18:00:00Z'),
					endsAt: null,
					allDay: false,
					location: 'Küche',
					recurrence: null,
					createdByMemberId: null,
					createdAt: new Date('2026-03-01T08:00:00Z'),
				},
			],
		},
	});
	const response = await route.get();
	assert.equal(response.status, 200);
	const { sections, failedSections } = (await response.json()) as {
		sections: Sections;
		failedSections: string[];
	};
	assert.deepEqual(failedSections, []);
	assert.deepEqual(sections.chatMessages, []);
	assert.deepEqual(sections.announcementComments, [
		{
			id: 'comment',
			announcementId: 'post',
			authorName: 'Alice',
			content: '=HYPERLINK("x")',
			createdAt: '2026-03-02T08:00:00.000Z',
		},
	]);
	assert.equal(sections.events?.[0]?.createdByName, '');
	assert.equal(sections.inventory?.[0]?.name, 'Reis');
	assert.deepEqual(sections.choreCompletions, [
		{
			id: 'done',
			choreTitle: 'Bad',
			completedByName: 'Alice',
			completedAt: '2026-03-03T08:00:00.000Z',
		},
	]);

	const expected = {
		chatMessages: 'id;createdAt;senderName;kind;body;imageUrl;editedAt;deletedAt;replyToMessageId',
		announcementComments:
			'id;announcementId;authorName;content;createdAt\ncomment;post;Alice;"\'=HYPERLINK(""x"")";2026-03-02 09:00',
		events:
			'id;title;description;startsAt;endsAt;allDay;location;recurrence;createdByName;createdAt\nevent;Putzparty;;2026-03-05 19:00;;false;Küche;;;2026-03-01 09:00',
	};
	for (const [section, csv] of Object.entries(expected)) {
		const csvResponse = await route.get(`?format=csv&section=${section}`);
		assert.equal(csvResponse.status, 200);
		assert.equal(
			csvResponse.headers.get('content-disposition'),
			`attachment; filename="MTE8PZAT-${section}.csv"`,
		);
		assert.equal(await csvResponse.text(), csv);
	}
});

test('a failed new section fails the full export closed', async (t) => {
	t.mock.method(console, 'error', () => {});
	for (const table of ['wgChatMessages', 'announcementComments', 'wgEvents']) {
		const response = await exportRoute(table).get();
		assert.equal(response.status, 500);
		assert.equal(((await response.json()) as { error: string }).error, 'export_incomplete');
	}
});

test('the counts summary counts rows per section instead of downloading them', async () => {
	const route = exportRoute(null, {
		rowsByTable: { wgChatMessages: [{ value: 3 }], wgMembers: [{ value: 2 }] },
	});
	const response = await route.get('?summary=counts');
	assert.equal(response.status, 200);
	const { counts } = (await response.json()) as { counts: Record<string, number> };
	assert.equal(counts.chatMessages, 3);
	assert.equal(counts.members, 2);
	assert.equal(counts.expenses, 0);
	assert.equal(Object.keys(counts).length, 14);
	assert.deepEqual(route.limits, []);
});
