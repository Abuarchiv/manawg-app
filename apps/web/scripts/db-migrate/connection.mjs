/**
 * Connection-string resolution and validation for the migrator. Nothing here opens a connection:
 * every check runs before `pg` is touched, so a misconfigured URL fails without network access.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);

/** Loopback, `.local`, or a single-label name such as a Docker Compose service (`db`). */
function isLocalHost(host) {
	return LOCAL_HOSTS.has(host) || host.endsWith('.local') || /^[a-z0-9][a-z0-9_-]*$/.test(host);
}

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

/**
 * Migrations need a session (advisory lock, DDL), so only port 5432 is accepted: the direct host
 * (IPv6 only on Supabase's free plan) or the session pooler (IPv4), never the transaction pooler.
 */
export function validateSupabaseSessionUrl(url, label) {
	validateDatabaseUrl(url, label);
	const parsed = new URL(url);
	const host = parsed.hostname.toLowerCase();
	if (
		!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
		!(host.endsWith('.supabase.co') || host.endsWith('.pooler.supabase.com')) ||
		parsed.port !== '5432'
	) {
		throw new Error(
			`${label} must be a Supabase PostgreSQL session connection (direct or session pooler) on port 5432.`,
		);
	}
}

const SESSION_POOLER_HOST = 'aws-0-eu-central-1.pooler.supabase.com';

/**
 * GitHub runners have no IPv6, and the direct Supabase host has no IPv4: CI keeps the pinned
 * direct URL as its secret and connects through the session pooler (port 5432, session locks).
 */
function pinnedSessionPoolerUrl(value, projectHost, user, failure) {
	if (!projectHost || !/^[a-z0-9]+\.supabase\.co$/.test(projectHost)) {
		throw new Error(`${failure} needs its Supabase project host (e.g. abcdefgh.supabase.co).`);
	}
	const projectRef = projectHost.split('.')[0];
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${failure} configuration is invalid.`);
	}
	if (
		!['postgres:', 'postgresql:'].includes(url.protocol) ||
		url.hostname !== `db.${projectRef}.supabase.co` ||
		url.port !== '5432' ||
		url.pathname !== '/postgres' ||
		url.username !== user ||
		!url.password ||
		url.hash ||
		url.searchParams.size !== 1 ||
		url.searchParams.get('sslmode') !== 'verify-full'
	) {
		throw new Error(`${failure} requires its pinned connection with verified TLS.`);
	}
	url.hostname = SESSION_POOLER_HOST;
	url.username = `${user}.${projectRef}`;
	return url.href;
}

/**
 * Explicit CI transport for the pinned Preview verifier; never a Production fallback.
 * @param {string} value
 * @param {Record<string, string | undefined>} [env]
 */
export function previewSessionDatabaseUrl(value, env = process.env) {
	const host = env.SUPABASE_PREVIEW_PROJECT_HOST?.toLowerCase();
	if (host && host === env.SUPABASE_PRODUCTION_PROJECT_HOST?.toLowerCase()) {
		throw new Error('Preview CI must not point at the Production project.');
	}
	return pinnedSessionPoolerUrl(value, host, 'manawg_preview_ci', 'Preview CI');
}

/**
 * Explicit CI transport for the protected Production migration workflow.
 * @param {string} value
 * @param {Record<string, string | undefined>} [env]
 */
export function productionSessionDatabaseUrl(value, env = process.env) {
	const host = env.SUPABASE_PRODUCTION_PROJECT_HOST?.toLowerCase();
	return pinnedSessionPoolerUrl(value, host, 'postgres', 'Production CI');
}

export function resolveConnectionString(env = process.env) {
	const migrationUrl = env.DATABASE_MIGRATION_URL;
	if (migrationUrl) {
		validateDatabaseUrl(migrationUrl, 'DATABASE_MIGRATION_URL');
		return migrationUrl;
	}

	const pooled = env.POSTGRES_URL ?? env.DATABASE_URL;
	if (pooled) {
		validateDatabaseUrl(pooled, 'POSTGRES_URL/DATABASE_URL');
		return pooled;
	}

	const direct = env.POSTGRES_URL_NON_POOLING ?? env.DATABASE_URL_UNPOOLED;
	if (direct) {
		validateDatabaseUrl(direct, 'POSTGRES_URL_NON_POOLING/DATABASE_URL_UNPOOLED');
		return direct;
	}

	throw new Error('No database URL. Set DATABASE_MIGRATION_URL, POSTGRES_URL or DATABASE_URL.');
}
