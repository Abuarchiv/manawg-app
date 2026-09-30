import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { closeClientOnQueryTimeout, resolveConnectionString } from './connection';
import * as schema from './schema';

type DbInstance = Omit<NodePgDatabase<typeof schema>, 'transaction'>;

interface CachedDb {
	db: DbInstance;
	pool: Pool;
	/** Raw connection-string source the pool was built from (see currentDbSource). */
	source: string;
}

let cachedDb: CachedDb | null = null;

function currentDbSource(): string {
	return process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
}

function invalidateDb(pool: Pool, err: Error): void {
	if (cachedDb?.pool !== pool) return;
	cachedDb = null;
	console.error('[db] Pool error; invalidating connection pool:', err.message);
	void pool.end().catch((endError: unknown) => {
		console.error('[db] Pool shutdown failed:', endError);
	});
}

// Module-level pools survive dev hot-reloads and long-lived serverless
// instances. If POSTGRES_URL/DATABASE_URL changes underneath us (env swap,
// hot reload after an .env edit), the old pool must not keep serving — it is
// dropped and rebuilt on next access instead of being cached forever.
function dropStaleDb(): void {
	if (!cachedDb || cachedDb.source === currentDbSource()) return;
	const stale = cachedDb;
	cachedDb = null;
	console.warn('[db] Connection string changed; rebuilding connection pool.');
	void stale.pool.end().catch((endError: unknown) => {
		console.error('[db] Stale pool shutdown failed:', endError);
	});
}

function buildDb(): CachedDb {
	const url = resolveConnectionString();
	const pool = new Pool({
		connectionString: url,
		max: 5,
		connectionTimeoutMillis: 2_000,
		lock_timeout: 2_000,
		query_timeout: 5_500,
		statement_timeout: 5_000,
	});
	pool.on('connect', closeClientOnQueryTimeout);
	// Omitting `transaction` is a narrowing assignment, not a cast: the drizzle
	// instance simply has one property more than DbInstance requires.
	const dbInstance: DbInstance = drizzle(pool, { schema });
	pool.on('error', (err) => invalidateDb(pool, err));
	return { db: dbInstance, pool, source: currentDbSource() };
}

// The proxy exists so the pool is only built on first use. The `{}` target is
// a documented lie — Proxy requires a T target but owns no state itself — and
// it is the only cast in this module: every property read is served through
// Reflect.get against the real drizzle instance, keeping types intact.
export const db: DbInstance = new Proxy({} as DbInstance, {
	get(_target, prop) {
		dropStaleDb();
		if (!cachedDb) cachedDb = buildDb();
		const value = Reflect.get(cachedDb.db, prop);
		return typeof value === 'function' ? value.bind(cachedDb.db) : value;
	},
});

export * from './schema';
