import { recordAuditEvent } from '@/core/audit';
import {
	announcementComments,
	announcementReactions,
	announcements,
	db,
	wgMembers,
} from '@/core/db';
import { badRequest, payloadTooLarge } from '@/core/errors';
import { requireWgMember } from '@/core/guards/require-wg-member';
import { withWgRoute } from '@/core/guards/with-wg-route';
import { readJsonBody } from '@/core/http/read-json';
import { logApiError } from '@/core/infra/observability';
import { dispatchNotificationSafely } from '@/core/notifications/notification-dispatch';
import { checkRateLimit, wgWriteLimiter } from '@/core/rate-limit';
import { imageUrlSchema, isAllowedImageUrlForWg } from '@/core/validators/image-url';
import {
	type AnnouncementReplayResponse,
	persistAnnouncementReplayWarning,
	withAnnouncementReplay,
} from '@/features/pinnwand/announcement-replay';
import {
	ANNOUNCEMENT_KINDS,
	summarizeAnnouncementReactions,
} from '@/features/pinnwand/announcement-workflow';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const CONTENT_MIN = 1;
const CONTENT_MAX = 2000;
const ANNOUNCEMENTS_LIST_LIMIT = 300;
const announcementKindSchema = z.enum(ANNOUNCEMENT_KINDS);

type AnnouncementCreateWarning =
	| null
	| 'notification_delivery_failed'
	| 'notification_delivery_unknown';

function announcementCreateIdempotencyScope(wgId: string, memberId: string): string {
	return `announcements-create:${wgId}:${memberId}`;
}

function legacyCreateReplay(value: unknown): AnnouncementReplayResponse | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const body = value as { announcement?: unknown; warning?: unknown };
	if (!body.announcement || typeof body.announcement !== 'object') return null;
	const id = (body.announcement as { id?: unknown }).id;
	if (typeof id !== 'string') return null;
	if (
		body.warning !== null &&
		body.warning !== 'notification_delivery_failed' &&
		body.warning !== 'notification_delivery_unknown'
	)
		return null;
	return { status: 200, body: value, entityId: id };
}

// SECURITY (#517): `source`/`sourcePath` are provenance and are never
// client-controlled. The schema drops them (zod strips unknown keys) and the
// insert forces `manual`/null; server-generated posts set them through
// internal paths instead — postSystemNotice (core/activity-feed.ts) writes
// them directly, and chore swap requests go through
// POST /chores/[id]/swap-request.
const createAnnouncementSchema = z.object({
	content: z.string().trim().min(CONTENT_MIN).max(CONTENT_MAX),
	imageUrl: imageUrlSchema,
	kind: announcementKindSchema.optional().default('info'),
});

export const GET = withWgRoute(
	'announcements GET',
	async (req, { code }) => {
		const auth = await requireWgMember(req, code);
		if (!auth.ok) return auth.response;
		const wgId = auth.wg.id;
		const items = await db
			.select()
			.from(announcements)
			.where(eq(announcements.wgId, wgId))
			.orderBy(sql`${announcements.pinnedAt} desc nulls last`, desc(announcements.createdAt))
			.limit(ANNOUNCEMENTS_LIST_LIMIT);

		if (items.length === 0) return NextResponse.json({ announcements: [] });

		const ids = items.map((item) => item.id);
		const reactions = await db
			.select({
				announcementId: announcementReactions.announcementId,
				memberId: announcementReactions.memberId,
				reaction: announcementReactions.reaction,
				memberName: wgMembers.name,
				memberColor: wgMembers.color,
			})
			.from(announcementReactions)
			.innerJoin(wgMembers, eq(announcementReactions.memberId, wgMembers.id))
			.where(inArray(announcementReactions.announcementId, ids));
		const comments = await db
			.select({
				id: announcementComments.id,
				announcementId: announcementComments.announcementId,
				memberId: announcementComments.memberId,
				content: announcementComments.content,
				createdAt: announcementComments.createdAt,
				authorName: wgMembers.name,
				authorColor: wgMembers.color,
			})
			.from(announcementComments)
			.innerJoin(wgMembers, eq(announcementComments.memberId, wgMembers.id))
			.where(inArray(announcementComments.announcementId, ids))
			.orderBy(asc(announcementComments.createdAt));
		const reactionSummary = summarizeAnnouncementReactions(reactions, auth.member.memberId);
		const commentsByAnnouncement = new Map<string, typeof comments>();
		for (const comment of comments) {
			const list = commentsByAnnouncement.get(comment.announcementId) ?? [];
			list.push(comment);
			commentsByAnnouncement.set(comment.announcementId, list);
		}
		const takersByAnnouncement = new Map<
			string,
			Array<{ memberId: string; name: string; color: string | null }>
		>();
		for (const reaction of reactions) {
			if (reaction.reaction !== 'take') continue;
			const list = takersByAnnouncement.get(reaction.announcementId) ?? [];
			list.push({
				memberId: reaction.memberId,
				name: reaction.memberName,
				color: reaction.memberColor,
			});
			takersByAnnouncement.set(reaction.announcementId, list);
		}

		return NextResponse.json({
			announcements: items.map((item) => ({
				...item,
				reactionCounts: reactionSummary.get(item.id)?.reactionCounts ?? {},
				myReactions: reactionSummary.get(item.id)?.myReactions ?? [],
				takers: takersByAnnouncement.get(item.id) ?? [],
				comments: commentsByAnnouncement.get(item.id) ?? [],
			})),
		});
	},
	{
		fixture: () => {
			return NextResponse.json({ announcements: [] });
		},
	},
);

export const POST = withWgRoute('announcements POST', async (req, { code }) => {
	const rawResult = await readJsonBody(req, 64 * 1024);
	if (!rawResult.ok)
		return rawResult.reason === 'payload_too_large'
			? payloadTooLarge()
			: badRequest('invalid_json');
	const raw = rawResult.body;

	const parsed = createAnnouncementSchema.safeParse(raw);
	if (!parsed.success) {
		const { fieldErrors } = parsed.error.flatten();
		if (fieldErrors.kind) return badRequest('kind_invalid');
		if (fieldErrors.imageUrl) return badRequest('image_invalid');
		return badRequest('content_invalid');
	}

	const { content, imageUrl = null, kind } = parsed.data;
	const safeImageUrl = typeof imageUrl === 'string' && imageUrl.length > 0 ? imageUrl : null;
	// Client-supplied provenance is ignored entirely: a member post is always
	// `manual` and never carries an internal deep link (#517).
	const safeSource = 'manual';
	const safeSourcePath = null;
	const auth = await requireWgMember(req, code);
	if (!auth.ok) return auth.response;
	const wg = auth.wg;
	if (!isAllowedImageUrlForWg(safeImageUrl, wg.id)) return badRequest('image_invalid');
	const scope = announcementCreateIdempotencyScope(wg.id, auth.member.memberId);

	// SECURITY: author is always the authenticated caller.
	const outcome = await withAnnouncementReplay(
		req,
		scope,
		async (tx) => {
			const limited = await checkRateLimit(
				wgWriteLimiter,
				`announcement:${wg.id}:${auth.member.memberId}`,
			);
			if (!limited.success) {
				return { response: { status: 429, body: { error: 'too_many_requests' } }, effect: null };
			}

			const [item] = await tx
				.insert(announcements)
				.values({
					wgId: wg.id,
					authorMemberId: auth.member.memberId,
					content,
					imageUrl: safeImageUrl,
					kind,
					source: safeSource,
					sourcePath: safeSourcePath,
				})
				.returning();
			if (!item) throw new Error('announcement_insert_failed');
			return {
				response: {
					status: 200,
					body: { announcement: item, warning: null },
					entityId: item.id,
				},
				effect: item,
			};
		},
		legacyCreateReplay,
	);
	if (!outcome.effect) {
		return NextResponse.json(outcome.response.body, { status: outcome.response.status });
	}

	const item = outcome.effect;
	void recordAuditEvent({
		wgId: wg.id,
		memberId: auth.member.memberId,
		eventType: 'announcement.created',
		entityType: 'announcement',
		entityId: item.id,
		summary: `${auth.member.name} hat einen Pinnwand-Beitrag erstellt.`,
		metadata: {
			contentPreview: content.slice(0, 120),
			kind,
			source: safeSource,
			hasImage: Boolean(safeImageUrl),
		},
	}).catch(() => undefined);

	let warning: AnnouncementCreateWarning = null;
	try {
		const delivery = await dispatchNotificationSafely({
			wg,
			event: 'announcement.posted',
			payload: {
				announcementId: item.id,
				title: content.slice(0, 120),
				actorName: auth.member.name,
			},
			excludeMemberId: auth.member.memberId,
		});
		warning = delivery.warning;
	} catch (err) {
		logApiError('[announcements POST] post-commit notification failed', err);
	}
	if (warning && outcome.key) {
		try {
			if (!(await persistAnnouncementReplayWarning(scope, outcome.key, item.id, warning))) {
				logApiError(
					'[announcements POST] replay warning persistence failed',
					new Error('replay_row_missing'),
				);
				warning = null;
			}
		} catch (err) {
			logApiError('[announcements POST] replay warning persistence failed', err);
			warning = null;
		}
	}
	return NextResponse.json({ announcement: item, warning });
});
