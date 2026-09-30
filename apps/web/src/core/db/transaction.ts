import { type ExtractTablesWithRelations, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { Client, Pool } from 'pg';
import { closeClientOnQueryTimeout, resolveTransactionConnectionString } from './connection';
import * as schema from './schema';

export { TransactionAbort } from './transaction-abort';

export type DbTransaction = PgTransaction<
	NodePgQueryResultHKT,
	typeof schema,
	ExtractTablesWithRelations<typeof schema>
>;

/** Acquire before WG/member row locks so capture, cron, and deletion share one lock order. */
export async function lockExpensePayments(tx: DbTransaction, wgId: string): Promise<void> {
	await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`expense-payment:${wgId}`}))`);
}

/**
 * Open a bounded transaction on a new connection for resolving an uncertain commit.
 * The fresh connection waits behind the original transaction's advisory lock before reading its durable outcome.
 */
export async function withFreshTransaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
	const client = new Client({
		connectionString: resolveTransactionConnectionString(),
		application_name: 'manawg-account-deletion-status-check',
		connectionTimeoutMillis: 2_000,
		query_timeout: 5_500,
		statement_timeout: 5_000,
	});
	closeClientOnQueryTimeout(client);
	await client.connect();
	try {
		return await drizzle(client, { schema }).transaction(fn);
	} finally {
		await client.end().catch((error: unknown) => {
			console.warn('[db/transaction] Fresh connection shutdown failed:', error);
		});
	}
}

interface TransactionalDb {
	transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T>;
}

interface CachedTransactionalDb {
	db: TransactionalDb;
	pool: Pool;
	url: string;
}

let cachedDb: CachedTransactionalDb | null = null;

function invalidateTransactionalDb(pool: Pool, err: Error): void {
	if (cachedDb?.pool !== pool) return;
	cachedDb = null;
	console.error('[db/transaction] Pool error; invalidating connection pool:', err);
	void pool.end().catch((endError: unknown) => {
		console.error('[db/transaction] Pool shutdown failed:', endError);
	});
}

function buildTransactionalDb(url: string): CachedTransactionalDb {
	const pool = new Pool({
		connectionString: url,
		max: 5,
		connectionTimeoutMillis: 2_000,
		lock_timeout: 2_000,
		query_timeout: 5_500,
		statement_timeout: 5_000,
	});
	pool.on('connect', closeClientOnQueryTimeout);
	const drizzleDb = drizzle(pool, { schema });
	// A typed wrapper instead of `as unknown as TransactionalDb`: the cast
	// used to hide any drift between drizzle's real transaction signature and
	// this module's expectation. If drizzle changes its API, this assignment
	// now fails at compile time instead of at runtime.
	const dbInstance: TransactionalDb = {
		transaction: (fn) => drizzleDb.transaction(fn),
	};
	pool.on('error', (err) => invalidateTransactionalDb(pool, err));
	return { db: dbInstance, pool, url };
}

export async function withTransaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
	const url = resolveTransactionConnectionString();
	if (cachedDb && cachedDb.url !== url) {
		const stale = cachedDb;
		cachedDb = null;
		console.warn('[db/transaction] Connection string changed; rebuilding connection pool.');
		void stale.pool.end().catch((endError: unknown) => {
			console.error('[db/transaction] Stale pool shutdown failed:', endError);
		});
	}
	if (!cachedDb) cachedDb = buildTransactionalDb(url);
	return cachedDb.db.transaction(fn);
}
