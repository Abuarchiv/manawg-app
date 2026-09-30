import assert from 'node:assert/strict';
import test from 'node:test';

const checker = await import('./db-migrate.mjs');

test('db:migrate accepts direct URLs and rejects query parameters that override them', async (t) => {
	for (const [name, url] of [
		['local connection', 'postgresql://migrator:example@localhost:5432/app'],
		[
			'remote connection with verified TLS',
			'postgresql://migrator:example@db.example.test:5432/app?sslmode=verify-full',
		],
	]) {
		await t.test(`accepts ${name}`, () => {
			assert.doesNotThrow(() => checker.validateDatabaseUrl(url, 'DATABASE_MIGRATION_URL'));
		});
	}

	for (const [name, url] of [
		[
			'host override',
			'postgresql://migrator:example@db.example.test:5432/app?sslmode=verify-full&host=localhost',
		],
		[
			'port override',
			'postgresql://migrator:example@db.example.test:5432/app?sslmode=verify-full&port=6543',
		],
		[
			'duplicate TLS mode',
			'postgresql://migrator:example@db.example.test:5432/app?sslmode=verify-full&sslmode=disable',
		],
	]) {
		await t.test(`rejects ${name}`, () => {
			assert.throws(() => checker.validateDatabaseUrl(url, 'DATABASE_MIGRATION_URL'));
		});
	}
});

const triggerArgs = {
	expenses: ['paid_by_member_id'],
	expense_imports: ['imported_by_member_id'],
	expense_payments: ['from_member_id', 'to_member_id'],
	shopping_items: ['added_by_member_id', 'bought_by_member_id'],
	announcements: ['author_member_id', 'resolved_by_member_id'],
	chores: ['assigned_member_id'],
	member_absences: ['member_id'],
	recurring_expenses: ['created_by_member_id', 'paid_by_member_id'],
	wg_events: ['created_by_member_id'],
	calendar_subscriptions: ['member_id'],
	expense_reminders: ['debtor_member_id', 'creditor_member_id', 'sent_by_member_id'],
	audit_events: ['member_id'],
	wg_chat_messages: ['sender_member_id'],
	wg_chat_reads: ['member_id'],
};

const expectedTriggers = [
	['expenses', 'expenses_member_wg_same_tenant', 'manawg_assert_member_belongs_to_wg'],
	[
		'expense_imports',
		'expense_imports_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
	],
	[
		'expense_payments',
		'expense_payments_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
	],
	['shopping_items', 'shopping_items_member_wg_same_tenant', 'manawg_assert_member_belongs_to_wg'],
	['announcements', 'announcements_member_wg_same_tenant', 'manawg_assert_member_belongs_to_wg'],
	['chores', 'chores_member_wg_same_tenant', 'manawg_assert_member_belongs_to_wg'],
	[
		'member_absences',
		'member_absences_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
	],
	[
		'recurring_expenses',
		'recurring_expenses_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
	],
	['wg_events', 'wg_events_member_wg_same_tenant', 'manawg_assert_member_belongs_to_wg'],
	[
		'calendar_subscriptions',
		'calendar_subscriptions_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
	],
	[
		'expense_reminders',
		'expense_reminders_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
	],
	['audit_events', 'audit_events_member_wg_same_tenant', 'manawg_assert_member_belongs_to_wg'],
	[
		'wg_chat_messages',
		'wg_chat_messages_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
	],
	['wg_chat_reads', 'wg_chat_reads_member_wg_same_tenant', 'manawg_assert_member_belongs_to_wg'],
	[
		'expense_splits',
		'expense_splits_member_wg_same_tenant',
		'manawg_assert_expense_split_member_wg',
	],
	[
		'chore_completions',
		'chore_completions_member_wg_same_tenant',
		'manawg_assert_chore_completion_member_wg',
	],
	[
		'announcement_reactions',
		'announcement_reactions_member_wg_same_tenant',
		'manawg_assert_announcement_member_wg',
	],
	[
		'announcement_comments',
		'announcement_comments_member_wg_same_tenant',
		'manawg_assert_announcement_member_wg',
	],
	[
		'wg_inventory_log',
		'wg_inventory_log_member_wg_same_tenant',
		'manawg_assert_inventory_log_member_wg',
	],
	['wg_chat_reactions', 'wg_chat_reactions_member_wg_same_tenant', 'manawg_assert_chat_member_wg'],
	['wg_chat_mentions', 'wg_chat_mentions_member_wg_same_tenant', 'manawg_assert_chat_mention_wg'],
].map(([table_name, trigger_name, function_name]) => ({
	table_name,
	trigger_name,
	function_schema: 'public',
	function_name,
	trigger_enabled: 'O',
	trigger_type: 23,
	has_when: false,
	update_columns: '',
	arguments_hex: Buffer.from(
		(triggerArgs[table_name] ?? []).map((arg) => `${arg}\0`).join(''),
	).toString('hex'),
}));

const invariantFunctionNames = [
	'manawg_assert_member_belongs_to_wg',
	'manawg_assert_expense_split_member_wg',
	'manawg_assert_chore_completion_member_wg',
	'manawg_assert_announcement_member_wg',
	'manawg_assert_inventory_log_member_wg',
	'manawg_assert_chat_member_wg',
	'manawg_assert_chat_mention_wg',
];

function createCatalogClient({ schemaCreateRows = [], triggerRows = expectedTriggers } = {}) {
	const queries = [];
	return {
		queries,
		query: async (sql, params = []) => {
			queries.push({ sql: String(sql), params });
			const text = String(sql);
			if (text.includes('has_schema_privilege')) return { rows: schemaCreateRows };
			if (text.includes('rel.relrowsecurity')) {
				return {
					rows: params[1].map((table_name) => ({ table_name, rls_enabled: true })),
				};
			}
			if (text.includes('has_table_privilege')) return { rows: [] };
			if (text.includes('has_sequence_privilege')) return { rows: [] };
			if (text.includes('has_function_privilege')) return { rows: [] };
			if (text.includes('from pg_roles')) {
				return { rows: [{ rolname: 'anon' }, { rolname: 'authenticated' }] };
			}
			if (text.includes('pg_policies')) return { rows: [] };
			if (text.includes("rel.relkind in ('v', 'm')")) return { rows: [] };
			if (text.includes('pg_trigger')) {
				const names = params[1];
				return {
					rows: triggerRows.filter((row) => names.includes(row.trigger_name)),
				};
			}
			if (text.includes('proc.proname = any')) {
				return {
					rows: invariantFunctionNames.map((object_name) => ({
						object_name,
						security_definer: true,
						config: ['search_path=public'],
					})),
				};
			}
			if (text.includes('proc.prosecdef')) return { rows: [] };
			if (text.includes('aclexplode')) return { rows: [] };
			throw new Error(`unexpected catalog query: ${text.slice(0, 120)}`);
		},
	};
}

test('db:check uses effective schema privileges and rejects CREATE for API roles', async () => {
	assert.equal(typeof checker.assertCatalogSecurity, 'function');
	const client = createCatalogClient({
		schemaCreateRows: [{ role_name: 'anon' }, { role_name: 'authenticated' }],
	});

	await assert.rejects(
		checker.assertCatalogSecurity(client, [{ table: 'wgs' }]),
		/public schema CREATE privilege.*anon.*authenticated/,
	);

	const privilegeQuery = client.queries.find(({ sql }) => sql.includes('has_schema_privilege'));
	assert.ok(privilegeQuery, 'checker queries effective schema privileges');
	assert.deepEqual(privilegeQuery.params, [['anon', 'authenticated'], 'public']);
});

test('db:check includes durable private image revocations in the RLS catalog scope', async () => {
	const client = createCatalogClient();
	await checker.assertCatalogSecurity(client, [
		{ table: 'wgs' },
		{ table: 'private_image_deletions' },
	]);

	const rlsQuery = client.queries.find(({ sql }) => sql.includes('rel.relrowsecurity'));
	assert.deepEqual(rlsQuery.params, ['public', ['wgs', 'private_image_deletions']]);
});

test('db:check requests and accepts all 21 bindings enabled for normal sessions', async () => {
	assert.equal(typeof checker.assertCatalogSecurity, 'function');
	assert.equal(expectedTriggers.length, 21);
	const client = createCatalogClient({
		triggerRows: expectedTriggers.map((row) =>
			row.trigger_name === 'expenses_member_wg_same_tenant'
				? { ...row, trigger_enabled: 'A' }
				: row,
		),
	});

	await checker.assertCatalogSecurity(client, [{ table: 'wgs' }]);

	const triggerQuery = client.queries.find(({ sql }) => sql.includes('pg_trigger'));
	assert.ok(triggerQuery, 'checker reads trigger bindings from the catalog');
	assert.deepEqual(triggerQuery.params, [
		'public',
		expectedTriggers.map(({ trigger_name }) => trigger_name),
	]);
});

test('db:check rejects a missing invariant trigger binding', async () => {
	assert.equal(typeof checker.assertCatalogSecurity, 'function');
	const client = createCatalogClient({
		triggerRows: expectedTriggers.filter(
			({ trigger_name }) => trigger_name !== 'announcement_comments_member_wg_same_tenant',
		),
	});

	await assert.rejects(
		checker.assertCatalogSecurity(client, [{ table: 'wgs' }]),
		/announcement_comments_member_wg_same_tenant.*missing|missing.*announcement_comments_member_wg_same_tenant/,
	);
});

test('db:check rejects invariant triggers disabled or limited to replica sessions', async (t) => {
	for (const trigger_enabled of ['D', 'R']) {
		await t.test(`trigger state ${trigger_enabled}`, async () => {
			assert.equal(typeof checker.assertCatalogSecurity, 'function');
			const client = createCatalogClient({
				triggerRows: expectedTriggers.map((row) =>
					row.trigger_name === 'expenses_member_wg_same_tenant' ? { ...row, trigger_enabled } : row,
				),
			});

			await assert.rejects(
				checker.assertCatalogSecurity(client, [{ table: 'wgs' }]),
				/expenses_member_wg_same_tenant.*not enabled for normal sessions/,
			);
		});
	}
});

test('db:check rejects invariant triggers bound to the wrong table or function', async () => {
	assert.equal(typeof checker.assertCatalogSecurity, 'function');
	const client = createCatalogClient({
		triggerRows: expectedTriggers.map((row) =>
			row.trigger_name === 'expenses_member_wg_same_tenant'
				? { ...row, function_name: 'manawg_assert_chat_member_wg' }
				: row,
		),
	});

	await assert.rejects(
		checker.assertCatalogSecurity(client, [{ table: 'wgs' }]),
		/expenses_member_wg_same_tenant.*expected public\.expenses.*manawg_assert_member_belongs_to_wg/,
	);
});

test('db:check rejects incomplete trigger events, filters, and member arguments', async (t) => {
	for (const change of [
		{ trigger_type: 7 }, // BEFORE INSERT FOR EACH ROW, but no UPDATE
		{ has_when: true },
		{ update_columns: '2' },
		{ arguments_hex: '' },
	]) {
		await t.test(JSON.stringify(change), async () => {
			const client = createCatalogClient({
				triggerRows: expectedTriggers.map((row) =>
					row.table_name === 'expenses' ? { ...row, ...change } : row,
				),
			});
			await assert.rejects(
				checker.assertCatalogSecurity(client, [{ table: 'wgs' }]),
				/expenses_member_wg_same_tenant does not cover every inserted or updated row/,
			);
		});
	}
});
