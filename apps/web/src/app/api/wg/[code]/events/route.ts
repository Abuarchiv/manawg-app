import { recordAuditEvent } from '@/core/audit';
import { db, idempotencyResponses, wgEvents } from '@/core/db';
import { TransactionAbort, withTransaction } from '@/core/db/transaction';
import { badRequest, serverError, tooMany } from '@/core/errors';
import { claimReplaySlotWithRetry } from '@/core/guards/idempotency';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import {
	RESPONSE_REPLAY_TTL_SECONDS,
	getCachedResponse,
	readIdempotencyKey,
} from '@/core/idempotency';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import { checkRateLimit, clientIpKey, wgReadLimiter, wgWriteLimiter } from '@/core/rate-limit';
import {
	buildEventsWindowFilter,
	withEventWindowCandidates,
} from '@/features/events/event-reminder-window';
import {
	type SerializedWgEvent,
	formatRecurrenceRule,
	parseRecurrenceRule,
	serializeWgEvent,
} from '@/features/events/events';
import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2_000;
const LOCATION_MAX = 200;
const RECURRENCE_MAX = 200;

type EventCreateWarning = null | 'notification_delivery_failed' | 'notification_delivery_unknown';
type EventCreateResponseBody = { event: SerializedWgEvent; warning: EventCreateWarning };
type EventCreateReplayResponse<T = unknown> = { status: number; body: T };

function readEventCreateReplayResponse(value: unknown): EventCreateReplayResponse | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.status === 'number' &&
		Number.isInteger(record.status) &&
		record.status >= 200 &&
		record.status <= 599 &&
		'body' in record
	) {
		return { status: record.status, body: record.body };
	}
	return 'event' in record ? { status: 200, body: value as EventCreateResponseBody } : null;
}

function replayEventCreateResponse(value: unknown): NextResponse {
	const replay = readEventCreateReplayResponse(value);
	return replay
		? NextResponse.json(replay.body, { status: replay.status })
		: serverError('idempotency_response_invalid');
}

const createSchema = z.object({
	title: z.string().trim().min(1).max(TITLE_MAX),
	description: z.string().trim().max(DESCRIPTION_MAX).nullable().optional(),
	startsAt: z.string().datetime({ offset: true }),
	endsAt: z.string().datetime({ offset: true }).nullable().optional(),
	allDay: z.boolean().optional().default(false),
	location: z.string().trim().max(LOCATION_MAX).nullable().optional(),
	recurrence: z.string().trim().max(RECURRENCE_MAX).nullable().optional(),
});

function normalizeRecurrence(value: string | null | undefined): string | null {
	if (value === undefined || value === null || value.length === 0) return null;
	const parsed = parseRecurrenceRule(value);
	if (!parsed) return 'invalid';
	return formatRecurrenceRule(parsed);
}

export const GET = withWgRoute(
	'events GET',
	async (req, { code }) => {
		const limit = await checkRateLimit(wgReadLimiter, `events:${clientIpKey(req)}`);
		if (!limit.success) return tooMany('rate_limited');

		const url = new URL(req.url);
		const fromParam = url.searchParams.get('from');
		const toParam = url.searchParams.get('to');
		const from = fromParam ? new Date(fromParam) : null;
		const to = toParam ? new Date(toParam) : null;
		if (from !== null && Number.isNaN(from.getTime())) return badRequest('from_invalid');
		if (to !== null && Number.isNaN(to.getTime())) return badRequest('to_invalid');
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wg = auth.wg;

		const wgFilter = eq(wgEvents.wgId, wg.id);
		const windowFilter = buildEventsWindowFilter(from, to);
		return withEventWindowCandidates(
			from,
			async (cursor, pageLimit) => {
				const cursorFilter = cursor
					? or(
							gt(wgEvents.startsAt, cursor.startsAt),
							and(eq(wgEvents.startsAt, cursor.startsAt), gt(wgEvents.id, cursor.id)),
						)
					: undefined;
				const baseFilter = windowFilter ? and(wgFilter, windowFilter) : wgFilter;
				const where = cursorFilter ? and(baseFilter, cursorFilter) : baseFilter;
				return db
					.select()
					.from(wgEvents)
					.where(where)
					.orderBy(asc(wgEvents.startsAt), asc(wgEvents.id))
					.limit(pageLimit);
			},
			() => NextResponse.json({ error: 'events_window_too_large' }, { status: 503 }),
			(rows) => {
				const events: SerializedWgEvent[] = rows.map(serializeWgEvent);
				return NextResponse.json({ events });
			},
		);
	},
	{
		fixture: () => {
			return NextResponse.json(
				{ events: [] },
				{ headers: { 'Cache-Control': 'private, no-store' } },
			);
		},
	},
);

export const POST = withWgRoute('events POST', async (req, { code }) => {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return badRequest('invalid_json');
	}
	const parsed = createSchema.safeParse(raw);
	if (!parsed.success) {
		const { fieldErrors } = parsed.error.flatten();
		if (fieldErrors.title) return badRequest('title_invalid');
		if (fieldErrors.startsAt) return badRequest('starts_at_invalid');
		if (fieldErrors.endsAt) return badRequest('ends_at_invalid');
		if (fieldErrors.description) return badRequest('description_invalid');
		if (fieldErrors.location) return badRequest('location_invalid');
		if (fieldErrors.recurrence) return badRequest('recurrence_invalid');
		return badRequest('invalid_body');
	}
	const startsAt = new Date(parsed.data.startsAt);
	const endsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt) : null;
	if (endsAt && endsAt.getTime() < startsAt.getTime()) {
		return badRequest('ends_before_start');
	}
	const recurrence = normalizeRecurrence(parsed.data.recurrence ?? null);
	if (recurrence === 'invalid') return badRequest('recurrence_invalid');
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;

	const idemKey = readIdempotencyKey(req);
	const idemScope = idemKey ? `event-create:${wg.id}:${auth.member.memberId}` : null;
	if (idemScope && idemKey) {
		const cached = await getCachedResponse<unknown>(idemScope, idemKey);
		if (cached) return replayEventCreateResponse(cached);
	}

	const limit = await checkRateLimit(wgWriteLimiter, `events:${wg.id}:${auth.member.memberId}`);
	if (!limit.success) return tooMany('rate_limited');
	if (idemScope && idemKey) {
		const slot = await claimReplaySlotWithRetry<unknown>(idemScope, idemKey);
		if (!slot.won) return replayEventCreateResponse(slot.cached);
	}

	let written:
		| { replayed: true; response: EventCreateReplayResponse }
		| {
				replayed: false;
				row: typeof wgEvents.$inferSelect;
				response: EventCreateReplayResponse<EventCreateResponseBody>;
		  };
	const rollback = { claimExpiresAt: null as Date | null, failed: false, error: null as unknown };
	try {
		written = await withTransaction(async (tx) => {
			try {
				if (idemScope && idemKey) {
					const [slot] = await tx
						.select({
							body: idempotencyResponses.responseBody,
							expiresAt: idempotencyResponses.expiresAt,
						})
						.from(idempotencyResponses)
						.where(
							and(eq(idempotencyResponses.scope, idemScope), eq(idempotencyResponses.key, idemKey)),
						)
						.limit(1)
						.for('update');
					if (!slot) throw new TransactionAbort('idempotency_claim_missing');
					const replay = readEventCreateReplayResponse(slot.body);
					if (replay) {
						return { replayed: true as const, response: replay };
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
					rollback.claimExpiresAt = slot.expiresAt;
				}

				const [row] = await tx
					.insert(wgEvents)
					.values({
						wgId: wg.id,
						title: parsed.data.title,
						description: parsed.data.description ?? null,
						startsAt,
						endsAt,
						allDay: parsed.data.allDay ?? false,
						location: parsed.data.location ?? null,
						recurrence,
						createdByMemberId: auth.member.memberId,
					})
					.returning();
				if (!row) throw new TransactionAbort('insert_failed');
				const response: EventCreateReplayResponse<EventCreateResponseBody> = {
					status: 200,
					body: { event: serializeWgEvent(row), warning: null },
				};
				if (idemScope && idemKey) {
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
				return { replayed: false as const, row, response };
			} catch (err) {
				rollback.failed = true;
				rollback.error = err;
				throw err;
			}
		});
	} catch (err) {
		if (
			rollback.failed &&
			err === rollback.error &&
			rollback.claimExpiresAt &&
			idemScope &&
			idemKey
		) {
			try {
				await db
					.delete(idempotencyResponses)
					.where(
						and(
							eq(idempotencyResponses.scope, idemScope),
							eq(idempotencyResponses.key, idemKey),
							eq(idempotencyResponses.expiresAt, rollback.claimExpiresAt),
							sql`${idempotencyResponses.responseBody} = '{"_claimed":true}'::jsonb`,
						),
					);
			} catch {
				console.warn('[events POST] rolled-back claim release failed');
			}
		}
		if (err instanceof TransactionAbort) return serverError(err.code);
		throw err;
	}
	if (written.replayed) return replayEventCreateResponse(written.response);

	const row = written.row;
	await recordAuditEvent({
		wgId: wg.id,
		memberId: auth.member.memberId,
		eventType: 'event.created',
		entityType: 'wg_event',
		entityId: row.id,
		summary: `${auth.member.name} hat den Termin „${row.title}“ angelegt.`,
		metadata: {
			startsAt: row.startsAt.toISOString(),
			allDay: row.allDay,
			recurring: row.recurrence !== null,
		},
	});

	const { warning }: { warning: EventCreateWarning } = await dispatchNotificationSafely({
		wg: { id: wg.id, name: wg.name, shareCode: code },
		event: 'event.created',
		payload: {
			eventId: row.id,
			title: row.title,
			startsAt: row.startsAt.toISOString(),
			allDay: row.allDay,
			actorName: auth.member.name,
		},
		excludeMemberId: auth.member.memberId,
	});

	let response: EventCreateReplayResponse<EventCreateResponseBody> = {
		...written.response,
		body: { ...written.response.body, warning },
	};
	if (idemScope && idemKey && warning !== null) {
		try {
			const updated = await db
				.update(idempotencyResponses)
				.set({
					responseBody: sql`jsonb_set(${idempotencyResponses.responseBody}, '{body,warning}', to_jsonb(${warning}::text))`,
				})
				.where(
					and(
						eq(idempotencyResponses.scope, idemScope),
						eq(idempotencyResponses.key, idemKey),
						gt(idempotencyResponses.expiresAt, new Date()),
						sql`${idempotencyResponses.responseBody}->'body'->'event'->>'id' = ${row.id}`,
						sql`${idempotencyResponses.responseBody}->'body'->'warning' = 'null'::jsonb`,
					),
				)
				.returning({ scope: idempotencyResponses.scope });
			if (updated.length !== 1) response = written.response;
		} catch {
			response = written.response;
			console.warn('[events POST] warning replay update failed');
		}
	}
	return replayEventCreateResponse(response);
});
