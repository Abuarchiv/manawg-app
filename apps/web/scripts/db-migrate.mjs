#!/usr/bin/env node
/**
 * Apply pending Drizzle migrations, with one-time adoption of a database that
 * predates the migration chain.
 *
 * History: the schema used to be synced by hand with `drizzle-kit push`, so the
 * SQL files in `drizzle/` drifted into fiction — five tables never had a
 * CREATE TABLE, yet later files ran UPDATE and CREATE INDEX against them. The
 * chain could not replay on an empty database. It was replaced by a single
 * `0000_baseline.sql` generated from `schema.ts`, which is verified to replay
 * cleanly.
 *
 * That leaves one problem: the existing databases already have all 24 tables,
 * but their migration ledger does not record THIS baseline. Some are empty;
 * others may still carry rows of the superseded push-era chain. Either way,
 * running the baseline against them would fail on the first CREATE TABLE. So
 * when the schema is already present but the baseline hash is not yet in the
 * ledger, this script records the baseline as applied instead of executing
 * it — the standard "adopt an existing database" move.
 *
 * The ledger itself stays exact and fail-closed: every row must either match
 * the canonical journal by hash, timestamp, and prefix order, or match an
 * entry of LEGACY_LEDGER_ALLOWLIST by exact hash, timestamp, and canonical
 * journal position. Unknown rows — including arbitrary 64-hex values — are
 * rejected before any adoption. A legacy database must be reviewed and its
 * rows explicitly documented before it can be adopted.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const MIGRATIONS_SCHEMA = 'drizzle';
const MIGRATIONS_TABLE = '__drizzle_migrations';
/** Any table that only exists once the baseline has been applied. */
const SENTINEL_TABLE = 'wgs';
const BASELINE_TAG = '0000_baseline';
/**
 * Exact allowlist of reviewed historical ledger hashes. A later security fix
 * changed `0007_data_api_security.sql` after Preview had applied it, so the
 * database legitimately carries the old hash at the canonical migration
 * position. The position is zero-based within the current journal; an unknown
 * hash at any other position still fails closed.
 */
const LEGACY_LEDGER_ALLOWLIST = new Map([
	[
		'88916329fbe6f5e5f4e4174e5db393aa3d7c4516790c4dbf3d1a41301f335aa0',
		{ when: 1788112576655, position: 7 },
	],
	[
		'fb524f9b63dd0b63b84d8d1bf6d916781e7cc206682bf23bdd0106d9e9dbbb0e',
		{ when: 1788436085539, position: 10 },
	],
]);
const MIGRATION_LOCK = 'manawg:drizzle-migrate';
const PUBLIC_SCHEMA = 'public';
const PUBLIC_ROLES = ['anon', 'authenticated'];
const MEMBER_WG_INVARIANT_FUNCTIONS = [
	'manawg_assert_member_belongs_to_wg',
	'manawg_assert_expense_split_member_wg',
	'manawg_assert_chore_completion_member_wg',
	'manawg_assert_announcement_member_wg',
	'manawg_assert_inventory_log_member_wg',
	'manawg_assert_chat_member_wg',
	'manawg_assert_chat_mention_wg',
];
// Keep the catalog contract explicit so a removed migration trigger fails closed.
const MEMBER_WG_INVARIANT_TRIGGERS = [
	[
		'expenses',
		'expenses_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['paid_by_member_id'],
	],
	[
		'expense_imports',
		'expense_imports_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['imported_by_member_id'],
	],
	[
		'expense_payments',
		'expense_payments_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['from_member_id', 'to_member_id'],
	],
	[
		'shopping_items',
		'shopping_items_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['added_by_member_id', 'bought_by_member_id'],
	],
	[
		'announcements',
		'announcements_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['author_member_id', 'resolved_by_member_id'],
	],
	[
		'chores',
		'chores_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['assigned_member_id'],
	],
	[
		'member_absences',
		'member_absences_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['member_id'],
	],
	[
		'recurring_expenses',
		'recurring_expenses_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['created_by_member_id', 'paid_by_member_id'],
	],
	[
		'wg_events',
		'wg_events_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['created_by_member_id'],
	],
	[
		'calendar_subscriptions',
		'calendar_subscriptions_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['member_id'],
	],
	[
		'expense_reminders',
		'expense_reminders_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['debtor_member_id', 'creditor_member_id', 'sent_by_member_id'],
	],
	[
		'audit_events',
		'audit_events_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['member_id'],
	],
	[
		'wg_chat_messages',
		'wg_chat_messages_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['sender_member_id'],
	],
	[
		'wg_chat_reads',
		'wg_chat_reads_member_wg_same_tenant',
		'manawg_assert_member_belongs_to_wg',
		['member_id'],
	],
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
].map(([table_name, trigger_name, function_name, args = []]) => ({
	table_name,
	trigger_name,
	function_name,
	args,
}));
const ALLOWED_SECURITY_DEFINER_FUNCTIONS = new Set(MEMBER_WG_INVARIANT_FUNCTIONS);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(scriptDir, '..', 'drizzle');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);
let currentStage = 'startup';

export function validateDatabaseUrl(url, label) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${label} is not a valid URL.`);
	}
	if (parsed.port === '6543') {
		throw new Error(
			`${label} must not use port 6543 (Supavisor Transaction Pooler). Use port 5432 or omit the port for local/Direct connections.`,
		);
	}
	if ([...parsed.searchParams.keys()].some((key) => key !== 'sslmode')) {
		throw new Error(`${label} must not include unsupported PostgreSQL query parameters.`);
	}
	if (parsed.searchParams.getAll('sslmode').length > 1) {
		throw new Error(`${label} must specify sslmode at most once.`);
	}
	const host = parsed.hostname.toLowerCase();
	const isLocal = LOCAL_HOSTS.has(host) || host.endsWith('.local');
	if (!isLocal && !parsed.port) {
		throw new Error(`${label} must specify a port for remote connections.`);
	}
	if (!isLocal) {
		const sslmode = parsed.searchParams.get('sslmode')?.toLowerCase();
		if (!['require', 'verify-ca', 'verify-full'].includes(sslmode ?? '')) {
			throw new Error(
				`${label} must require TLS for remote connections (sslmode=require, verify-ca, or verify-full).`,
			);
		}
	}
}

function validateSupabaseDirectUrl(url, label) {
	validateDatabaseUrl(url, label);
	const parsed = new URL(url);
	if (
		!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
		!parsed.hostname.toLowerCase().endsWith('.supabase.co') ||
		parsed.port !== '5432'
	) {
		throw new Error(`${label} must be a direct Supabase PostgreSQL connection on port 5432.`);
	}
}

/** Explicit CI transport for the pinned Preview verifier; never a Production fallback. */
export function previewSessionDatabaseUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Preview CI database configuration is invalid.');
	}
	if (
		!['postgres:', 'postgresql:'].includes(url.protocol) ||
		url.hostname !== 'db.sthiwjebcwwiphashgla.supabase.co' ||
		url.port !== '5432' ||
		url.pathname !== '/postgres' ||
		url.username !== 'manawg_preview_ci' ||
		!url.password ||
		url.hash ||
		url.searchParams.size !== 1 ||
		url.searchParams.get('sslmode') !== 'verify-full'
	) {
		throw new Error('Preview CI requires its pinned verifier connection with verified TLS.');
	}
	url.hostname = 'aws-0-eu-central-1.pooler.supabase.com';
	url.username = 'manawg_preview_ci.sthiwjebcwwiphashgla';
	return url.href;
}

/**
 * Turn a Neon pooled host into its direct one. Neon's pooled endpoint is the
 * direct endpoint with a `-pooler` label inserted:
 *   ep-xxx-pooler.region.aws.neon.tech  ->  ep-xxx.region.aws.neon.tech
 * A URL that has no such label (a non-Neon or already-direct host) is returned
 * untouched.
 */
function toDirectEndpoint(url) {
	try {
		const parsed = new URL(url);
		parsed.hostname = parsed.hostname.replace(/-pooler\./, '.');
		return parsed.toString();
	} catch {
		return url;
	}
}

function resolveConnectionString() {
	const migrationUrl = process.env.DATABASE_MIGRATION_URL;
	if (migrationUrl) {
		validateDatabaseUrl(migrationUrl, 'DATABASE_MIGRATION_URL');
		return migrationUrl;
	}

	const pooled = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
	if (pooled) {
		const direct = toDirectEndpoint(pooled);
		validateDatabaseUrl(direct, 'POSTGRES_URL/DATABASE_URL');
		return direct;
	}

	const direct = process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL_UNPOOLED;
	if (direct) {
		validateDatabaseUrl(direct, 'POSTGRES_URL_NON_POOLING/DATABASE_URL_UNPOOLED');
		return direct;
	}

	throw new Error('No database URL. Set DATABASE_MIGRATION_URL, POSTGRES_URL or DATABASE_URL.');
}

function readMigrationJournal() {
	const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
	const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
	if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
		throw new Error('Migration journal must contain entries.');
	}

	const tags = new Set();
	let previousWhen = -1;
	for (const [index, entry] of journal.entries.entries()) {
		if (!Number.isInteger(entry.idx) || entry.idx !== index) {
			throw new Error(`Migration journal entry ${index} must use contiguous idx ${index}.`);
		}
		if (
			typeof entry.tag !== 'string' ||
			!/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
			tags.has(entry.tag) ||
			!fs.existsSync(path.join(migrationsFolder, `${entry.tag}.sql`))
		) {
			throw new Error(
				`Migration journal entry ${index} has an invalid, duplicate, or missing SQL tag.`,
			);
		}
		if (!Number.isSafeInteger(entry.when) || entry.when <= previousWhen) {
			throw new Error(
				`Migration journal entry ${entry.tag} must have a unique increasing timestamp.`,
			);
		}
		tags.add(entry.tag);
		previousWhen = entry.when;
	}
	const sqlTags = fs
		.readdirSync(migrationsFolder)
		.filter((file) => file.endsWith('.sql'))
		.map((file) => file.slice(0, -'.sql'.length));
	if (sqlTags.length !== tags.size || sqlTags.some((tag) => !tags.has(tag))) {
		throw new Error('Migration journal must list every SQL migration exactly once.');
	}
	return journal;
}

function readJournalEntry(tag) {
	const journal = readMigrationJournal();
	const entry = journal.entries.find((it) => it.tag === tag);
	if (!entry) throw new Error(`Journal has no entry tagged "${tag}".`);
	return entry;
}

/** Must match drizzle's own hash: sha256 over the raw file contents. */
function hashMigration(tag) {
	const sql = fs.readFileSync(path.join(migrationsFolder, `${tag}.sql`), 'utf8');
	return crypto.createHash('sha256').update(sql).digest('hex');
}

async function tableExists(client, schema, table) {
	const { rows } = await client.query(
		`select 1
		 from pg_catalog.pg_class as c
		 join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
		 where n.nspname = $1
		   and c.relname = $2
		   and c.relkind in ('r', 'p')`,
		[schema, table],
	);
	return rows.length > 0;
}

function latestAvailableSnapshotTag() {
	const snapshots = fs
		.readdirSync(path.join(migrationsFolder, 'meta'))
		.map((file) => {
			const match = /^(\d+)_snapshot\.json$/.exec(file);
			return match ? { number: Number(match[1]), tag: file.slice(0, -'.json'.length) } : null;
		})
		.filter(Boolean)
		.sort((left, right) => left.number - right.number);
	const latest = snapshots.at(-1);
	if (!latest) throw new Error('Database check failed: no migration snapshot is available.');
	return latest.tag;
}

function expectedSchema(snapshotTag) {
	const snapshotNumber = snapshotTag.split('_', 1)[0];
	const snapshotPath = path.join(migrationsFolder, 'meta', `${snapshotNumber}_snapshot.json`);
	const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
	return Object.entries(snapshot.tables)
		.filter(([name]) => name.startsWith('public.'))
		.map(([name, table]) => ({
			table: name.slice('public.'.length),
			columns: table.columns,
			indexes: table.indexes,
			foreignKeys: table.foreignKeys,
			compositePrimaryKeys: table.compositePrimaryKeys,
			uniqueConstraints: table.uniqueConstraints,
			checkConstraints: table.checkConstraints,
		}));
}

export function expectedBaselineSchema() {
	return expectedSchema(BASELINE_TAG);
}

const normalizeSql = (value) =>
	String(value ?? '')
		.toLowerCase()
		.replace(/"([^"\n]+)"/g, '$1')
		.replace(/::[a-z ]+(?:\[\])?/g, '')
		.replace(/\s+/g, '');

const normalizeType = (type) => normalizeSql(type).replace('charactervarying', 'varchar');
const normalizeDefault = (value) => normalizeSql(value).replace(/^\((.*)\)$/, '$1');
const normalizeCheck = (value, tableName) =>
	normalizeSql(value)
		.replace(/notvalid/g, '')
		.replace(/^check\((.*)\)$/, '$1')
		.replaceAll(`${tableName}.`, '')
		.replace(/(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)in\(([^)]*)\)/g, '$1=any(array[$2])')
		.replace(/[()]/g, '');
const sameColumns = (actual, expected) => actual?.join('\u0000') === expected.join('\u0000');
const foreignKeyAction = {
	a: 'no action',
	r: 'restrict',
	c: 'cascade',
	n: 'set null',
	d: 'set default',
};
const normalizeIndexPart = (value) =>
	String(value ?? '')
		.toLowerCase()
		.replace(/"([^"\n]+)"/g, '$1')
		.replace(/(?:public\.)?[a-z_][a-z0-9_]*\./g, '')
		.replace(/[()]/g, '')
		.replace(/\s+/g, '')
		.replace(/nullslast/g, '');
const expectedIndexKeys = (index) =>
	index.columns.map(({ expression, asc, nulls }) =>
		normalizeIndexPart(
			`${expression}${asc ? '' : ' DESC'}${nulls === 'first' ? ' NULLS FIRST' : ''}`,
		),
	);

const ADOPTION_KNOWN_DRIFT = {
	columnNullability: new Set(['shopping_items.normalized_name']),
	columnDefaults: new Set(['expense_reminders.channel']),
	constraints: new Set(['c.expense_reminders.expense_reminders_channel_check']),
	extraColumns: new Set(['push_subscriptions.last_used_at']),
};

const LEGACY_DATA_CHECKS = [
	[
		'announcements.kind',
		`select count(*)::int as count from public.announcements where kind not in ('info', 'question', 'problem', 'request', 'decision')`,
	],
	[
		'announcements.status',
		`select count(*)::int as count from public.announcements where status not in ('open', 'resolved')`,
	],
	[
		'announcements.source',
		`select count(*)::int as count from public.announcements where source not in ('manual', 'system', 'chore_swap', 'expense', 'shopping')`,
	],
	[
		'chores.recurrence_type',
		`select count(*)::int as count from public.chores where recurrence_type not in ('days', 'months')`,
	],
	[
		'expense_splits.amount_cents',
		'select count(*)::int as count from public.expense_splits where amount_cents < 0',
	],
	[
		'expenses.amount_cents',
		'select count(*)::int as count from public.expenses where amount_cents <= 0',
	],
	[
		'wg_chat_messages.kind',
		`select count(*)::int as count from public.wg_chat_messages where kind not in ('text', 'image', 'system')`,
	],
];

async function assertExpectedSchema(
	client,
	snapshotTag,
	failurePrefix,
	{ allowKnownAdoptionDrift = false, rejectUnexpected = false } = {},
) {
	const { rows: columnRows } =
		await client.query(`select rel.relname as table_name, attr.attname as column_name,
		format_type(attr.atttypid, attr.atttypmod) as type, attr.attnotnull as not_null,
		pg_get_expr(def.adbin, def.adrelid) as default_expr, case when attr.attgenerated = 's' then 's' else '' end as generated,
		case when attr.attgenerated = '' then null else pg_get_expr(def.adbin, def.adrelid) end as generation_expr
		from pg_attribute attr join pg_class rel on rel.oid = attr.attrelid
		join pg_namespace ns on ns.oid = rel.relnamespace left join pg_attrdef def on def.adrelid = rel.oid and def.adnum = attr.attnum
		where ns.nspname = 'public' and rel.relkind in ('r', 'p') and attr.attnum > 0 and not attr.attisdropped`);
	const { rows: constraintRows } =
		await client.query(`select con.conname as constraint_name, con.contype as constraint_type, con.convalidated as is_valid, rel.relname as table_name,
		array(select attr.attname::text from unnest(con.conkey) with ordinality as key(attnum, ord) join pg_attribute attr on attr.attrelid = con.conrelid and attr.attnum = key.attnum order by key.ord) as columns,
		foreign_rel.relname as foreign_table_name, foreign_ns.nspname as foreign_schema,
		array(select attr.attname::text from unnest(con.confkey) with ordinality as key(attnum, ord) join pg_attribute attr on attr.attrelid = con.confrelid and attr.attnum = key.attnum order by key.ord) as foreign_columns,
		con.confdeltype as delete_action, con.confupdtype as update_action, pg_get_constraintdef(con.oid, true) as definition
		from pg_constraint con join pg_class rel on rel.oid = con.conrelid join pg_namespace ns on ns.oid = rel.relnamespace
		left join pg_class foreign_rel on foreign_rel.oid = con.confrelid left join pg_namespace foreign_ns on foreign_ns.oid = foreign_rel.relnamespace
		where ns.nspname = 'public' and con.contype in ('p', 'u', 'c', 'f')`);
	const { rows: indexRows } =
		await client.query(`select rel.relname as table_name, index_rel.relname as index_name, idx.indisunique as is_unique,
		idx.indisvalid as is_valid, idx.indisready as is_ready, method.amname as method,
		array(select pg_get_indexdef(idx.indexrelid, position, true) ||
				case when (idx.indoption[position - 1] & 1) = 1 then ' desc' else '' end ||
				case when (idx.indoption[position - 1] & 2) = 2 then ' nulls first' else '' end
			from generate_series(1, idx.indnkeyatts) as position) as keys,
		pg_get_expr(idx.indpred, idx.indrelid, true) as predicate
		from pg_index idx join pg_class rel on rel.oid = idx.indrelid join pg_class index_rel on index_rel.oid = idx.indexrelid
		join pg_namespace ns on ns.oid = rel.relnamespace join pg_am method on method.oid = index_rel.relam
		where ns.nspname = 'public' and not exists (select 1 from pg_constraint con where con.conindid = idx.indexrelid)`);

	const expected = expectedSchema(snapshotTag);
	const requireValidatedConstraints = Number(snapshotTag.split('_', 1)[0]) >= 9;
	const columns = new Map(columnRows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
	const expectedTables = new Set(expected.map(({ table }) => table));
	const expectedColumns = new Map(
		expected.flatMap((table) =>
			Object.values(table.columns).map((column) => [`${table.table}.${column.name}`, column]),
		),
	);
	const mismatches = [];
	if (rejectUnexpected) {
		for (const tableName of new Set(columnRows.map((row) => row.table_name))) {
			if (!expectedTables.has(tableName)) mismatches.push(`unexpected table public.${tableName}`);
		}
		for (const [key] of columns) {
			const [tableName, columnName] = key.split('.');
			if (
				expectedTables.has(tableName) &&
				!expectedColumns.has(key) &&
				!(
					allowKnownAdoptionDrift &&
					ADOPTION_KNOWN_DRIFT.extraColumns.has(`${tableName}.${columnName}`)
				)
			) {
				mismatches.push(`unexpected column public.${key}`);
			}
		}
	}
	for (const table of expected) {
		for (const column of Object.values(table.columns)) {
			const actual = columns.get(`${table.table}.${column.name}`);
			if (!actual) {
				mismatches.push(`column public.${table.table}.${column.name}`);
				continue;
			}
			if (normalizeType(actual.type) !== normalizeType(column.type)) {
				mismatches.push(`column public.${table.table}.${column.name} type`);
			}
			if (
				actual.not_null !== column.notNull &&
				!(
					allowKnownAdoptionDrift &&
					ADOPTION_KNOWN_DRIFT.columnNullability.has(`${table.table}.${column.name}`)
				)
			)
				mismatches.push(`column public.${table.table}.${column.name} nullability`);
			if (
				!column.generated &&
				normalizeDefault(actual.default_expr) !== normalizeDefault(column.default) &&
				!(
					allowKnownAdoptionDrift &&
					ADOPTION_KNOWN_DRIFT.columnDefaults.has(`${table.table}.${column.name}`)
				)
			) {
				mismatches.push(`column public.${table.table}.${column.name} default`);
			}
			if ((actual.generated === 's') !== Boolean(column.generated)) {
				mismatches.push(`column public.${table.table}.${column.name} generation`);
			} else if (
				column.generated &&
				normalizeSql(actual.generation_expr) !== normalizeSql(column.generated.as)
			) {
				mismatches.push(`column public.${table.table}.${column.name} generation expression`);
			}
		}
	}

	const constraints = new Map(
		constraintRows.map((row) => [
			`${row.constraint_type}.${row.table_name}.${row.constraint_name}`,
			row,
		]),
	);
	if (rejectUnexpected) {
		const expectedNamedConstraints = new Set(
			expected.flatMap((table) => [
				...Object.values(table.compositePrimaryKeys).map(
					(constraint) => `p.${table.table}.${constraint.name}`,
				),
				...Object.values(table.uniqueConstraints).map(
					(constraint) => `u.${table.table}.${constraint.name}`,
				),
				...Object.values(table.checkConstraints).map(
					(constraint) => `c.${table.table}.${constraint.name}`,
				),
				...Object.values(table.foreignKeys).map(
					(constraint) => `f.${table.table}.${constraint.name}`,
				),
			]),
		);
		for (const row of constraintRows) {
			const key = `${row.constraint_type}.${row.table_name}.${row.constraint_name}`;
			const isExpectedSinglePrimaryKey =
				row.constraint_type === 'p' &&
				expected.some(
					(table) =>
						table.table === row.table_name &&
						Object.values(table.columns).some(
							(column) => column.primaryKey && sameColumns(row.columns, [column.name]),
						),
				);
			if (
				!expectedTables.has(row.table_name) ||
				(!expectedNamedConstraints.has(key) &&
					!isExpectedSinglePrimaryKey &&
					!(allowKnownAdoptionDrift && ADOPTION_KNOWN_DRIFT.constraints.has(key)))
			) {
				mismatches.push(`unexpected constraint public.${row.table_name}.${row.constraint_name}`);
			}
		}
	}
	const primaryKeys = constraintRows.filter((row) => row.constraint_type === 'p');
	const findConstraint = (type, table, name) => constraints.get(`${type}.${table}.${name}`);
	for (const table of expected) {
		for (const column of Object.values(table.columns)) {
			if (
				column.primaryKey &&
				!primaryKeys.some(
					(row) =>
						row.table_name === table.table &&
						row.is_valid === true &&
						sameColumns(row.columns, [column.name]),
				)
			) {
				mismatches.push(`primary key public.${table.table}.${column.name}`);
			}
		}
		for (const constraint of Object.values(table.compositePrimaryKeys)) {
			const actual = findConstraint('p', table.table, constraint.name);
			if (!actual || actual.is_valid !== true || !sameColumns(actual.columns, constraint.columns))
				mismatches.push(`primary key public.${table.table}.${constraint.name}`);
		}
		for (const constraint of Object.values(table.uniqueConstraints)) {
			const actual = findConstraint('u', table.table, constraint.name);
			if (!actual || actual.is_valid !== true || !sameColumns(actual.columns, constraint.columns))
				mismatches.push(`unique constraint public.${table.table}.${constraint.name}`);
		}
		for (const constraint of Object.values(table.checkConstraints)) {
			const actual = findConstraint('c', table.table, constraint.name);
			const mismatch =
				!actual ||
				(requireValidatedConstraints && actual.is_valid !== true) ||
				normalizeCheck(actual.definition, table.table) !==
					normalizeCheck(constraint.value, table.table);
			if (
				mismatch &&
				!(
					allowKnownAdoptionDrift &&
					ADOPTION_KNOWN_DRIFT.constraints.has(`c.${table.table}.${constraint.name}`)
				)
			)
				mismatches.push(`check constraint public.${table.table}.${constraint.name}`);
		}
		for (const foreignKey of Object.values(table.foreignKeys)) {
			const actual = findConstraint('f', table.table, foreignKey.name);
			if (
				!actual ||
				actual.is_valid !== true ||
				!sameColumns(actual.columns, foreignKey.columnsFrom) ||
				actual.foreign_table_name !== foreignKey.tableTo ||
				actual.foreign_schema !== 'public' ||
				!sameColumns(actual.foreign_columns, foreignKey.columnsTo) ||
				(foreignKeyAction[actual.delete_action] ?? actual.delete_action) !== foreignKey.onDelete ||
				(foreignKeyAction[actual.update_action] ?? actual.update_action) !== foreignKey.onUpdate
			) {
				mismatches.push(`foreign key public.${table.table}.${foreignKey.name}`);
			}
		}
	}

	const indexes = new Map(indexRows.map((row) => [`${row.table_name}.${row.index_name}`, row]));
	for (const table of expected) {
		for (const index of Object.values(table.indexes)) {
			const actual = indexes.get(`${table.table}.${index.name}`);
			if (
				!actual ||
				actual.is_valid !== true ||
				actual.is_ready !== true ||
				actual.is_unique !== index.isUnique ||
				actual.method !== index.method ||
				!sameColumns(actual.keys?.map(normalizeIndexPart), expectedIndexKeys(index)) ||
				normalizeCheck(actual.predicate, table.table) !== normalizeCheck(index.where, table.table)
			) {
				mismatches.push(`index public.${table.table}.${index.name}`);
			}
		}
	}

	if (mismatches.length) {
		throw new Error(`${failurePrefix} Mismatches: ${mismatches.join(', ')}.`);
	}
}

export async function assertBaselineSchema(client) {
	return assertExpectedSchema(
		client,
		BASELINE_TAG,
		`Refusing to adopt ${BASELINE_TAG}: baseline schema is incomplete. Apply or repair the baseline before retrying.`,
		{ allowKnownAdoptionDrift: true, rejectUnexpected: true },
	);
}

export async function assertMigrationLedgerPrefix(client, { requireTable = true } = {}) {
	if (!(await tableExists(client, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE))) {
		if (requireTable)
			throw new Error('Database check failed: Drizzle migration ledger is missing.');
		return { entries: readMigrationJournal().entries, appliedCount: 0 };
	}
	const { rows } = await client.query(
		`select id, hash, created_at from ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} order by id asc`,
	);
	const { entries } = readMigrationJournal();
	const canonicalEntries = entries.map((entry) => ({
		...entry,
		hash: hashMigration(entry.tag),
	}));
	const expectedByHash = new Map();
	for (const entry of canonicalEntries) {
		if (expectedByHash.has(entry.hash)) {
			throw new Error(`Migration journal has duplicate hash for ${entry.tag}.`);
		}
		expectedByHash.set(entry.hash, entry);
	}
	const appliedHashes = new Set();
	let appliedCount = 0;
	for (const row of rows) {
		const hash = typeof row.hash === 'string' ? row.hash : '';
		const createdAt = String(row.created_at ?? '');
		if (!/^[a-f0-9]{64}$/.test(hash)) {
			throw new Error(`Database check failed: invalid migration hash in ledger row ${row.id}.`);
		}
		if (!/^\d+$/.test(createdAt)) {
			throw new Error(
				`Database check failed: invalid migration timestamp in ledger row ${row.id}.`,
			);
		}

		const entry = expectedByHash.get(hash);
		if (!entry) {
			// Fail-closed: LEGACY_LEDGER_ALLOWLIST documents every tolerated
			// historical row by exact hash, timestamp, and canonical journal
			// position. Any unknown row — including arbitrary 64-hex values —
			// is rejected here and never adopted.
			const legacy = LEGACY_LEDGER_ALLOWLIST.get(hash);
			if (
				!legacy ||
				createdAt !== String(legacy.when) ||
				appliedCount !== Number(legacy.position)
			) {
				throw new Error(
					`Database check failed: unexpected migration row ${row.id} outside the canonical ledger (hash ${hash}, created_at ${createdAt}).`,
				);
			}
			if (appliedHashes.has(hash)) {
				throw new Error(`Database check failed: duplicate legacy migration row ${row.id}.`);
			}
			appliedHashes.add(hash);
			appliedCount += 1;
			continue;
		}
		if (appliedHashes.has(hash)) {
			throw new Error(`Database check failed: duplicate migration ${entry.tag}.`);
		}
		const expectedEntry = canonicalEntries[appliedCount];
		if (entry !== expectedEntry) {
			throw new Error(
				`Database check failed: migration ledger is not a canonical prefix; expected ${expectedEntry?.tag ?? 'no further migration'} before ${entry.tag}.`,
			);
		}
		if (createdAt !== String(entry.when)) {
			throw new Error(`Database check failed: timestamp mismatch for migration ${entry.tag}.`);
		}
		appliedHashes.add(hash);
		appliedCount += 1;
	}
	return { entries, appliedCount };
}

async function assertMigrationLedger(client) {
	const { entries, appliedCount } = await assertMigrationLedgerPrefix(client);
	if (appliedCount !== entries.length) {
		throw new Error(
			`Database check failed: migration ledger is incomplete; missing migrations ${entries
				.slice(appliedCount)
				.map(({ tag }) => tag)
				.join(', ')}.`,
		);
	}
}

export async function assertCatalogSecurity(client, expectedTables) {
	const roleResult = await client.query(
		'select rolname from pg_roles where rolname = any($1::name[])',
		[PUBLIC_ROLES],
	);
	const presentRoles = new Set(roleResult.rows.map(({ rolname }) => rolname));
	const missingRoles = PUBLIC_ROLES.filter((role) => !presentRoles.has(role));
	if (missingRoles.length) {
		throw new Error(
			`Database check failed: required Supabase roles are missing: ${missingRoles.join(', ')}.`,
		);
	}
	const { rows: schemaCreatePrivileges } = await client.query(
		// has_schema_privilege includes effective grants inherited from PUBLIC and role memberships.
		`select grantee.rolname as role_name
		 from pg_roles grantee cross join pg_namespace ns
		 where grantee.rolname = any($1::name[])
		   and ns.nspname = $2
		   and has_schema_privilege(grantee.oid, ns.oid, 'CREATE')`,
		[PUBLIC_ROLES, PUBLIC_SCHEMA],
	);
	const schemaCreateRoles = PUBLIC_ROLES.filter((role) =>
		schemaCreatePrivileges.some(({ role_name }) => role_name === role),
	);
	if (schemaCreateRoles.length) {
		throw new Error(
			`Database check failed: public schema CREATE privilege must be empty for anon/authenticated roles; granted effectively to ${schemaCreateRoles.join(', ')}.`,
		);
	}

	const expectedTableNames = expectedTables.map(({ table }) => table);
	const { rows: rlsRows } = await client.query(
		`select rel.relname as table_name, rel.relrowsecurity as rls_enabled
		 from pg_class rel
		 join pg_namespace ns on ns.oid = rel.relnamespace
		 where ns.nspname = $1 and rel.relname = any($2::name[]) and rel.relkind in ('r', 'p')`,
		[PUBLIC_SCHEMA, expectedTableNames],
	);
	const rlsByTable = new Map(rlsRows.map((row) => [row.table_name, row.rls_enabled]));
	const rlsMismatches = expectedTableNames
		.filter((table) => rlsByTable.get(table) !== true)
		.map((table) => `public.${table}${rlsByTable.has(table) ? ' RLS disabled' : ' table missing'}`);
	if (rlsMismatches.length) {
		throw new Error(
			`Database check failed: RLS requirements not met: ${rlsMismatches.join(', ')}.`,
		);
	}

	const { rows: tablePrivileges } = await client.query(
		`select role_name, object_name, privileges
		 from (
			select grantee.rolname as role_name, rel.relname as object_name,
				array(
					select privilege_values.privilege_name
					from unnest($2::text[]) as privilege_values(privilege_name)
					where has_table_privilege(grantee.rolname, rel.oid, privilege_values.privilege_name)
				) as privileges
			from pg_roles grantee
			cross join pg_class rel
			join pg_namespace ns on ns.oid = rel.relnamespace
			where grantee.rolname = any($1::name[]) and ns.nspname = $3 and rel.relkind in ('r', 'p')
		 ) grants
		 where cardinality(privileges) > 0`,
		[
			PUBLIC_ROLES,
			['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
			PUBLIC_SCHEMA,
		],
	);
	const { rows: sequencePrivileges } = await client.query(
		`select role_name, object_name, privileges
		 from (
			select grantee.rolname as role_name, rel.relname as object_name,
				array(
					select privilege_values.privilege_name
					from unnest($2::text[]) as privilege_values(privilege_name)
					where has_sequence_privilege(grantee.rolname, rel.oid, privilege_values.privilege_name)
				) as privileges
			from pg_roles grantee
			cross join pg_class rel
			join pg_namespace ns on ns.oid = rel.relnamespace
			where grantee.rolname = any($1::name[]) and ns.nspname = $3 and rel.relkind = 'S'
		 ) grants
		 where cardinality(privileges) > 0`,
		[PUBLIC_ROLES, ['USAGE', 'SELECT', 'UPDATE'], PUBLIC_SCHEMA],
	);
	const { rows: functionPrivileges } = await client.query(
		`select role_name, object_name, privileges
		 from (
			select grantee.rolname as role_name,
				format('%s(%s)', proc.proname, pg_get_function_identity_arguments(proc.oid)) as object_name,
				array(
					select privilege_values.privilege_name
					from unnest($2::text[]) as privilege_values(privilege_name)
					where has_function_privilege(grantee.rolname, proc.oid, privilege_values.privilege_name)
				) as privileges
			from pg_roles grantee
			cross join pg_proc proc
			join pg_namespace ns on ns.oid = proc.pronamespace
			where grantee.rolname = any($1::name[]) and ns.nspname = $3
		 ) grants
		 where cardinality(privileges) > 0`,
		[PUBLIC_ROLES, ['EXECUTE'], PUBLIC_SCHEMA],
	);
	const privilegeMismatches = [
		...tablePrivileges.map(
			({ role_name, object_name, privileges }) =>
				`${role_name} has ${privileges.join(', ')} on public table ${object_name}`,
		),
		...sequencePrivileges.map(
			({ role_name, object_name, privileges }) =>
				`${role_name} has ${privileges.join(', ')} on public sequence ${object_name}`,
		),
		...functionPrivileges.map(
			({ role_name, object_name, privileges }) =>
				`${role_name} has ${privileges.join(', ')} on public function ${object_name}`,
		),
	];
	if (privilegeMismatches.length) {
		throw new Error(
			`Database check failed: public role privileges must be empty: ${privilegeMismatches.join('; ')}.`,
		);
	}

	const { rows: policies } = await client.query(
		'select policyname, tablename from pg_policies where schemaname = $1',
		[PUBLIC_SCHEMA],
	);
	const { rows: views } = await client.query(
		`select relname as object_name, case relkind when 'v' then 'view' when 'm' then 'materialized view' end as object_type
		 from pg_class rel join pg_namespace ns on ns.oid = rel.relnamespace
		 where ns.nspname = $1 and rel.relkind in ('v', 'm')`,
		[PUBLIC_SCHEMA],
	);
	const { rows: securityDefiners } = await client.query(
		`select proc.proname as object_name, pg_get_function_identity_arguments(proc.oid) as arguments
		 from pg_proc proc join pg_namespace ns on ns.oid = proc.pronamespace
		 where ns.nspname = $1 and proc.prosecdef`,
		[PUBLIC_SCHEMA],
	);
	const { rows: executablePublicFunctions } = await client.query(
		`select proc.proname as object_name, pg_get_function_identity_arguments(proc.oid) as arguments
		 from pg_proc proc join pg_namespace ns on ns.oid = proc.pronamespace
		 where ns.nspname = $1
		   and (proc.proacl is null or exists (
			 select 1 from aclexplode(proc.proacl) privilege
			 where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
		   ))`,
		[PUBLIC_SCHEMA],
	);
	const { rows: invariantFunctions } = await client.query(
		`select proc.proname as object_name,
				proc.prosecdef as security_definer,
				coalesce(proc.proconfig, array[]::text[]) as config
		 from pg_proc proc join pg_namespace ns on ns.oid = proc.pronamespace
		 where ns.nspname = $1 and proc.proname = any($2::name[])`,
		[PUBLIC_SCHEMA, MEMBER_WG_INVARIANT_FUNCTIONS],
	);
	const invariantByName = new Map(
		invariantFunctions.map((functionRow) => [functionRow.object_name, functionRow]),
	);
	const invariantMismatches = MEMBER_WG_INVARIANT_FUNCTIONS.flatMap((name) => {
		const functionRow = invariantByName.get(name);
		if (!functionRow) return [`missing public invariant function ${name}()`];
		const mismatches = [];
		if (functionRow.security_definer !== true) {
			mismatches.push(`public invariant function ${name}() is not SECURITY DEFINER`);
		}
		if (!functionRow.config.includes('search_path=public')) {
			mismatches.push(`public invariant function ${name}() has an unsafe search_path`);
		}
		return mismatches;
	});
	const { rows: invariantTriggers } = await client.query(
		`select rel.relname as table_name, trg.tgname as trigger_name,
			function_ns.nspname as function_schema, proc.proname as function_name,
			trg.tgenabled as trigger_enabled, trg.tgtype as trigger_type,
			trg.tgqual is not null as has_when, trg.tgattr::text as update_columns,
			encode(trg.tgargs, 'hex') as arguments_hex
		 from pg_trigger trg
		 join pg_class rel on rel.oid = trg.tgrelid
		 join pg_namespace table_ns on table_ns.oid = rel.relnamespace
		 join pg_proc proc on proc.oid = trg.tgfoid
		 join pg_namespace function_ns on function_ns.oid = proc.pronamespace
		 where table_ns.nspname = $1
		   and trg.tgname = any($2::name[])
		   and not trg.tgisinternal`,
		[PUBLIC_SCHEMA, MEMBER_WG_INVARIANT_TRIGGERS.map(({ trigger_name }) => trigger_name)],
	);
	const triggersByName = new Map();
	for (const trigger of invariantTriggers) {
		const matches = triggersByName.get(trigger.trigger_name) ?? [];
		matches.push(trigger);
		triggersByName.set(trigger.trigger_name, matches);
	}
	const triggerMismatches = MEMBER_WG_INVARIANT_TRIGGERS.flatMap((expected) => {
		const actual = triggersByName.get(expected.trigger_name) ?? [];
		if (actual.length === 0) {
			return [`missing public.${expected.table_name}.${expected.trigger_name} trigger`];
		}
		if (actual.length > 1) {
			return [`public trigger ${expected.trigger_name} has multiple catalog bindings`];
		}
		const [trigger] = actual;
		const mismatches = [];
		if (
			trigger.table_name !== expected.table_name ||
			trigger.function_schema !== PUBLIC_SCHEMA ||
			trigger.function_name !== expected.function_name
		) {
			mismatches.push(
				`public trigger ${expected.trigger_name} is bound to ${trigger.function_schema}.${trigger.table_name} -> ${trigger.function_name}; expected public.${expected.table_name} -> public.${expected.function_name}`,
			);
		}
		// O fires in normal origin sessions; A fires in every session. R and D do not.
		if (!['O', 'A'].includes(trigger.trigger_enabled)) {
			mismatches.push(
				`public trigger ${expected.trigger_name} is not enabled for normal sessions (state ${trigger.trigger_enabled})`,
			);
		}
		const expectedArguments = Buffer.from(expected.args.map((arg) => `${arg}\0`).join('')).toString(
			'hex',
		);
		if (
			trigger.trigger_type !== 23 || // ROW + BEFORE + INSERT + UPDATE
			trigger.has_when !== false ||
			trigger.update_columns !== '' ||
			trigger.arguments_hex !== expectedArguments
		) {
			mismatches.push(
				`public trigger ${expected.trigger_name} does not cover every inserted or updated row with the expected member columns`,
			);
		}
		return mismatches;
	});
	if (triggerMismatches.length) {
		throw new Error(
			`Database check failed: member/WG invariant trigger requirements not met: ${triggerMismatches.join('; ')}.`,
		);
	}
	const catalogMismatches = [
		...invariantMismatches,
		...policies.map(({ policyname, tablename }) => `public policy ${policyname} on ${tablename}`),
		...views.map(({ object_name, object_type }) => `public ${object_type} ${object_name}`),
		...securityDefiners
			.filter(({ object_name }) => !ALLOWED_SECURITY_DEFINER_FUNCTIONS.has(object_name))
			.map(
				({ object_name, arguments: args }) =>
					`public SECURITY DEFINER function ${object_name}(${args})`,
			),
		...executablePublicFunctions.map(
			({ object_name, arguments: args }) => `executable public function ${object_name}(${args})`,
		),
	];
	if (catalogMismatches.length) {
		throw new Error(
			`Database check failed: forbidden public catalog objects: ${catalogMismatches.join('; ')}.`,
		);
	}
}

async function verifyDatabase(client) {
	await client.query('select 1');
	const { entries } = readMigrationJournal();
	if (!entries.at(-1)?.tag) throw new Error('Database check failed: migration journal is empty.');
	const latestSnapshotTag = latestAvailableSnapshotTag();
	const expected = expectedSchema(latestSnapshotTag);
	await assertExpectedSchema(
		client,
		latestSnapshotTag,
		`Database check failed: schema does not match ${latestSnapshotTag}.`,
		{ rejectUnexpected: true },
	);
	await assertCatalogSecurity(client, expected);
	await assertMigrationLedger(client);
	for (const [label, query] of LEGACY_DATA_CHECKS) {
		const { rows } = await client.query(query);
		if (Number(rows[0]?.count ?? 0) !== 0) {
			throw new Error(`Database check failed: existing data violates ${label}.`);
		}
	}

	await client.query('begin');
	try {
		await client.query('create temporary table manawg_db_check (id integer)');
		await client.query('insert into manawg_db_check values (1)');
		await client.query('rollback');
	} catch (error) {
		await client.query('rollback').catch(() => undefined);
		throw error;
	}
	const { rows } = await client.query(
		"select to_regclass('pg_temp.manawg_db_check') is null as rolled_back",
	);
	if (rows[0]?.rolled_back !== true) {
		throw new Error('Database check failed: transaction rollback was not observed.');
	}
}

/**
 * Has this exact baseline already been recorded as applied? An empty ledger and
 * a ledger that only holds the superseded push-era chain both answer "no" — both
 * still need adoption.
 */
async function ledgerHasBaseline(client, hash) {
	if (!(await tableExists(client, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE))) return false;
	const { rows } = await client.query(
		`select 1 from ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} where hash = $1 limit 1`,
		[hash],
	);
	return rows.length > 0;
}

/**
 * Record the baseline as applied without running it. Only called when the
 * schema is already populated, so this describes reality rather than changing
 * it.
 */
async function adoptBaseline(client) {
	const entry = readJournalEntry(BASELINE_TAG);
	const hash = hashMigration(BASELINE_TAG);
	await client.query(`create schema if not exists ${MIGRATIONS_SCHEMA}`);
	await client.query(
		`create table if not exists ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} (
			id serial primary key,
			hash text not null,
			created_at bigint
		)`,
	);
	await client.query(
		`insert into ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} (hash, created_at) values ($1, $2)`,
		[hash, entry.when],
	);
}

function safeFailureReason(error) {
	const text = [error?.message, error?.cause?.message].filter(Boolean).join('\n');
	if (/unexpected migration row/i.test(text)) return 'unexpected-migration-row';
	if (/migration ledger is not a canonical prefix/i.test(text)) return 'non-canonical-ledger';
	if (/timestamp mismatch/i.test(text)) return 'migration-timestamp';
	if (/invalid migration (?:hash|timestamp)/i.test(text)) return 'invalid-ledger-value';
	if (/duplicate migration/i.test(text)) return 'duplicate-migration';
	if (/migration ledger is missing/i.test(text)) return 'missing-ledger';
	if (/syntax error/i.test(text)) return 'sql-syntax';
	if (/relation .* does not exist/i.test(text)) return 'missing-relation';
	if (/column .* does not exist/i.test(text)) return 'missing-column';
	if (/already exists|duplicate key/i.test(text)) return 'duplicate-object';
	const permission = text.match(/permission denied for (schema|table|sequence|function)/i);
	if (permission) return `permission-${permission[1].toLowerCase()}`;
	const owner = text.match(/must be owner of (schema|table|sequence|function|relation)/i);
	if (owner) return `owner-${owner[1].toLowerCase()}`;
	if (/permission denied|insufficient privilege/i.test(text)) return 'permission';
	return 'unclassified';
}

async function main() {
	currentStage = 'connection-config';
	const sourceConnection = resolveConnectionString();
	validateSupabaseDirectUrl(sourceConnection, 'Database migration connection');
	const connectionString =
		process.env.MANAWG_PREVIEW_CI_SESSION === 'true'
			? previewSessionDatabaseUrl(sourceConnection)
			: sourceConnection;
	const pool = new pg.Pool({ connectionString, max: 1 });
	currentStage = 'connect';
	const client = await pool.connect();
	let locked = false;
	try {
		currentStage = 'lock';
		await client.query('select pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK]);
		locked = true;
		if (process.argv.includes('--check')) {
			currentStage = 'verify';
			await verifyDatabase(client);
			console.error('[migrate] Database check passed.');
			return;
		}

		currentStage = 'inspect-schema';
		const hasSchema = await tableExists(client, 'public', SENTINEL_TABLE);
		currentStage = 'inspect-ledger-table';
		const hasMigrationLedger = await tableExists(client, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE);
		currentStage = 'inspect-ledger';
		const ledger = hasMigrationLedger ? await assertMigrationLedgerPrefix(client) : null;
		if (ledger && ledger.appliedCount === ledger.entries.length) {
			currentStage = 'verify';
			await verifyDatabase(client);
			console.error('[migrate] Verified up to date.');
			return;
		}
		currentStage = 'inspect-baseline';
		const baselineHash = hashMigration(BASELINE_TAG);
		currentStage = 'inspect-baseline-ledger';
		const needsAdoption = hasSchema && !(await ledgerHasBaseline(client, baselineHash));

		if (needsAdoption) {
			currentStage = 'adoption-verify';
			await assertBaselineSchema(client);
			console.error(
				`[migrate] Existing schema without this baseline in the ledger — recording ${BASELINE_TAG} as applied.`,
			);
			currentStage = 'adopt';
			await adoptBaseline(client);
		}

		currentStage = 'ledger';
		if (hasMigrationLedger || needsAdoption) await assertMigrationLedgerPrefix(client);
		const db = drizzle(client);
		currentStage = 'migrate';
		await migrate(db, { migrationsFolder });
		console.error('[migrate] Up to date.');
	} finally {
		try {
			if (locked) {
				const previousStage = currentStage;
				currentStage = 'unlock';
				let unlockSucceeded = false;
				try {
					await client.query('select pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK]);
					unlockSucceeded = true;
				} finally {
					if (unlockSucceeded) currentStage = previousStage;
				}
			}
		} finally {
			client.release();
			await pool.end();
		}
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		const rawErrorCode =
			err && typeof err === 'object'
				? (err.code ?? (err.cause && typeof err.cause === 'object' ? err.cause.code : undefined))
				: undefined;
		const errorCode =
			typeof rawErrorCode === 'string' && /^[A-Z0-9_]{5,}$/.test(rawErrorCode)
				? ` [code=${rawErrorCode}]`
				: '';
		const failureReason = safeFailureReason(err);
		console.error(
			`[migrate] Failed [stage=${currentStage}] [reason=${failureReason}]${errorCode}:`,
			err instanceof Error ? err.message : err,
		);
		process.exit(1);
	});
}
