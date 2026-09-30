#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { assertCatalogSecurity } from './db-migrate.mjs';

const TARGET_MIGRATION = '0016_revoke_data_api_table_select';
const PUBLIC_ROLES = ['anon', 'authenticated'];
const TABLE_PRIVILEGES = [
	'SELECT',
	'INSERT',
	'UPDATE',
	'DELETE',
	'TRUNCATE',
	'REFERENCES',
	'TRIGGER',
	'MAINTAIN',
];
const unsafeDatabaseVars = [
	'POSTGRES_URL',
	'DATABASE_URL',
	'DATABASE_MIGRATION_URL',
	'POSTGRES_URL_NON_POOLING',
	'DATABASE_URL_UNPOOLED',
];

if (process.env.MANAWG_LOCAL_MIGRATION_REHEARSAL !== 'YES_DISPOSABLE_POSTGRES') {
	throw new Error('Opt in with MANAWG_LOCAL_MIGRATION_REHEARSAL=YES_DISPOSABLE_POSTGRES.');
}
if (unsafeDatabaseVars.some((name) => process.env[name]?.trim())) {
	throw new Error(
		`Unset ${unsafeDatabaseVars.join(', ')} before running this local-only rehearsal.`,
	);
}

const rawUrl = process.env.MANAWG_LOCAL_MIGRATION_REHEARSAL_URL;
if (!rawUrl)
	throw new Error('Set MANAWG_LOCAL_MIGRATION_REHEARSAL_URL to a local disposable PostgreSQL URL.');
const adminUrl = new URL(rawUrl);
if (
	!['postgres:', 'postgresql:'].includes(adminUrl.protocol) ||
	!['127.0.0.1', '[::1]'].includes(adminUrl.hostname) ||
	decodeURIComponent(adminUrl.username) !== 'postgres' ||
	adminUrl.password ||
	adminUrl.pathname !== '/postgres' ||
	!adminUrl.port ||
	adminUrl.search ||
	adminUrl.hash
) {
	throw new Error(
		'The rehearsal accepts only password-free postgres URLs to 127.0.0.1 or ::1, database /postgres, with an explicit port and no query options.',
	);
}

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const runId = randomBytes(6).toString('hex');
const databaseNames = [`manawg_grants_${runId}_fresh`, `manawg_grants_${runId}_upgrade`];
const migrationRole = `manawg_grants_${runId}_migrator`;
const createdRoles = [];
const admin = new pg.Client({ connectionString: adminUrl.toString() });
let tempRoot;
let adminConnected = false;

async function connect(databaseName) {
	const url = new URL(adminUrl);
	url.pathname = `/${databaseName}`;
	const client = new pg.Client({ connectionString: url.toString() });
	await client.connect();
	await client.query(`set role ${quoteIdentifier(migrationRole)}`);
	return client;
}

async function applyMigrations(databaseName, migrationsFolder) {
	const client = await connect(databaseName);
	try {
		await migrate(drizzle(client), { migrationsFolder });
	} finally {
		await client.end();
	}
}

async function inspectPrivileges(client) {
	const {
		rows: [tables],
	} = await client.query(`
		select count(*) filter (where ${TABLE_PRIVILEGES.map((privilege) => `has_table_privilege('anon', c.oid, '${privilege}')`).join(' or ')})::int as anon,
		       count(*) filter (where ${TABLE_PRIVILEGES.map((privilege) => `has_table_privilege('authenticated', c.oid, '${privilege}')`).join(' or ')})::int as authenticated
		  from pg_class c join pg_namespace n on n.oid = c.relnamespace
		 where n.nspname = 'public' and c.relkind in ('r', 'p')`);
	const {
		rows: [defaults],
	} = await client.query(`
		select count(*) filter (where d.defaclnamespace = 0)::int as global,
		       count(*) filter (where d.defaclnamespace = 'public'::regnamespace)::int as public
		  from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
		 where d.defaclrole = current_user::regrole and d.defaclobjtype = 'r'
		   and a.grantee in ('anon'::regrole, 'authenticated'::regrole)`);
	return { tables, defaults };
}

async function assertMigrationResult(databaseName, expectedTables) {
	const client = await connect(databaseName);
	try {
		await assertCatalogSecurity(client, expectedTables);
		const privileges = await inspectPrivileges(client);
		if (
			Object.values(privileges.tables).some(Boolean) ||
			Object.values(privileges.defaults).some(Boolean)
		) {
			throw new Error(
				`${databaseName} retains public-role table or default privileges: ${JSON.stringify(privileges)}`,
			);
		}
		await client.query('create table public.manawg_grants_probe (id integer)');
		const {
			rows: [probe],
		} = await client.query(`
			select bool_or(has_table_privilege(role_name, 'public.manawg_grants_probe', privilege_name)) as any_access
			  from (values ('anon'), ('authenticated')) as roles(role_name)
			 cross join (values ${TABLE_PRIVILEGES.map((privilege) => `('${privilege}')`).join(', ')}) as privileges(privilege_name)`);
		if (probe.any_access)
			throw new Error(`${databaseName} grants table access to anon or authenticated by default.`);
		process.stdout.write(
			`${databaseName}: catalog check passed; current and future public tables have no anon/authenticated privileges.\n`,
		);
	} finally {
		await client.end();
	}
}

try {
	await admin.connect();
	adminConnected = true;
	const {
		rows: [server],
	} = await admin.query(`
		select current_user, r.rolsuper, current_setting('server_version_num')::int as version,
		       host(inet_server_addr()) as address
		  from pg_roles r where r.rolname = current_user`);
	if (
		!server.rolsuper ||
		Math.floor(server.version / 10000) < 17 ||
		!['127.0.0.1', '::1'].includes(server.address)
	) {
		throw new Error('Use a PostgreSQL 17+ local loopback server and its postgres superuser.');
	}

	for (const role of PUBLIC_ROLES) {
		const { rowCount } = await admin.query('select 1 from pg_roles where rolname = $1', [role]);
		if (!rowCount) {
			await admin.query(`create role ${role} nologin`);
			createdRoles.push(role);
		}
	}
	await admin.query(`create role ${quoteIdentifier(migrationRole)} nologin`);
	createdRoles.push(migrationRole);

	const migrationsFolder = path.resolve('drizzle');
	const journalPath = path.join(migrationsFolder, 'meta/_journal.json');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
	const targetIndex = journal.entries.findIndex(({ tag }) => tag === TARGET_MIGRATION);
	if (targetIndex < 1 || journal.entries[targetIndex].idx !== targetIndex) {
		throw new Error(
			`Canonical migration ${TARGET_MIGRATION} is missing or has a non-canonical journal position.`,
		);
	}
	const latest = journal.entries.at(-1);
	const snapshot = JSON.parse(
		readFileSync(
			path.join(migrationsFolder, 'meta', `${String(latest.idx).padStart(4, '0')}_snapshot.json`),
			'utf8',
		),
	);
	const expectedTables = Object.values(snapshot.tables).map(({ name }) => ({ table: name }));
	const preTarget = journal.entries[targetIndex - 1];
	const preTargetSnapshot = JSON.parse(
		readFileSync(
			path.join(
				migrationsFolder,
				'meta',
				`${String(preTarget.idx).padStart(4, '0')}_snapshot.json`,
			),
			'utf8',
		),
	);
	const preTargetTables = Object.values(preTargetSnapshot.tables).map(({ name }) => ({
		table: name,
	}));
	tempRoot = mkdtempSync(path.join(tmpdir(), 'manawg-grants-rehearsal-'));
	const prefixFolder = path.join(tempRoot, 'before-0016');
	mkdirSync(path.join(prefixFolder, 'meta'), { recursive: true });
	const prefix = { ...journal, entries: journal.entries.slice(0, targetIndex) };
	writeFileSync(
		path.join(prefixFolder, 'meta/_journal.json'),
		`${JSON.stringify(prefix, null, 2)}\n`,
	);
	for (const { tag } of prefix.entries) {
		copyFileSync(path.join(migrationsFolder, `${tag}.sql`), path.join(prefixFolder, `${tag}.sql`));
	}

	for (const databaseName of databaseNames) {
		await admin.query(
			`create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(migrationRole)}`,
		);
	}

	const [fresh, upgrade] = databaseNames;
	await applyMigrations(upgrade, prefixFolder);
	const oldClient = await connect(upgrade);
	try {
		await oldClient.query(
			'alter default privileges grant all privileges on tables to anon, authenticated',
		);
		const oldPrivileges = await inspectPrivileges(oldClient);
		if (
			oldPrivileges.tables.anon === 0 ||
			oldPrivileges.tables.authenticated === 0 ||
			oldPrivileges.defaults.global === 0 ||
			oldPrivileges.defaults.public === 0
		) {
			throw new Error(
				`The pre-0016 rehearsal did not recreate the grant mismatch: ${JSON.stringify(oldPrivileges)}`,
			);
		}
		let rejected = false;
		try {
			await assertCatalogSecurity(oldClient, preTargetTables);
		} catch (error) {
			if (!String(error?.message).includes('public role privileges must be empty')) throw error;
			rejected = true;
		}
		if (!rejected) throw new Error('The real catalog checker accepted the pre-0016 grants.');
		process.stdout.write(
			'Upgrade baseline: pre-0016 grants reproduced and rejected by assertCatalogSecurity.\n',
		);
	} finally {
		await oldClient.end();
	}

	await applyMigrations(upgrade, migrationsFolder);
	await applyMigrations(fresh, migrationsFolder);
	await assertMigrationResult(upgrade, expectedTables);
	await assertMigrationResult(fresh, expectedTables);
	process.stdout.write('Migration grants rehearsal passed for fresh install and upgrade.\n');
} finally {
	if (adminConnected) {
		for (const databaseName of [...databaseNames].reverse()) {
			try {
				await admin.query(`drop database if exists ${quoteIdentifier(databaseName)}`);
			} catch (error) {
				process.stderr.write(
					`Could not clean rehearsal database ${databaseName}: ${error.message}\n`,
				);
				process.exitCode = 1;
			}
		}
		for (const role of [...createdRoles].reverse()) {
			try {
				await admin.query(`drop role ${role}`);
			} catch (error) {
				process.stderr.write(`Could not clean local rehearsal role ${role}: ${error.message}\n`);
				process.exitCode = 1;
			}
		}
		await admin.end();
	}
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
}
