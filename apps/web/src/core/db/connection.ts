import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'pg';
import { SUPABASE_ROOT_CA } from './supabase-ca';

let supabaseRootPath: string | undefined;

const warnedUrlPairs = new Set<string>();
const RUNTIME_TIMEOUT_QUERY_PARAMS = [
	'lock_timeout',
	'query_timeout',
	'statement_timeout',
] as const;

/** Discard a client when pg's client-side read deadline fires during a query. */
export function closeClientOnQueryTimeout(client: Client): void {
	const query = new Proxy(client.query, {
		apply(target, thisArg, args) {
			const callbackIndex = args.length - 1;
			const callback = args[callbackIndex];
			if (typeof callback === 'function') {
				args[callbackIndex] = function (this: unknown, ...callbackArgs: unknown[]) {
					if (isQueryReadTimeout(callbackArgs[0])) void client.end();
					return callback.apply(this, callbackArgs);
				};
			}

			const result = Reflect.apply(target, thisArg, args);
			return result instanceof Promise
				? result.catch((error: unknown) => {
						if (isQueryReadTimeout(error)) void client.end();
						throw error;
					})
				: result;
		},
	});
	Reflect.set(client, 'query', query);
}

function isQueryReadTimeout(error: unknown): boolean {
	return error instanceof Error && error.message === 'Query read timeout';
}

/**
 * `POSTGRES_URL`/`DATABASE_URL` are supported aliases — Vercel sets one,
 * other platforms the other — so a winner is picked by design. Two non-empty values that *differ* mean the deployment carries
 * two databases' configuration and one of them is silently ignored, which is
 * exactly the drift that surfaces as "works in Preview, missing table in
 * production". Report which variable wins instead.
 */
function warnOnAmbiguousUrlPair(primary: string, secondary: string): void {
	const first = process.env[primary]?.trim();
	const second = process.env[secondary]?.trim();
	if (!first || !second || first === second || warnedUrlPairs.has(primary)) return;
	warnedUrlPairs.add(primary);
	console.warn(
		`[db] ${primary} and ${secondary} are both set but differ — ${primary} takes precedence. Unset ${secondary} to remove the ambiguity.`,
	);
}

export function resolveConnectionString(): string {
	warnOnAmbiguousUrlPair('POSTGRES_URL', 'DATABASE_URL');
	const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
	if (!url) {
		throw new Error(
			'POSTGRES_URL (or DATABASE_URL) is not set. Set a PostgreSQL connection string for the environment.',
		);
	}
	return secureRuntimeConnectionString(url, 'database connection');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/**
 * Loopback, `.local`, or a single-label name such as a Docker Compose service (`db`): hosts that
 * never leave the machine or its private container network, so TLS is not required.
 */
function isLocalHost(host: string): boolean {
	return LOCAL_HOSTS.has(host) || host.endsWith('.local') || /^[a-z0-9][a-z0-9_-]*$/.test(host);
}

function secureRuntimeConnectionString(url: string, label: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${label} is not a valid URL.`);
	}
	const host = parsed.hostname.toLowerCase();
	if (!isLocalHost(host)) {
		parsed.searchParams.set('sslmode', 'verify-full');
	}
	validateDatabaseUrl(parsed.href, label);
	if (
		(host.endsWith('.supabase.co') || host.endsWith('.pooler.supabase.com')) &&
		!parsed.searchParams.has('sslrootcert')
	) {
		if (!supabaseRootPath) {
			const path = join(mkdtempSync(join(tmpdir(), 'manawg-db-ca-')), 'root.crt');
			writeFileSync(path, SUPABASE_ROOT_CA, { mode: 0o600 });
			supabaseRootPath = path;
		}
		parsed.searchParams.set('sslrootcert', supabaseRootPath);
	}
	return parsed.href;
}

export function validateDatabaseUrl(url: string, label: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${label} is not a valid URL.`);
	}
	if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
		throw new Error(`${label} must be a PostgreSQL URL with a host.`);
	}
	if (parsed.searchParams.has('host')) {
		throw new Error(`${label} must not override its host in query parameters.`);
	}
	for (const parameter of RUNTIME_TIMEOUT_QUERY_PARAMS) {
		if (parsed.searchParams.has(parameter)) {
			throw new Error(`${label} must not override ${parameter} in query parameters.`);
		}
	}
	// Drizzle binds BEGIN/COMMIT to one node-postgres client, which supports
	// Supavisor transaction pooling. Migration/session locks use the separate
	// direct-connection validator in scripts/db-migrate/connection.mjs.
	const host = parsed.hostname.toLowerCase();
	const isLocal = isLocalHost(host);
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
