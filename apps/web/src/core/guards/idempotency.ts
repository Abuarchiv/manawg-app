import {
	type ReplaySlotDependencies,
	type ReplaySlotResult,
	claimReplaySlot,
} from '@/core/guards/replay-slot';
import {
	claimResponseSlot,
	getCachedResponse,
	readIdempotencyKey,
	releaseResponseSlot,
	setCachedResponse,
} from '@/core/idempotency';
import { NextResponse } from 'next/server';

export type { ReplaySlotDependencies, ReplaySlotResult } from '@/core/guards/replay-slot';

type ReplayEntry<T> = {
	expiresAt: number;
	promise: Promise<T>;
};

export type ReplayReservation<T> =
	| {
			owned: true;
			resolve: (body: T) => void;
			reject: (reason: unknown) => void;
	  }
	| {
			owned: false;
			promise: Promise<T>;
	  };

/**
 * In-process (single warm-Lambda-instance) response-replay cache, keyed by
 * an arbitrary string. Deduplicates concurrent requests that land on the
 * SAME instance while the first is still writing — the first caller
 * "reserves" the key and every other caller on this instance gets its
 * eventual response instead of racing it into a second write.
 *
 * This is deliberately separate from (and faster than) the cross-process
 * Postgres claim in {@link claimReplaySlotWithRetry} below, which covers
 * the case where the duplicate request lands on a *different* Lambda
 * instance. Both layers are required — see the "RED BUG-002" test in
 * expenses/route.test.ts, which exercises the local-map layer even when
 * the Postgres cache read is stale/null.
 *
 * Extracted verbatim (semantics unchanged) from the hand-rolled
 * `expenseCreateReplay` Map in expenses/route.ts so both the expenses and
 * recurring-expenses routes can share one reservation implementation.
 */
export class ReplayCache<T> {
	private readonly entries = new Map<string, ReplayEntry<T>>();

	constructor(private readonly ttlMs: number) {}

	get(cacheKey: string): Promise<T> | null {
		const entry = this.entries.get(cacheKey);
		if (!entry) return null;
		if (entry.expiresAt <= Date.now()) {
			this.entries.delete(cacheKey);
			return null;
		}
		return entry.promise;
	}

	remember(cacheKey: string, body: T): void {
		this.entries.set(cacheKey, {
			expiresAt: Date.now() + this.ttlMs,
			promise: Promise.resolve(body),
		});
	}

	/**
	 * Claim the local reservation for `cacheKey`, or return the existing
	 * in-flight/resolved promise if another caller already owns it.
	 */
	reserve(cacheKey: string): ReplayReservation<T> {
		const existing = this.get(cacheKey);
		if (existing) return { owned: false, promise: existing };

		// The Promise executor runs synchronously, so `resolveFn`/`rejectFn`
		// are always reassigned to the real callbacks before this line
		// finishes — no non-null assertion needed to use them below.
		let resolveFn: (body: T) => void = () => undefined;
		let rejectFn: (reason: unknown) => void = () => undefined;
		const promise = new Promise<T>((promiseResolve, promiseReject) => {
			resolveFn = promiseResolve;
			rejectFn = promiseReject;
		});
		// A reservation that is ultimately rejected must not surface as an
		// unhandled rejection — the route's own catch handles reporting.
		promise.catch(() => undefined);

		this.entries.set(cacheKey, { expiresAt: Date.now() + this.ttlMs, promise });
		return {
			owned: true,
			resolve: (body) => {
				this.remember(cacheKey, body);
				resolveFn(body);
			},
			reject: (reason) => {
				this.entries.delete(cacheKey);
				rejectFn(reason);
			},
		};
	}
}

/** Namespaces a raw Idempotency-Key header value under a caller-chosen scope. */

export function replayKey(scope: string, key: string): string {
	return `${scope}:${key}`;
}

/**
 * Cross-process response-replay claim with poll-and-retry, backed by the
 * Postgres claim table in `@/core/idempotency` (deliberately not Redis — see
 * that module's doc comment re: the iter 13 P0 outage where an empty-env
 * Redis client silently no-opped and let duplicate expense inserts through).
 *
 * Attempts to claim the (scope, key) slot. If lost, checks once immediately
 * (the winner may already be done), then polls with bounded backoff.
 * Returns:
 *   - `{ won: true }` — caller should perform the mutation and eventually
 *     call `setCachedResponse`.
 *   - `{ won: false, cached: T }` — a completed response to replay as-is.
 * Throws on claim/cache errors or when polling ends without a response.
 * A slow/crashed winner or a failed cache write never authorizes a takeover.
 */
export async function claimReplaySlotWithRetry<T>(
	scope: string,
	key: string,
	dependencies?: ReplaySlotDependencies<T>,
): Promise<ReplaySlotResult<T>> {
	return claimReplaySlot(scope, key, {
		claim:
			dependencies?.claim ?? ((claimScope, claimKey) => claimResponseSlot(claimScope, claimKey)),
		read: dependencies?.read ?? ((readScope, readKey) => getCachedResponse<T>(readScope, readKey)),
		...(dependencies?.sleep ? { sleep: dependencies.sleep } : {}),
	});
}

interface CachedJsonResponse {
	status: number;
	body: unknown;
}

/**
 * Client-error answers that mean "try again later" rather than "this request
 * is wrong". Replaying them from the seven-day response cache would turn a
 * transient throttle into a permanent one for the caller's key.
 */
const TRANSIENT_CLIENT_STATUSES = new Set([408, 425, 429]);

/**
 * Whether a handler response may be persisted under the caller's
 * Idempotency-Key and replayed to later retries.
 *
 * - **2xx** — the mutation completed; replaying the same body is exactly what
 *   the key is for.
 * - **4xx (deterministic)** — validation/authorization rejections such as
 *   `member_not_in_wg` are produced before any mutation, so a retry would
 *   arrive at the same answer anyway; replaying saves a redundant handler run.
 * - **everything else (5xx, 408/425/429)** — NOT replayable. Offline queues
 *   keep the key and retry on a later connection, so caching a transient
 *   failure would make it permanent for `RESPONSE_REPLAY_TTL_SECONDS`.
 */
function isReplayableStatus(status: number): boolean {
	if (status >= 200 && status < 300) return true;
	if (status >= 400 && status < 500 && !TRANSIENT_CLIENT_STATUSES.has(status)) return true;
	return false;
}

/** Replay a JSON mutation response after the caller has authenticated and
 * established a tenant/member-scoped replay scope. */
export async function withIdempotentJsonResponse(
	req: Request,
	scope: string,
	handler: () => Promise<NextResponse>,
	beforeReplay?: () => Promise<NextResponse | null>,
): Promise<NextResponse> {
	const key = readIdempotencyKey(req);
	if (!key) return handler();

	const cached = await getCachedResponse<CachedJsonResponse>(scope, key);
	if (cached) {
		const blocked = await beforeReplay?.();
		if (blocked) return blocked;
		return NextResponse.json(cached.body, { status: cached.status });
	}

	const slot = await claimReplaySlotWithRetry<CachedJsonResponse>(scope, key);
	if (!slot.won) {
		const blocked = await beforeReplay?.();
		if (blocked) return blocked;
		return NextResponse.json(slot.cached.body, { status: slot.cached.status });
	}

	let response: NextResponse;
	try {
		response = await handler();
	} catch (error) {
		// The handler never produced a response: free the claim so the next
		// retry re-runs it instead of waiting out the claim lease.
		await releaseResponseSlot(scope, key);
		throw error;
	}

	if (!isReplayableStatus(response.status)) {
		// A failed response must not become the permanent answer for this key.
		// The row still holds the claim placeholder, so releasing it lets the
		// retry claim again and re-run the handler.
		await releaseResponseSlot(scope, key);
		return response;
	}

	let body: unknown = null;
	try {
		body = await response.clone().json();
	} catch {
		// Mutation routes covered by this helper are JSON responses. Keep a
		// replayable null body if a future route returns an empty success.
	}
	await setCachedResponse(scope, key, { status: response.status, body });
	return response;
}
