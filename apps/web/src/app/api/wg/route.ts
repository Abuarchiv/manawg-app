import { recordAuditEvent } from '@/core/audit';
import { getAuthenticatedUser } from '@/core/auth/server';
import { db, idempotencyResponses, wgMembers, wgs } from '@/core/db';
import { assertAccountCanAcquireMembership } from '@/core/db/account-deletion';
import { LIMITS } from '@/core/db/schema';
import { TransactionAbort, withTransaction } from '@/core/db/transaction';
import { apiError, badRequest, conflict, serverError, tooMany } from '@/core/errors';
import { claimReplaySlotWithRetry } from '@/core/guards/idempotency';
import { deriveMemberToken } from '@/core/guards/member-token';
import {
	RESPONSE_REPLAY_TTL_SECONDS,
	getCachedResponse,
	readIdempotencyKey,
} from '@/core/idempotency';
import { E2E_CREATED_WG, isE2EDbDownMode } from '@/core/infra/e2e-db-down';
import { logApiError } from '@/core/infra/observability';
import { checkRateLimit, clientIpKey, rateLimitFailMode, registerLimiter } from '@/core/rate-limit';
import { generateShareCode, isValidShareCode } from '@/shared/lib/share-code';
import { and, eq, gt, sql } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const WG_NAME_MIN = 1;
const WG_NAME_MAX = 100;
const SHARE_CODE_RETRIES = 5;

type CachedJsonResponse = { status: number; body: unknown };

function isCachedJsonResponse(value: unknown): value is CachedJsonResponse {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.status === 'number' &&
		Number.isInteger(row.status) &&
		row.status >= 200 &&
		row.status <= 599 &&
		'body' in row
	);
}

function replayResponse(response: CachedJsonResponse): NextResponse {
	return NextResponse.json(response.body, { status: response.status });
}

const createWgSchema = z.object({
	name: z.string().trim().min(WG_NAME_MIN).max(WG_NAME_MAX),
	creatorName: z.string().trim().min(WG_NAME_MIN).max(LIMITS.NAME_MAX),
});

function isUniqueShareCodeViolation(err: unknown): boolean {
	return (
		!!err &&
		typeof err === 'object' &&
		'code' in err &&
		(err as { code?: unknown }).code === '23505'
	);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
	// Defense in depth: middleware already covers /api/wg with wgWriteLimiter
	// (30/min/IP). WG creation is rarer than other writes, so apply the
	// stricter registerLimiter (3/hour/IP) on top to block WG spam.
	const ip = clientIpKey(req);
	// Local/CI dev servers have no Upstash service and must still exercise the
	// real DB flow; fail-closed deployments reject missing limiter state.
	const limit = await checkRateLimit(registerLimiter, ip, rateLimitFailMode());
	if (!limit.success) {
		if (limit.limiterUnavailable) {
			const retryAfter = Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000));
			return NextResponse.json(
				{ error: 'rate_limiter_unavailable', retryAfterMs: Math.max(0, limit.reset - Date.now()) },
				{
					status: 503,
					headers: {
						'Retry-After': retryAfter.toString(),
					},
				},
			);
		}
		return tooMany('rate_limited', 'wg_create_rate_limited');
	}

	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}

	const parsed = createWgSchema.safeParse(raw);
	if (!parsed.success) {
		const { fieldErrors } = parsed.error.flatten();
		if (fieldErrors.name) return badRequest('name_invalid');
		if (fieldErrors.creatorName) return badRequest('creator_name_invalid');
		return badRequest('invalid_body');
	}

	const { name, creatorName } = parsed.data;

	if (isE2EDbDownMode()) {
		return NextResponse.json({
			wg: {
				id: E2E_CREATED_WG.id,
				shareCode: E2E_CREATED_WG.shareCode,
				name,
			},
			creator: {
				id: E2E_CREATED_WG.member.id,
				name: creatorName,
				token: deriveMemberToken(E2E_CREATED_WG.id, E2E_CREATED_WG.member.id),
			},
		});
	}

	let user: { id: string } | null;
	try {
		user = await getAuthenticatedUser(req);
	} catch (err) {
		// A transient Auth outage is retryable, not an unauthenticated caller.
		logApiError('[api/wg POST] auth lookup failed', err);
		return apiError('db_error', 503);
	}
	if (!user) return apiError('auth_required', 401, 'auth_required');
	const authenticatedUser = user;
	const idemKey = readIdempotencyKey(req);
	const idemScope = `wg-create:${authenticatedUser.id}`;
	const accountDeletionReplayResponse = async () => {
		try {
			await withTransaction((tx) => assertAccountCanAcquireMembership(tx, authenticatedUser.id));
			return null;
		} catch (err) {
			if (err instanceof TransactionAbort && err.code === 'account_deletion_pending') {
				return conflict('account_deletion_pending', 'account_deletion_pending');
			}
			logApiError('[api/wg POST] replay fence check failed', err);
			return serverError('db_error');
		}
	};
	if (idemKey) {
		const cached = await getCachedResponse<CachedJsonResponse>(idemScope, idemKey);
		if (cached) {
			const blocked = await accountDeletionReplayResponse();
			if (blocked) return blocked;
			return replayResponse(cached);
		}
	}

	let shareCode = '';
	for (let attempt = 0; attempt < SHARE_CODE_RETRIES; attempt += 1) {
		const candidate = generateShareCode();
		if (!isValidShareCode(candidate)) continue;
		const existing = await db.query.wgs.findFirst({
			where: (w, { eq }) => eq(w.shareCode, candidate),
			columns: { id: true },
		});
		if (!existing) {
			shareCode = candidate;
			break;
		}
	}
	if (!shareCode) {
		return serverError('share_code_exhausted');
	}
	if (idemKey) {
		const slot = await claimReplaySlotWithRetry<CachedJsonResponse>(idemScope, idemKey);
		if (!slot.won) {
			const blocked = await accountDeletionReplayResponse();
			if (blocked) return blocked;
			return replayResponse(slot.cached);
		}
	}

	try {
		// The WG and its creator are one write. A WG whose creator row is missing
		// has a valid share code but no one who can administer it, and the person
		// who just created it is not a member of it. This used to be repaired
		// with a delete afterwards, which only covered the case of an insert
		// returning no row — when the insert threw instead, nothing cleaned up
		// and the empty WG stayed.
		//
		// The share-code uniqueness check happens before the transaction, so the
		// 23505 on the unique index can still fire inside it — retry with a fresh
		// code instead of surfacing a raw db_error to a double-clicking user.
		let lastError: unknown = null;
		for (let attempt = 0; attempt < SHARE_CODE_RETRIES; attempt += 1) {
			if (attempt > 0) {
				const candidate = generateShareCode();
				if (!isValidShareCode(candidate)) continue;
				shareCode = candidate;
			}
			try {
				const result = await withTransaction(async (tx) => {
					await assertAccountCanAcquireMembership(tx, authenticatedUser.id);
					if (idemKey) {
						const [slot] = await tx
							.select({
								body: idempotencyResponses.responseBody,
								expiresAt: idempotencyResponses.expiresAt,
							})
							.from(idempotencyResponses)
							.where(
								and(
									eq(idempotencyResponses.scope, idemScope),
									eq(idempotencyResponses.key, idemKey),
								),
							)
							.limit(1)
							.for('update');
						if (!slot) throw new TransactionAbort('idempotency_claim_missing');
						if (slot.expiresAt > new Date() && isCachedJsonResponse(slot.body)) {
							return { replayed: true as const, response: slot.body };
						}
						if (
							slot.expiresAt <= new Date() ||
							!slot.body ||
							typeof slot.body !== 'object' ||
							Array.isArray(slot.body) ||
							Object.keys(slot.body).length !== 1 ||
							(slot.body as Record<string, unknown>)._claimed !== true
						) {
							throw new TransactionAbort('idempotency_claim_invalid');
						}
					}
					const [createdWg] = await tx.insert(wgs).values({ name, shareCode }).returning();
					if (!createdWg) throw new TransactionAbort('insert_failed');

					const [createdMember] = await tx
						.insert(wgMembers)
						.values({
							wgId: createdWg.id,
							name: creatorName,
							role: 'admin',
							authUserId: authenticatedUser.id,
						})
						.returning();
					if (!createdMember) throw new TransactionAbort('member_insert_failed');

					const response: CachedJsonResponse = {
						status: 200,
						body: {
							wg: { id: createdWg.id, shareCode: createdWg.shareCode, name: createdWg.name },
							creator: { id: createdMember.id, name: createdMember.name },
						},
					};
					if (idemKey) {
						const updated = await tx
							.update(idempotencyResponses)
							.set({
								responseBody: response,
								expiresAt: new Date(Date.now() + RESPONSE_REPLAY_TTL_SECONDS * 1000),
							})
							.where(
								and(
									eq(idempotencyResponses.scope, idemScope),
									eq(idempotencyResponses.key, idemKey),
									gt(idempotencyResponses.expiresAt, new Date()),
									sql`${idempotencyResponses.responseBody} = '{"_claimed":true}'::jsonb`,
								),
							)
							.returning({ scope: idempotencyResponses.scope });
						if (updated.length !== 1) throw new TransactionAbort('idempotency_claim_missing');
					}
					return { replayed: false as const, wg: createdWg, member: createdMember, response };
				});
				if (result.replayed) return replayResponse(result.response);

				await recordAuditEvent({
					wgId: result.wg.id,
					memberId: result.member.id,
					eventType: 'wg.created',
					entityType: 'wg',
					entityId: result.wg.id,
					summary: `${result.member.name} hat die WG erstellt.`,
					metadata: { name: result.wg.name, shareCode: result.wg.shareCode },
				});
				return replayResponse(result.response);
			} catch (err) {
				if (err instanceof TransactionAbort) {
					if (err.code === 'account_deletion_pending') {
						return conflict('account_deletion_pending', 'account_deletion_pending');
					}
					return serverError(err.code);
				}
				lastError = err;
				if (!isUniqueShareCodeViolation(err)) throw err;
			}
		}
		logApiError('[api/wg POST] share code retries exhausted', lastError);
		return serverError('share_code_exhausted');
	} catch (err) {
		logApiError('[api/wg POST] insert failed', err);
		return serverError('db_error');
	}
}
