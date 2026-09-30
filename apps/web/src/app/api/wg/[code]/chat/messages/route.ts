import { recordAuditEvent } from '@/core/audit';
import {
	db,
	idempotencyResponses,
	wgChatMentions,
	wgChatMessages,
	wgChatReactions,
	wgMembers,
} from '@/core/db';
import { assertPrivateImageCanBeAttached } from '@/core/db/private-image-deletions';
import { TransactionAbort, lockExpensePayments, withTransaction } from '@/core/db/transaction';
import { badRequest, conflict, payloadTooLarge } from '@/core/errors';
import { UUID_PATTERN } from '@/core/guards/api-auth';
import { claimReplaySlotWithRetry } from '@/core/guards/idempotency';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { readJsonBody } from '@/core/http/read-json';
import {
	RESPONSE_REPLAY_TTL_SECONDS,
	getCachedResponse,
	readIdempotencyKey,
} from '@/core/idempotency';
import { readListLimit } from '@/core/infra/env';
import { logApiError } from '@/core/infra/observability';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import { chatMessageLimiter, checkRateLimit } from '@/core/rate-limit';
import { imageUrlSchema, isAllowedImageUrlForWg } from '@/core/validators/image-url';
import {
	CHAT_REFRESH_BATCH_SIZE,
	chatMessagesReadPayload,
	filterPersistedMentionIds,
	previewBody,
	sanitizeMessageBody,
} from '@/features/chat/chat-pure';
import { buildChatCursorWhere } from '@/features/chat/chat-unread-query';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

// Operator-tunable via CHAT_MESSAGES_* (see .env.example). Every value runs
// through readListLimit, so an empty, unparsable or out-of-range setting falls
// back to / clamps to a working limit instead of disabling the bound.
// The body ceiling stays well under the route's 64 KiB raw-body cap, and the
// page ceiling matches the members listing, so neither knob can degenerate
// into an unbounded read or a whole-request payload.
const BODY_MAX = readListLimit(process.env, 'CHAT_MESSAGES_BODY_MAX', 4000, 10_000);
const PAGE_MAX = readListLimit(process.env, 'CHAT_MESSAGES_PAGE_MAX', 100, 500);
const PAGE_DEFAULT = readListLimit(process.env, 'CHAT_MESSAGES_PAGE_DEFAULT', 50, PAGE_MAX);
const PREVIEW_LENGTH = 120;
const MENTIONS_MAX = 20;

interface CachedJsonResponse {
	status: number;
	body: unknown;
}

type ChatMessageRow = typeof wgChatMessages.$inferSelect;

function isCachedJsonResponse(value: unknown): value is CachedJsonResponse {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Number.isInteger((value as CachedJsonResponse).status) &&
		(value as CachedJsonResponse).status >= 200 &&
		(value as CachedJsonResponse).status < 600 &&
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

async function persistChatReplayWarning(
	scope: string,
	key: string,
	messageId: string,
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
				sql`${idempotencyResponses.responseBody}->'body'->'message'->>'id' = ${messageId}`,
				sql`${idempotencyResponses.responseBody}->'body' ? 'warning'`,
				sql`(${idempotencyResponses.responseBody}->'body'->'warning' = 'null'::jsonb OR ${idempotencyResponses.responseBody}->'body'->>'warning' = ${warning})`,
			),
		)
		.returning({ scope: idempotencyResponses.scope });
	return rows.length === 1;
}

const createMessageSchema = z
	.object({
		body: z.string().max(BODY_MAX).optional(),
		imageUrl: imageUrlSchema,
		replyToMessageId: z.string().uuid().optional().nullable(),
		mentionMemberIds: z.array(z.string().uuid()).max(MENTIONS_MAX).optional(),
	})
	.refine(
		(value) =>
			(typeof value.body === 'string' && value.body.trim().length > 0) ||
			(typeof value.imageUrl === 'string' && value.imageUrl.length > 0),
		{ message: 'empty_message' },
	);

export const GET = withWgRoute('chat messages GET', async (req, { code }) => {
	const url = new URL(req.url);
	const beforeRaw = url.searchParams.get('before');
	const beforeId = url.searchParams.get('beforeId');
	const refreshIdParams = url.searchParams.getAll('refreshId');
	const limitRaw = url.searchParams.get('limit');
	const limit = Math.min(
		PAGE_MAX,
		Math.max(1, Number.parseInt(limitRaw ?? `${PAGE_DEFAULT}`, 10) || PAGE_DEFAULT),
	);
	const before = beforeRaw ? new Date(beforeRaw) : null;
	if (before && Number.isNaN(before.getTime())) return badRequest('before_invalid');
	if (beforeId && !UUID_PATTERN.test(beforeId)) return badRequest('before_id_invalid');
	if (
		refreshIdParams.length > CHAT_REFRESH_BATCH_SIZE ||
		refreshIdParams.some((id) => !UUID_PATTERN.test(id))
	)
		return badRequest('refresh_ids_invalid');
	// Pagination cursor must be complete: beforeId without before (or vice
	// versa) would either silently fall back to the latest page or lose rows
	// on createdAt ties.
	if (!!before !== !!beforeId) return badRequest('before_cursor_incomplete');
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;

	const where = beforeId
		? and(
				eq(wgChatMessages.wgId, wg.id),
				buildChatCursorWhere(wgChatMessages, wg.id, beforeId, 'before'),
			)
		: eq(wgChatMessages.wgId, wg.id);

	const pageRows = await db
		.select()
		.from(wgChatMessages)
		.where(where)
		.orderBy(desc(wgChatMessages.createdAt), desc(wgChatMessages.id))
		.limit(limit);

	const pageIds = new Set(pageRows.map((row) => row.id));
	const refreshIds = [...new Set(refreshIdParams)].filter((id) => !pageIds.has(id));
	const refreshedRows =
		refreshIds.length > 0
			? await db
					.select()
					.from(wgChatMessages)
					.where(and(eq(wgChatMessages.wgId, wg.id), inArray(wgChatMessages.id, refreshIds)))
			: [];
	const rows = [...pageRows, ...refreshedRows];

	if (rows.length === 0) {
		return NextResponse.json({
			...chatMessagesReadPayload(pageRows, refreshedRows),
			reactions: [],
			mentions: [],
		});
	}

	const liveMessageIds = rows.filter((row) => !row.deletedAt).map((row) => row.id);
	if (liveMessageIds.length === 0) {
		return NextResponse.json({
			...chatMessagesReadPayload(pageRows, refreshedRows),
			reactions: [],
			mentions: [],
		});
	}
	const [reactionRows, mentionRows] = await Promise.all([
		db
			.select({
				messageId: wgChatReactions.messageId,
				memberId: wgChatReactions.memberId,
				emoji: wgChatReactions.emoji,
				memberName: wgMembers.name,
				memberColor: wgMembers.color,
			})
			.from(wgChatReactions)
			.innerJoin(wgMembers, eq(wgChatReactions.memberId, wgMembers.id))
			.where(inArray(wgChatReactions.messageId, liveMessageIds)),
		db
			.select({
				messageId: wgChatMentions.messageId,
				mentionedMemberId: wgChatMentions.mentionedMemberId,
			})
			.from(wgChatMentions)
			.where(inArray(wgChatMentions.messageId, liveMessageIds)),
	]);

	return NextResponse.json({
		...chatMessagesReadPayload(pageRows, refreshedRows),
		reactions: reactionRows,
		mentions: mentionRows,
	});
});

export const POST = withWgRoute('chat messages POST', async (req, { code }) => {
	const rawResult = await readJsonBody(req, 64 * 1024);
	if (!rawResult.ok)
		return rawResult.reason === 'payload_too_large'
			? payloadTooLarge()
			: badRequest('invalid_json');
	const raw = rawResult.body;

	const parsed = createMessageSchema.safeParse(raw);
	if (!parsed.success) {
		const { formErrors, fieldErrors } = parsed.error.flatten();
		if (formErrors.includes('empty_message')) return badRequest('empty_message');
		if (fieldErrors.imageUrl) return badRequest('image_invalid');
		if (fieldErrors.replyToMessageId) return badRequest('reply_to_invalid');
		if (fieldErrors.mentionMemberIds) return badRequest('mentions_invalid');
		return badRequest('body_invalid');
	}

	const cleanBody = sanitizeMessageBody(parsed.data.body ?? null, BODY_MAX);
	const imageUrl =
		typeof parsed.data.imageUrl === 'string' && parsed.data.imageUrl.length > 0
			? parsed.data.imageUrl
			: null;
	const kind = imageUrl ? 'image' : 'text';
	const replyToMessageId = parsed.data.replyToMessageId ?? null;
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;
	if (!isAllowedImageUrlForWg(imageUrl, wg.id)) return badRequest('image_invalid');

	const replayKey = readIdempotencyKey(req);
	const replayScope = `chat-message:${wg.id}:${auth.member.memberId}`;
	if (replayKey) {
		const cached = await getCachedResponse<CachedJsonResponse>(replayScope, replayKey);
		if (cached) {
			if (!isCachedJsonResponse(cached)) throw new Error('idempotency_claim_invalid');
			return NextResponse.json(cached.body, { status: cached.status });
		}
		const slot = await claimReplaySlotWithRetry<CachedJsonResponse>(replayScope, replayKey);
		if (!slot.won) {
			if (!isCachedJsonResponse(slot.cached)) throw new Error('idempotency_claim_invalid');
			return NextResponse.json(slot.cached.body, { status: slot.cached.status });
		}
	}

	let lockedClaimExpiry: Date | null = null;
	let callbackFailure: unknown;
	let failedInCallback = false;
	let outcome: {
		response: CachedJsonResponse;
		created: ChatMessageRow | null;
		mentionIds: string[];
	};
	try {
		outcome = await withTransaction(async (tx) => {
			try {
				await lockExpensePayments(tx, wg.id);
				if (replayKey) {
					const [slot] = await tx
						.select({
							body: idempotencyResponses.responseBody,
							expiresAt: idempotencyResponses.expiresAt,
						})
						.from(idempotencyResponses)
						.where(
							and(
								eq(idempotencyResponses.scope, replayScope),
								eq(idempotencyResponses.key, replayKey),
							),
						)
						.limit(1)
						.for('update');
					if (!slot) throw new Error('idempotency_claim_missing');
					if (isCachedJsonResponse(slot.body)) {
						return { response: slot.body, created: null, mentionIds: [] as string[] };
					}
					if (!isClaimPlaceholder(slot.body)) throw new Error('idempotency_claim_invalid');
					lockedClaimExpiry = slot.expiresAt;
				}

				async function complete(
					response: CachedJsonResponse,
					created: ChatMessageRow | null = null,
					mentionIds: string[] = [],
				) {
					if (replayKey) {
						const rows = await tx
							.update(idempotencyResponses)
							.set({
								responseBody: response,
								expiresAt: new Date(Date.now() + RESPONSE_REPLAY_TTL_SECONDS * 1000),
							})
							.where(
								and(
									eq(idempotencyResponses.scope, replayScope),
									eq(idempotencyResponses.key, replayKey),
									sql`${idempotencyResponses.responseBody} @> '{"_claimed": true}'::jsonb`,
								),
							)
							.returning({ scope: idempotencyResponses.scope });
						if (rows.length !== 1) throw new Error('idempotency_claim_missing');
					}
					return { response, created, mentionIds };
				}

				const limited = await checkRateLimit(
					chatMessageLimiter,
					`chat:${wg.id}:${auth.member.memberId}`,
				);
				if (!limited.success) {
					return await complete({ status: 429, body: { error: 'too_many_requests' } });
				}

				if (replyToMessageId) {
					if (!UUID_PATTERN.test(replyToMessageId)) {
						return await complete({ status: 400, body: { error: 'reply_to_invalid' } });
					}
					const replyRow = await tx
						.select({ id: wgChatMessages.id })
						.from(wgChatMessages)
						.where(
							and(
								eq(wgChatMessages.id, replyToMessageId),
								eq(wgChatMessages.wgId, wg.id),
								isNull(wgChatMessages.deletedAt),
							),
						)
						.limit(1);
					if (replyRow.length === 0) {
						return await complete({ status: 400, body: { error: 'reply_to_not_found' } });
					}
				}
				await assertPrivateImageCanBeAttached(tx, wg.id, imageUrl);

				const requestedMentionIds = Array.from(
					new Set((parsed.data.mentionMemberIds ?? []).filter((id) => UUID_PATTERN.test(id))),
				);
				let validMentionIds: string[] = [];
				if (requestedMentionIds.length > 0) {
					const validRows = await tx
						.select({ id: wgMembers.id })
						.from(wgMembers)
						.where(and(eq(wgMembers.wgId, wg.id), inArray(wgMembers.id, requestedMentionIds)));
					validMentionIds = validRows
						.map((row) => row.id)
						.filter((id) => id !== auth.member.memberId);
				}

				const [inserted] = await tx
					.insert(wgChatMessages)
					.values({
						wgId: wg.id,
						senderMemberId: auth.member.memberId,
						kind,
						body: cleanBody,
						imageUrl,
						replyToMessageId,
					})
					.returning();
				if (!inserted) throw new Error('chat_message_insert_failed');

				let persistedMentionIds: string[] = [];
				if (validMentionIds.length > 0) {
					const insertedMentionRows = await tx
						.insert(wgChatMentions)
						.values(
							validMentionIds.map((mentionedMemberId) => ({
								messageId: inserted.id,
								mentionedMemberId,
							})),
						)
						.onConflictDoNothing()
						.returning({ mentionedMemberId: wgChatMentions.mentionedMemberId });
					persistedMentionIds = filterPersistedMentionIds(validMentionIds, insertedMentionRows);
				}
				return await complete(
					{
						status: 200,
						body: { message: inserted, mentions: persistedMentionIds, warning: null },
					},
					inserted,
					persistedMentionIds,
				);
			} catch (err) {
				callbackFailure = err;
				failedInCallback = true;
				throw err;
			}
		});
	} catch (err) {
		// Drizzle rethrows the callback error only after ROLLBACK succeeds. A COMMIT
		// failure never enters the callback catch and keeps its claim fail-closed.
		if (replayKey && lockedClaimExpiry && failedInCallback && err === callbackFailure) {
			try {
				await db
					.delete(idempotencyResponses)
					.where(
						and(
							eq(idempotencyResponses.scope, replayScope),
							eq(idempotencyResponses.key, replayKey),
							eq(idempotencyResponses.expiresAt, lockedClaimExpiry),
							sql`${idempotencyResponses.responseBody} @> '{"_claimed": true}'::jsonb`,
						),
					);
			} catch (releaseErr) {
				logApiError('[chat/messages] rollback claim release failed', releaseErr);
			}
		}
		if (err instanceof TransactionAbort && err.code === 'image_removed') {
			return conflict('image_removed', 'image_removed');
		}
		throw err;
	}

	if (!outcome.created) {
		return NextResponse.json(outcome.response.body, { status: outcome.response.status });
	}

	const preview = previewBody(cleanBody ?? (imageUrl ? 'Bild' : ''), PREVIEW_LENGTH);
	const notificationDispatches = [
		dispatchNotificationSafely({
			wg,
			event: 'chat.message',
			payload: { messageId: outcome.created.id, actorName: auth.member.name, preview },
			excludeMemberId: auth.member.memberId,
		}),
	];
	if (outcome.mentionIds.length > 0) {
		notificationDispatches.push(
			dispatchNotificationSafely({
				wg,
				event: 'chat.mention',
				payload: { messageId: outcome.created.id, actorName: auth.member.name, preview },
				targetMemberIds: outcome.mentionIds,
				excludeMemberId: auth.member.memberId,
			}),
		);
	}
	void recordAuditEvent({
		wgId: wg.id,
		memberId: auth.member.memberId,
		eventType: 'chat.message.created',
		entityType: 'chat_message',
		entityId: outcome.created.id,
		summary: `${auth.member.name} hat im Chat eine Nachricht gesendet.`,
		metadata: { preview, kind, mentions: outcome.mentionIds.length },
	}).catch(() => undefined);

	const notificationResults = await Promise.all(notificationDispatches);
	let warning: 'notification_delivery_failed' | 'notification_delivery_unknown' | null =
		notificationResults.some((result) => result.warning === 'notification_delivery_unknown')
			? 'notification_delivery_unknown'
			: notificationResults.some((result) => result.warning === 'notification_delivery_failed')
				? 'notification_delivery_failed'
				: null;
	if (warning && replayKey) {
		try {
			if (!(await persistChatReplayWarning(replayScope, replayKey, outcome.created.id, warning))) {
				logApiError(
					'[chat/messages] replay warning persistence failed',
					new Error('replay_row_missing'),
				);
				warning = null;
			}
		} catch (err) {
			logApiError('[chat/messages] replay warning persistence failed', err);
			warning = null;
		}
	}
	return NextResponse.json({ message: outcome.created, mentions: outcome.mentionIds, warning });
});
