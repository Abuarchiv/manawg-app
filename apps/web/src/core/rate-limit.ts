import { captureException } from '@/core/infra/observability';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis/cloudflare';

/**
 * An empty or whitespace-only variable is *configured but unusable* — a typo
 * in the deployment environment, not an intentional "no Redis" choice. Read it
 * as unset so the documented fail-open/fail-closed handling still applies, but
 * name the exact variable instead of failing open without a trace: `checkEnv`
 * only reports these two as generically "degraded" at boot.
 */
function readUpstashSetting(name: string, value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		console.warn(
			`[rate-limit] ${name} is set but empty — rate limiting stays disabled until it holds a value.`,
		);
		return undefined;
	}
	return trimmed;
}

const url = readUpstashSetting('UPSTASH_REDIS_REST_URL', process.env.UPSTASH_REDIS_REST_URL);
const token = readUpstashSetting('UPSTASH_REDIS_REST_TOKEN', process.env.UPSTASH_REDIS_REST_TOKEN);

export function rateLimitFailMode(): 'open' | 'closed' {
	const standaloneProduction = process.env.NODE_ENV === 'production' && !process.env.VERCEL_ENV;
	return process.env.NODE_ENV === 'test' ||
		process.env.VERCEL_ENV === 'production' ||
		standaloneProduction
		? 'closed'
		: 'open';
}

export function createConfiguredRedis(): Redis | null {
	if (!url || !token) return null;
	try {
		const endpoint = new URL(url);
		if (
			endpoint.protocol !== 'https:' ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash
		) {
			if (rateLimitFailMode() === 'closed') {
				throw new Error('UPSTASH_REDIS_REST_URL must use https');
			}
			return null;
		}
		return new Redis({ url, token });
	} catch {
		if (rateLimitFailMode() === 'closed') {
			throw new Error('UPSTASH_REDIS_REST_URL must be a valid https URL');
		}
		return null;
	}
}

const redis = createConfiguredRedis();

function build(limit: number, windowSec: number, prefix: string): Ratelimit | null {
	if (!redis) return null;
	return new Ratelimit({
		redis,
		limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
		prefix: `manawg:${prefix}`,
		analytics: false,
	});
}

export const registerLimiter = build(3, 3600, 'reg'); // 3 / hour / IP
export const wgReadLimiter = build(120, 60, 'wg-read'); // 120 reads / min / IP — WG GET endpoints
export const wgWriteLimiter = build(30, 60, 'wg-write'); // 30 writes / min / IP — WG mutation endpoints
// Every full page load of a WG does one lookup, and flatmates share their router's IP,
// so 20/min locked whole WGs out ("Deine WG konnte nicht geladen werden"). With
// 32^8 codes, one IP at 120/min still needs ~17,000 years to walk the code space.
export const wgShareCodeLookupLimiter = build(120, 60, 'wg-code-lookup'); // 120 share-code lookups / min / IP — brute-force defense
// Nested /api/wg/<code>/… routes answer differently for an unknown code and
// for a foreign WG. Only misses are counted (per signed-in account), so
// members are never throttled while code enumeration stops after a few tries.
export const wgShareCodeMissLimiter = build(20, 3600, 'wg-code-miss'); // 20 unknown/foreign share codes / hour / account
export const notifTestLimiter = build(3, 60, 'notif-test'); // 3 test notifications / min / member — anti-spam
export const reminderSendLimiter = build(10, 3600, 'reminder-send'); // 10 Mahnungen / hour / member — global anti-spam

export const chatReadLimiter = build(120, 60, 'chat-read'); // 120 read-receipts / min / member
export const chatMessageLimiter = build(20, 60, 'chat-msg'); // 20 messages / min / member — anti-spam
export const uploadSignLimiter = build(20, 60, 'upload-sign'); // 20 upload signatures / min / member
// A single export request dumps the WG's entire dataset (expenses, chores,
// chat, announcements). The middleware's 120 reads/min is far too generous for
// that, so it gets its own bucket on top.
export const wgExportLimiter = build(20, 3600, 'wg-export'); // 20 exports / hour / member
// The dashboard aggregates the WG's financial state. The middleware's
// 120 reads/min is per IP and shared with every other GET, so the route gets
// its own per-member bucket: scraping balances stays throttled even from a
// rotating pool of IPs.
export const dashboardLimiter = build(60, 60, 'dashboard'); // 60 dashboard reads / min / member
// The expense list returns the WG's full expense history; same per-member
// bucket reasoning as the dashboard.
export const expensesReadLimiter = build(60, 60, 'expenses-read'); // 60 expense-list reads / min / member
export const healthLimiter = build(60, 60, 'health'); // 60 probes / min / IP — outside the middleware matcher
export const importLimiter = build(10, 3600, 'import-preview'); // 10 preview / hour / member
export const importCommitLimiter = build(3, 3600, 'import-commit'); // 3 commit / hour / member

function forwardedForClientIp(headers: Headers): string | null {
	const fwd = headers.get('x-forwarded-for');
	if (!fwd) return null;
	const values = fwd
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean);
	return values.at(-1) ?? null;
}

// Per-IP key for the IP-scoped limiters (wgReadLimiter/wgWriteLimiter etc.).
// Keying on the share code instead would create one shared bucket per WG that
// any code-holder could exhaust pre-auth, locking out every member.
export function clientIpKey(req: { headers: Headers }): string {
	return (
		forwardedForClientIp(req.headers) ||
		req.headers.get('cf-connecting-ip') ||
		req.headers.get('x-real-ip') ||
		'anonymous'
	);
}

interface RateLimitResult {
	success: boolean;
	remaining: number;
	reset: number;
	limiterUnavailable?: boolean;
}

const FAIL_OPEN_PRODUCTION_LOG =
	'[rate-limit] Upstash Redis not configured in production — failing open';
const FAIL_CLOSED_PRODUCTION_LOG =
	'[rate-limit] Upstash Redis not configured in production — failing closed';
const OPEN_STATE_REPORT_INTERVAL_MS = 5 * 60 * 1000;
// Both maps below use `cause` (the report throttle also includes fail mode).
// Causes are internal literals today,
// but nothing stops a future caller from passing request-derived text — and
// in a long-lived serverless instance an unbounded module-level Map is a
// textbook memory leak. Once the cap is reached only already-known causes
// keep their entries, so memory stays bounded while the signal survives.
const MAX_TRACKED_CAUSES = 32;
const lastReportedAt = new Map<string, number>();

// Monotonic fail-open tally. Failing open is deliberate, but it must be
// measurable: a sustained Upstash outage or a standing misconfiguration
// silently disables every limiter while the API looks healthy. The report
// throttle below still dedupes the *alert*, but the counter counts every
// fail-open event so operators can alert on "rate limiting is disabled".
// Observational only — it never influences the allow/deny decision.
const failOpenTotals = new Map<string, number>();

export function getFailOpenStats(): {
	total: number;
	byCause: Record<string, number>;
} {
	const byCause: Record<string, number> = {};
	let total = 0;
	for (const [cause, count] of failOpenTotals) {
		byCause[cause] = count;
		total += count;
	}
	return { total, byCause };
}

function trackCause(map: Map<string, number>, cause: string, value: number): boolean {
	if (!map.has(cause) && map.size >= MAX_TRACKED_CAUSES) return false;
	map.set(cause, value);
	return true;
}

/**
 * An unavailable limiter must remain visible in either fail mode. Reported at
 * most once per interval per cause and mode; never log provider errors because
 * they can contain credentials or request details.
 */
function reportUnavailable(
	cause: string,
	failMode: 'open' | 'closed',
	limiterCallFailed = false,
): void {
	if (failMode === 'open') {
		// Count only requests that were allowed without a working limiter.
		trackCause(failOpenTotals, cause, (failOpenTotals.get(cause) ?? 0) + 1);
	}

	const isProduction = process.env.VERCEL_ENV === 'production';
	const state = failMode === 'open' ? 'failing open' : 'failing closed';

	// An unconfigured limiter is only newsworthy in production; a limiter that
	// throws is a defect anywhere, so it is always logged.
	if (limiterCallFailed) {
		console.error(`[rate-limit] limiter call failed, ${state}`);
	} else if (isProduction) {
		console.error(failMode === 'open' ? FAIL_OPEN_PRODUCTION_LOG : FAIL_CLOSED_PRODUCTION_LOG);
	}

	if (!isProduction) return;
	const now = Date.now();
	const reportKey = `${failMode}:${cause}`;
	const previous = lastReportedAt.get(reportKey);
	if (previous !== undefined && now - previous < OPEN_STATE_REPORT_INTERVAL_MS) return;
	// Unknown causes beyond the tracking cap are logged above but never
	// captured here — without a stored timestamp they would bypass the
	// throttle and fire on every request.
	if (!trackCause(lastReportedAt, reportKey, now)) return;

	captureException(new Error(`rate-limit ${state}`), {
		area: 'rate-limit',
		cause,
	});
}

/** Test seam — the report throttle and fail-open tally are process-global state. */
export function resetOpenStateReporting(): void {
	lastReportedAt.clear();
	failOpenTotals.clear();
}

export async function checkRateLimit(
	limiter: Pick<Ratelimit, 'limit'> | null,
	key: string,
	failMode: 'open' | 'closed' = rateLimitFailMode(),
): Promise<RateLimitResult> {
	if (!limiter) {
		reportUnavailable('upstash-not-configured', failMode);
		if (failMode === 'closed') {
			return { success: false, remaining: 0, reset: Date.now() + 60_000, limiterUnavailable: true };
		}
		return { success: true, remaining: -1, reset: 0 };
	}
	try {
		const r = await limiter.limit(key);
		if (r.reason === 'timeout') throw new Error('Upstash rate-limit timed out');
		return { success: r.success, remaining: r.remaining, reset: r.reset };
	} catch {
		reportUnavailable('limiter-call-failed', failMode, true);
		if (failMode === 'closed') {
			return { success: false, remaining: 0, reset: Date.now() + 60_000, limiterUnavailable: true };
		}
		return { success: true, remaining: -1, reset: 0 };
	}
}
