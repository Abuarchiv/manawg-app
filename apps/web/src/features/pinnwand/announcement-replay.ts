import { db, idempotencyResponses } from '@/core/db';
import { type DbTransaction, lockExpensePayments, withTransaction } from '@/core/db/transaction';
import { claimReplaySlotWithRetry } from '@/core/guards/idempotency';
import {
	RESPONSE_REPLAY_TTL_SECONDS,
	getCachedResponse,
	readIdempotencyKey,
} from '@/core/idempotency';
import { logApiError } from '@/core/infra/observability';
import { and, eq, gt, sql } from 'drizzle-orm';

export interface AnnouncementReplayResponse {
	status: number;
	body: unknown;
	entityId?: string;
}

export interface AnnouncementMutation<T> {
	response: AnnouncementReplayResponse;
	effect: T | null;
}

function isCompletedResponse(value: unknown): value is AnnouncementReplayResponse {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Number.isInteger((value as AnnouncementReplayResponse).status) &&
		(value as AnnouncementReplayResponse).status >= 200 &&
		(value as AnnouncementReplayResponse).status < 600 &&
		'body' in value
	);
}

function isClaimPlaceholder(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		(value as { _claimed?: unknown })._claimed === true
	);
}

export async function withAnnouncementReplay<T>(
	req: Request,
	scope: string,
	mutate: (tx: DbTransaction) => Promise<AnnouncementMutation<T>>,
	legacyResponse?: (value: unknown) => AnnouncementReplayResponse | null,
	wgId?: string,
): Promise<AnnouncementMutation<T> & { key: string | null }> {
	const key = readIdempotencyKey(req);
	const completedResponse = (value: unknown): AnnouncementReplayResponse | null =>
		isCompletedResponse(value) ? value : (legacyResponse?.(value) ?? null);
	if (key) {
		const cached = await getCachedResponse<AnnouncementReplayResponse>(scope, key);
		if (cached) {
			const response = completedResponse(cached);
			if (!response) throw new Error('idempotency_claim_invalid');
			return { response, effect: null, key };
		}
		const slot = await claimReplaySlotWithRetry<AnnouncementReplayResponse>(scope, key);
		if (!slot.won) {
			const response = completedResponse(slot.cached);
			if (!response) throw new Error('idempotency_claim_invalid');
			return { response, effect: null, key };
		}
	}

	let lockedClaimExpiry: Date | null = null;
	let callbackFailure: unknown;
	let failedInCallback = false;
	let result: AnnouncementMutation<T>;
	try {
		result = await withTransaction(async (tx) => {
			try {
				if (wgId) await lockExpensePayments(tx, wgId);
				if (key) {
					const [slot] = await tx
						.select({
							body: idempotencyResponses.responseBody,
							expiresAt: idempotencyResponses.expiresAt,
						})
						.from(idempotencyResponses)
						.where(and(eq(idempotencyResponses.scope, scope), eq(idempotencyResponses.key, key)))
						.limit(1)
						.for('update');
					if (!slot) throw new Error('idempotency_claim_missing');
					const completed = completedResponse(slot.body);
					if (completed) return { response: completed, effect: null };
					if (!isClaimPlaceholder(slot.body)) throw new Error('idempotency_claim_invalid');
					lockedClaimExpiry = slot.expiresAt;
				}

				const mutation = await mutate(tx);
				if (
					key &&
					lockedClaimExpiry &&
					mutation.response.status === 429 &&
					mutation.effect === null
				) {
					// A rejected write can retry the same key once its rate limit clears.
					const rows = await tx
						.delete(idempotencyResponses)
						.where(
							and(
								eq(idempotencyResponses.scope, scope),
								eq(idempotencyResponses.key, key),
								eq(idempotencyResponses.expiresAt, lockedClaimExpiry),
								sql`${idempotencyResponses.responseBody} @> '{"_claimed": true}'::jsonb`,
							),
						)
						.returning({ scope: idempotencyResponses.scope });
					if (rows.length !== 1) throw new Error('idempotency_claim_missing');
					return mutation;
				}
				if (key) {
					const rows = await tx
						.update(idempotencyResponses)
						.set({
							responseBody: mutation.response,
							expiresAt: new Date(Date.now() + RESPONSE_REPLAY_TTL_SECONDS * 1000),
						})
						.where(
							and(
								eq(idempotencyResponses.scope, scope),
								eq(idempotencyResponses.key, key),
								sql`${idempotencyResponses.responseBody} @> '{"_claimed": true}'::jsonb`,
							),
						)
						.returning({ scope: idempotencyResponses.scope });
					if (rows.length !== 1) throw new Error('idempotency_claim_missing');
				}
				return mutation;
			} catch (err) {
				callbackFailure = err;
				failedInCallback = true;
				throw err;
			}
		});
	} catch (err) {
		// Drizzle rethrows a callback error only after ROLLBACK succeeds.
		// A COMMIT failure leaves the claim in place for a safe later retry.
		if (key && lockedClaimExpiry && failedInCallback && err === callbackFailure) {
			try {
				await db
					.delete(idempotencyResponses)
					.where(
						and(
							eq(idempotencyResponses.scope, scope),
							eq(idempotencyResponses.key, key),
							eq(idempotencyResponses.expiresAt, lockedClaimExpiry),
							sql`${idempotencyResponses.responseBody} @> '{"_claimed": true}'::jsonb`,
						),
					);
			} catch (releaseErr) {
				logApiError('[announcement/replay] rollback claim release failed', releaseErr);
			}
		}
		throw err;
	}
	return { ...result, key };
}

export async function persistAnnouncementReplayWarning(
	scope: string,
	key: string,
	entityId: string,
	warning: 'notification_delivery_failed' | 'notification_delivery_unknown',
): Promise<boolean> {
	const rows = await db
		.update(idempotencyResponses)
		.set({
			responseBody: sql`jsonb_set(${idempotencyResponses.responseBody}, '{body,warning}', to_jsonb(${warning}::text))`,
		})
		.where(
			and(
				eq(idempotencyResponses.scope, scope),
				eq(idempotencyResponses.key, key),
				gt(idempotencyResponses.expiresAt, new Date()),
				sql`${idempotencyResponses.responseBody}->>'entityId' = ${entityId}`,
				sql`${idempotencyResponses.responseBody}->>'status' = '200'`,
				sql`${idempotencyResponses.responseBody}->'body' ? 'warning'`,
				sql`(${idempotencyResponses.responseBody}->'body'->'warning' = 'null'::jsonb OR ${idempotencyResponses.responseBody}->'body'->>'warning' = ${warning})`,
			),
		)
		.returning({ scope: idempotencyResponses.scope });
	return rows.length === 1;
}
