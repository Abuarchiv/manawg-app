import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sql } from 'drizzle-orm';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function load(relativePath, mocks, env, logs = []) {
	const source = readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
	const compiled = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	new Function('require', 'module', 'exports', 'process', 'console', compiled)(
		(id) => (Object.hasOwn(mocks, id) ? mocks[id] : require(id)),
		module,
		module.exports,
		{ env },
		{ warn: () => {}, error: (...args) => logs.push(args) },
	);
	return module.exports;
}

test(
	'runtime database pools time out stalled, locked, and slow queries and recover',
	{ timeout: 60_000 },
	async (t) => {
		const runtimeUrl = 'postgresql://postgres@127.0.0.1:6543/postgres?sslmode=disable';
		const expected = {
			connectionString: runtimeUrl,
			max: 5,
			connectionTimeoutMillis: 2_000,
			lock_timeout: 2_000,
			query_timeout: 5_500,
			statement_timeout: 5_000,
		};
		for (const parameter of ['lock_timeout', 'query_timeout', 'statement_timeout']) {
			const url = new URL(runtimeUrl);
			url.searchParams.set(parameter, '0');
			const resolver = load(
				'core/db/connection.ts',
				{ './supabase-ca': {} },
				{ POSTGRES_URL: url.href },
			);
			assert.throws(() => resolver.resolveConnectionString(), new RegExp(parameter));
			assert.throws(() => resolver.resolveTransactionConnectionString(), new RegExp(parameter));
		}
		const configuredUrl = new URL(runtimeUrl);
		configuredUrl.searchParams.set('application_name', 'runtime-pool-test');
		configuredUrl.searchParams.set('connect_timeout', '0');
		const resolver = load(
			'core/db/connection.ts',
			{ './supabase-ca': {} },
			{ POSTGRES_URL: configuredUrl.href },
		);
		const preserved = new URL(resolver.resolveConnectionString());
		assert.equal(preserved.searchParams.get('application_name'), 'runtime-pool-test');
		assert.equal(preserved.searchParams.get('connect_timeout'), '0');

		const configEnv = { POSTGRES_URL: runtimeUrl };
		const connection = {
			closeClientOnQueryTimeout: () => {},
			resolveConnectionString: () => runtimeUrl,
			resolveTransactionConnectionString: () => runtimeUrl,
		};
		class ConfigPool {
			constructor(options) {
				this.options = options;
			}

			on() {}
		}
		const poolMock = { Pool: ConfigPool };
		const configDb = load(
			'core/db/index.ts',
			{
				'./connection': connection,
				'./schema': {},
				pg: poolMock,
				'drizzle-orm/node-postgres': { drizzle: (pool) => ({ getConfig: () => pool.options }) },
			},
			configEnv,
		);
		assert.deepEqual(configDb.db.getConfig(), expected);
		const { withTransaction: configTransaction } = load(
			'core/db/transaction.ts',
			{
				'./connection': connection,
				'./schema': {},
				'./transaction-abort': {},
				pg: poolMock,
				'drizzle-orm/node-postgres': {
					drizzle: (pool) => ({ transaction: async () => pool.options }),
				},
			},
			configEnv,
		);
		assert.deepEqual(await configTransaction(() => undefined), expected);

		if (process.env.RUN_DB_TIMEOUT_INTEGRATION !== '1') return;
		const initdb = spawnSync('which', ['initdb'], { encoding: 'utf8' });
		const pgCtl = spawnSync('which', ['pg_ctl'], { encoding: 'utf8' });
		if (initdb.status !== 0 || pgCtl.status !== 0 || process.getuid?.() === 0) {
			t.skip(
				'Requires local initdb and pg_ctl and a non-root user for a disposable PostgreSQL instance.',
			);
			return;
		}

		const dataDir = mkdtempSync(join(tmpdir(), 'manawg-db-timeouts-'));
		const portProbe = net.createServer();
		await new Promise((resolve, reject) => {
			portProbe.once('error', reject);
			portProbe.listen(0, '127.0.0.1', resolve);
		});
		const address = portProbe.address();
		assert.ok(address && typeof address !== 'string');
		const pgPort = address.port;
		await new Promise((resolve, reject) => {
			portProbe.close((error) => (error ? reject(error) : resolve()));
		});

		const run = (binary, args) => {
			const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30_000 });
			assert.equal(result.status, 0, `${binary} failed: ${result.stderr || result.stdout}`);
		};
		let proxy;
		let proxyStarted = false;
		let dropRepliesForQuery = null;
		let droppedReplyBytes = 0;
		const proxySockets = new Set();
		const pools = [];
		let pgStarted = false;
		try {
			run(initdb.stdout.trim(), [
				'--no-locale',
				'--encoding=UTF8',
				'--auth=trust',
				'--username=postgres',
				'-D',
				dataDir,
			]);
			run(pgCtl.stdout.trim(), [
				'-D',
				dataDir,
				'-l',
				join(dataDir, 'postgres.log'),
				'-o',
				`-h 127.0.0.1 -p ${pgPort} -F`,
				'-w',
				'start',
			]);
			pgStarted = true;

			let stalledConnections = 0;
			proxy = net.createServer((client) => {
				proxySockets.add(client);
				client.once('close', () => proxySockets.delete(client));
				if (stalledConnections > 0) {
					stalledConnections -= 1;
					const closeTimer = setTimeout(() => client.destroy(), 4_500);
					closeTimer.unref();
					client.once('close', () => clearTimeout(closeTimer));
					return;
				}
				const upstream = net.connect(pgPort, '127.0.0.1');
				proxySockets.add(upstream);
				upstream.once('close', () => proxySockets.delete(upstream));
				client.once('close', () => upstream.destroy());
				upstream.once('close', () => client.destroy());
				client.on('error', () => upstream.destroy());
				upstream.on('error', () => client.destroy());
				let requestText = '';
				let dropResponses = false;
				client.on('data', (chunk) => {
					if (!dropResponses && dropRepliesForQuery) {
						requestText += chunk.toString('utf8');
						if (requestText.toLowerCase().includes(dropRepliesForQuery)) {
							dropResponses = true;
							dropRepliesForQuery = null;
						}
						if (requestText.length > 16_384) requestText = requestText.slice(-8_192);
					}
					upstream.write(chunk);
				});
				upstream.on('data', (chunk) => {
					if (dropResponses) {
						droppedReplyBytes += chunk.length;
						return;
					}
					client.write(chunk);
				});
			});
			await new Promise((resolve, reject) => {
				proxy.once('error', reject);
				proxy.listen(0, '127.0.0.1', resolve);
			});
			proxyStarted = true;
			const proxyAddress = proxy.address();
			assert.ok(proxyAddress && typeof proxyAddress !== 'string');
			const testRuntimeUrl = `postgresql://postgres@127.0.0.1:${proxyAddress.port}/postgres?sslmode=disable`;
			const env = { POSTGRES_URL: testRuntimeUrl };
			const testConnection = load('core/db/connection.ts', { './supabase-ca': {} }, env);
			const { Pool, Client } = require('pg');
			class TrackedPool extends Pool {
				constructor(options) {
					super(options);
					pools.push(this);
				}

				end() {
					this.testEndPromise ??= super.end();
					return this.testEndPromise;
				}
			}
			const drizzlePg = require('drizzle-orm/node-postgres');
			const db = load(
				'core/db/index.ts',
				{
					'./connection': testConnection,
					'./schema': {},
					pg: { Pool: TrackedPool },
					'drizzle-orm/node-postgres': drizzlePg,
				},
				env,
			);

			const expectConnectTimeout = async (operation) => {
				stalledConnections += 1;
				const startedAt = Date.now();
				await assert.rejects(operation(), (error) => error instanceof Error);
				const elapsed = Date.now() - startedAt;
				assert.ok(elapsed >= 1_500 && elapsed < 3_500, `connection timeout took ${elapsed}ms`);
			};
			await expectConnectTimeout(() => db.db.execute(sql`select 1`));
			const readResult = await db.db.execute(sql`select 42::integer as answer`);
			assert.equal(readResult.rows[0]?.answer, 42);
			const readSettings = await db.db.execute(
				sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock`,
			);
			assert.equal(readSettings.rows[0]?.statement, '5s');
			assert.equal(readSettings.rows[0]?.lock, '2s');
			dropRepliesForQuery = 'select pg_sleep';
			const readTimeoutStartedAt = Date.now();
			await assert.rejects(
				db.db.execute(sql`select pg_sleep(0.1)`),
				(error) => error instanceof Error,
			);
			const readTimeoutElapsed = Date.now() - readTimeoutStartedAt;
			assert.ok(
				readTimeoutElapsed >= 5_000 && readTimeoutElapsed < 7_500,
				`client-side read timeout took ${readTimeoutElapsed}ms`,
			);
			assert.ok(droppedReplyBytes > 0, 'the proxy dropped the completed read response');
			const readRecovered = await db.db.execute(sql`select 43::integer as answer`);
			assert.equal(readRecovered.rows[0]?.answer, 43);

			const { withTransaction } = load(
				'core/db/transaction.ts',
				{
					'./connection': testConnection,
					'./schema': {},
					'./transaction-abort': {},
					pg: { Pool: TrackedPool, Client },
					'drizzle-orm/node-postgres': drizzlePg,
				},
				env,
			);
			await expectConnectTimeout(() => withTransaction((tx) => tx.execute(sql`select 1`)));

			const transactionSettings = await withTransaction((tx) =>
				tx.execute(
					sql`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock`,
				),
			);
			assert.equal(transactionSettings.rows[0]?.statement, '5s');
			assert.equal(transactionSettings.rows[0]?.lock, '2s');

			const lockHolder = new Client({
				connectionString: `postgresql://postgres@127.0.0.1:${pgPort}/postgres?sslmode=disable`,
			});
			try {
				await lockHolder.connect();
				await lockHolder.query('BEGIN');
				await lockHolder.query('SELECT pg_advisory_xact_lock(147258369)');
				const lockStartedAt = Date.now();
				await assert.rejects(
					withTransaction((tx) => tx.execute(sql`select pg_advisory_xact_lock(147258369)`)),
					(error) => error.cause?.code === '55P03',
				);
				assert.ok(
					Date.now() - lockStartedAt < 3_500,
					'lock timeout should precede statement timeout',
				);
			} finally {
				await lockHolder.query('ROLLBACK').catch(() => {});
				await lockHolder.end().catch(() => {});
			}

			await assert.rejects(
				withTransaction((tx) => tx.execute(sql`select pg_sleep(10)`)),
				(error) => error.cause?.code === '57014',
			);
			const probeClient = new Client({
				connectionString: `postgresql://postgres@127.0.0.1:${pgPort}/postgres?sslmode=disable`,
			});
			await probeClient.connect();
			try {
				await probeClient.query(
					'CREATE TABLE manawg_runtime_timeout_probe (id integer PRIMARY KEY)',
				);
				dropRepliesForQuery = 'insert into manawg_runtime_timeout_probe';
				droppedReplyBytes = 0;
				const writeTimeoutStartedAt = Date.now();
				await assert.rejects(
					withTransaction((tx) =>
						tx.execute(sql.raw('insert into manawg_runtime_timeout_probe (id) values (1)')),
					),
					(error) => error instanceof Error,
				);
				const writeTimeoutElapsed = Date.now() - writeTimeoutStartedAt;
				assert.ok(
					writeTimeoutElapsed >= 5_000 && writeTimeoutElapsed < 7_500,
					`transaction read timeout took ${writeTimeoutElapsed}ms`,
				);
				assert.ok(droppedReplyBytes > 0, 'the proxy dropped the completed write response');
				const { rows } = await probeClient.query(
					'select count(*)::integer as count from manawg_runtime_timeout_probe',
				);
				assert.equal(rows[0]?.count, 0, 'the timed-out transaction must roll back');
				const recovered = await withTransaction((tx) =>
					tx.execute(sql`select 7::integer as answer`),
				);
				assert.equal(recovered.rows[0]?.answer, 7);
			} finally {
				await probeClient
					.query('DROP TABLE IF EXISTS manawg_runtime_timeout_probe')
					.catch(() => {});
				await probeClient.end().catch(() => {});
			}
		} finally {
			if (proxyStarted) {
				await Promise.all(pools.map((pool) => pool.end()));
				for (const socket of proxySockets) socket.destroy();
				await new Promise((resolve) => proxy.close(resolve));
			}
			if (pgStarted) {
				const stopped = spawnSync(
					pgCtl.stdout.trim(),
					['-D', dataDir, '-m', 'immediate', '-w', 'stop'],
					{
						encoding: 'utf8',
						timeout: 30_000,
					},
				);
				assert.equal(stopped.status, 0, `pg_ctl stop failed: ${stopped.stderr || stopped.stdout}`);
			}
			rmSync(dataDir, { recursive: true, force: true });
		}
	},
);
